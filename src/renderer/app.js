import {
  ABSENCE_REASONS, EVENT_TYPES, addDays, addMonths, buildReport, eventState, eventsOn, findConflicts, fromISO, fromMinutes, hourRange, layoutDay,
  monthWeeks, nameKey, plural, rollCall, splitList, splitNames, suggestedStart, statusName, toCsv, toISO, toMinutes, typeName, uniqueValues, visibleOn, weekDays,
} from './logic.mjs';

const POLL_MS = 10_000;
const IDLE_MS = 5 * 60_000;
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const $ = (id) => document.getElementById(id);
const api = window.calendar;

const state = {
  view: 'week',
  date: toISO(new Date()),
  allEvents: [], // все мероприятия сети: по ним ищутся занятые люди и техника
  events: [], // те, что показывает это устройство
  directory: [],
  attendance: [],
  settings: null,
  deviceNames: new Map(),
  storageError: null,
  lastActivity: Date.now(),
  renderedMinute: '',
  today: toISO(new Date()),
};

/** Создаёт элемент. Текст всегда попадает как текст, а не как разметка. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const now = () => {
  const d = new Date();
  return { iso: toISO(d), time: fromMinutes(d.getHours() * 60 + d.getMinutes()) };
};

const fmt = (iso, options) => new Intl.DateTimeFormat('ru-RU', options).format(fromISO(iso));
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const timeRange = (e) => `${e.start}–${e.end}`;
const peopleCount = (n) => `${n} ${plural(n, 'участник', 'участника', 'участников')}`;

function periodTitle() {
  if (state.view === 'day') return capitalize(fmt(state.date, { weekday: 'long', day: 'numeric', month: 'long' }));
  if (state.view === 'month') return capitalize(fmt(state.date, { month: 'long', year: 'numeric' })).replace(/ г\.$/, '');
  const days = weekDays(state.date);
  const first = fromISO(days[0]);
  const last = fromISO(days[6]);
  const lastText = fmt(days[6], { day: 'numeric', month: 'long' });
  const year = last.getFullYear();
  return first.getMonth() === last.getMonth()
    ? `${first.getDate()}–${lastText} ${year}`
    : `${fmt(days[0], { day: 'numeric', month: 'long' })} – ${lastText} ${year}`;
}

function dayNumber(iso, isToday) {
  const text = String(fromISO(iso).getDate());
  return h('span', { class: isToday ? 'todaynum' : '' }, text);
}

function openDay(iso) {
  state.date = iso;
  state.view = 'day';
  render();
}

function eventLabel(e) {
  return `${e.title}, ${timeRange(e)}`;
}

function eventBlock(item, range, dayView) {
  const { event, column, columns } = item;
  const clock = now();
  const status = eventState(event, clock.iso, clock.time);
  const span = (range.last - range.first) * 60;
  const start = toMinutes(event.start) - range.first * 60;
  const length = toMinutes(event.end) - toMinutes(event.start);
  const details = [h('strong', {}, event.title), h('span', {}, timeRange(event) + (dayView && status === 'now' ? ', идёт сейчас' : ''))];
  if (event.place) details.push(h('span', {}, event.place));
  if (dayView) {
    details.push(h('span', {}, typeName(event.type)));
    if (event.responsible) details.push(h('span', {}, `Ответственный: ${event.responsible}`));
    if (event.participants.length) details.push(h('span', {}, peopleCount(event.participants.length)));
    if (event.equipment.length) details.push(h('span', {}, `Техника: ${event.equipment.join(', ')}`));
  } else if (event.participants.length) {
    details.push(h('span', {}, peopleCount(event.participants.length)));
  }
  const block = h('button', {
    class: `block t-${event.type} ${status}${!dayView && columns > 1 ? ' narrow' : ''}`,
    'aria-label': eventLabel(event),
    onclick: (e) => { e.stopPropagation(); showDetails(event.id); },
  }, details);
  block.style.top = `calc(${(start / span) * 100}% + .08rem)`;
  block.style.height = `calc(${(length / span) * 100}% - .16rem)`;
  block.style.left = `calc(${(column / columns) * 100}% + .15rem)`;
  block.style.width = `calc(${100 / columns}% - .3rem)`;
  return block;
}

/** Оставляет в блоке только строки, которые помещаются целиком. */
function fitBlock(block) {
  const overflows = () => block.scrollHeight > block.clientHeight + 1;
  const title = block.querySelector('strong');
  const time = title.nextElementSibling;
  while (overflows() && block.lastChild !== time) block.lastChild.remove();
  if (!overflows()) return;
  // Время важнее хвоста названия: сокращаем название до целых строк.
  const box = getComputedStyle(block);
  const room = block.clientHeight - parseFloat(box.paddingTop) - parseFloat(box.paddingBottom) - time.offsetHeight;
  title.classList.add('clamped');
  title.style.webkitLineClamp = Math.max(1, Math.floor(room / parseFloat(getComputedStyle(title).lineHeight)));
  if (overflows()) time.remove();
}

function timeGrid(days, dayView) {
  const clock = now();
  const shown = state.events.filter((e) => days.includes(e.date));
  const range = hourRange(shown);
  const hoursCount = range.last - range.first;

  const hours = h('div', { class: 'hours' });
  const lines = h('div', { class: 'lines' });
  for (let i = 0; i < hoursCount; i += 1) {
    const top = `${(i / hoursCount) * 100}%`;
    const label = h('span', {}, `${range.first + i}:00`);
    label.style.top = top;
    hours.append(label);
    const line = h('i');
    line.style.top = top;
    lines.append(line);
  }

  const columns = days.map((iso) => {
    const column = h('div', {
      class: `day${iso === clock.iso ? ' today' : ''}`,
      onclick: (e) => {
        const box = e.currentTarget.getBoundingClientRect();
        const minutes = range.first * 60 + ((e.clientY - box.top) / box.height) * hoursCount * 60;
        const start = Math.min(Math.floor(minutes / 30) * 30, 23 * 60);
        openForm({ date: iso, start: fromMinutes(start), end: fromMinutes(Math.min(start + 60, 23 * 60 + 55)) });
      },
    });
    for (const item of layoutDay(eventsOn(state.events, iso))) column.append(eventBlock(item, range, dayView));
    if (iso === clock.iso) {
      const minutes = toMinutes(clock.time) - range.first * 60;
      if (minutes >= 0 && minutes <= hoursCount * 60) {
        const line = h('div', { class: 'nowline' });
        line.style.top = `${(minutes / (hoursCount * 60)) * 100}%`;
        column.append(line);
      }
    }
    return column;
  });

  const body = h('div', { class: 'days' }, lines, columns);
  if (dayView && !shown.length) {
    body.append(h('p', { class: 'hint' }, 'На этот день мероприятий нет. Нажмите на нужное время, чтобы добавить.'));
  }
  return h('div', { class: `timegrid${dayView ? ' dayview' : ''}` }, hours, body);
}

