import {
  addDays, addMonths, eventState, eventsOn, findConflicts, fromISO, fromMinutes, hourRange, layoutDay,
  monthWeeks, plural, splitList, suggestedStart, toISO, toMinutes, uniqueValues, weekDays,
} from './logic.mjs';

const POLL_MS = 10_000;
const IDLE_MS = 5 * 60_000;
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const $ = (id) => document.getElementById(id);
const api = window.calendar;

const state = {
  view: 'week',
  date: toISO(new Date()),
  events: [],
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

/** Меловой контур вокруг числа: рисуется от руки и с небольшим нахлёстом. */
function chalkCircle() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M62 7C34 1 8 17 6 48c-2 32 27 48 53 44 26-4 39-27 34-49C88 19 64 5 38 10');
  svg.append(path);
  return svg;
}

function dayNumber(iso, isToday) {
  const text = String(fromISO(iso).getDate());
  return isToday ? h('span', { class: 'circled' }, text, chalkCircle()) : h('span', {}, text);
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
    if (event.responsible) details.push(h('span', {}, `Ответственный: ${event.responsible}`));
    if (event.participants.length) details.push(h('span', {}, peopleCount(event.participants.length)));
    if (event.equipment.length) details.push(h('span', {}, `Техника: ${event.equipment.join(', ')}`));
  } else if (event.participants.length) {
    details.push(h('span', {}, peopleCount(event.participants.length)));
  }
  const block = h('button', {
    class: `block ${status}${!dayView && columns > 1 ? ' narrow' : ''}`,
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
        class: `chip ${eventState(e, clock.iso, clock.time)}`,
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
  const changed = result.ok && JSON.stringify(result.value) !== JSON.stringify(state.events);
  if (changed) state.events = result.value;
  const bannerChanged = error !== state.storageError;
  if (bannerChanged) {
    state.storageError = error;
    const banner = $('banner');
    banner.hidden = !error;
    if (error) {
      const { dataDir } = await api.getSettings();
      banner.textContent = `Нет доступа к папке с мероприятиями (${dataDir}). На экране последние загруженные данные, сохранить изменения пока нельзя. Программа подключится сама, как только папка станет доступна.`;
    }
  }
  if (changed || bannerChanged) render();
}

const storeMessage = (result) => (result.code === 'conflict'
  ? 'Это мероприятие уже изменили или удалили на другой панели. Закройте окно и откройте его заново.'
  : result.code === 'invalid'
    ? result.message
    : 'Не удалось сохранить: нет доступа к папке с мероприятиями. Попробуйте ещё раз.');

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

function showDetails(id) {
  const event = state.events.find((e) => e.id === id);
  if (!event) return;
  const dialog = $('details');
  const footer = h('div', { class: 'sheetfoot' });

  const showActions = () => footer.replaceChildren(
    h('button', { class: 'primary', onclick: () => { dialog.close(); openForm(event); } }, 'Изменить'),
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
          state.events = state.events.filter((e) => e.id !== event.id);
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
        fact('Дата', fmt(event.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(/ г\.$/, '')),
        fact('Время', timeRange(event)),
        fact('Место', event.place),
        fact('Ответственный', event.responsible || 'Не указан')),
      listGroup(`Участники: ${event.participants.length}`, event.participants, true),
      listGroup('Техника', event.equipment, false),
      event.notes && h('section', { class: 'group' }, h('h3', {}, 'Примечание'), h('p', { class: 'notes' }, event.notes))),
    footer,
  );
  dialog.showModal();
}

/* Форма мероприятия */

function listInput(label, listId, inputId, placeholder, values, onChange) {
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
      h('div', { class: 'adder' }, input, h('button', { type: 'button', onclick: () => { commit(); input.focus(); } }, 'Добавить')),
      tags),
  };
}

function suggestions(id, values) {
  return h('datalist', { id }, uniqueValues(values).map((value) => h('option', { value })));
}