function renderWeek(board) {
  const clock = now();
  const days = weekDays(state.date);
  const head = h('div', { class: 'dayhead' }, days.map((iso, i) =>
    h('button', {
      class: i > 4 ? 'off' : '',
      'aria-label': fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' }),
      onclick: () => openDay(iso),
    }, WEEKDAYS[i], h('span', { class: 'number' }, dayNumber(iso, iso === clock.iso)))));
  board.append(head, timeGrid(days, false));
}

function renderMonth(board) {
  const clock = now();
  const weeks = monthWeeks(state.date);
  const month = fromISO(state.date).getMonth();
  const head = h('div', { class: 'monthhead' }, WEEKDAYS.map((d) => h('span', {}, d)));
  const grid = h('div', { class: 'month' });
  board.append(head, grid);

  // Сколько мероприятий помещается, зависит от экрана и числа недель в месяце.
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const room = grid.clientHeight / weeks.length - 2.3 * rem;
  const chip = 1.93 * rem;
  const fits = Math.max(1, Math.floor(room / chip));
  const fitsWithMore = Math.max(1, Math.floor((room - 1.58 * rem) / chip));

  for (const iso of weeks.flat()) {
    const events = eventsOn(state.events, iso);
    const visible = events.length > fits ? events.slice(0, fitsWithMore) : events;
    const classes = ['cell'];
    if (fromISO(iso).getMonth() !== month) classes.push('outside');
    if (iso === clock.iso) classes.push('today');
    grid.append(h('div', { class: classes.join(' '), onclick: () => openDay(iso) },
      h('div', { class: 'date' }, dayNumber(iso, iso === clock.iso)),
      visible.map((e) => h('button', {
        class: `chip t-${e.type} ${eventState(e, clock.iso, clock.time)}`,
        onclick: (ev) => { ev.stopPropagation(); showDetails(e.id); },
      }, `${e.start} ${e.title}`)),
      events.length > visible.length && h('div', { class: 'more' }, `ещё ${events.length - visible.length}`)));
  }
}

function render() {
  $('title').textContent = periodTitle();
  for (const button of document.querySelectorAll('.views button')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  }
  const board = $('board');
  board.replaceChildren();
  if (state.view === 'month') renderMonth(board);
  else if (state.view === 'week') renderWeek(board);
  else {
    board.append(timeGrid([state.date], true));
  }
  for (const block of board.querySelectorAll('.block')) fitBlock(block);
  state.renderedMinute = now().time;
}

function move(direction) {
  if (state.view === 'month') state.date = addMonths(state.date, direction);
  else state.date = addDays(state.date, state.view === 'week' ? 7 * direction : direction);
  render();
}

/* Данные */

let loading = false;

async function refresh() {
  if (loading) return;
  loading = true;
  const result = await api.list();
  loading = false;
  const error = result.ok ? null : result.message;
  const changed = result.ok && JSON.stringify(result.value) !== JSON.stringify(state.allEvents);
  if (changed) setEvents(result.value);
  const bannerChanged = error !== state.storageError;
  if (bannerChanged) {
    state.storageError = error;
    const banner = $('banner');
    banner.hidden = !error;
    banner.textContent = error
      ? 'Не удаётся прочитать мероприятия на этом компьютере. На экране последние загруженные данные. Проверьте свободное место и права на папку C:\\ProgramData\\StudentCalendar.'
      : '';
  }
  if (changed || bannerChanged) render();
  await loadDirectory();
  await loadAttendance();
  await loadDevices();
}

let redrawRoll = null;

async function loadAttendance() {
  const result = await api.attendance();
  if (!result.ok || JSON.stringify(result.value) === JSON.stringify(state.attendance)) return;
  state.attendance = result.value;
  if ($('roll').open) redrawRoll?.();
}

async function loadDirectory() {
  const result = await api.directory();
  if (!result.ok || JSON.stringify(result.value) === JSON.stringify(state.directory)) return;
  state.directory = result.value;
  const dialog = $('catalog');
  const typing = dialog.contains(document.activeElement) && document.activeElement.value;
  if (dialog.open && !typing) drawCatalog();
}

const refsOf = (kind) => state.directory
  .filter((ref) => ref.kind === kind)
  .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

function setEvents(all) {
  state.allEvents = all;
  state.events = all.filter((e) => visibleOn(e, state.settings.deviceId, state.settings.showAll));
}

async function loadDevices() {
  const status = await api.syncStatus();
  state.deviceNames = new Map(status.peers.map((peer) => [peer.id, peer.name]));
  state.deviceNames.set(state.settings.deviceId, state.settings.deviceName);
  return status;
}

const deviceName = (id) => state.deviceNames.get(id) ?? 'Неизвестное устройство';

function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 5000);
}

const storeMessage = (result) => (result.code === 'conflict'
  ? 'Это мероприятие уже изменили или удалили на другом устройстве. Закройте окно и откройте его заново.'
  : result.code === 'invalid'
    ? result.message
    : 'Не удалось сохранить на этом компьютере. Попробуйте ещё раз.');

/* Карточка мероприятия */

const closeButton = (dialog) => h('button', {
  class: 'icon',
  'aria-label': 'Закрыть',
  type: 'button',
  onclick: () => dialog.close(),
}, svgCross());

function svgCross() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 5l14 14M19 5 5 19');
  svg.append(path);
  return svg;
}

function listGroup(title, items, ordered) {
  const list = items.length
    ? h(ordered ? 'ol' : 'ul', {}, items.map((item) => h('li', {}, item)))
    : h('p', { class: 'empty' }, 'Не указано');
  return h('section', { class: 'group' }, h('h3', {}, title), list);
}

const attendanceOf = (eventId) => state.attendance.find((doc) => doc.eventId === eventId);

const roll = (event) => {
  const clock = now();
  return rollCall(event, attendanceOf(event.id), clock.iso, clock.time);
};

const countPresent = (event) => roll(event).filter((row) => row.status === 'present').length;

function showDetails(id) {
  const event = state.allEvents.find((e) => e.id === id);
  if (!event) return;
  const dialog = $('details');
  const footer = h('div', { class: 'sheetfoot' });

  const showActions = () => footer.replaceChildren(
    h('button', { class: 'plain', onclick: () => { dialog.close(); openForm(event); } }, 'Изменить'),
    event.participants.length > 0 && h('button', {
      class: 'primary',
      onclick: () => { dialog.close(); openRoll(event.id); },
    }, `Отметка: ${countPresent(event)} из ${event.participants.length}`),
    h('div', { class: 'spacer' }),
    h('button', { class: 'plain', onclick: showConfirm }, 'Удалить'),
  );

  const showConfirm = () => footer.replaceChildren(
    h('p', { class: 'message' }, 'Удалить мероприятие без возможности восстановления?'),
    h('button', { class: 'plain', onclick: showActions }, 'Оставить'),
    h('button', {
      class: 'danger',
      onclick: async () => {
        const result = await api.remove(event.id, event.updatedAt);
        if (result.ok) {
          setEvents(state.allEvents.filter((e) => e.id !== event.id));
          dialog.close();
          render();
        } else {
          footer.replaceChildren(h('p', { class: 'message' }, storeMessage(result)));
        }
      },
    }, 'Удалить'),
  );

  showActions();
  const fact = (name, value) => (value ? [h('dt', {}, name), h('dd', {}, value)] : []);
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, event.title), closeButton(dialog)),
    h('div', { class: 'sheetbody' },
      h('dl', { class: 'facts' },
        fact('Тип', typeName(event.type)),
        fact('Дата', fmt(event.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(/ г\.$/, '')),
        fact('Время', timeRange(event)),
        fact('Место', event.place),
        fact('Ответственный', event.responsible || 'Не указан'),
        fact('Показывать на', event.devices.map(deviceName).join(', '))),
      listGroup(`Участники: ${event.participants.length}`, event.participants, true),
      listGroup('Техника', event.equipment, false),
      event.notes && h('section', { class: 'group' }, h('h3', {}, 'Примечание'), h('p', { class: 'notes' }, event.notes))),
    footer,
  );
  dialog.showModal();
}

/* Форма мероприятия */

function listInput(label, listId, inputId, placeholder, values, onChange, pick) {
  const tags = h('div', { class: 'tags' });
  const heading = h('label', { for: inputId });
  const input = h('input', { id: inputId, list: listId, placeholder, autocomplete: 'off' });

  const draw = () => {
    heading.textContent = values.length ? `${label}: ${values.length}` : label;
    tags.replaceChildren(...values.map((value, index) =>
      h('span', { class: 'tag' }, value, h('button', {
        type: 'button',
        'aria-label': `Убрать: ${value}`,
        onclick: () => { values.splice(index, 1); draw(); onChange(); },
      }, '×'))));
  };

  const addFrom = (text) => {
    const known = new Set(values.map((v) => v.toLocaleLowerCase('ru')));
    for (const value of splitList(text)) {
      const key = value.toLocaleLowerCase('ru');
      if (!known.has(key)) {
        known.add(key);
        values.push(value);
      }
    }
    draw();
    onChange();
  };

  const commit = () => {
    if (!input.value.trim()) return;
    addFrom(input.value);
    input.value = '';
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  });
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (/[\r\n;\t]/.test(text.trim())) {
      e.preventDefault();
      addFrom(text);
    }
  });

  draw();
  return {
    commit,
    element: h('div', { class: 'field' }, heading,
      h('div', { class: 'adder' }, input,
        h('button', { type: 'button', onclick: () => { commit(); input.focus(); } }, 'Добавить'),
        h('button', { type: 'button', onclick: () => pick(() => { draw(); onChange(); }) }, 'Из списка')),
      tags),
  };
}

/** Выбор устройств. Пустой список означает «на всех». */
function devicePicker(selected, network) {
  const self = { id: state.settings.deviceId, name: `${state.settings.deviceName} (это устройство)` };
  const known = [self, ...network.peers];
  for (const id of selected) if (!known.some((d) => d.id === id)) known.push({ id, name: deviceName(id) });
  if (known.length < 2) return null;

  const row = h('div', { class: 'targets', role: 'group', 'aria-labelledby': 'l-targets' });
  const draw = () => {
    const toggle = (device) => h('button', {
      type: 'button',
      'aria-pressed': String(selected.includes(device.id)),
      onclick: () => {
        const index = selected.indexOf(device.id);
        if (index === -1) selected.push(device.id);
        else selected.splice(index, 1);
        draw();
      },
    }, device.name);
    row.replaceChildren(
      h('button', {
        type: 'button',
        'aria-pressed': String(!selected.length),
        onclick: () => { selected.length = 0; draw(); },
      }, 'Все устройства'),
      ...known.map(toggle),
    );
  };
  draw();
  return h('div', { class: 'field' },
    h('span', { class: 'label', id: 'l-targets' }, 'Где показывать'),
    row,
    h('p', { class: 'help' }, 'Выключенное устройство получит мероприятие при следующей связи с любым устройством сети.'));
}

function suggestions(id, values) {
  return h('datalist', { id }, uniqueValues(values).map((value) => h('option', { value })));
}