function openForm(source = {}) {
  const dialog = $('form');
  const clock = now();
  const start = source.start ?? suggestedStart(clock.time);
  const draft = {
    id: source.id ?? null,
    participants: [...(source.participants ?? [])],
    equipment: [...(source.equipment ?? [])],
  };

  const field = (label, id, attrs, size = '') => {
    const input = h('input', { id, name: id, ...attrs });
    if (attrs.type === 'date' || attrs.type === 'time') {
      // Палец должен открывать выбор по нажатию на всё поле, а не на значок.
      input.addEventListener('click', () => { try { input.showPicker(); } catch { /* окно уже открыто */ } });
    }
    return h('div', { class: `field ${size}`, 'data-for': id }, h('label', { for: id }, label), input);
  };

  const title = field('Название', 'f-title', { value: source.title ?? '', autocomplete: 'off', maxlength: 200 });
  const date = field('Дата', 'f-date', { type: 'date', value: source.date ?? state.date }, 'third');
  const from = field('Начало', 'f-start', { type: 'time', value: start }, 'third');
  const to = field('Окончание', 'f-end', {
    type: 'time',
    value: source.end ?? fromMinutes(Math.min(toMinutes(start) + 60, 23 * 60 + 55)),
  }, 'third');
  const place = field('Место', 'f-place', { value: source.place ?? '', list: 'd-places', autocomplete: 'off' }, 'half');
  const responsible = field('Ответственный', 'f-responsible', { value: source.responsible ?? '', list: 'd-people', autocomplete: 'off' }, 'half');
  const conflictBox = h('section', { class: 'conflicts', 'aria-live': 'polite', hidden: true });
  const message = h('p', { class: 'message error' });

  const read = () => ({
    id: draft.id,
    title: $('f-title').value.trim(),
    date: $('f-date').value,
    start: $('f-start').value,
    end: $('f-end').value,
    place: $('f-place').value.trim(),
    responsible: $('f-responsible').value.trim(),
    participants: draft.participants,
    equipment: draft.equipment,
    notes: $('f-notes').value.trim(),
  });

  const updateConflicts = () => {
    if (!dialog.open) return;
    const found = findConflicts(read(), state.events);
    conflictBox.hidden = !found.length;
    conflictBox.replaceChildren(
      h('h3', {}, 'Уже заняты в это время'),
      h('ul', {}, found.map((c) => h('li', {}, `${c.name}: ${eventLabel(c.event)}`))),
    );
  };

  const participants = listInput('Участники', 'd-people', 'f-participants',
    'Фамилия и имя, можно вставить список из таблицы', draft.participants, updateConflicts);
  const equipment = listInput('Техника', 'd-equipment', 'f-equipment',
    'Например, проектор', draft.equipment, updateConflicts);

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

  const save = h('button', { class: 'primary', type: 'submit' }, source.id ? 'Сохранить' : 'Добавить мероприятие');

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
      state.events = [...state.events.filter((x) => x.id !== result.value.id), result.value];
      state.date = result.value.date;
      dialog.close();
      render();
    },
  },
    h('div', { class: 'sheetbody' },
      h('div', { class: 'fields' },
        title, date, from, to, place, responsible,
        participants.element, equipment.element, conflictBox,
        h('div', { class: 'field' },
          h('label', { for: 'f-notes' }, 'Примечание'),
          h('textarea', { id: 'f-notes', maxlength: 2000 }, source.notes ?? ''))),
      suggestions('d-people', state.events.flatMap((e) => [e.responsible, ...e.participants])),
      suggestions('d-equipment', state.events.flatMap((e) => e.equipment)),
      suggestions('d-places', state.events.map((e) => e.place))),
    h('div', { class: 'sheetfoot' }, save, message));

  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, source.id ? 'Изменить мероприятие' : 'Новое мероприятие'), closeButton(dialog)),
    form,
  );
  dialog.showModal();
  updateConflicts();
  if (!source.id) $('f-title').focus();
}

/* Настройки */

async function openSettings() {
  const dialog = $('preferences');
  const current = await api.getSettings();
  const folder = h('input', { id: 's-folder', value: current.dataDir, spellcheck: 'false' });
  const fullscreen = h('input', { id: 's-fullscreen', type: 'checkbox', checked: current.fullscreen });
  const message = h('p', { class: 'message error' });

  const form = h('form', {
    class: 'sheetform',
    onsubmit: async (e) => {
      e.preventDefault();
      const result = await api.saveSettings({ dataDir: folder.value, fullscreen: fullscreen.checked });
      if (!result.ok) {
        message.textContent = `Папка недоступна: ${folder.value.trim() || 'не указана'}. Проверьте путь и права на запись.`;
        return;
      }
      dialog.close();
      state.events = [];
      render();
      refresh();
    },
  },
    h('div', { class: 'sheetbody' },
      h('div', { class: 'setting field' },
        h('label', { for: 's-folder' }, 'Папка с мероприятиями'),
        h('div', { class: 'adder' }, folder, h('button', {
          type: 'button',
          onclick: async () => {
            const picked = await api.pickFolder();
            if (picked) folder.value = picked;
          },
        }, 'Выбрать')),
        h('p', { class: 'help' }, 'Чтобы все панели показывали одно и то же, укажите на каждой одну сетевую папку, например \\\\server\\calendar.')),
      h('div', { class: 'setting' },
        h('label', { class: 'check' }, fullscreen, 'Открывать на весь экран')),
      h('p', { class: 'help' }, `Версия ${current.version}`)),
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
  if ($('form').open || $('preferences').open) return;
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

wire();
render();
tick();
refresh();
setInterval(tick, 1000);
setInterval(refresh, POLL_MS);