async function openForm(source = {}) {
  const dialog = $('form');
  const network = await loadDevices();
  const clock = now();
  const start = source.start ?? suggestedStart(clock.time);
  const draft = {
    id: source.id ?? null,
    participants: [...(source.participants ?? [])],
    equipment: [...(source.equipment ?? [])],
    devices: [...(source.devices ?? [])],
    type: source.type ?? 'lesson',
  };

  const field = (label, id, attrs, size = '') => {
    const input = h('input', { id, name: id, ...attrs });
    if (attrs.type === 'date' || attrs.type === 'time') {
      // Палец должен открывать выбор по нажатию на всё поле, а не на значок.
      input.addEventListener('click', () => { try { input.showPicker(); } catch { /* окно уже открыто */ } });
    }
    return h('div', { class: `field ${size}`, 'data-for': id }, h('label', { for: id }, label), input);
  };

  const typeRow = h('div', { class: 'targets', role: 'group', 'aria-labelledby': 'l-type' });
  const drawTypes = () => typeRow.replaceChildren(...EVENT_TYPES.map(([id, label]) => h('button', {
    type: 'button',
    class: `t-${id}`,
    'aria-pressed': String(draft.type === id),
    onclick: () => { draft.type = id; drawTypes(); },
  }, label)));
  drawTypes();
  const typeField = h('div', { class: 'field' }, h('span', { class: 'label', id: 'l-type' }, 'Тип'), typeRow);

  const title = field('Название', 'f-title', { value: source.title ?? '', autocomplete: 'off', maxlength: 200 });
  const date = field('Дата', 'f-date', { type: 'date', value: source.date ?? state.date }, 'third');
  const from = field('Начало', 'f-start', { type: 'time', value: start }, 'third');
  const to = field('Окончание', 'f-end', {
    type: 'time',
    value: source.end ?? fromMinutes(Math.min(toMinutes(start) + 60, 23 * 60 + 55)),
  }, 'third');
  const place = field('Место', 'f-place', { value: source.place ?? '', list: 'd-places', autocomplete: 'off' }, 'half');
  const responsible = field('Ответственный', 'f-responsible', { value: source.responsible ?? '', list: 'd-people', autocomplete: 'off' }, 'half');
  const responsibleInput = responsible.querySelector('input');
  responsible.append(h('div', { class: 'adder' }, responsibleInput, h('button', {
    type: 'button',
    onclick: () => {
      const selected = responsibleInput.value.trim() ? [responsibleInput.value.trim()] : [];
      openPicker({
        title: 'Ответственный',
        sections: [{ items: refsOf('teacher').map((ref) => ref.name) }],
        selected,
        single: true,
        busy: busyNames('person'),
        empty: 'Список преподавателей пуст. Добавьте их в разделе «Справочники».',
        done: (names) => {
          responsibleInput.value = names[0] ?? '';
          updateConflicts();
        },
      });
    },
  }, 'Из списка')));
  const conflictBox = h('section', { class: 'conflicts', 'aria-live': 'polite', hidden: true });
  const message = h('p', { class: 'message error' });

  const read = () => ({
    id: draft.id,
    type: draft.type,
    title: $('f-title').value.trim(),
    date: $('f-date').value,
    start: $('f-start').value,
    end: $('f-end').value,
    place: $('f-place').value.trim(),
    responsible: $('f-responsible').value.trim(),
    participants: draft.participants,
    equipment: draft.equipment,
    devices: draft.devices,
    notes: $('f-notes').value.trim(),
  });

  const updateConflicts = () => {
    if (!dialog.open) return;
    const found = findConflicts(read(), state.allEvents);
    conflictBox.hidden = !found.length;
    conflictBox.replaceChildren(
      h('h3', {}, 'Уже заняты в это время'),
      h('ul', {}, found.map((c) => h('li', {}, `${c.name}: ${eventLabel(c.event)}`))),
    );
  };

  /** Кто или что уже занято в выбранное время: имя → мероприятие. */
  const busyNames = (kind) => {
    const names = state.directory.map((ref) => ref.name);
    const probe = { ...read(), responsible: '', participants: kind === 'person' ? names : [], equipment: kind === 'equipment' ? names : [] };
    return new Map(findConflicts(probe, state.allEvents).map((c) => [nameKey(c.name), eventLabel(c.event)]));
  };

  const pickInto = (values, config) => (changed) => openPicker({
    ...config,
    selected: values,
    done: (names) => {
      values.splice(0, values.length, ...names);
      changed();
    },
  });

  const participants = listInput('Участники', 'd-people', 'f-participants',
    'Фамилия и имя, можно вставить список из таблицы', draft.participants, updateConflicts,
    (changed) => pickInto(draft.participants, {
      title: 'Студенты',
      sections: [
        ...refsOf('group').map((group) => ({
          name: group.name,
          items: refsOf('student').filter((s) => s.groupId === group.id).map((s) => s.name),
        })),
      ],
      busy: busyNames('person'),
      empty: 'Список студентов пуст. Добавьте группы и студентов в разделе «Справочники».',
    })(changed));
  const equipment = listInput('Техника', 'd-equipment', 'f-equipment',
    'Например, проектор', draft.equipment, updateConflicts,
    (changed) => pickInto(draft.equipment, {
      title: 'Техника',
      sections: [{ items: refsOf('equipment').map((ref) => ref.name) }],
      busy: busyNames('equipment'),
      empty: 'Список техники пуст. Добавьте её в разделе «Справочники».',
    })(changed));

  const targets = devicePicker(draft.devices, network);

  const setInvalid = (wrapper, text) => {
    wrapper.classList.toggle('invalid', Boolean(text));
    wrapper.querySelector('.error')?.remove();
    if (text) wrapper.append(h('p', { class: 'error' }, text));
  };

  const validate = (event) => {
    const titleError = event.title ? '' : 'Укажите название';
    const timeError = event.start && event.end && event.start < event.end ? '' : 'Окончание должно быть позже начала';
    const dateError = event.date ? '' : 'Укажите дату';
    setInvalid(title, titleError);
    setInvalid(to, timeError);
    setInvalid(date, dateError);
    return !(titleError || timeError || dateError);
  };

  const save = h('button', { class: 'primary', type: 'submit' }, source.id ? 'Сохранить' : 'Добавить событие');

  const form = h('form', {
    novalidate: true,
    class: 'sheetform',
    oninput: () => {
      updateConflicts();
      if (form.querySelector('.invalid')) validate(read());
    },
    onsubmit: async (e) => {
      e.preventDefault();
      participants.commit();
      equipment.commit();
      const event = read();
      if (!validate(event)) return;
      save.disabled = true;
      message.textContent = '';
      const result = await api.save(event, source.updatedAt ?? null);
      save.disabled = false;
      if (!result.ok) {
        message.textContent = storeMessage(result);
        return;
      }
      setEvents([...state.allEvents.filter((x) => x.id !== result.value.id), result.value]);
      state.date = result.value.date;
      dialog.close();
      render();
      if (event.devices.length) toast(`Событие отправлено: ${event.devices.map(deviceName).join(', ')}`);
    },
  },
    h('div', { class: 'sheetbody' },
      h('div', { class: 'fields' },
        typeField, title, date, from, to, place, responsible, targets,
        participants.element, equipment.element, conflictBox,
        h('div', { class: 'field' },
          h('label', { for: 'f-notes' }, 'Примечание'),
          h('textarea', { id: 'f-notes', maxlength: 2000 }, source.notes ?? ''))),
      suggestions('d-people', [...refsOf('teacher'), ...refsOf('student')].map((ref) => ref.name)
        .concat(state.allEvents.flatMap((e) => [e.responsible, ...e.participants]))),
      suggestions('d-equipment', refsOf('equipment').map((ref) => ref.name)
        .concat(state.allEvents.flatMap((e) => e.equipment))),
      suggestions('d-places', state.allEvents.map((e) => e.place))),
    h('div', { class: 'sheetfoot' }, save, message));

  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, source.id ? 'Изменить событие' : 'Новое событие'), closeButton(dialog)),
    form,
  );
  dialog.showModal();
  updateConflicts();
  if (!source.id) $('f-title').focus();
}

/* Выбор из списка */

/**
 * Окно выбора. Значения, введённые в форме вручную, остаются нетронутыми:
 * окно меняет только то, что есть в его списке.
 */
function openPicker({ title, sections, selected, single = false, busy = new Map(), empty, done }) {
  const dialog = $('picker');
  const chosen = new Set(selected.map(nameKey));
  const listed = new Map(sections.flatMap((section) => section.items).map((name) => [nameKey(name), name]));
  const opened = new Set();
  const search = h('input', { id: 'p-search', type: 'search', placeholder: 'Поиск', autocomplete: 'off', 'aria-label': 'Поиск' });
  const list = h('div', { class: 'picklist' });
  const confirm = h('button', { class: 'primary', type: 'button', onclick: finish });

  function finish() {
    const manual = selected.filter((name) => !listed.has(nameKey(name)));
    const picked = [...listed].filter(([key]) => chosen.has(key)).map(([, name]) => name);
    const kept = selected.filter((name) => listed.has(nameKey(name)) && chosen.has(nameKey(name)));
    const added = picked.filter((name) => !kept.some((k) => nameKey(k) === nameKey(name)));
    dialog.close();
    done([...manual, ...kept, ...added]);
  }

  const row = (name) => {
    const key = nameKey(name);
    const note = busy.get(key);
    return h('button', {
      type: 'button',
      class: 'pickrow',
      'aria-pressed': String(chosen.has(key)),
      onclick: () => {
        if (single) {
          chosen.clear();
          chosen.add(key);
          finish();
          return;
        }
        if (chosen.has(key)) chosen.delete(key);
        else chosen.add(key);
        draw();
      },
    }, h('strong', {}, name), note && h('span', {}, `Занято: ${note}`));
  };

  function draw() {
    const query = nameKey(search.value);
    const rows = [];
    for (const section of sections) {
      const items = section.items.filter((name) => !query || nameKey(name).includes(query));
      if (!items.length && (query || !section.name)) continue;
      if (section.name) {
        const count = section.items.filter((name) => chosen.has(nameKey(name))).length;
        const all = section.items.length > 0 && count === section.items.length;
        const open = query || opened.has(section.name);
        rows.push(h('div', { class: 'pickgroup' },
          h('button', {
            type: 'button',
            class: 'grouptoggle',
            'aria-expanded': String(Boolean(open)),
            onclick: () => {
              if (opened.has(section.name)) opened.delete(section.name);
              else opened.add(section.name);
              draw();
            },
          }, h('strong', {}, section.name), h('span', {}, `выбрано ${count} из ${section.items.length}`)),
          section.items.length > 0 && h('button', {
            type: 'button',
            class: 'plain',
            onclick: () => {
              for (const name of section.items) {
                if (all) chosen.delete(nameKey(name));
                else chosen.add(nameKey(name));
              }
              draw();
            },
          }, all ? 'Снять всех' : 'Всю группу')));
        if (open) rows.push(...items.map(row));
      } else {
        rows.push(...items.map(row));
      }
    }
    list.replaceChildren(...(rows.length ? rows : [h('p', { class: 'help' }, listed.size || sections.length ? 'Ничего не найдено.' : empty)]));
    confirm.textContent = `Готово: выбрано ${[...chosen].filter((key) => listed.has(key)).length}`;
  }

  search.addEventListener('input', draw);
  draw();
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, title), closeButton(dialog)),
    h('div', { class: 'sheetbody' }, h('div', { class: 'field' }, search), list),
    !single && h('div', { class: 'sheetfoot' }, confirm),
  );
  dialog.showModal();
}

/* Справочники */

const catalog = { tab: 'groups', groupId: null, editing: null, confirming: null, message: '' };

const CATALOG_TABS = [
  ['groups', 'Группы и студенты'],
  ['equipment', 'Техника'],
  ['teacher', 'Преподаватели'],
];

async function commitCatalog(result) {
  catalog.message = result.ok ? catalog.message : storeMessage(result);
  catalog.editing = null;
  catalog.confirming = null;
  const fresh = await api.directory();
  if (fresh.ok) state.directory = fresh.value;
  drawCatalog();
}

/** Добавляет имена, пропуская те, что уже есть, и сообщает о пропущенных. */
async function addRefs(text, kind, existing, extra = {}) {
  const known = new Set(existing.map((ref) => nameKey(ref.name)));
  const fresh = [];
  const repeated = [];
  for (const name of splitNames(text)) {
    if (known.has(nameKey(name))) {
      repeated.push(name);
    } else {
      known.add(nameKey(name));
      fresh.push({ ref: { kind, name, ...extra }, base: null });
    }
  }
  catalog.message = repeated.length ? `Уже есть в списке: ${repeated.join(', ')}` : '';
  if (fresh.length) await commitCatalog(await api.saveRefs(fresh));
  else drawCatalog();
}

function addForm(id, placeholder, onAdd) {
  const input = h('input', { id, placeholder, autocomplete: 'off', 'aria-label': placeholder });
  const submit = async () => {
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    await onAdd(text);
    $(id)?.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (/[\r\n]/.test(text.trim())) {
      e.preventDefault();
      input.value = '';
      onAdd(text);
    }
  });
  return h('div', { class: 'field' }, h('div', { class: 'adder' }, input, h('button', { type: 'button', onclick: submit }, 'Добавить')));
}

function refRow(ref, { confirmText = 'Удалить из списка?', removals = () => [ref], open = null, active = false, detail = null } = {}) {
  if (catalog.editing === ref.id) {
    const input = h('input', { id: 'c-edit', value: ref.name, autocomplete: 'off', 'aria-label': 'Название' });
    const groups = refsOf('group');
    const move = ref.kind === 'student'
      ? h('select', { id: 'c-group', 'aria-label': 'Группа' }, groups.map((g) => h('option', { value: g.id, selected: g.id === ref.groupId }, g.name)))
      : null;
    return h('li', { class: 'refrow editing' }, input, move,
      h('button', {
        type: 'button',
        class: 'primary',
        onclick: async () => {
          const name = input.value.trim();
          if (!name) return;
          catalog.message = '';
          await commitCatalog(await api.saveRefs([{
            ref: { ...ref, name, ...(move ? { groupId: move.value } : {}) },
            base: ref.updatedAt,
          }]));
        },
      }, 'Сохранить'),
      h('button', { type: 'button', class: 'plain', onclick: () => { catalog.editing = null; drawCatalog(); } }, 'Отмена'));
  }
  if (catalog.confirming === ref.id) {
    return h('li', { class: 'refrow' }, h('p', { class: 'refname' }, confirmText),
      h('button', {
        type: 'button',
        class: 'danger',
        onclick: async () => {
          catalog.message = '';
          if (catalog.groupId === ref.id) catalog.groupId = null;
          await commitCatalog(await api.removeRefs(removals().map((r) => ({ id: r.id, base: r.updatedAt }))));
        },
      }, 'Удалить'),
      h('button', { type: 'button', class: 'plain', onclick: () => { catalog.confirming = null; drawCatalog(); } }, 'Оставить'));
  }
  const label = open
    ? h('button', { type: 'button', class: 'refname link', 'aria-pressed': String(active), onclick: open }, h('strong', {}, ref.name), detail && h('span', {}, detail))
    : h('p', { class: 'refname' }, ref.name);
  return h('li', { class: 'refrow' }, label,
    h('button', { type: 'button', class: 'plain', onclick: () => { catalog.editing = ref.id; catalog.confirming = null; drawCatalog(); } }, 'Изменить'),
    h('button', { type: 'button', class: 'plain', onclick: () => { catalog.confirming = ref.id; catalog.editing = null; drawCatalog(); } }, 'Удалить'));
}

function refList(rows, emptyText) {
  return rows.length ? h('ul', { class: 'reflist' }, rows) : h('p', { class: 'help' }, emptyText);
}

function groupsPane() {
  const groups = refsOf('group');
  const students = refsOf('student');
  if (!groups.some((g) => g.id === catalog.groupId)) catalog.groupId = groups[0]?.id ?? null;
  const current = groups.find((g) => g.id === catalog.groupId);
  const members = students.filter((s) => s.groupId === catalog.groupId);
  const count = (group) => students.filter((s) => s.groupId === group.id).length;

  return h('div', { class: 'catalogcols' },
    h('section', {},
      h('h3', {}, 'Группы'),
      addForm('c-add-group', 'Название группы', (text) => addRefs(text, 'group', groups)),
      refList(groups.map((group) => refRow(group, {
        confirmText: `Удалить группу и студентов: ${count(group)}?`,
        removals: () => [group, ...students.filter((s) => s.groupId === group.id)],
        open: () => { catalog.groupId = group.id; catalog.message = ''; drawCatalog(); },
        active: group.id === catalog.groupId,
        detail: `${count(group)} ${plural(count(group), 'студент', 'студента', 'студентов')}`,
      })), 'Добавьте первую группу.')),
    h('section', {},
      h('h3', {}, current ? `Студенты группы ${current.name}` : 'Студенты'),
      current
        ? [
          addForm('c-add-student', 'Фамилия и имя или столбец из таблицы',
            (text) => addRefs(text, 'student', members, { groupId: current.id })),
          refList(members.map((student) => refRow(student)), 'В группе пока нет студентов.'),
        ]
        : h('p', { class: 'help' }, 'Сначала добавьте группу.')));
}

function simplePane(kind, placeholder, emptyText) {
  const items = refsOf(kind);
  return h('section', {},
    addForm(`c-add-${kind}`, placeholder, (text) => addRefs(text, kind, items)),
    refList(items.map((item) => refRow(item)), emptyText));
}

function drawCatalog() {
  const dialog = $('catalog');
  const pane = catalog.tab === 'groups'
    ? groupsPane()
    : catalog.tab === 'equipment'
      ? simplePane('equipment', 'Название или столбец из таблицы', 'Добавьте технику, чтобы выбирать её в мероприятиях.')
      : simplePane('teacher', 'Фамилия и инициалы или столбец из таблицы', 'Добавьте преподавателей, чтобы выбирать ответственных.');
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, 'Справочники'), closeButton(dialog)),
    h('div', { class: 'tabs', role: 'group', 'aria-label': 'Раздел справочников' }, CATALOG_TABS.map(([tab, label]) =>
      h('button', {
        type: 'button',
        'aria-pressed': String(catalog.tab === tab),
        onclick: () => {
          Object.assign(catalog, { tab, editing: null, confirming: null, message: '' });
          drawCatalog();
        },
      }, label))),
    h('div', { class: 'sheetbody' }, catalog.message && h('p', { class: 'notice' }, catalog.message), pane),
  );
  $('c-edit')?.focus();
}

/* Отметка на паре */

const clockTime = (at) => new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

function rowNote(row) {
  if (row.status === 'present') {
    return `Отмечен в ${clockTime(row.at)}${row.late ? `, опоздание ${row.late} мин` : ''}`;
  }
  return row.status === 'pending' ? 'Нажмите на имя, чтобы отметиться' : statusName(row.status);
}

function openRoll(id) {
  const dialog = $('roll');
  const event = state.allEvents.find((e) => e.id === id);
  if (!event) return;
  const search = h('input', { id: 'r-search', type: 'search', placeholder: 'Поиск по фамилии', autocomplete: 'off', 'aria-label': 'Поиск по фамилии' });
  const summary = h('p', { class: 'rollsummary', role: 'status' });
  const list = h('ul', { class: 'rolllist' });
  const failure = h('p', { class: 'error' });

  const setMark = async (name, status) => {
    const result = await api.mark(event.id, name, status);
    failure.textContent = result.ok ? '' : 'Отметка не сохранена. Попробуйте ещё раз.';
    if (result.ok) {
      state.attendance = [...state.attendance.filter((doc) => doc.eventId !== event.id), result.value];
      draw();
    }
  };

  function draw() {
    const rows = roll(event);
    const count = (status) => rows.filter((row) => row.status === status).length;
    const parts = [
      `Отмечены: ${count('present')} из ${rows.length}`,
      `с опозданием: ${rows.filter((row) => row.late).length}`,
      ...ABSENCE_REASONS.map(([reason, label]) => `${label.toLowerCase()}: ${count(reason)}`),
    ];
    summary.textContent = parts.join(', ');
    const query = nameKey(search.value);
    list.replaceChildren(...rows.filter((row) => !query || nameKey(row.name).includes(query)).map((row) =>
      h('li', { class: 'rollrow' },
        h('button', {
          type: 'button',
          class: 'rollname',
          'aria-pressed': String(row.status === 'present'),
          onclick: () => setMark(row.name, row.status === 'present' ? null : 'present'),
        }, h('strong', {}, row.name), h('span', { class: row.late ? 'late' : '' }, rowNote(row))),
        ...ABSENCE_REASONS.map(([reason, label]) => h('button', {
          type: 'button',
          class: 'reason',
          'aria-pressed': String(row.status === reason),
          onclick: () => setMark(row.name, row.status === reason ? null : reason),
        }, label)))));
  }

  search.addEventListener('input', draw);
  redrawRoll = draw;
  draw();
  dialog.replaceChildren(
    h('div', { class: 'sheethead' },
      h('div', {},
        h('h2', {}, event.title),
        h('p', { class: 'help' }, `${typeName(event.type)}, ${fmt(event.date, { day: 'numeric', month: 'long' })}, ${timeRange(event)}`)),
      closeButton(dialog)),
    h('div', { class: 'sheetbody' }, summary, failure, h('div', { class: 'field' }, search), list),
  );
  dialog.showModal();
}

/* Отчёты */

const TYPE_FILTERS = [
  ['classes', 'Все пары', ['lesson', 'practice', 'task']],
  ...EVENT_TYPES.map(([id, label]) => [id, label, [id]]),
  ['all', 'Всё, включая мероприятия', EVENT_TYPES.map(([id]) => id)],
];

const reports = { tab: 'pairs', from: '', to: '', type: 'classes', group: '', teacher: '' };

const shownPercent = (value) => (value === null ? 'нет данных' : `${value}%`);
const shortDate = (iso) => iso.split('-').reverse().join('.');

const COUNTS = [
  ['Были', (r) => r.present],
  ['Опоздали', (r) => r.late],
  ['Болезнь', (r) => r.sick],
  ['По приказу', (r) => r.order],
  ['Уважительная', (r) => r.excused],
  ['Без причины', (r) => r.absent],
  ['%', (r) => shownPercent(r.percent)],
];

const REPORT_TABS = [
  ['pairs', 'Проведённые пары', 'Пары', [
    ['Дата', (r) => shortDate(r.event.date)],
    ['Время', (r) => timeRange(r.event)],
    ['Тип', (r) => typeName(r.event.type)],
    ['Название', (r) => r.event.title],
    ['Преподаватель', (r) => r.event.responsible],
    ['Группы', (r) => r.groups.join(', ')],
    ['Место', (r) => r.event.place],
    ['Всего', (r) => r.total],
    ...COUNTS,
  ]],
  ['students', 'Посещаемость студентов', 'Студенты', [
    ['Группа', (r) => r.group],
    ['Студент', (r) => r.name],
    ['Пар', (r) => r.total],
    ...COUNTS,
  ]],
  ['groups', 'По группам', 'Группы', [
    ['Группа', (r) => r.name],
    ['Всего мест', (r) => r.total],
    ...COUNTS,
  ]],
];

function currentReport() {
  const clock = now();
  return buildReport({
    events: state.allEvents,
    attendance: state.attendance,
    students: refsOf('student'),
    groups: refsOf('group'),
    filters: {
      from: reports.from,
      to: reports.to,
      types: TYPE_FILTERS.find(([id]) => id === reports.type)[2],
      group: reports.group,
      teacher: reports.teacher,
    },
    nowISO: clock.iso,
    nowTime: clock.time,
  });
}

function reportSummary(report) {
  const total = report.pairs.reduce((sum, pair) => sum + pair.total, 0);
  const present = report.pairs.reduce((sum, pair) => sum + pair.present, 0);
  const pairs = report.pairs.length;
  const label = `Проведено: ${pairs} ${plural(pairs, 'пара', 'пары', 'пар')}`;
  return total ? `${label}. Посещаемость: ${Math.round((present / total) * 100)}%` : label;
}

function drawReportResult(box) {
  const report = currentReport();
  const [tab, , , columns] = REPORT_TABS.find(([id]) => id === reports.tab);
  const rows = report[tab];
  box.replaceChildren(
    h('p', { class: 'rollsummary', id: 'report-summary' }, reportSummary(report)),
    rows.length
      ? h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, columns.map(([name]) => h('th', { scope: 'col' }, name)))),
        h('tbody', {}, rows.map((row) => h('tr', {}, columns.map(([, value]) => h('td', {}, String(value(row) ?? ''))))))))
      : h('p', { class: 'help' }, 'За этот период проведённых пар нет. Измените период или условия отбора.'),
  );
}

async function exportReport() {
  const report = currentReport();
  const [tab, , fileName, columns] = REPORT_TABS.find(([id]) => id === reports.tab);
  const csv = toCsv(columns.map(([name]) => name), report[tab].map((row) => columns.map(([, value]) => value(row))));
  const result = await api.saveReport(`${fileName} ${reports.from} ${reports.to}.csv`, csv);
  if (!result.ok) toast('Отчёт не сохранён: нет доступа к выбранной папке.');
  else if (result.value) toast('Отчёт сохранён.');
}

function openReports() {
  const dialog = $('reports');
  const clock = now();
  reports.from = `${clock.iso.slice(0, 8)}01`;
  reports.to = clock.iso;
  const result = h('div', { class: 'reportresult' });
  const refresh = () => drawReportResult(result);

  const dateField = (id, label, key) => {
    const input = h('input', { id, type: 'date', value: reports[key] });
    input.addEventListener('change', () => { if (input.value) { reports[key] = input.value; refresh(); } });
    input.addEventListener('click', () => { try { input.showPicker(); } catch { /* окно уже открыто */ } });
    return h('div', { class: 'field' }, h('label', { for: id }, label), input);
  };

  const selectField = (id, label, key, options) => {
    const select = h('select', { id }, options.map(([value, text]) => h('option', { value, selected: reports[key] === value }, text)));
    select.addEventListener('change', () => { reports[key] = select.value; refresh(); });
    return h('div', { class: 'field' }, h('label', { for: id }, label), select);
  };

  const teachers = uniqueValues([...refsOf('teacher').map((t) => t.name), ...state.allEvents.map((e) => e.responsible)]);
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Вид отчёта' });
  const drawTabs = () => tabs.replaceChildren(...REPORT_TABS.map(([id, label]) => h('button', {
    type: 'button',
    'aria-pressed': String(reports.tab === id),
    onclick: () => { reports.tab = id; drawTabs(); refresh(); },
  }, label)));
  drawTabs();
  refresh();

  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, 'Отчёты'), closeButton(dialog)),
    tabs,
    h('div', { class: 'reportfilters' },
      dateField('rp-from', 'С', 'from'),
      dateField('rp-to', 'По', 'to'),
      selectField('rp-type', 'Что считать', 'type', TYPE_FILTERS.map(([id, label]) => [id, label])),
      selectField('rp-group', 'Группа', 'group', [['', 'Все группы'], ...refsOf('group').map((g) => [g.name, g.name])]),
      selectField('rp-teacher', 'Преподаватель', 'teacher', [['', 'Все преподаватели'], ...teachers.map((t) => [t, t])])),
    h('div', { class: 'sheetbody' }, result),
    h('div', { class: 'sheetfoot' }, h('button', { class: 'primary', type: 'button', onclick: exportReport }, 'Сохранить для Excel')),
  );
  dialog.showModal();
}

/* Настройки */

const PROBLEMS = {
  'port-busy': 'Обмен работает в другой учётной записи на этом компьютере.',
  failed: 'Обмен не запустился. Перезапустите программу.',
};

const STATUS = {
  'wrong-key': 'Другой ключ сети',
  outdated: 'Старая версия программы, обмен приостановлен',
  offline: 'Нет связи',
  unknown: 'Связи ещё не было',
};

function peerStatus(peer) {
  const last = peer.lastSync
    ? new Date(peer.lastSync).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : null;
  if (peer.status === 'ok') return `На связи, обмен ${last}`;
  return last && peer.status !== 'wrong-key' ? `${STATUS[peer.status]}, последний обмен ${last}` : STATUS[peer.status];
}

function deviceList(status) {
  if (!status.enabled) {
    return [h('p', { class: 'help' }, PROBLEMS[status.problem] ?? 'Введите ключ сети, чтобы включить обмен.')];
  }
  const rows = [
    ...status.peers.map((peer) => h('li', {}, h('strong', {}, peer.name), h('span', {}, peerStatus(peer)))),
    ...status.unreachable.map((peer) => h('li', {}, h('strong', {}, peer.address), h('span', {}, STATUS[peer.status] ?? 'Нет связи'))),
  ];
  return [
    h('p', { class: 'help' }, `Адрес этого устройства: ${status.addresses.join(', ') || 'нет подключения к сети'}`),
    rows.length ? h('ul', { class: 'devices' }, rows) : h('p', { class: 'help' }, 'Других устройств пока не найдено.'),
  ];
}

function updateText(status) {
  if (!status) return 'Обновления ещё не проверялись.';
  const when = new Date(status.checkedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  if (status.result === 'installed') return `Обновление до версии ${status.latest} установлено ${when}.`;
  if (status.result === 'up-to-date') return `Последняя проверка обновлений: ${when}. Установлена новейшая версия.`;
  return `Обновления не удалось проверить ${when}. Нужен доступ к github.com. Следующая попытка пройдёт сама.`;
}

async function openSettings() {
  const dialog = $('preferences');
  const current = await api.getSettings();
  const name = h('input', { id: 's-name', value: current.deviceName, autocomplete: 'off', maxlength: 60 });
  const key = h('input', { id: 's-key', value: current.syncKey, spellcheck: 'false', autocomplete: 'off' });
  const peers = h('input', { id: 's-peers', value: current.peers.join(', '), spellcheck: 'false', autocomplete: 'off' });
  const showAll = h('input', { id: 's-all', type: 'checkbox', checked: current.showAll });
  const fullscreen = h('input', { id: 's-fullscreen', type: 'checkbox', checked: current.fullscreen });
  const message = h('p', { class: 'message error' });
  const devices = h('div', { id: 's-devices' });
  const drawDevices = async () => devices.replaceChildren(...deviceList(await api.syncStatus()));
  await drawDevices();

  const form = h('form', {
    class: 'sheetform',
    onsubmit: async (e) => {
      e.preventDefault();
      const result = await api.saveSettings({
        deviceName: name.value,
        syncKey: key.value,
        peers: peers.value,
        showAll: showAll.checked,
        fullscreen: fullscreen.checked,
      });
      if (!result.ok) {
        message.textContent = result.code === 'invalid' ? result.message : 'Настройки не сохранены: нет доступа к файлу настроек.';
        return;
      }
      state.settings = await api.getSettings();
      setEvents(state.allEvents);
      dialog.close();
      render();
      refresh();
    },
  },
    h('div', { class: 'sheetbody' },
      h('div', { class: 'setting field' },
        h('label', { for: 's-name' }, 'Название устройства'),
        name,
        h('p', { class: 'help' }, 'Например, «Ауд. 204» или «Кабинет Лебедевой». Его увидят на других устройствах.')),
      h('div', { class: 'setting field' },
        h('label', { for: 's-key' }, 'Ключ сети'),
        h('div', { class: 'adder' }, key, h('button', {
          type: 'button',
          onclick: async () => { key.value = await api.generateKey(); },
        }, 'Создать')),
        h('p', { class: 'help' }, 'Создайте ключ на одном устройстве и введите такой же на остальных. Устройства с разными ключами не видят друг друга.')),
      h('div', { class: 'setting field' },
        h('label', { for: 's-peers' }, 'Адреса устройств в других сетях'),
        peers,
        h('p', { class: 'help' }, 'Нужны, только если устройства не находят друг друга сами, например 10.0.2.15, 10.0.3.7. Достаточно одного адреса: остальные передадутся автоматически.')),
      h('div', { class: 'setting' },
        h('label', { class: 'check' }, showAll, 'Показывать мероприятия всех устройств'),
        h('p', { class: 'help' }, 'Включите на компьютерах преподавателей.'),
        h('label', { class: 'check' }, fullscreen, 'Открывать на весь экран')),
      h('section', { class: 'setting' },
        h('div', { class: 'grouphead' },
          h('h3', {}, 'Устройства в сети'),
          h('button', {
            type: 'button',
            class: 'plain',
            onclick: async (e) => {
              const button = e.currentTarget;
              button.disabled = true;
              await api.syncNow();
              await drawDevices();
              await refresh();
              button.disabled = false;
            },
          }, 'Обменяться сейчас')),
        devices),
      h('p', { class: 'help' }, `Версия ${current.version}`),
      h('p', { class: 'help', id: 's-update' }, updateText(await api.updateStatus()))),
    h('div', { class: 'sheetfoot' }, h('button', { class: 'primary', type: 'submit' }, 'Сохранить настройки'), message));

  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, 'Настройки'), closeButton(dialog)),
    form,
  );
  dialog.showModal();
}

/* Часы и фоновая работа */

function tick() {
  const clock = now();
  $('clock').textContent = clock.time;
  $('clock').dateTime = clock.time;
  // На следующий день панель должна сама перейти на него.
  if (clock.iso !== state.today) {
    if (state.date === state.today) state.date = clock.iso;
    state.today = clock.iso;
  }
  if (clock.time !== state.renderedMinute) render();
  if (Date.now() - state.lastActivity > IDLE_MS) resetIdle();
}

/** Панель общая: после паузы возвращается к текущей неделе. */
function resetIdle() {
  state.lastActivity = Date.now();
  if (['form', 'preferences', 'catalog', 'roll', 'reports'].some((id) => $(id).open)) return;
  if ($('details').open) $('details').close();
  state.view = 'week';
  state.date = now().iso;
  render();
}

function wire() {
  $('prev').addEventListener('click', () => move(-1));
  $('next').addEventListener('click', () => move(1));
  $('today').addEventListener('click', () => { state.date = now().iso; render(); });
  $('add').addEventListener('click', () => openForm());
  $('settings').addEventListener('click', openSettings);
  $('open-reports').addEventListener('click', openReports);
  $('open-catalog').addEventListener('click', () => {
    catalog.message = '';
    drawCatalog();
    $('catalog').showModal();
  });
  $('minimize').addEventListener('click', () => api.minimize());
  for (const button of document.querySelectorAll('.views button')) {
    button.addEventListener('click', () => { state.view = button.dataset.view; render(); });
  }
  window.addEventListener('resize', render);
  $('details').addEventListener('click', (e) => { if (e.target === $('details')) $('details').close(); });
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, () => { state.lastActivity = Date.now(); }, { passive: true });
  }
}

async function start() {
  wire();
  state.settings = await api.getSettings();
  api.onChanged(refresh);
  render();
  tick();
  await refresh();
}

start();
setInterval(tick, 1000);
setInterval(refresh, POLL_MS);
