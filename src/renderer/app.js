import { JOURNAL_ACTIONS, JOURNAL_FIELD_LABELS } from './logic.mjs';
import {
  ABSENCE_REASONS, ABSENT_FROM_MINUTE, EVENT_TYPES, STUDY_DAY, isAllDay, MAX_REPEATS, REPEATS, repeatDates, seriesFrom, LATE_FROM_MINUTE, actualStart, countsLateness, startDelay, OWN_CAMERA, activeNotices, addDays, addMonths, buildReport, busyFrom, TEMPLATE_FIELDS, deadlineAlerts, deadlineList, deadlineState, equipmentCount, equipmentLabel, equipmentNow, eventState, eventsOn, findConflicts, freeStock, fromISO, groupMembers, memoApplies, memoData, fromMinutes, hourRange, layoutDay,
  monthWeeks, nameKey, needsMemo, parentGroup, pendingCertificates, parseEquipment, plural, rollCall, shortages, splitList, splitNames, suggestedStart, statusName, toCsv, toISO, toMinutes, typeName, uniqueValues, visibleOn, weekDays,
} from './logic.mjs';

import { petChange, petLook, petPrizes, petSprite, petStatus, PRIZE_DAYS, prizeIcon, PRIZES } from './pet.mjs';
import { LANGUAGES, locale, t, tp, translatePage } from './i18n.mjs';

const POLL_MS = 10_000;
const IDLE_MS = 5 * 60_000;

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

/** Выполняет перерисовку внутри окна, не теряя место в длинном списке. */
function keepScroll(node, work) {
  const box = node.closest('.sheetbody');
  const top = box?.scrollTop;
  work();
  if (box) box.scrollTop = top;
}

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

const fmt = (iso, options) => new Intl.DateTimeFormat(locale(), options).format(fromISO(iso)).replace(/ г\.$/, '');
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// 1 января 2024 — понедельник: неделя всегда начинается с него.
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => capitalize(fmt(`2024-01-0${i + 1}`, { weekday: 'short' })));
const timeRange = (e) => (isAllDay(e) ? t('Весь день, {0}–{1}', [e.start, e.end]) : `${e.start}–${e.end}`);
const peopleCount = (n) => tp('people', n);

function periodTitle() {
  if (state.view === 'day') return capitalize(fmt(state.date, { weekday: 'long', day: 'numeric', month: 'long' }));
  if (state.view === 'month') return capitalize(fmt(state.date, { month: 'long', year: 'numeric' }));
  const days = weekDays(state.date);
  return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', year: 'numeric' })
    .formatRange(fromISO(days[0]), fromISO(days[6])).replace(/ г\.$/, '');
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
  const details = [h('strong', {}, event.title), h('span', {}, timeRange(event) + (dayView && status === 'now' ? t(', идёт сейчас') : ''))];
  if (event.place) details.push(h('span', {}, event.place));
  if (dayView) {
    details.push(h('span', {}, typeLabel(event.type)));
    if (event.prepMinutes) details.push(h('span', {}, t('Подготовка с {0}', [busyFrom(event)])));
    if (event.responsible) details.push(h('span', {}, t('Ответственный: {0}', [event.responsible])));
    if (event.participants.length) details.push(h('span', {}, peopleCount(event.participants.length)));
    if (event.equipment.length) details.push(h('span', {}, t('Техника: {0}', [event.equipment.map((name) => gearLabel(event, name)).join(', ')])));
  } else if (event.participants.length) {
    details.push(h('span', {}, peopleCount(event.participants.length)));
  }
  const excusedCount = roll(event).filter((row) => row.excusedFor).length;
  if (excusedCount) details.splice(2, 0, h('span', { class: 'blockexcused' }, t('По приказу: {0}', [excusedCount])));
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
  const lines = Math.floor(room / parseFloat(getComputedStyle(title).lineHeight));
  title.classList.add('clamped');
  title.style.webkitLineClamp = Math.max(1, lines);
  // Сжатое название наехало бы на время: в совсем низком блоке остаётся только оно.
  if (lines < 1 || overflows()) time.remove();
}

function timeGrid(days, dayView) {
  const clock = now();
  const shown = state.events.filter((e) => days.includes(e.date) && !isAllDay(e));
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
    for (const item of layoutDay(eventsOn(state.events, iso).filter((e) => !isAllDay(e)))) column.append(eventBlock(item, range, dayView));
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
  if (dayView && !eventsOn(state.events, days[0]).length) {
    body.append(h('p', { class: 'hint' }, t('На этот день мероприятий нет. Нажмите на нужное время, чтобы добавить.')));
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
  board.append(head);
  const strip = deadlineStrip(days);
  if (strip) board.append(strip);
  board.append(timeGrid(days, false));
}

const deadlinesOn = (iso) => state.events
  .filter((event) => event.deadline.startsWith(iso) && !event.deadlineDone)
  .sort((a, b) => a.deadline.localeCompare(b.deadline));

function deadlineChip(event) {
  const late = deadlineState(event, moment()) === 'overdue';
  return h('button', {
    class: `chip deadlinechip t-${event.type}${late ? ' overdue' : ''}`,
    onclick: (e) => { e.stopPropagation(); showDetails(event.id); },
  }, t('Сдать до {0}: {1}', [event.deadline.slice(11), event.title]));
}

function allDayChip(event) {
  const clock = now();
  return h('button', {
    class: `chip alldaychip t-${event.type} ${eventState(event, clock.iso, clock.time)}`,
    'aria-label': eventLabel(event),
    onclick: (e) => { e.stopPropagation(); showDetails(event.id); },
  }, event.title);
}

/** События на весь день и сроки не привязаны к часам, поэтому идут полосой над сеткой. */
function deadlineStrip(days) {
  const allDay = days.map((iso) => eventsOn(state.events, iso).filter(isAllDay));
  const perDay = days.map(deadlinesOn);
  if (![...allDay, ...perDay].some((items) => items.length)) return null;
  return h('div', { class: 'deadlinestrip' },
    h('span', { class: 'deadlinegutter' }),
    perDay.map((items, i) => h('div', { class: 'deadlineday' },
      allDay[i].map(allDayChip),
      items.slice(0, 2).map(deadlineChip),
      items.length > 2 && h('button', { class: 'more', onclick: openDeadlines }, t('ещё {0}', [items.length - 2])))));
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
    const items = [
      ...deadlinesOn(iso).map((event) => () => deadlineChip(event)),
      ...eventsOn(state.events, iso).map((e) => () => h('button', {
        class: `chip t-${e.type} ${eventState(e, clock.iso, clock.time)}`,
        onclick: (ev) => { ev.stopPropagation(); showDetails(e.id); },
      }, isAllDay(e) ? e.title : `${e.start} ${e.title}`)),
    ];
    const visible = items.length > fits ? items.slice(0, fitsWithMore) : items;
    const classes = ['cell'];
    if (fromISO(iso).getMonth() !== month) classes.push('outside');
    if (iso === clock.iso) classes.push('today');
    grid.append(h('div', { class: classes.join(' '), onclick: () => openDay(iso) },
      h('div', { class: 'date' }, dayNumber(iso, iso === clock.iso)),
      visible.map((make) => make()),
      items.length > visible.length && h('div', { class: 'more' }, t('ещё {0}', [items.length - visible.length]))));
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
    const strip = deadlineStrip([state.date]);
    if (strip) board.append(strip);
    board.append(timeGrid([state.date], true));
  }
  for (const block of board.querySelectorAll('.block')) fitBlock(block);
  state.renderedMinute = now().time;
  refreshDeadlines();
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
      ? t('Не удаётся прочитать мероприятия на этом компьютере. На экране последние загруженные данные. Проверьте свободное место и права на папку C:\\ProgramData\\Kerdiis.')
      : '';
  }
  if (changed || bannerChanged) render();
  await loadDirectory();
  await loadAttendance();
  await loadDevices();
  refreshPet();
  refreshTicker();
  refreshGear();
  if ($('journal').open) loadJournal();
}

let redrawRoll = null;
let rollStale = false;

/** Пока учитель правит время, список не перерисовывается: иначе поле пропадёт из-под пальца. */
const editingTime = () => Boolean(document.activeElement?.closest?.('#roll .timefield'));

async function loadAttendance() {
  const result = await api.attendance();
  if (!result.ok || JSON.stringify(result.value) === JSON.stringify(state.attendance)) return;
  state.attendance = result.value;
  if (!$('roll').open) return;
  if (editingTime()) rollStale = true;
  else redrawRoll?.();
}

/**
 * Поле времени без системного выпадающего окна: оно на панелях закрывалось само.
 * Время вводится цифрами (0925 или 09:25), «−» и «+» меняют его на минуту.
 */
function timeField({ value, label, onCommit, className = '' }) {
  const parse = (text) => {
    const digits = String(text).replace(/\D/g, '');
    if (digits.length < 3 || digits.length > 4) return null;
    const hours = Number(digits.slice(0, -2));
    const minutes = Number(digits.slice(-2));
    return hours < 24 && minutes < 60 ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` : null;
  };
  const shift = (time, delta) => {
    const total = (Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) + delta + 1440) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };
  const input = h('input', {
    type: 'text',
    class: `latetime ${className}`.trim(),
    inputmode: 'numeric',
    maxlength: 5,
    autocomplete: 'off',
    value,
    'aria-label': label,
  });
  const commit = () => {
    const time = parse(input.value);
    if (!time) {
      input.value = value;
      return;
    }
    input.value = time;
    if (time !== value) onCommit(time);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = value;
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    commit();
    if (rollStale) {
      rollStale = false;
      setTimeout(() => { if (!editingTime()) redrawRoll?.(); }, 0);
    }
  });
  const step = (delta, text, name) => h('button', {
    type: 'button',
    class: 'timestep',
    'aria-label': name,
    onclick: () => onCommit(shift(parse(input.value) ?? value, delta)),
  }, text);
  return h('span', { class: 'timefield' },
    step(-1, '−', t('На минуту раньше')), input, step(1, '+', t('На минуту позже')));
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

const deviceName = (id) => state.deviceNames.get(id) ?? t('Неизвестное устройство');

function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 5000);
}

const storeMessage = (result) => (result.code === 'conflict'
  ? t('Это мероприятие уже изменили или удалили на другом устройстве. Закройте окно и откройте его заново.')
  : result.code === 'invalid'
    ? t('Проверьте название, дату и время')
    : result.code === 'locked'
      ? t('Отчёт по этой паре зафиксирован: название, время, состав и удаление закрыты.')
      : result.code === 'teacher-only'
        ? t('Это можно сделать только в версии для преподавателей.')
        : t('Не удалось сохранить на этом компьютере. Попробуйте ещё раз.'));

/* Карточка мероприятия */

const closeButton = (dialog) => h('button', {
  class: 'icon',
  'aria-label': t('Закрыть'),
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
    : h('p', { class: 'empty' }, t('Не указано'));
  return h('section', { class: 'group' }, h('h3', {}, title), list);
}

const typeLabel = (type) => t(typeName(type));
/** «Своя камера» хранится по-русски на всех устройствах, а показывается на языке интерфейса. */
const gearLabel = (event, name) => (name === OWN_CAMERA ? equipmentLabel(event, name).replace(OWN_CAMERA, t(OWN_CAMERA)) : equipmentLabel(event, name));
const statusLabel = (status) => t(statusName(status));

const prepText = (event) => (event.prepMinutes ? t('с {0}, {1} мин', [busyFrom(event), event.prepMinutes]) : '');

const attendanceOf = (eventId) => state.attendance.find((doc) => doc.eventId === eventId);

const roll = (event) => {
  const clock = now();
  return rollCall(event, attendanceOf(event.id), clock.iso, clock.time, state.allEvents);
};

const countPresent = (event) => roll(event).filter((row) => row.status === 'present').length;

function showDetails(id) {
  const event = state.allEvents.find((e) => e.id === id);
  if (!event) return;
  const dialog = $('details');
  const footer = h('div', { class: 'sheetfoot' });
  const excused = roll(event).filter((row) => row.excusedFor);

  const showActions = () => footer.replaceChildren(
    canManage() && h('button', { class: 'plain', onclick: () => { dialog.close(); openForm(event); } }, t('Изменить')),
    event.participants.length > 0 && h('button', {
      class: 'primary',
      onclick: () => { dialog.close(); openRoll(event.id); },
    }, t('Отметка: {0} из {1}', [countPresent(event), event.participants.length])),
    // Занятию без техники техническое задание не нужно.
    (event.type !== 'lesson' || event.equipment.length > 0) && h('button', { class: 'plain', onclick: () => { dialog.close(); openPaper(event.id); } }, t('Тех. задание')),
    canManage() && event.deadline && h('button', {
      class: 'plain',
      onclick: async () => {
        if (await setDeadlineDone(event, !event.deadlineDone)) {
          dialog.close();
          showDetails(event.id);
        }
      },
    }, event.deadlineDone ? t('Вернуть в работу') : t('Отметить сдачу')),
    canManage() && memoApplies(event) && h('button', { class: 'plain', onclick: () => { dialog.close(); createMemo(event); } }, t('Служебная записка')),
    h('div', { class: 'spacer' }),
    canManage() && h('button', { class: 'plain', onclick: showConfirm }, t('Удалить')),
  );

  const following = seriesFrom(event, state.allEvents);
  const removeAll = async (list) => {
    const removed = [];
    let failed = null;
    for (const item of list) {
      const result = await api.remove(item.id, item.updatedAt);
      if (result.ok) removed.push(item.id);
      else failed = failed ?? result;
    }
    setEvents(state.allEvents.filter((e) => !removed.includes(e.id)));
    render();
    if (failed && !removed.length) {
      footer.replaceChildren(h('p', { class: 'message' }, storeMessage(failed)));
      return;
    }
    dialog.close();
    if (list.length > 1) toast(t('Удалено событий: {0}', [removed.length]));
  };
  const showConfirm = () => footer.replaceChildren(
    h('p', { class: 'message' }, following.length > 1
      ? t('Это событие из цепочки, дальше в ней ещё {0}. Что удалить?', [following.length - 1])
      : t('Удалить мероприятие без возможности восстановления?')),
    h('button', { class: 'plain', onclick: showActions }, t('Оставить')),
    h('button', { class: 'danger', onclick: () => removeAll([event]) }, following.length > 1 ? t('Только это') : t('Удалить')),
    following.length > 1 && h('button', { class: 'danger', id: 'remove-following', onclick: () => removeAll(following) }, t('Это и все следующие')),
  );

  showActions();
  const fact = (name, value) => (value ? [h('dt', {}, name), h('dd', {}, value)] : []);
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, event.title), closeButton(dialog)),
    h('div', { class: 'sheetbody' },
      h('dl', { class: 'facts' },
        fact(t('Тип'), typeLabel(event.type)),
        fact(t('Дата'), fmt(event.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })),
        fact(t('Время'), timeRange(event)),
        event.repeat ? fact(t('Повтор'), t('{0}, до {1}', [repeatLabel(event.repeat.every), shortDay(event.repeat.until)])) : [],
        fact(t('Подготовка'), prepText(event)),
        event.deadline ? fact(deadlineLabel(event.type), deadlineFact(event)) : [],
        excused.length ? fact(t('Освобождены по приказу'), excused.map((row) => `${row.name} (${row.excusedFor})`).join(', ')) : [],
        fact(t('Место'), event.place),
        fact(t('Ответственный'), event.responsible || t('Не указан')),
        fact(t('Показывать на'), event.devices.map(deviceName).join(', '))),
      listGroup(t('Участники: {0}', [event.participants.length]), event.participants, true),
      listGroup(t('Техника'), event.equipment.map((name) => gearLabel(event, name)), false),
      event.ownCameras.length > 0 && listGroup(t('Со своей камерой'), event.ownCameras, false),
      event.notes && h('section', { class: 'group' }, h('h3', {}, t('Примечание')), h('p', { class: 'notes' }, event.notes))),
    footer,
  );
  dialog.showModal();
}

/* Форма мероприятия */

function listInput(label, inputId, placeholder, values, onChange, pick, { tagLabel = (value) => value, suggest = () => [] } = {}) {
  const tags = h('div', { class: 'tags' });
  const heading = h('label', { for: inputId });
  const input = h('input', { id: inputId, placeholder, autocomplete: 'off' });

  const draw = () => {
    heading.textContent = values.length ? `${label}: ${values.length}` : label;
    keepScroll(tags, () => tags.replaceChildren(...values.map((value, index) =>
      h('span', { class: 'tag' }, tagLabel(value), h('button', {
        type: 'button',
        'aria-label': t('Убрать: {0}', [value]),
        onclick: () => { values.splice(index, 1); draw(); onChange(); },
      }, '×')))));
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

  const hints = attachSuggest(input, suggest, (value) => {
    input.value = '';
    addFrom(value);
  });

  draw();
  return {
    commit,
    element: h('div', { class: 'field' }, heading,
      h('div', { class: 'adder' }, input,
        h('button', { type: 'button', onclick: () => { commit(); input.focus(); } }, t('Добавить')),
        h('button', { type: 'button', onclick: () => pick(() => { draw(); onChange(); }) }, t('Из списка'))),
      hints,
      tags),
  };
}

/** Выбор устройств. Пустой список означает «на всех». */
function devicePicker(selected, network) {
  const self = { id: state.settings.deviceId, name: t('{0} (это устройство)', [state.settings.deviceName]) };
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
      }, t('Все устройства')),
      ...known.map(toggle),
    );
  };
  draw();
  return h('div', { class: 'field' },
    h('span', { class: 'label', id: 'l-targets' }, t('Где показывать')),
    row,
    h('p', { class: 'help' }, t('Выключенное устройство получит мероприятие при следующей связи с любым устройством сети.')));
}

/**
 * Подсказки при вводе. Системный список браузера на сенсорном экране нельзя
 * прокрутить, поэтому список свой: он встроен в форму и листается пальцем.
 */
function attachSuggest(input, getValues, pick) {
  const box = h('div', { class: 'suggest', hidden: true });
  const hide = () => { box.hidden = true; };
  const draw = () => {
    const query = nameKey(input.value);
    const items = query
      ? uniqueValues(getValues()).filter((value) => nameKey(value).includes(query) && nameKey(value) !== query)
      : [];
    box.hidden = !items.length;
    box.replaceChildren(...items.map((value) => h('button', {
      type: 'button',
      onclick: () => { hide(); pick(value); },
    }, value)));
  };
  input.addEventListener('input', draw);
  input.addEventListener('blur', () => setTimeout(hide, 150));
  // Нажатие на полосу прокрутки не должно снимать фокус с поля и закрывать список.
  box.addEventListener('mousedown', (e) => e.preventDefault());
  return box;
}

async function openForm(source = {}) {
  const dialog = $('form');
  const network = await loadDevices();
  const clock = now();
  const start = source.start ?? suggestedStart(clock.time);
  const draft = {
    id: source.id ?? null,
    participants: [...(source.participants ?? [])],
    equipment: (source.equipment ?? []).filter((name) => name !== OWN_CAMERA),
    qty: { ...(source.equipmentQty ?? {}) },
    devices: [...(source.devices ?? [])],
    type: source.type ?? 'lesson',
  };

  const field = (label, id, attrs, size = '') => {
    const input = h('input', { id, name: id, ...attrs });
    if (attrs.type === 'date' || attrs.type === 'time' || attrs.type === 'datetime-local') {
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
    onclick: () => { draft.type = id; drawTypes(); showPrep(); showDeadline(); updateConflicts(); },
  }, t(label))));
  drawTypes();
  const typeField = h('div', { class: 'field' }, h('span', { class: 'label', id: 'l-type' }, t('Тип')), typeRow);

  const title = field(t('Название'), 'f-title', { value: source.title ?? '', autocomplete: 'off', maxlength: 200 });
  const date = field(t('Дата'), 'f-date', { type: 'date', value: source.date ?? state.date }, 'third');
  const from = field(t('Начало'), 'f-start', { type: 'time', value: start }, 'third');
  const allDayBox = h('input', { id: 'f-allday', type: 'checkbox', checked: Boolean(source.allDay) });
  const allDayField = h('div', { class: 'field' }, h('label', { class: 'check' }, allDayBox, t('Весь день')));
  const showTimes = () => {
    from.hidden = allDayBox.checked;
    to.hidden = allDayBox.checked;
    if (allDayBox.checked) {
      $('f-start').value = STUDY_DAY.start;
      $('f-end').value = STUDY_DAY.end;
    }
  };
  allDayBox.addEventListener('change', () => {
    if (!allDayBox.checked) {
      $('f-start').value = '09:00';
      $('f-end').value = '10:00';
    }
    showTimes();
    updateConflicts();
  });
  const to = field(t('Окончание'), 'f-end', {
    type: 'time',
    value: source.end ?? fromMinutes(Math.min(toMinutes(start) + 60, 23 * 60 + 55)),
  }, 'third');
  const prep = field(t('Подготовка до начала, минут'), 'f-prep', {
    type: 'number', min: 0, max: 720, step: 5, value: source.prepMinutes || '', placeholder: t('Без подготовки'),
  });
  prep.append(h('div', { class: 'targets prepchoices' }, [15, 30, 45, 60, 90, 120].map((minutes) => h('button', {
    type: 'button',
    onclick: () => { $('f-prep').value = minutes; updateConflicts(); },
  }, String(minutes)))));
  prep.append(h('p', { class: 'help' }, t('На это время студентов освобождают от занятий. Они и техника уже считаются занятыми.')));
  const showPrep = () => { prep.hidden = draft.type === 'lesson'; };
  showPrep();

  // Повтор задаётся только при создании: дальше у каждого события своя запись.
  const repeatSelect = h('select', { id: 'f-repeat' },
    h('option', { value: '' }, t('Не повторять')),
    REPEATS.map(([id, label]) => h('option', { value: id }, t(label))));
  const until = h('input', { id: 'f-until', type: 'date', 'aria-label': t('Повторять до') });
  until.addEventListener('click', () => { try { until.showPicker(); } catch { /* окно уже открыто */ } });
  const repeatHint = h('p', { class: 'help' });
  const repeat = h('div', { class: 'field', 'data-for': 'f-repeat', hidden: Boolean(source.id) },
    h('label', { for: 'f-repeat' }, t('Повторять')),
    h('div', { class: 'repeatrow' }, repeatSelect, h('span', { class: 'repeatuntil' }, t('до'), until)),
    repeatHint);
  const repeatPlan = () => (repeatSelect.value ? repeatDates($('f-date').value, repeatSelect.value, until.value) : [$('f-date').value]);
  const showRepeat = () => {
    until.closest('.repeatuntil').hidden = !repeatSelect.value;
    const count = repeatSelect.value && until.value ? repeatPlan().length : 0;
    repeatHint.textContent = count
      ? t('Будет создано событий: {0}, последнее {1}.', [count, shortDay(repeatPlan().at(-1))])
      : repeatSelect.value ? t('Укажите дату, до которой повторять. Например, последний день семестра.') : '';
  };
  repeatSelect.addEventListener('change', showRepeat);
  until.addEventListener('change', showRepeat);
  showRepeat();

  const deadline = field('', 'f-deadline', { type: 'datetime-local', value: source.deadline ?? '' });
  deadline.append(h('div', { class: 'targets prepchoices' },
    [1, 3, 7].map((count) => h('button', {
      type: 'button',
      onclick: () => { $('f-deadline').value = `${addDays($('f-date').value || state.date, count)}T18:00`; },
    }, tp('days', count))),
    h('button', { type: 'button', onclick: () => { $('f-deadline').value = ''; } }, t('Без срока'))));
  deadline.append(h('p', { class: 'help' }, t('Кнопки считают дни от даты события, срок ставится на 18:00.')));
  const showDeadline = () => {
    deadline.hidden = !DEADLINE_TYPES.includes(draft.type);
    deadline.querySelector('label').textContent = deadlineLabel(draft.type);
  };
  showDeadline();

  const place = field(t('Место'), 'f-place', { value: source.place ?? '', autocomplete: 'off' }, 'half');
  place.append(attachSuggest(place.querySelector('input'), () => state.allEvents.map((e) => e.place), (value) => {
    $('f-place').value = value;
  }));
  const responsible = field(t('Ответственный'), 'f-responsible', { value: source.responsible ?? '', autocomplete: 'off' }, 'half');
  const responsibleInput = responsible.querySelector('input');
  responsible.append(h('div', { class: 'adder' }, responsibleInput, h('button', {
    type: 'button',
    onclick: () => {
      const selected = responsibleInput.value.trim() ? [responsibleInput.value.trim()] : [];
      openPicker({
        title: t('Ответственный'),
        sections: [{ items: refsOf('teacher').map((ref) => ref.name) }],
        selected,
        single: true,
        busy: busyNames('person'),
        empty: t('Список преподавателей пуст. Добавьте их в разделе «Справочники».'),
        done: (names) => {
          responsibleInput.value = names[0] ?? '';
          updateConflicts();
        },
      });
    },
  }, t('Из списка'))), attachSuggest(responsibleInput, () => [
    ...refsOf('teacher').map((ref) => ref.name),
    ...state.allEvents.map((e) => e.responsible),
  ], (value) => {
    responsibleInput.value = value;
    updateConflicts();
  }));
  const conflictBox = h('section', { class: 'conflicts', 'aria-live': 'polite', hidden: true });
  const ownBox = h('p', { class: 'help ownbox', hidden: true });
  const message = h('p', { class: 'message error' });

  const ownCameraHolders = () => {
    const owners = new Set(refsOf('student').filter((student) => student.ownCamera).map((student) => nameKey(student.name)));
    return draft.participants.filter((name) => owners.has(nameKey(name)));
  };

  /** Камеры студентов попадают в список техники сами и лимит не расходуют. */
  const withOwnCameras = () => {
    const holders = ownCameraHolders();
    const qty = Object.fromEntries(draft.equipment.filter((name) => draft.qty[name] > 1).map((name) => [name, draft.qty[name]]));
    if (holders.length > 1) qty[OWN_CAMERA] = holders.length;
    return {
      equipment: holders.length ? [...draft.equipment, OWN_CAMERA] : [...draft.equipment],
      equipmentQty: qty,
      ownCameras: holders,
    };
  };

  /** Новый срок снимает отметку о сдаче: сдавать нужно уже к нему. */
  const readDeadline = () => {
    const value = DEADLINE_TYPES.includes(draft.type) ? $('f-deadline').value : '';
    return { deadline: value, deadlineDone: value && value === source.deadline ? source.deadlineDone ?? '' : '' };
  };

  const read = () => ({
    id: draft.id,
    type: draft.type,
    title: $('f-title').value.trim(),
    date: $('f-date').value,
    start: $('f-start').value,
    end: $('f-end').value,
    allDay: allDayBox.checked,
    prepMinutes: draft.type === 'lesson' ? 0 : Math.max(0, Math.round(Number($('f-prep').value) || 0)),
    ...readDeadline(),
    place: $('f-place').value.trim(),
    responsible: $('f-responsible').value.trim(),
    participants: draft.participants,
    ...withOwnCameras(),
    devices: draft.devices,
    notes: $('f-notes').value.trim(),
    // Правка не выводит событие из цепочки.
    seriesId: source.seriesId ?? '',
    repeat: source.repeat ?? null,
  });

  const updateConflicts = () => {
    if (!dialog.open) return;
    const event = read();
    const found = findConflicts(event, state.allEvents, refsOf('equipment'));
    const lacking = shortages(event, state.allEvents, refsOf('equipment'));
    conflictBox.hidden = !found.length && !lacking.length;
    conflictBox.replaceChildren(
      found.length > 0 && h('h3', {}, t('Уже заняты в это время')),
      found.length > 0 && h('ul', {}, found.map((c) => h('li', {}, `${c.name}: ${eventLabel(c.event)}`))),
      lacking.length > 0 && h('h3', {}, t('Не хватает техники')),
      lacking.length > 0 && h('ul', {}, lacking.map((item) => h('li', {}, t('{0}: нужно {1}, свободно {2} из {3}', [item.name, item.need, item.free, item.total])))),
    );
    const holders = ownCameraHolders();
    ownBox.hidden = !holders.length;
    ownBox.textContent = t('Со своей камерой: {0}. Эти камеры не расходуют лимит.', [holders.join(', ')]);
  };

  /** Кто или что уже занято в выбранное время: имя → мероприятие. */
  const busyNames = (kind) => {
    const names = state.directory.map((ref) => ref.name);
    const probe = { ...read(), responsible: '', participants: kind === 'person' ? names : [], equipment: kind === 'equipment' ? names : [] };
    return new Map(findConflicts(probe, state.allEvents).map((c) => [nameKey(c.name), eventLabel(c.event)]));
  };

  const people = () => [...refsOf('teacher'), ...refsOf('student')].map((ref) => ref.name)
    .concat(state.allEvents.flatMap((e) => [e.responsible, ...e.participants]));

  const pickInto = (values, config) => (changed) => openPicker({
    ...config,
    selected: values,
    done: (names) => {
      values.splice(0, values.length, ...names);
      changed();
    },
  });

  const participants = listInput(t('Участники'), 'f-participants',
    t('Фамилия и имя, можно вставить список из таблицы'), draft.participants, updateConflicts,
    (changed) => pickInto(draft.participants, {
      title: t('Студенты'),
      sections: [
        ...refsOf('group').map((group) => ({
          name: group.name,
          items: groupMembers(group, refsOf('group'), refsOf('student')).map((s) => s.name),
        })),
      ],
      busy: busyNames('person'),
      empty: t('Список студентов пуст. Добавьте группы и студентов в разделе «Справочники».'),
      selectAll: t('Всех студентов'),
    })(changed), { suggest: people });
  const equipment = listInput(t('Техника'), 'f-equipment',
    t('Например, проектор'), draft.equipment, updateConflicts,
    (changed) => openStockPicker({
      event: read(),
      values: draft.equipment,
      qty: draft.qty,
      holders: ownCameraHolders(),
      done: changed,
    }),
    {
      tagLabel: (name) => gearLabel({ equipmentQty: draft.qty }, name),
      suggest: () => [...refsOf('equipment').map((ref) => ref.name), ...state.allEvents.flatMap((e) => e.equipment)]
        .filter((name) => name !== OWN_CAMERA),
    });

  const targets = devicePicker(draft.devices, network);

  const setInvalid = (wrapper, text) => {
    wrapper.classList.toggle('invalid', Boolean(text));
    wrapper.querySelector('.error')?.remove();
    if (text) wrapper.append(h('p', { class: 'error' }, text));
  };

  const validate = (event) => {
    const titleError = event.title ? '' : t('Укажите название');
    const timeError = event.start && event.end && event.start < event.end ? '' : t('Окончание должно быть позже начала');
    const dateError = event.date ? '' : t('Укажите дату');
    setInvalid(title, titleError);
    setInvalid(to, timeError);
    setInvalid(date, dateError);
    const plan = repeatSelect.value ? repeatPlan() : [];
    const repeatError = !repeatSelect.value || source.id ? ''
      : !until.value || until.value < event.date ? t('Укажите дату окончания повторов не раньше даты события')
        : plan.length >= MAX_REPEATS ? t('Слишком длинная цепочка: не больше {0} событий', [MAX_REPEATS - 1]) : '';
    setInvalid(repeat, repeatError);
    const lacking = shortages(event, state.allEvents, refsOf('equipment'));
    message.textContent = lacking.length ? t('Не хватает: {0}. Уменьшите количество или выберите другое время.', [lacking.map((item) => item.name).join(', ')]) : '';
    return !(titleError || timeError || dateError || repeatError || lacking.length);
  };

  const save = h('button', { class: 'primary', type: 'submit' }, source.id ? t('Сохранить') : t('Добавить событие'));

  const finish = (date) => {
    state.date = date;
    dialog.close();
    render();
  };

  const saveSeries = async (event, every, last) => {
    const seriesId = crypto.randomUUID();
    const result = await api.saveMany(repeatDates(event.date, every, last)
      .map((date) => ({ ...event, id: null, date, seriesId, repeat: { every, until: last } })));
    save.disabled = false;
    if (!result.ok) {
      message.textContent = storeMessage(result);
      return;
    }
    setEvents([...state.allEvents, ...result.value]);
    finish(event.date);
    toast(t('Добавлено событий: {0}', [result.value.length]));
    if (canManage() && needsMemo(result.value[0], source)) createMemo(result.value[0]);
  };

  // Дата у каждого события своя, остальное переносится на всю цепочку дальше.
  const saveFollowing = async (event) => {
    let skipped = 0;
    const saved = [];
    for (const other of seriesFrom(source, state.allEvents)) {
      const changed = other.id === source.id
        ? event
        : { ...other, ...event, id: other.id, date: other.date, deadline: other.deadline, deadlineDone: other.deadlineDone };
      const result = await api.save(changed, other.updatedAt);
      if (result.ok) saved.push(result.value);
      else skipped += 1;
    }
    save.disabled = false;
    setEvents([...state.allEvents.filter((x) => !saved.some((y) => y.id === x.id)), ...saved]);
    finish(event.date);
    toast(skipped
      ? t('Изменено событий: {0}. Не изменено: {1}, по ним отчёт уже зафиксирован или их изменили на другом устройстве.', [saved.length, skipped])
      : t('Изменено событий: {0}', [saved.length]));
  };

  const askScope = () => {
    message.replaceChildren(
      t('Это событие из цепочки. Что изменить?'),
      h('button', { type: 'button', class: 'plain', onclick: () => { form.dataset.scope = 'one'; form.requestSubmit(); } }, t('Только это')),
      h('button', { type: 'button', class: 'primary', id: 'scope-following', onclick: () => { form.dataset.scope = 'following'; form.requestSubmit(); } }, t('Это и все следующие')),
    );
  };

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
      if (!source.id && repeatSelect.value) {
        await saveSeries(event, repeatSelect.value, until.value);
        return;
      }
      if (source.seriesId && seriesFrom(source, state.allEvents).length > 1 && !form.dataset.scope) {
        save.disabled = false;
        askScope();
        return;
      }
      if (form.dataset.scope === 'following') {
        await saveFollowing(event);
        return;
      }
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
      if (event.devices.length) toast(t('Событие отправлено: {0}', [event.devices.map(deviceName).join(', ')]));
      if (canManage() && needsMemo(result.value, source)) createMemo(result.value);
    },
  },
    h('div', { class: 'sheetbody' },
      h('div', { class: 'fields' },
        typeField, title, date, allDayField, from, to, repeat, prep, deadline, place, responsible, targets,
        participants.element, equipment.element, ownBox, conflictBox,
        h('div', { class: 'field' },
          h('label', { for: 'f-notes' }, t('Примечание')),
          h('textarea', { id: 'f-notes', maxlength: 2000 }, source.notes ?? '')))),
    h('div', { class: 'sheetfoot' }, save, message));

  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, source.id ? t('Изменить событие') : t('Новое событие')), closeButton(dialog)),
    form,
  );
  dialog.showModal();
  showTimes();
  updateConflicts();
  if (!source.id) $('f-title').focus();
}

/* Выбор из списка */

/**
 * Окно выбора. Значения, введённые в форме вручную, остаются нетронутыми:
 * окно меняет только то, что есть в его списке.
 */
function openPicker({ title, sections, selected, single = false, busy = new Map(), empty, selectAll = null, done }) {
  const dialog = $('picker');
  const chosen = new Set(selected.map(nameKey));
  const listed = new Map(sections.flatMap((section) => section.items).map((name) => [nameKey(name), name]));
  const opened = new Set();
  const search = h('input', { id: 'p-search', type: 'search', placeholder: t('Поиск'), autocomplete: 'off', 'aria-label': t('Поиск') });
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
    }, h('strong', {}, name), note && h('span', {}, t('Занято: {0}', [note])));
  };

  function draw() {
    const query = nameKey(search.value);
    const rows = [];
    if (selectAll && listed.size) {
      const everyone = [...listed.keys()].every((key) => chosen.has(key));
      rows.push(h('button', {
        type: 'button',
        class: 'plain pickall',
        onclick: () => {
          for (const key of listed.keys()) {
            if (everyone) chosen.delete(key);
            else chosen.add(key);
          }
          draw();
        },
      }, everyone ? t('Снять всех') : `${selectAll}: ${listed.size}`));
    }
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
          }, h('strong', {}, section.name), h('span', {}, t('выбрано {0} из {1}', [count, section.items.length]))),
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
          }, all ? t('Снять всех') : t('Всю группу'))));
        if (open) rows.push(...items.map(row));
      } else {
        rows.push(...items.map(row));
      }
    }
    keepScroll(list, () => list.replaceChildren(...(rows.length ? rows : [h('p', { class: 'help' }, listed.size || sections.length ? t('Ничего не найдено.') : empty)])));
    confirm.textContent = t('Готово: выбрано {0}', [[...chosen].filter((key) => listed.has(key)).length]);
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

/** Выбор техники с количеством: больше свободного выбрать нельзя. */
function openStockPicker({ event, values, qty, holders, done }) {
  const dialog = $('picker');
  const stock = refsOf('equipment').filter((item) => item.name !== OWN_CAMERA);
  const counts = new Map(stock.map((item) => {
    const chosen = values.find((name) => nameKey(name) === nameKey(item.name));
    return [item.name, chosen ? equipmentCount({ equipmentQty: qty }, chosen) : 0];
  }));
  const list = h('div', { class: 'picklist' });

  // Строки не пересоздаются: меняется только число, поэтому список стоит на месте.
  const stockRow = (item) => {
    const free = freeStock(event, state.allEvents, item);
    const value = h('output', { 'aria-label': t('Выбрано: {0}', [item.name]) });
    const change = (delta) => { counts.set(item.name, counts.get(item.name) + delta); update(); };
    const less = h('button', { type: 'button', 'aria-label': t('Меньше: {0}', [item.name]), onclick: () => change(-1) }, '−');
    const more = h('button', { type: 'button', 'aria-label': t('Больше: {0}', [item.name]), onclick: () => change(1) }, '+');
    const update = () => {
      const count = counts.get(item.name);
      value.textContent = String(count);
      less.disabled = count === 0;
      more.disabled = free !== null && count >= free;
    };
    update();
    return h('div', { class: 'qtyrow' },
      h('div', { class: 'qtyname' },
        h('strong', {}, item.name),
        h('span', {}, free === null ? t('Без лимита') : t('Свободно {0} из {1}', [free, item.quantity]))),
      less, value, more);
  };

  const rows = stock.map((item) => ({ key: nameKey(item.name), element: stockRow(item) }));
  list.append(...rows.map((row) => row.element));
  if (!stock.length) list.append(h('p', { class: 'help' }, t('Список техники пуст. Добавьте её в разделе «Справочники».')));

  // Строки только скрываются: выбранное количество при поиске не теряется.
  const search = h('input', { id: 'p-search', type: 'search', placeholder: t('Поиск по названию'), autocomplete: 'off', 'aria-label': t('Поиск по названию') });
  const nothing = h('p', { class: 'help', hidden: true }, t('Ничего не найдено.'));
  list.append(nothing);
  search.addEventListener('input', () => {
    const query = nameKey(search.value);
    for (const row of rows) row.element.hidden = Boolean(query) && !row.key.includes(query);
    nothing.hidden = !rows.length || rows.some((row) => !row.element.hidden);
  });

  const finish = () => {
    const listed = new Set(stock.map((item) => nameKey(item.name)));
    const manual = values.filter((name) => !listed.has(nameKey(name)));
    const picked = stock.filter((item) => counts.get(item.name) > 0).map((item) => item.name);
    for (const name of Object.keys(qty)) if (!manual.includes(name)) delete qty[name];
    for (const name of picked) qty[name] = counts.get(name);
    values.splice(0, values.length, ...manual, ...picked);
    dialog.close();
    done();
  };

  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Техника')), closeButton(dialog)),
    h('div', { class: 'sheetbody' },
      holders.length > 0 && h('p', { class: 'notice' }, t('Со своей камерой: {0}.', [holders.join(', ')])),
      h('div', { class: 'field' }, search),
      list),
    h('div', { class: 'sheetfoot' }, h('button', { class: 'primary', type: 'button', onclick: finish }, t('Готово'))),
  );
  dialog.showModal();
}

/* Справочники */

const catalog = { tab: 'groups', groupId: null, editing: null, confirming: null, message: '' };

const CATALOG_TABS = [
  ['groups', t('Группы и студенты')],
  ['equipment', t('Техника')],
  ['teacher', t('Преподаватели')],
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
  catalog.message = repeated.length ? t('Уже есть в списке: {0}', [repeated.join(', ')]) : '';
  if (fresh.length) await commitCatalog(await api.saveRefs(fresh));
  else drawCatalog();
}

/** Количество из поля: пусто означает «без лимита». */
const parseQuantity = (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

async function addEquipment(rows, existing) {
  const known = new Set(existing.map((ref) => nameKey(ref.name)));
  const fresh = [];
  const repeated = [];
  for (const { name, quantity } of rows) {
    if (known.has(nameKey(name))) {
      repeated.push(name);
    } else {
      known.add(nameKey(name));
      fresh.push({ ref: { kind: 'equipment', name, quantity }, base: null });
    }
  }
  catalog.message = repeated.length ? t('Уже есть в списке: {0}', [repeated.join(', ')]) : '';
  if (fresh.length) await commitCatalog(await api.saveRefs(fresh));
  else drawCatalog();
}

function addForm(id, placeholder, onAdd, extra = null) {
  const input = h('input', { id, placeholder, autocomplete: 'off', 'aria-label': placeholder });
  const submit = async () => {
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    await onAdd(text, extra?.value ?? '');
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
  return h('div', { class: 'field' }, h('div', { class: 'adder' }, input, extra, h('button', { type: 'button', onclick: submit }, t('Добавить'))));
}

function refRow(ref, { confirmText = t('Удалить из списка?'), removals = () => [ref], open = null, active = false, detail = null, extra = null } = {}) {
  if (catalog.editing === ref.id) {
    const input = h('input', { id: 'c-edit', value: ref.name, autocomplete: 'off', 'aria-label': t('Название') });
    const groups = refsOf('group');
    const move = ref.kind === 'student'
      ? h('select', { id: 'c-group', 'aria-label': t('Группа') }, groups.map((g) => h('option', { value: g.id, selected: g.id === ref.groupId }, g.name)))
      : null;
    const limit = ref.kind === 'equipment'
      ? h('input', { id: 'c-qty', class: 'qtyinput', type: 'number', min: 0, value: ref.quantity ?? '', placeholder: t('Без лимита'), 'aria-label': t('Количество') })
      : null;
    return h('li', { class: 'refrow editing' }, input, move, limit,
      h('button', {
        type: 'button',
        class: 'primary',
        onclick: async () => {
          const name = input.value.trim();
          if (!name) return;
          catalog.message = '';
          await commitCatalog(await api.saveRefs([{
            ref: { ...ref, name, ...(move ? { groupId: move.value } : {}), ...(limit ? { quantity: parseQuantity(limit.value) } : {}) },
            base: ref.updatedAt,
          }]));
        },
      }, t('Сохранить')),
      h('button', { type: 'button', class: 'plain', onclick: () => { catalog.editing = null; drawCatalog(); } }, t('Отмена')));
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
      }, t('Удалить')),
      h('button', { type: 'button', class: 'plain', onclick: () => { catalog.confirming = null; drawCatalog(); } }, t('Оставить')));
  }
  const label = open
    ? h('button', { type: 'button', class: 'refname link', 'aria-pressed': String(active), onclick: open }, h('strong', {}, ref.name), detail && h('span', {}, detail))
    : h('div', { class: 'refname' }, h('p', {}, ref.name), detail && h('span', {}, detail));
  return h('li', { class: 'refrow' }, label, extra,
    h('button', { type: 'button', class: 'plain', onclick: () => { catalog.editing = ref.id; catalog.confirming = null; drawCatalog(); } }, t('Изменить')),
    h('button', { type: 'button', class: 'plain', onclick: () => { catalog.confirming = ref.id; catalog.editing = null; drawCatalog(); } }, t('Удалить')));
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
  const count = (group) => groupMembers(group, groups, students).length;
  const subgroups = groups.filter((group) => current && parentGroup(group, groups)?.id === current.id);

  return h('div', { class: 'catalogcols' },
    h('section', {},
      h('h3', {}, t('Группы')),
      addForm('c-add-group', t('Название группы'), (text) => addRefs(text, 'group', groups)),
      refList(groups.map((group) => refRow(group, {
        confirmText: t('Удалить группу и студентов: {0}?', [count(group)]),
        removals: () => [group, ...students.filter((s) => s.groupId === group.id)],
        open: () => { catalog.groupId = group.id; catalog.message = ''; drawCatalog(); },
        active: group.id === catalog.groupId,
        detail: tp('students', count(group)),
      })), t('Добавьте первую группу.'))),
    h('section', {},
      h('h3', {}, current ? t('Студенты группы {0}', [current.name]) : t('Студенты')),
      subgroups.length > 0 && h('p', { class: 'help' }, t('Подгруппы: {0}. Их студенты входят в эту группу и здесь не повторяются.', [subgroups.map((group) => group.name).join(', ')])),
      current
        ? [
          addForm('c-add-student', t('Фамилия и имя или столбец из таблицы'),
            (text) => addRefs(text, 'student', members, { groupId: current.id })),
          refList(members.map((student) => refRow(student, {
            extra: h('button', {
              type: 'button',
              class: 'plain owntoggle',
              'aria-pressed': String(student.ownCamera === true),
              onclick: async () => {
                catalog.message = '';
                await commitCatalog(await api.saveRefs([{ ref: { ...student, ownCamera: !student.ownCamera }, base: student.updatedAt }]));
              },
            }, t('Своя камера')),
          })), t('В группе пока нет студентов.')),
        ]
        : h('p', { class: 'help' }, t('Сначала добавьте группу.'))));
}

function simplePane(kind, placeholder, emptyText) {
  const items = refsOf(kind);
  return h('section', {},
    addForm(`c-add-${kind}`, placeholder, (text) => addRefs(text, kind, items)),
    refList(items.map((item) => refRow(item)), emptyText));
}

function equipmentPane() {
  const items = refsOf('equipment');
  const quantity = h('input', { id: 'c-add-qty', class: 'qtyinput', type: 'number', min: 0, placeholder: t('Без лимита'), 'aria-label': t('Количество, пусто означает без лимита') });
  return h('section', {},
    addForm('c-add-equipment', t('Название или таблица из двух столбцов'), (text, count) => {
      const rows = parseEquipment(text);
      if (rows.length === 1 && rows[0].quantity === null) rows[0].quantity = parseQuantity(count);
      return addEquipment(rows, items);
    }, quantity),
    h('p', { class: 'help' }, t('Количество ограничивает выбор в событиях с учётом пересечений по времени. Пустое поле означает «без лимита». Камеры студентов добавлять не нужно: отметьте «Своя камера» у студента.')),
    refList(items.map((item) => refRow(item, {
      detail: item.quantity === null ? t('Без лимита') : t('{0} шт.', [item.quantity]),
    })), t('Добавьте технику, чтобы выбирать её в событиях.')));
}

function drawCatalog({ fromTop = false } = {}) {
  const dialog = $('catalog');
  const scrolled = fromTop ? 0 : dialog.querySelector('.sheetbody')?.scrollTop ?? 0;
  const pane = catalog.tab === 'groups'
    ? groupsPane()
    : catalog.tab === 'equipment'
      ? equipmentPane()
      : simplePane('teacher', t('Фамилия и инициалы или столбец из таблицы'), t('Добавьте преподавателей, чтобы выбирать ответственных.'));
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Справочники')), closeButton(dialog)),
    h('div', { class: 'tabs', role: 'group', 'aria-label': t('Раздел справочников') }, CATALOG_TABS.map(([tab, label]) =>
      h('button', {
        type: 'button',
        'aria-pressed': String(catalog.tab === tab),
        onclick: () => {
          Object.assign(catalog, { tab, editing: null, confirming: null, message: '' });
          drawCatalog({ fromTop: true });
        },
      }, label))),
    h('div', { class: 'sheetbody' }, catalog.message && h('p', { class: 'notice' }, catalog.message), pane),
  );
  dialog.querySelector('.sheetbody').scrollTop = scrolled;
  $('c-edit')?.focus({ preventScroll: true });
}

/* Отметка на паре */

const clockTime = (at) => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

function rowNote(row) {
  if (row.lateMark && row.status === 'absent') return t('Пришёл в {0}, с {1}-й минуты это пропуск', [clockTime(row.at), ABSENT_FROM_MINUTE]);
  if (row.lateMark && !row.late) return t('Пришёл в {0}, меньше {1} минут от начала не считается опозданием', [clockTime(row.at), LATE_FROM_MINUTE]);
  if (row.status === 'present') {
    return row.late
      ? t('Пришёл в {0}, опоздание {1} мин', [clockTime(row.at), row.late])
      : t('Отмечен в {0}', [clockTime(row.at)]);
  }
  if (row.excusedFor) return t('По приказу: {0}', [row.excusedFor]);
  if (row.unconfirmed) return t('Болезнь, ждём справку');
  return row.status === 'pending' ? t('Нажмите на имя, чтобы отметиться') : statusLabel(row.status);
}

/* Шаблон служебной записки и резервные копии */

const fieldNames = () => TEMPLATE_FIELDS[locale().startsWith('ru') ? 'ru' : 'en'];
const braces = (names) => names.map((name) => `{{${name}}}`).join(', ');

function templateSection() {
  const box = h('section', { class: 'setting', id: 's-template' });
  const message = h('p', { class: 'help', role: 'status' });
  const draw = async () => {
    const { custom } = await api.memoTemplate();
    box.replaceChildren(
      h('h3', { class: 'settinghead' }, t('Шаблон служебной записки')),
      h('p', {}, custom ? t('Загружен свой шаблон.') : t('Используется встроенный шаблон.')),
      h('div', { class: 'targets' },
        h('button', { type: 'button', onclick: async () => {
          const result = await api.downloadTemplate();
          if (result.ok && result.value) message.textContent = t('Сохранено: {0}', [result.value]);
        } }, t('Скачать шаблон')),
        h('button', { type: 'button', id: 's-template-upload', onclick: async () => {
          const result = await api.uploadTemplate();
          if (!result.ok) {
            message.textContent = result.code === 'no-fields'
              ? t('В файле нет ни одного поля. Добавьте поля в двойных фигурных скобках, например {0}.', [braces(fieldNames().row.slice(1, 2))])
              : t('Это не документ Word (.docx).');
          } else if (result.value) {
            message.textContent = result.value.unknown.length
              ? t('Шаблон загружен. Не распознаны поля: {0}. Они останутся в записке как есть.', [result.value.unknown.join(', ')])
              : t('Шаблон загружен, поля распознаны: {0}.', [result.value.known.length]);
            draw();
          }
        } }, t('Загрузить свой')),
        custom && h('button', { type: 'button', onclick: async () => {
          await api.resetTemplate();
          message.textContent = '';
          draw();
        } }, t('Вернуть встроенный'))),
      message,
      h('p', { class: 'help' }, t('Скачайте шаблон, поменяйте его в Word и загрузите обратно. Поля пишутся в двойных фигурных скобках: {0}. Строка таблицы, где есть {1}, повторяется для каждого студента.', [braces(fieldNames().memo), braces(fieldNames().row)])),
    );
  };
  draw();
  return box;
}

function backupSection() {
  const box = h('section', { class: 'setting', id: 's-backup' });
  const message = h('p', { class: 'help', role: 'status' });
  const draw = async () => {
    const status = await api.backupStatus();
    const last = status.last
      ? t('Последняя копия: {0}', [`${shortDay(status.last.slice(0, 10))}, ${status.last.slice(11, 13)}:${status.last.slice(13, 15)}`])
      : t('Копий ещё нет.');
    box.replaceChildren(
      h('h3', { class: 'settinghead' }, t('Резервные копии')),
      h('p', {}, last),
      status.problem ? h('p', { class: 'error' }, t('Последняя копия не создана: {0}', [status.problem])) : '',
      h('p', { class: 'help backupdir' }, t('Папка: {0}', [status.dir])),
      h('div', { class: 'targets' },
        h('button', { type: 'button', id: 's-backup-now', onclick: async (e) => {
          e.currentTarget.disabled = true;
          const result = await api.backupNow();
          message.textContent = result.ok ? t('Копия сохранена.') : t('Копия не создана. Проверьте, доступна ли папка.');
          draw();
        } }, t('Сделать копию сейчас')),
        h('button', { type: 'button', onclick: async () => {
          const result = await api.chooseBackupDir();
          if (result.ok && result.value) draw();
        } }, t('Выбрать папку')),
        h('button', { type: 'button', id: 's-backup-restore', onclick: async () => {
          const result = await api.restoreBackup();
          if (!result.ok) message.textContent = t('Не удалось прочитать копию.');
          else if (result.value !== null) {
            message.textContent = t('Возвращено записей: {0}', [result.value]);
            await refresh();
          }
        } }, t('Вернуть удалённое из копии'))),
      message,
      h('p', { class: 'help' }, t('Копия делается сама раз в день, хранятся последние 30. Лучше выбрать сетевую папку или флешку: копия на этом же диске не спасёт при поломке компьютера. Возврат из копии добавляет только удалённые и пропавшие записи, текущие не меняются.')),
    );
  };
  draw();
  return box;
}

/** Удаление событий за период: сначала подсчёт, потом подтверждение. */
function clearSection() {
  const clock = now();
  const from = h('input', { id: 's-clear-from', type: 'date', value: clock.iso, 'aria-label': t('С') });
  const to = h('input', { id: 's-clear-to', type: 'date', value: clock.iso, 'aria-label': t('По') });
  const types = new Set(EVENT_TYPES.map(([id]) => id));
  const typeRow = h('div', { class: 'targets' });
  const drawTypes = () => typeRow.replaceChildren(...EVENT_TYPES.map(([id, label]) => h('button', {
    type: 'button',
    class: `t-${id}`,
    'aria-pressed': String(types.has(id)),
    onclick: () => { if (types.has(id)) types.delete(id); else types.add(id); drawTypes(); reset(); },
  }, t(label))));
  const message = h('p', { class: 'help', role: 'status' });
  const actions = h('div', { class: 'targets clearactions' });
  const matching = () => state.allEvents.filter((e) => e.date >= from.value && e.date <= to.value && types.has(e.type));
  const reset = () => {
    message.textContent = '';
    actions.replaceChildren(h('button', { type: 'button', id: 's-clear', onclick: confirm }, t('Удалить события за период')));
  };
  function confirm() {
    if (!from.value || !to.value || from.value > to.value || !types.size) {
      message.textContent = t('Выберите период и хотя бы один тип.');
      return;
    }
    const count = matching().length;
    if (!count) {
      message.textContent = t('За этот период событий нет.');
      return;
    }
    message.textContent = t('Будет удалено событий: {0}, на всех устройствах сети. Перед удалением программа сделает резервную копию. Зафиксированные пары останутся.', [count]);
    actions.replaceChildren(
      h('button', { type: 'button', class: 'plain', onclick: reset }, t('Отмена')),
      h('button', { type: 'button', class: 'danger', id: 's-clear-confirm', onclick: async (e) => {
        e.currentTarget.disabled = true;
        const result = await api.removeRange(from.value, to.value, [...types]);
        reset();
        if (!result.ok) {
          message.textContent = result.code === 'backup-failed'
            ? t('Копия не создана, поэтому ничего не удалено. Проверьте папку резервных копий.')
            : t('Не удалось удалить события. Попробуйте ещё раз.');
          return;
        }
        await refresh();
        message.textContent = result.value.kept
          ? t('Удалено событий: {0}. Оставлено зафиксированных: {1}.', [result.value.removed, result.value.kept])
          : t('Удалено событий: {0}', [result.value.removed]);
      } }, t('Удалить {0}', [tp('events', count)])),
    );
  }
  from.addEventListener('change', reset);
  to.addEventListener('change', reset);
  drawTypes();
  reset();
  return h('section', { class: 'setting', id: 's-clearbox' },
    h('h3', { class: 'settinghead' }, t('Удаление событий за период')),
    h('div', { class: 'repeatrow' }, t('С'), from, t('по'), to),
    typeRow,
    actions,
    message,
    h('p', { class: 'help' }, t('Например, чтобы очистить календарь после окончания семестра. Если удалили лишнее, его можно вернуть кнопкой «Вернуть удалённое из копии».')));
}

/* Окно */

function showWindowButtons(full) {
  $('minimize').hidden = !full;
  $('quit').hidden = !full;
}

/** Палец на доске легко задеть: закрытие подтверждается. */
function askQuit() {
  const dialog = $('quitask');
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Закрыть программу?')), closeButton(dialog)),
    h('div', { class: 'sheetbody' }, h('p', {}, t('Календарь пропадёт с экрана до следующего запуска. Он запустится сам при следующем входе в Windows.'))),
    h('div', { class: 'sheetfoot' },
      h('button', { type: 'button', class: 'plain', onclick: () => dialog.close() }, t('Отмена')),
      h('button', { type: 'button', class: 'primary', id: 'quit-confirm', onclick: () => api.quit() }, t('Закрыть'))),
  );
  dialog.showModal();
}

/* Версии программы */

const isClient = () => state.settings?.edition === 'client';
const canManage = () => !isClient();

/** Клиент на панели не показывает разделы преподавателя. Запрет проверяется и в основном процессе. */
function applyEdition() {
  for (const id of ['open-catalog', 'open-reports', 'notices-open', 'open-journal']) $(id).hidden = isClient();
}

/* Отметки на паре */

const pad2 = (value) => String(value).padStart(2, '0');

function inputTime(at) {
  const date = new Date(at);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function markText(mark) {
  if (!mark.status) return t('Нет отметки');
  if (mark.status === 'sick' && mark.confirmed === false) return t('Болезнь, ждём справку');
  if (mark.status !== 'present') return statusLabel(mark.status);
  return mark.late ? t('Опоздал, {0}', [clockTime(mark.at)]) : t('Присутствовал');
}

const stampText = (at) => new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function openRoll(id) {
  const dialog = $('roll');
  const event = state.allEvents.find((e) => e.id === id);
  if (!event) return;
  const search = h('input', { id: 'r-search', type: 'search', placeholder: t('Поиск по фамилии'), autocomplete: 'off', 'aria-label': t('Поиск по фамилии') });
  const summary = h('p', { class: 'rollsummary', role: 'status' });
  const banner = h('p', { class: 'lockbanner', hidden: true });
  const startBox = h('div', { class: 'startline' });
  const list = h('ul', { class: 'rolllist' });
  const failure = h('p', { class: 'error' });
  const log = h('section', { class: 'rollhistory', hidden: true });
  const footer = h('div', { class: 'sheetfoot' });
  let confirming = false;

  const apply = (doc) => {
    state.attendance = [...state.attendance.filter((item) => item.eventId !== event.id), doc];
    draw();
  };

  const refused = (result) => {
    if (result.code === 'teacher-only') {
      failure.textContent = t('Это можно сделать только в версии для преподавателей.');
    } else if (result.code === 'locked') {
      failure.textContent = t('Отчёт зафиксирован. Исправить его можно в версии для преподавателей.');
    } else {
      failure.textContent = t('Отметка не сохранена. Попробуйте ещё раз.');
    }
    draw();
  };

  const setMark = async (name, status, options = {}) => {
    const result = await api.mark(event.id, name, status, options);
    if (result.ok) {
      failure.textContent = '';
      apply(result.value);
    } else {
      refused(result);
    }
  };

  // Отчёт уходит один раз: кнопка гаснет сразу, а повтор отклоняет хранилище.
  const lock = async (e) => {
    e.currentTarget.disabled = true;
    const excused = Object.fromEntries(roll(event).filter((row) => row.excusedFor).map((row) => [row.name, row.excusedFor]));
    const result = await api.lockReport(event.id, excused);
    confirming = false;
    if (result.ok) {
      failure.textContent = '';
      apply(result.value);
      toast(t('Отчёт зафиксирован и отправлен на другие устройства.'));
    } else if (result.code === 'locked') {
      failure.textContent = t('Отчёт по этому занятию уже отправлен.');
      await refresh();
      draw();
    } else {
      refused(result);
    }
  };

  const start = async (at) => {
    const result = await api.startLesson(event.id, at);
    if (result.ok) {
      failure.textContent = '';
      apply(result.value);
    } else {
      failure.textContent = result.code === 'not-now'
        ? t('Начать занятие можно за 30 минут до начала и до 40-й минуты по расписанию.')
        : result.code === 'started' ? t('Занятие уже начато.') : t('Отметка не сохранена. Попробуйте ещё раз.');
      draw();
    }
  };

  function drawStart(doc, locked, teacherMode) {
    const delay = startDelay(event, doc);
    const began = doc?.start ? clockTime(actualStart(event, doc).toISOString()) : null;
    startBox.replaceChildren(...[
      began
        ? h('p', { class: `startinfo${delay ? ' delayed' : ''}` }, delay
          ? t('Занятие началось в {0}, по расписанию {1}. Задержка {2} мин, опоздание считается от фактического начала.', [began, event.start, delay])
          : t('Занятие началось вовремя, в {0}.', [event.start]))
        : !locked && h('button', { type: 'button', class: 'primary', id: 'start-lesson', onclick: () => start() }, t('Начать занятие')),
      teacherMode && !locked && doc?.start && timeField({
        value: began,
        label: t('Фактическое начало'),
        onCommit: (time) => start(new Date(`${event.date}T${time}`).toISOString()),
      }),
      !began && !locked && h('p', { class: 'help' }, t('Нажмите, когда занятие фактически началось. Опоздание будет считаться от этого времени: до {0} минут не опоздание, с {0}-й по {1}-ю опоздание, с {2}-й пропуск.', [LATE_FROM_MINUTE, ABSENT_FROM_MINUTE - 1, ABSENT_FROM_MINUTE])),
    ].filter(Boolean));
  }

  const lateControls = (row) => [
    h('button', {
      type: 'button',
      class: 'reason',
      'aria-pressed': String(Boolean(row.lateMark || row.late)),
      onclick: () => (row.lateMark || row.late ? setMark(row.name, 'present', { late: false, at: row.at }) : setMark(row.name, 'present', { late: true })),
    }, t('Опоздал')),
    (row.lateMark || row.late > 0) && timeField({
      value: inputTime(row.at),
      label: t('Время прихода: {0}', [row.name]),
      onCommit: (time) => setMark(row.name, 'present', { late: true, at: new Date(`${event.date}T${time}`).toISOString() }),
    }),
  ];

  function drawFooter(doc) {
    if (confirming) {
      footer.replaceChildren(
        h('p', { class: 'message' }, t('Отчёт закроется для панелей. Кто не отмечен, станет отсутствующим. Исправить его можно будет только в версии для преподавателей.')),
        h('button', { type: 'button', class: 'plain', onclick: () => { confirming = false; draw(); } }, t('Отмена')),
        h('button', { type: 'button', class: 'primary', id: 'lock-confirm', onclick: lock }, t('Зафиксировать')),
      );
      return;
    }
    if (isClient()) {
      footer.replaceChildren(h('p', { class: 'message' }, t('Подтверждение справки, остальные причины и отчёт ведутся в версии для преподавателей.')));
      return;
    }
    footer.replaceChildren(...(doc?.lock ? [] : [
      h('button', { type: 'button', class: 'primary', id: 'lock-report', onclick: () => { confirming = true; draw(); } }, t('Зафиксировать и отправить')),
    ]));
  }

  function draw() {
    const rows = roll(event);
    const doc = attendanceOf(event.id);
    const locked = Boolean(doc?.lock);
    const teacherMode = canManage();
    const count = (status) => rows.filter((row) => row.status === status).length;
    const parts = [
      t('Отмечены: {0} из {1}', [count('present'), rows.length]),
      countsLateness(event) && t('с опозданием: {0}', [rows.filter((row) => row.late).length]),
      ...ABSENCE_REASONS.map(([reason, label]) => `${t(label).toLowerCase()}: ${count(reason)}`),
    ];
    summary.textContent = parts.filter(Boolean).join(', ');
    if (countsLateness(event)) drawStart(doc, locked, teacherMode);
    banner.hidden = !locked;
    banner.textContent = locked ? t('Отчёт зафиксирован: {0}, {1}', [doc.lock.teacher, stampText(doc.lock.at)]) : '';
    const query = nameKey(search.value);
    keepScroll(list, () => list.replaceChildren(...rows.filter((row) => !query || nameKey(row.name).includes(query)).map((row) => {
      const settled = !row.excusedFor && !row.unconfirmed && !['present', 'pending', 'absent'].includes(row.status);
      return h('li', { class: `rollrow${row.excusedFor ? ' excused' : ''}` },
        h('button', {
          type: 'button',
          class: 'rollname',
          'aria-pressed': String(Boolean(row.marked)),
          disabled: !teacherMode && (locked || settled),
          onclick: () => setMark(row.name, row.marked ? null : 'present'),
        }, h('strong', {}, row.name), h('span', { class: row.late ? 'late' : '' }, rowNote(row))),
        (!locked || teacherMode) && !row.excusedFor && countsLateness(event) && lateControls(row),
        !row.excusedFor && (!locked || teacherMode) && ABSENCE_REASONS
          .filter(([reason]) => teacherMode || (reason === 'sick' && !settled))
          .map(([reason, label]) => h('button', {
            type: 'button',
            class: 'reason',
            'aria-pressed': String(row.status === reason && !row.lateMark),
            onclick: () => setMark(row.name, row.status === reason ? null : reason),
          }, t(label))),
        teacherMode && row.status === 'sick' && h('button', {
          type: 'button',
          class: 'reason certificate',
          'aria-pressed': String(!row.unconfirmed),
          onclick: () => setMark(row.name, 'sick', { confirmed: Boolean(row.unconfirmed), at: row.at }),
        }, t('Справка принята')));
    })));
    const history = doc?.history ?? [];
    log.hidden = !history.length;
    log.replaceChildren(
      h('h3', {}, t('Исправления после фиксации: {0}', [history.length])),
      h('ul', {}, [...history].reverse().map((entry) => h('li', {},
        t('{0}, {1}. {2}: {3} на {4}', [stampText(entry.at), entry.teacher, entry.name, markText(entry.before), markText(entry.after)])))),
    );
    drawFooter(doc);
  }

  search.addEventListener('input', draw);
  redrawRoll = draw;
  draw();
  dialog.replaceChildren(
    h('div', { class: 'sheethead' },
      h('div', {},
        h('h2', {}, event.title),
        h('p', { class: 'help' }, `${typeLabel(event.type)}, ${fmt(event.date, { day: 'numeric', month: 'long' })}, ${timeRange(event)}`)),
      closeButton(dialog)),
    h('div', { class: 'sheetbody' }, banner, startBox, summary, failure, h('div', { class: 'field' }, search), list, log),
    footer,
  );
  dialog.showModal();
}

/* Служебная записка */

/** Формирует записку об освобождении от занятий и показывает, где она лежит. */
async function createMemo(event) {
  const dialog = $('memo');
  const today = now().iso;
  const memo = memoData(event, refsOf('student'), refsOf('group'), today);
  const result = await api.createMemo(memo, t('Записка {0} {1}', [event.date, event.title]));
  const note = h('p', { class: 'error' });
  dialog.replaceChildren(
    h('div', { class: 'sheethead' },
      h('h2', {}, result.ok ? t('Служебная записка готова') : t('Записка не сформирована')),
      closeButton(dialog)),
    h('div', { class: 'sheetbody' },
      result.ok
        ? [
          h('p', {}, t('Освобождение от занятий: {0}.', [peopleCount(event.participants.length)])),
          h('p', { class: 'help memofile' }, t('Документы, папка «Служебные записки»: {0}', [result.value])),
        ]
        : h('p', {}, t('Не удалось записать файл в папку «Документы». Проверьте свободное место и попробуйте ещё раз кнопкой в карточке события.')),
      note),
    result.ok && h('div', { class: 'sheetfoot' },
      h('button', {
        class: 'primary',
        type: 'button',
        onclick: async () => {
          const opened = await api.openMemo();
          if (opened.ok) dialog.close();
          else note.textContent = t('На этом компьютере нет программы для файлов Word. Откройте записку на другом компьютере.');
        },
      }, t('Открыть')),
      h('button', { class: 'plain', type: 'button', onclick: () => api.revealMemo() }, t('Показать в папке'))),
  );
  if (!dialog.open) dialog.showModal();
}

/* Техническое задание */

const checkBox = () => h('span', { class: 'box', 'aria-hidden': 'true' });

/** Лист чек-листа. Один и тот же для предпросмотра и печати. */
function paperSheet(event) {
  const date = fmt(event.date, { day: 'numeric', month: 'long', year: 'numeric' });
  const weekday = fmt(event.date, { weekday: 'long' });
  const groupNames = new Map(refsOf('group').map((group) => [group.id, group.name]));
  const groupOf = new Map(refsOf('student').map((student) => [nameKey(student.name), groupNames.get(student.groupId)]));
  const fact = (name, value) => (value ? [h('dt', {}, name), h('dd', {}, value)] : []);
  const tasks = event.notes.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const gear = event.equipment.map((name) => h('tr', {},
    h('td', {}, name === OWN_CAMERA ? t(OWN_CAMERA) : name),
    h('td', { class: 'num' }, String(equipmentCount(event, name))),
    h('td', { class: 'mark' }, checkBox()),
    h('td', { class: 'mark' }, checkBox()),
    h('td', { class: 'mark' }, checkBox())));

  return h('article', { class: 'paper' },
    h('header', {},
      h('p', { class: 'kicker' }, t('Техническое задание на {0}', [date])),
      h('h2', {}, event.title)),
    h('dl', {},
      fact(t('Тип'), typeLabel(event.type)),
      fact(t('День'), `${weekday}, ${date}`),
      fact(t('Время'), timeRange(event)),
      fact(t('Подготовка'), prepText(event)),
      event.deadline ? fact(deadlineLabel(event.type), momentText(event.deadline)) : [],
      fact(t('Место'), event.place),
      fact(t('Ответственный'), event.responsible),
      fact(t('Участников'), event.participants.length ? String(event.participants.length) : '')),
    h('section', {},
      h('h3', {}, t('Техника')),
      gear.length
        ? h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, t('Наименование')),
            h('th', { class: 'num' }, t('Кол-во')),
            h('th', { class: 'mark' }, t('Подготовлено')),
            h('th', { class: 'mark' }, t('Выдано')),
            h('th', { class: 'mark' }, t('Возвращено')))),
          h('tbody', {}, gear))
        : h('p', {}, t('Техника не указана.')),
      event.ownCameras.length > 0 && h('p', { class: 'own' }, t('Со своей камерой: {0}.', [event.ownCameras.join(', ')]))),
    tasks.length > 0 && h('section', {},
      h('h3', {}, t('Задачи')),
      h('ul', { class: 'checks' }, tasks.map((task) => h('li', {}, checkBox(), h('span', {}, task))))),
    event.participants.length > 0 && h('section', {},
      h('h3', {}, t('Участники')),
      h('ul', { class: 'checks people' }, event.participants.map((name) => {
        const group = groupOf.get(nameKey(name));
        return h('li', {}, checkBox(), h('span', {}, group ? `${name}, ${group}` : name));
      }))),
    h('footer', {},
      h('p', {}, h('span', {}, t('Ответственный')), h('i'), h('span', {}, event.responsible || t('подпись'))),
      h('p', {}, h('span', {}, t('Технику принял')), h('i'), h('span', {}, t('подпись')))));
}

/** Кнопки печати и PDF. На бумагу идёт лист, который sheet() кладёт в область печати. */
function printButtons(sheet, fileName) {
  const failure = h('p', { class: 'message error' });
  const prepare = () => {
    failure.textContent = '';
    $('printarea').replaceChildren(sheet());
  };
  return [
    h('button', {
      class: 'primary',
      type: 'button',
      onclick: async () => {
        prepare();
        const result = await api.printPaper();
        if (!result.ok) failure.textContent = t('Не удалось напечатать. Проверьте принтер или сохраните PDF.');
      },
    }, t('Печать')),
    h('button', {
      class: 'plain',
      type: 'button',
      onclick: async () => {
        prepare();
        const result = await api.savePaperPdf(fileName(), t('Сохранить PDF'));
        if (!result.ok) failure.textContent = t('PDF не сохранён: нет доступа к выбранной папке.');
        else if (result.value) toast(t('PDF сохранён.'));
      },
    }, t('Сохранить PDF')),
    failure,
  ];
}

function openPaper(id) {
  const event = state.allEvents.find((e) => e.id === id);
  if (!event) return;
  const dialog = $('paper');
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Техническое задание')), closeButton(dialog)),
    h('div', { class: 'sheetbody paperview' }, paperSheet(event)),
    h('div', { class: 'sheetfoot' }, printButtons(() => paperSheet(event), () => t('ТЗ {0} {1}.pdf', [event.title, event.date]))),
  );
  dialog.showModal();
}

/* Отчёты */

const TYPE_FILTERS = [
  ['classes', t('Все пары'), ['lesson', 'practice', 'task']],
  ...EVENT_TYPES.map(([id, label]) => [id, t(label), [id]]),
  ['all', t('Всё, включая мероприятия'), EVENT_TYPES.map(([id]) => id)],
];

const reports = { tab: 'pairs', from: '', to: '', type: 'classes', group: '', teacher: '' };

const shownPercent = (value) => (value === null ? t('нет данных') : `${value}%`);
const shortDate = (iso) => fmt(iso, { day: '2-digit', month: '2-digit', year: 'numeric' });

const COUNTS = [
  [t('Были'), (r) => r.present],
  [t('Опоздали'), (r) => r.late],
  [t('Болезнь'), (r) => r.sick],
  [t('По приказу'), (r) => r.order],
  [t('Уважительная'), (r) => r.excused],
  [t('Без причины'), (r) => r.absent],
  ['%', (r) => shownPercent(r.percent)],
  [t('Без справки'), (r) => r.noCertificate],
];

const REPORT_TABS = [
  ['pairs', t('Проведённые пары'), t('Пары'), [
    [t('Дата'), (r) => shortDate(r.event.date)],
    [t('Время'), (r) => timeRange(r.event)],
    [t('Тип'), (r) => typeLabel(r.event.type)],
    [t('Название'), (r) => r.event.title],
    [t('Преподаватель'), (r) => r.event.responsible],
    [t('Группы'), (r) => r.groups.join(', ')],
    [t('Место'), (r) => r.event.place],
    [t('Начало'), (r) => (r.delay ? `${clockTime(r.startedAt)} (+${r.delay})` : '')],
    [t('Зафиксировал'), (r) => r.locked?.teacher ?? ''],
    [t('Всего'), (r) => r.total],
    ...COUNTS,
  ]],
  ['students', t('Посещаемость студентов'), t('Студенты'), [
    [t('Группа'), (r) => r.group],
    [t('Студент'), (r) => r.name],
    [t('Пар'), (r) => r.total],
    ...COUNTS,
  ]],
  ['groups', t('По группам'), t('Группы'), [
    [t('Группа'), (r) => t(r.name)],
    [t('Всего мест'), (r) => r.total],
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
  const label = tp('pairsHeld', pairs);
  return total ? t('{0}. Посещаемость: {1}%', [label, Math.round((present / total) * 100)]) : label;
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
      : h('p', { class: 'help' }, t('За этот период проведённых пар нет. Измените период или условия отбора.')),
  );
}

/** Лист отчёта для печати и PDF. */
function reportSheet() {
  const report = currentReport();
  const [tab, title, , columns] = REPORT_TABS.find(([id]) => id === reports.tab);
  const conditions = [
    TYPE_FILTERS.find(([id]) => id === reports.type)[1],
    reports.group && t('группа {0}', [reports.group]),
    reports.teacher && t('преподаватель {0}', [reports.teacher]),
  ].filter(Boolean).join(', ');
  const rows = report[tab];
  return h('article', { class: 'paper reportpaper' },
    h('header', {},
      h('p', { class: 'kicker' }, t('Отчёт за {0}–{1}: {2}', [shortDate(reports.from), shortDate(reports.to), conditions])),
      h('h2', {}, title)),
    h('p', { class: 'own' }, reportSummary(report)),
    rows.length > 0
      ? h('table', {},
        h('thead', {}, h('tr', {}, columns.map(([name]) => h('th', {}, name)))),
        h('tbody', {}, rows.map((row) => h('tr', {}, columns.map(([, value]) => h('td', {}, String(value(row) ?? '')))))))
      : h('p', { class: 'own' }, t('За этот период проведённых пар нет.')),
    h('p', { class: 'stamp' }, t('Сформировано {0}', [fmt(now().iso, { day: 'numeric', month: 'long', year: 'numeric' })])));
}

async function exportReport() {
  const report = currentReport();
  const [tab, , fileName, columns] = REPORT_TABS.find(([id]) => id === reports.tab);
  const csv = toCsv(columns.map(([name]) => name), report[tab].map((row) => columns.map(([, value]) => value(row))));
  const result = await api.saveReport(`${fileName} ${reports.from} ${reports.to}.csv`, csv, { title: t('Сохранить отчёт'), filter: t('Таблица для Excel') });
  if (!result.ok) toast(t('Отчёт не сохранён: нет доступа к выбранной папке.'));
  else if (result.value) toast(t('Отчёт сохранён.'));
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

  const teachers = uniqueValues([...refsOf('teacher').map((teacher) => teacher.name), ...state.allEvents.map((e) => e.responsible)]);
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': t('Вид отчёта') });
  const drawTabs = () => tabs.replaceChildren(...REPORT_TABS.map(([id, label]) => h('button', {
    type: 'button',
    'aria-pressed': String(reports.tab === id),
    onclick: () => { reports.tab = id; drawTabs(); refresh(); },
  }, label)));
  drawTabs();
  refresh();
  const printBar = printButtons(reportSheet, () => t('Отчёт {0} {1} {2}.pdf', [REPORT_TABS.find(([id]) => id === reports.tab)[2], reports.from, reports.to]));

  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Отчёты')), closeButton(dialog)),
    tabs,
    h('div', { class: 'reportfilters' },
      dateField('rp-from', t('С'), 'from'),
      dateField('rp-to', t('По'), 'to'),
      selectField('rp-type', t('Что считать'), 'type', TYPE_FILTERS.map(([id, label]) => [id, label])),
      selectField('rp-group', t('Группа'), 'group', [['', t('Все группы')], ...refsOf('group').map((g) => [g.name, g.name])]),
      selectField('rp-teacher', t('Преподаватель'), 'teacher', [['', t('Все преподаватели')], ...teachers.map((name) => [name, name])])),
    h('div', { class: 'sheetbody' }, result),
    h('div', { class: 'sheetfoot' },
      printBar[0],
      printBar[1],
      h('button', { class: 'plain', type: 'button', onclick: exportReport }, t('Сохранить для Excel')),
      printBar[2]),
  );
  dialog.showModal();
}

/* Тамагочи */

const PET_KEY = 'pet-group';

const MOODS = {
  play: (name) => t('{0} отлично себя чувствует и играет', [name]),
  fine: (name) => t('{0} здоров и доволен', [name]),
  sad: (name) => t('{0} грустит: студенты стали опаздывать и пропускать', [name]),
  sick: (name) => t('{0} болеет. Без посещений ему станет хуже', [name]),
};

function savedPetGroup() {
  try {
    return localStorage.getItem(PET_KEY);
  } catch {
    return null;
  }
}

function rememberPetGroup(id) {
  try {
    localStorage.setItem(PET_KEY, id);
  } catch { /* выбор просто не запомнится */ }
}

/** У подгрупп нет своего питомца: он общий для всей группы. */
const petGroups = () => refsOf('group').filter((group) => !parentGroup(group, refsOf('group')));

function currentPetGroup() {
  const groups = petGroups();
  return groups.find((group) => group.id === savedPetGroup()) ?? groups[0] ?? null;
}

function petOf(group) {
  const clock = now();
  return petStatus({
    group,
    groups: refsOf('group'),
    students: refsOf('student'),
    events: state.allEvents,
    attendance: state.attendance,
    nowISO: clock.iso,
    nowTime: clock.time,
  });
}

const petTitle = (group) => group.petName || t('Безымянный питомец');

let petButtonKey = '';

/** Кнопка внизу экрана. Перерисовывается только при смене настроения, чтобы не сбивать анимацию. */
function refreshPet() {
  const button = $('pet-open');
  const group = currentPetGroup();
  button.hidden = !group;
  refreshTicker();
  if (!group) return;
  const pet = petOf(group);
  const key = `${group.id}:${group.petName}:${pet.mood}:${pet.health}`;
  if (key !== petButtonKey) {
    petButtonKey = key;
    button.setAttribute('aria-label', t('Тамагочи группы {0}', [group.name]));
    button.replaceChildren(petSprite(pet.mood), h('span', {}, group.petName || group.name));
    if ($('pet').open) drawPet();
  }
}

function petStats(pet) {
  if (pet.mood === 'dead') {
    return [t('Посещаемость группы довела питомца до смерти. Последняя пара: {0}.', [fmt(pet.diedOn, { day: 'numeric', month: 'long' })])];
  }
  if (!pet.last) return [t('Пока нет отмеченных пар. Здоровье зависит от посещаемости группы.')];
  const { last } = pet;
  return [
    t('Учтено пар: {0}', [pet.counted]),
    t('Последняя: {0}, {1}. Пришли {2} из {3}, опоздали {4}, пропустили {5}.', [last.title, fmt(last.date, { day: 'numeric', month: 'long' }), last.present, last.total, last.late, last.absent]),
  ];
}

const shortDay = (iso) => fmt(iso, { day: 'numeric', month: 'long' });

/** График здоровья по парам. Одна линия, подробности при наведении и касании. */
function healthChart(pet) {
  if (!pet.timeline.length) return null;
  const levels = pet.timeline.map((point) => point.health);
  const summary = h('p', { class: 'help' }, t('Питомец с {0}. Учтено пар: {1}. Здоровье от {2} до {3}', [shortDay(pet.bornOn), pet.counted, Math.min(...levels), Math.max(...levels)]));
  if (pet.timeline.length < 2) return h('section', { class: 'petsection' }, h('h3', {}, t('Здоровье по парам')), summary);
  const points = pet.timeline.slice(-30);
  const width = 400;
  const height = 130;
  const left = 30;
  const top = 8;
  const plot = height - top - 8;
  const ns = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const x = (i) => left + (i / (points.length - 1)) * (width - left - 10);
  const y = (health) => top + (1 - health / 100) * plot;
  const svg = make('svg', { viewBox: `0 0 ${width} ${height}`, class: 'healthchart', role: 'img', 'aria-label': t('Здоровье по парам') });
  for (const level of [0, 50, 100]) {
    svg.append(make('line', { x1: left, x2: width - 10, y1: y(level), y2: y(level), class: 'grid' }));
    const label = make('text', { x: left - 6, y: y(level) + 3.5, class: 'axis' });
    label.textContent = String(level);
    svg.append(label);
  }
  svg.append(make('polyline', { class: 'healthline', points: points.map((p, i) => `${x(i)},${y(p.health)}`).join(' ') }));
  const end = points.at(-1);
  const marker = make('circle', { class: 'healthdot', cx: x(points.length - 1), cy: y(end.health), r: 4.5 });
  svg.append(marker);
  const caption = h('p', { class: 'help healthcaption' });
  const describe = (p) => t('{0}, {1}: здоровье {2}', [shortDay(p.date), p.title, p.health]);
  caption.textContent = describe(end);
  const step = (width - left - 10) / (points.length - 1);
  points.forEach((p, i) => {
    const target = make('rect', { x: x(i) - step / 2, y: 0, width: step, height, class: 'healthhit' });
    const show = () => {
      caption.textContent = describe(p);
      marker.setAttribute('cx', x(i));
      marker.setAttribute('cy', y(p.health));
    };
    target.addEventListener('pointerenter', show);
    target.addEventListener('pointerdown', show);
    svg.append(target);
  });
  return h('section', { class: 'petsection' }, h('h3', {}, t('Здоровье по парам')), svg, caption, summary);
}

/** Записанные смерти и питомец, который умер, но ещё не заменён новым. */
function deathsOf(group) {
  const pet = petOf(group);
  const current = pet.diedOn ? [{ name: group.petName ?? '', bornOn: pet.bornOn, diedOn: pet.diedOn, pairs: pet.counted }] : [];
  return [...(group.petDeaths ?? []), ...current];
}

function petGraves(group) {
  const deaths = deathsOf(group);
  if (!deaths.length) return null;
  return h('section', { class: 'petsection' },
    h('h3', {}, t('Умерло питомцев: {0}', [deaths.length])),
    h('ul', { class: 'petdeaths' }, [...deaths].reverse().map((death) => h('li', {},
      h('strong', {}, death.name || t('Безымянный питомец')),
      h('span', {}, t('{0} – {1}, пар: {2}', [shortDay(death.bornOn), shortDay(death.diedOn), death.pairs]))))));
}

function petOverview(groups) {
  if (groups.length < 2) return null;
  return h('section', { class: 'petsection' },
    h('h3', {}, t('Все группы')),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, [t('Группа'), t('Питомец'), t('Здоровье'), t('Умерло')].map((name) => h('th', { scope: 'col' }, name)))),
      h('tbody', {}, groups.map((group) => {
        const pet = petOf(group);
        return h('tr', {},
          h('td', {}, group.name),
          h('td', {}, group.petName || '–'),
          h('td', {}, pet.mood === 'dead' ? t('Умер') : String(pet.health)),
          h('td', {}, String(deathsOf(group).length)));
      })))));
}

function drawPet() {
  const dialog = $('pet');
  const groups = petGroups();
  const group = currentPetGroup();
  if (!group) {
    dialog.close();
    return;
  }
  const pet = petOf(group);
  const prizes = petPrizes(pet);
  const look = petLook(group.petLook, prizes);
  const failure = h('p', { class: 'error' });

  const saveGroup = async (changes) => {
    const result = await api.saveRefs([{ ref: { ...group, ...changes }, base: group.updatedAt }]);
    if (!result.ok) {
      failure.textContent = t('Не удалось сохранить. Попробуйте ещё раз.');
      return;
    }
    await loadDirectory();
    petButtonKey = '';
    refreshPet();
    drawPet();
  };

  const name = h('input', { id: 'pet-name', value: group.petName ?? '', maxlength: 24, placeholder: t('Придумайте имя'), autocomplete: 'off', 'aria-label': t('Имя питомца') });
  const saveName = () => saveGroup({ petName: name.value });
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveName();
    }
  });

  const stage = h('button', {
    type: 'button',
    class: 'petstage',
    'aria-label': pet.mood === 'dead' ? t('Надгробие') : t('Погладить питомца'),
    onclick: () => {
      if (pet.mood === 'dead') return;
      const heart = h('span', { class: 'petheart', 'aria-hidden': 'true' }, '♥');
      stage.append(heart);
      setTimeout(() => heart.remove(), 900);
    },
  }, petSprite(pet.mood, look));

  const meter = h('div', { class: 'petmeter' }, h('i'));
  meter.firstChild.style.width = `${pet.health}%`;
  meter.firstChild.className = `level-${pet.mood}`;

  const titleLine = pet.mood === 'dead'
    ? t('{0}: питомец умер', [petTitle(group)])
    : MOODS[pet.mood](petTitle(group));

  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Тамагочи')), closeButton(dialog)),
    h('div', { class: 'sheetbody' },
      groups.length > 1 && h('div', { class: 'targets petgroups', role: 'group', 'aria-label': t('Группа') }, groups.map((item) => h('button', {
        type: 'button',
        'aria-pressed': String(item.id === group.id),
        onclick: () => {
          rememberPetGroup(item.id);
          petButtonKey = '';
          refreshPet();
          drawPet();
        },
      }, item.name))),
      stage,
      h('p', { class: 'petmood' }, titleLine),
      pet.mood !== 'dead' && h('div', { class: 'petlevel' }, meter, h('span', {}, t('Здоровье {0} из 100', [pet.health]))),
      petStats(pet).map((line) => h('p', { class: 'help' }, line)),
      canManage() && (pet.mood === 'dead'
        ? h('button', {
          type: 'button',
          class: 'primary petnew',
          onclick: () => {
            const clock = now();
            saveGroup({ petName: '', petSince: `${clock.iso}T${clock.time}`, petDeaths: deathsOf(group) });
          },
        }, t('Завести нового питомца'))
        : h('div', { class: 'field petname' },
          h('div', { class: 'adder' }, name, h('button', { type: 'button', onclick: saveName }, t('Назвать'))))),
      failure,
      pet.mood !== 'dead' && prizeSection(pet, prizes, look, (next) => saveGroup({ petLook: next })),
      healthChart(pet),
      petGraves(group),
      petOverview(groups),
      h('p', { class: 'help' }, t('Питомец живёт посещаемостью группы: пропуски без причины и опоздания вредят ему, хорошая посещаемость лечит. Уважительные причины не вредят.'))),
  );
}

/** Призы питомца: полученные, следующий и наряд, который выбирает преподаватель. */
function prizeSection(pet, prizes, look, saveLook) {
  const owned = new Map(prizes.earned.map((prize) => [prize.id, prize]));
  const progress = prizes.next
    ? t('До приза «{0}»: {1} из {2} дней подряд со здоровьем 100.', [t(prizes.next.name), prizes.streak, PRIZE_DAYS])
    : t('Все призы получены. Каждые {0} дня подряд со здоровьем 100 приносят звезду.', [PRIZE_DAYS]);
  const tiles = h('ul', { class: 'prizes' }, PRIZES.map((prize) => {
    const got = owned.get(prize.id);
    return h('li', { class: `prize${got ? '' : ' locked'}`, 'data-prize': prize.id },
      prizeIcon(prize.id),
      h('strong', {}, t(prize.name)),
      h('span', { class: 'help' }, got ? t('получен {0}', [shortDay(got.date)]) : t('ещё не получен')));
  }));
  const slot = (name, label, kind) => {
    const options = prizes.earned.filter((prize) => prize.slot === kind);
    if (!options.length) return null;
    return h('div', { class: 'prizeslot' },
      h('span', { class: 'help' }, label),
      h('div', { class: 'targets', role: 'group', 'aria-label': label },
        [{ id: '' }, ...options].map((prize) => h('button', {
          type: 'button',
          'aria-pressed': String(look[name] === prize.id),
          onclick: () => {
            const next = { ...look, [name]: prize.id };
            // Один предмет не может стоять сразу с двух сторон.
            if (kind === 'side' && prize.id) for (const other of ['left', 'right']) if (other !== name && next[other] === prize.id) next[other] = '';
            saveLook(next);
          },
        }, prize.id ? t(prize.name) : t('Ничего')))));
  };
  return h('section', { class: 'petsection' },
    h('h3', {}, prizes.stars ? t('Призы и звёзды: ★ × {0}', [prizes.stars]) : t('Призы')),
    h('p', { class: 'help' }, progress),
    tiles,
    canManage() && prizes.earned.length > 0 && h('div', { class: 'prizelook' },
      slot('head', t('На голове'), 'head'),
      slot('left', t('Слева'), 'side'),
      slot('right', t('Справа'), 'side')));
}

/* Бегущая строка */

const TICKER_REM_PER_SECOND = 5.5; // примерно 9 знаков в секунду: читается на ходу
const NOTICE_COLORS = [['blue', t('Синий')], ['green', t('Зелёный')], ['yellow', t('Жёлтый')], ['red', t('Красный')]];

const moment = () => {
  const clock = now();
  return `${clock.iso}T${clock.time}`;
};

let tickerKey = '';

const MAX_DEADLINE_ALERTS = 5;
const PET_ALERT_COLORS = { dead: 'red', sick: 'red', sad: 'yellow', fine: 'green', play: 'green' };

function deadlineItems() {
  const alerts = deadlineAlerts(state.events, moment());
  const items = alerts.slice(0, MAX_DEADLINE_ALERTS).map(({ event, late }) => ({
    id: `deadline-${event.id}`,
    color: late ? 'red' : 'yellow',
    name: late
      ? t('Просрочено: {0}, срок был {1}', [event.title, momentText(event.deadline)])
      : t('{0}: {1}, до {2}', [deadlineLabel(event.type), event.title, momentText(event.deadline)]),
  }));
  const rest = alerts.length - items.length;
  if (rest > 0) items.push({ id: 'deadline-rest', color: 'yellow', name: t('Ещё сроков: {0}', [rest]) });
  return items;
}

function certificateItems() {
  const people = pendingCertificates(state.attendance, state.allEvents);
  const items = people.slice(0, MAX_DEADLINE_ALERTS).map((person) => ({
    id: `certificate-${person.name}`,
    color: 'yellow',
    name: t('{0}: предъявите справку для подтверждения больничного', [person.name]),
  }));
  const rest = people.length - items.length;
  if (rest > 0) items.push({ id: 'certificate-rest', color: 'yellow', name: t('Ещё ждём справки: {0}', [rest]) });
  return items;
}

function petItems() {
  const clock = now();
  return petGroups().flatMap((group) => {
    // Только критическое: питомец болен, пока болеет, или недавно умер.
    const pet = petOf(group);
    const change = petChange(pet, clock.iso);
    const critical = pet.mood === 'sick' || (pet.mood === 'dead' && change?.to === 'dead');
    if (!critical) return [];
    const name = petTitle(group);
    const text = pet.mood === 'dead' ? t('{0}: питомец умер', [name]) : MOODS.sick(name);
    return [{ id: `pet-${group.id}`, color: 'red', name: t('Группа {0}: {1}', [group.name, text]) }];
  });
}

/** Перезапускает строку, только если изменилось содержимое: иначе она бы дёргалась. */
function refreshTicker() {
  const notices = [...activeNotices(refsOf('notice'), moment()), ...deadlineItems(), ...certificateItems(), ...petItems()];
  const box = $('ticker');
  $('notices-open').hidden = isClient();
  const key = JSON.stringify([notices.map((notice) => [notice.id, notice.name, notice.color]), box.clientWidth]);
  if (key === tickerKey) return;
  tickerKey = key;
  box.hidden = !notices.length;
  const track = box.firstElementChild;
  track.replaceChildren(...notices.map((notice) => h('span', { class: `notice notice-${notice.color}` }, notice.name)));
  if (!notices.length) return;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const distance = box.clientWidth + track.scrollWidth;
  track.style.setProperty('--from', `${box.clientWidth}px`);
  track.style.setProperty('--to', `${-track.scrollWidth}px`);
  track.style.animation = 'none';
  void track.offsetWidth;
  track.style.animation = '';
  track.style.animationDuration = `${distance / (TICKER_REM_PER_SECOND * rem)}s`;
  // Ширина могла измениться, когда строка появилась на экране.
  tickerKey = JSON.stringify([notices.map((notice) => [notice.id, notice.name, notice.color]), box.clientWidth]);
}

const noticeEditor = { id: null, base: null };

function openNotices() {
  noticeEditor.id = null;
  drawNotices();
  $('notices').showModal();
}

function drawNotices() {
  const dialog = $('notices');
  const editing = refsOf('notice').find((notice) => notice.id === noticeEditor.id);
  const clock = now();
  const text = h('textarea', { id: 'n-text', maxlength: 200, placeholder: t('Текст напоминания') }, editing?.name ?? '');
  const until = h('input', { id: 'n-until', type: 'datetime-local', value: editing?.until ?? `${addDays(clock.iso, 1)}T18:00` });
  let color = editing?.color ?? 'blue';
  const failure = h('p', { class: 'error' });
  const days = (count) => h('button', {
    type: 'button',
    onclick: () => { until.value = `${addDays(clock.iso, count)}T18:00`; },
  }, tp('days', count));
  const saveNotice = async () => {
    const name = text.value.trim();
    if (!name) { failure.textContent = t('Введите текст напоминания'); return; }
    if (until.value <= moment()) { failure.textContent = t('Срок должен быть позже текущего времени'); return; }
    const ref = { ...(editing ?? { kind: 'notice' }), name, color, until: until.value };
    const result = await api.saveRefs([{ ref, base: editing?.updatedAt ?? null }]);
    if (!result.ok) { failure.textContent = storeMessage(result); return; }
    noticeEditor.id = null;
    await reloadNotices();
  };
  const notices = [...refsOf('notice')].sort((a, b) => b.until.localeCompare(a.until));

  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Напоминания')), closeButton(dialog)),
    h('div', { class: 'sheetbody' },
      h('p', { class: 'help noticehelp' }, t('Строка показывается внизу экрана на всех устройствах сети. Управлять ею могут только преподаватели.')),
      h('p', { class: 'help noticehelp' }, t('Сроки сдачи, ожидаемые справки и изменения состояния питомцев попадают в строку сами, здесь их нет.')),
      h('div', { class: 'field' }, h('label', { for: 'n-text' }, t('Текст')), text),
      h('div', { class: 'field settingnext' }, h('span', { class: 'label' }, t('Цвет')),
        choiceRow(NOTICE_COLORS, color, (id) => { color = id; })),
      h('div', { class: 'field settingnext' }, h('label', { for: 'n-until' }, t('Показывать до')), until,
        h('div', { class: 'targets prepchoices' }, [1, 3, 7].map(days))),
      failure,
      h('div', { class: 'noticeactions' },
        h('button', { class: 'primary', type: 'button', onclick: saveNotice }, editing ? t('Сохранить') : t('Добавить в строку')),
        editing && h('button', { class: 'plain', type: 'button', onclick: () => { noticeEditor.id = null; drawNotices(); } }, t('Отмена'))),
      notices.length > 0 && h('ul', { class: 'reflist noticelist' }, notices.map((notice) => {
        const expired = notice.until <= moment();
        return h('li', { class: 'refrow' },
          h('div', { class: 'refname' },
            h('p', {}, h('span', { class: `noticemark notice-${notice.color}` }), notice.name),
            h('span', {}, expired ? t('Срок вышел') : t('До {0}', [noticeUntil(notice)]))),
          h('button', { type: 'button', class: 'plain', onclick: () => { noticeEditor.id = notice.id; drawNotices(); } }, t('Изменить')),
          h('button', {
            type: 'button',
            class: 'plain',
            onclick: async () => {
              await api.removeRefs([{ id: notice.id, base: notice.updatedAt }]);
              await reloadNotices();
            },
          }, t('Удалить')));
      }))),
  );
}

const momentText = (value) => `${shortDay(value.slice(0, 10))}, ${value.slice(11)}`;
const noticeUntil = (notice) => momentText(notice.until);

async function reloadNotices() {
  const fresh = await api.directory();
  if (fresh.ok) state.directory = fresh.value;
  refreshTicker();
  drawNotices();
}

const repeatLabel = (every) => t(REPEATS.find(([id]) => id === every)?.[1] ?? '');

/* Сроки сдачи */

const DEADLINE_TYPES = ['task', 'event'];

const deadlineLabel = (type) => (type === 'task' ? t('Срок сдачи') : t('Срок сдачи материалов'));

function deadlineFact(event) {
  const when = momentText(event.deadline);
  const status = deadlineState(event, moment());
  if (status === 'done') return t('{0}. Сдано: {1}', [when, momentText(event.deadlineDone)]);
  return status === 'overdue' ? t('{0}. Просрочено', [when]) : when;
}

async function setDeadlineDone(event, done) {
  const result = await api.save({ ...event, deadlineDone: done ? moment() : '' }, event.updatedAt);
  if (!result.ok) {
    toast(storeMessage(result));
    return false;
  }
  setEvents([...state.allEvents.filter((x) => x.id !== result.value.id), result.value]);
  render();
  return true;
}

function deadlineTable(title, events, late = false) {
  if (!events.length) return null;
  return h('section', { class: 'petsection' },
    h('h3', { class: late ? 'deadlinelate' : '' }, t('{0}: {1}', [title, events.length])),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, [t('Событие'), t('Что сдать'), t('Срок'), t('Ответственный'), t('Участники'), ''].map((name) => h('th', { scope: 'col' }, name)))),
      h('tbody', {}, events.map((event) => h('tr', {},
        h('td', {}, h('button', { class: 'linkbutton', onclick: () => { $('deadlines').close(); showDetails(event.id); } }, event.title)),
        h('td', {}, event.type === 'task' ? t('Задание') : t('Материалы')),
        h('td', {}, event.deadlineDone ? t('{0}. Сдано: {1}', [momentText(event.deadline), momentText(event.deadlineDone)]) : momentText(event.deadline)),
        h('td', {}, event.responsible || t('Не указан')),
        h('td', {}, String(event.participants.length)),
        h('td', {}, canManage() && h('button', {
          class: 'plain',
          onclick: () => setDeadlineDone(event, !event.deadlineDone),
        }, event.deadlineDone ? t('Вернуть в работу') : t('Отметить сдачу')))))))));
}

/** Одна справка закрывает все занятия, на которых студент числится больным. */
async function acceptCertificate(person) {
  for (const { event, at } of person.classes) await api.mark(event.id, person.name, 'sick', { confirmed: true, at });
  await refresh();
  refreshTicker();
  drawDeadlines();
}

function certificateTable() {
  const people = pendingCertificates(state.attendance, state.allEvents);
  if (!people.length) return null;
  return h('section', { class: 'petsection' },
    h('h3', {}, t('Ждём справку: {0}', [people.length])),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, [t('Студент'), t('Занятия'), ''].map((name) => h('th', { scope: 'col' }, name)))),
      h('tbody', {}, people.map((person) => h('tr', {},
        h('td', {}, person.name),
        h('td', {}, person.classes.map(({ event }) => `${shortDay(event.date)}, ${event.title}`).join('; ')),
        h('td', {}, canManage() && h('button', { class: 'plain', onclick: () => acceptCertificate(person) }, t('Справка принята')))))))));
}

function drawDeadlines() {
  const box = $('deadlines-result');
  if (!box) return;
  const list = deadlineList(state.events, moment());
  const certificates = certificateTable();
  const empty = !certificates && !Object.values(list).some((events) => events.length);
  const sections = [
    certificates,
    empty && h('p', { class: 'help' }, t('Сроков пока нет. Укажите срок сдачи в задании или мероприятии.')),
    deadlineTable(t('Просрочено'), list.overdue, true),
    deadlineTable(t('Сегодня и завтра'), list.soon),
    deadlineTable(t('Позже'), list.later),
    deadlineTable(t('Сдано'), list.done.slice(0, 30)),
  ];
  keepScroll(box, () => box.replaceChildren(...sections.filter(Boolean)));
}

function openDeadlines() {
  const dialog = $('deadlines');
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Сроки сдачи')), closeButton(dialog)),
    h('div', { class: 'sheetbody', id: 'deadlines-result' }),
  );
  drawDeadlines();
  dialog.showModal();
}

/** Счётчик на кнопке и открытый список. На кнопке только то, что требует внимания. */
function refreshDeadlines() {
  const list = deadlineList(state.events, moment());
  const badge = $('deadline-count');
  const count = list.overdue.length + list.soon.length;
  badge.hidden = !count;
  badge.textContent = String(count);
  badge.classList.toggle('late', list.overdue.length > 0);
  if ($('deadlines').open) drawDeadlines();
}

/* Журнал изменений событий */

const journalView = { query: '', limit: 200, entries: [] };

const LIST_FIELDS = new Set(['participants', 'equipment', 'ownCameras', 'devices']);

/** Значение поля по-человечески. */
function journalValue(field, value) {
  if (value === null || value === '' || (Array.isArray(value) && !value.length)) return '—';
  if (field === 'type') return typeLabel(value);
  if (field === 'date') return fmt(value, { day: 'numeric', month: 'long', year: 'numeric' });
  if (field === 'allDay') return value ? t('да') : t('нет');
  if (field === 'deadline' || field === 'deadlineDone') return stampText(value);
  if (field === 'prepMinutes') return t('{0} мин', [value]);
  if (field === 'equipmentQty') return Object.entries(value).map(([name, n]) => `${name} ×${n}`).join(', ') || '—';
  if (field === 'devices') return value.map(deviceName).join(', ');
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/** Строка изменения поля. В списках видно, кого добавили и кого убрали. */
function journalField(item) {
  const label = t(JOURNAL_FIELD_LABELS[item.field] ?? item.field);
  if (LIST_FIELDS.has(item.field)) {
    const name = item.field === 'devices' ? deviceName : (x) => x;
    const before = item.before ?? [];
    const after = item.after ?? [];
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    return h('li', {}, h('span', { class: 'jfield' }, label),
      added.length > 0 && h('span', { class: 'jadded' }, t('добавлены: {0}', [added.map(name).join(', ')])),
      removed.length > 0 && h('span', { class: 'jremoved' }, t('убраны: {0}', [removed.map(name).join(', ')])));
  }
  return h('li', {}, h('span', { class: 'jfield' }, label),
    h('span', { class: 'jbefore' }, journalValue(item.field, item.before)),
    h('span', { 'aria-hidden': 'true' }, ' → '),
    h('span', { class: 'jafter' }, journalValue(item.field, item.after)));
}

function journalEntry(entry) {
  const when = entry.date ? `${fmt(entry.date, { day: 'numeric', month: 'long' })}, ${entry.start}–${entry.end}` : '';
  const what = [];
  if (entry.action === 'create-series') what.push(t('{0} с {1} по {2}', [tp('events', entry.count), fmt(entry.from, { day: 'numeric', month: 'long' }), fmt(entry.to, { day: 'numeric', month: 'long', year: 'numeric' })]));
  if (entry.action === 'delete-range') what.push(t('{0} с {1} по {2}', [tp('events', entry.count), fmt(entry.from, { day: 'numeric', month: 'long' }), fmt(entry.to, { day: 'numeric', month: 'long', year: 'numeric' })]));
  if (entry.action === 'restore') what.push(t('Записей: {0}', [entry.count]));
  const exists = entry.eventId && state.allEvents.some((e) => e.id === entry.eventId);
  return h('li', { class: `jentry j-${entry.action}` },
    h('div', { class: 'jhead' },
      h('time', { datetime: entry.at }, new Date(entry.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })),
      h('strong', {}, t(JOURNAL_ACTIONS[entry.action])),
      h('span', { class: 'help' }, entry.device || t('Неизвестное устройство'))),
    entry.title && h('div', { class: 'jevent' },
      exists
        ? h('button', { type: 'button', class: 'link', onclick: () => { $('journal').close(); showDetails(entry.eventId); } }, entry.title)
        : h('span', {}, entry.title),
      h('span', { class: 'help' }, [entry.type && typeLabel(entry.type), when].filter(Boolean).join(', '))),
    what.length > 0 && h('div', { class: 'help' }, what.join(', ')),
    entry.fields.length > 0 && h('ul', { class: 'jfields' }, entry.fields.map(journalField)),
  );
}

function drawJournal() {
  const box = $('journal-result');
  if (!box) return;
  const query = journalView.query.trim().toLocaleLowerCase(locale());
  const found = journalView.entries.filter((entry) => !query
    || `${entry.title} ${entry.device}`.toLocaleLowerCase(locale()).includes(query));
  if (!found.length) {
    box.replaceChildren(h('p', { class: 'help' }, journalView.entries.length ? t('Ничего не найдено.') : t('Изменений пока нет. Журнал хранит изменения событий за последние полгода.')));
    return;
  }
  const days = new Map();
  for (const entry of found.slice(0, journalView.limit)) {
    const day = new Date(entry.at).toLocaleDateString('sv');
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(entry);
  }
  keepScroll(box, () => box.replaceChildren(...[
    ...[...days].map(([day, entries]) => h('section', { class: 'jday' },
      h('h3', {}, fmt(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })),
      h('ul', { class: 'jlist' }, entries.map(journalEntry)))),
    found.length > journalView.limit && h('button', {
      type: 'button',
      class: 'plain',
      onclick: () => { journalView.limit += 200; drawJournal(); },
    }, t('Показать ещё')),
  ].filter(Boolean)));
}

async function loadJournal() {
  const result = await api.journal();
  if (!result.ok) return;
  journalView.entries = result.value;
  drawJournal();
}

async function openJournal() {
  const dialog = $('journal');
  journalView.query = '';
  journalView.limit = 200;
  const search = h('input', {
    type: 'search',
    id: 'journal-search',
    placeholder: t('Поиск по названию или устройству'),
    'aria-label': t('Поиск по названию или устройству'),
    autocomplete: 'off',
    oninput: (e) => { journalView.query = e.target.value; journalView.limit = 200; drawJournal(); },
  });
  dialog.replaceChildren(
    h('div', { class: 'sheethead' },
      h('div', {}, h('h2', {}, t('Журнал изменений')), h('p', { class: 'help' }, t('Кто, когда и что поменял в событиях за последние полгода.'))),
      closeButton(dialog)),
    h('div', { class: 'sheetbody' }, h('div', { class: 'field' }, search), h('div', { id: 'journal-result' })),
  );
  dialog.showModal();
  await loadJournal();
}

/* Занятость техники */

const gearView = { query: '' };

function gearRows() {
  const clock = now();
  const query = nameKey(gearView.query);
  return equipmentNow(refsOf('equipment'), state.allEvents, clock.iso, clock.time)
    .filter((row) => !query || nameKey(row.name).includes(query));
}

function drawGearResult(box) {
  const rows = gearRows();
  const cell = (...content) => h('td', {}, ...content);
  const quantity = (row) => (row.total === null ? String(row.used) : t('{0} из {1}', [row.used, row.total]));
  const nextText = (row) => (row.next ? `${row.next.date === now().iso ? '' : `${shortDay(row.next.date)}, `}${busyFrom(row.next)}, ${row.next.title}` : '–');
  const lines = rows.flatMap((row) => {
    const status = row.used === 0
      ? h('span', { class: 'gearstate free' }, t('Свободно'))
      : row.total !== null && row.used < row.total
        ? h('span', { class: 'gearstate part' }, t('Занято частично'))
        : h('span', { class: 'gearstate busy' }, t('Занято'));
    const head = (span) => [
      h('td', { rowspan: span }, h('strong', {}, row.name)),
      h('td', { rowspan: span }, status),
      h('td', { rowspan: span }, quantity(row)),
    ];
    const tail = h('td', { rowspan: Math.max(row.holders.length, 1) }, nextText(row));
    if (!row.holders.length) return [h('tr', {}, head(1), cell('–'), cell('–'), cell('–'), cell('–'), tail)];
    return row.holders.map(({ event, count }, i) => h('tr', {},
      i === 0 && head(row.holders.length),
      cell(event.responsible || t('Не указан'), row.holders.length > 1 || count > 1 ? ` × ${count}` : ''),
      cell(event.title),
      cell(event.place || '–'),
      cell(event.end),
      i === 0 && tail));
  });
  const busy = rows.filter((row) => row.used > 0).length;
  box.replaceChildren(
    h('p', { class: 'rollsummary' }, t('Сейчас в работе: {0} из {1}. Обновлено в {2}', [busy, rows.length, now().time])),
    rows.length
      ? h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, [t('Техника'), t('Состояние'), t('Занято'), t('У кого'), t('Событие'), t('Место'), t('До'), t('Дальше')]
          .map((name) => h('th', { scope: 'col' }, name)))),
        h('tbody', {}, lines)))
      : h('p', { class: 'help' }, gearView.query ? t('Ничего не найдено.') : t('Список техники пуст. Добавьте её в разделе «Справочники».')),
  );
}

function openGear() {
  const dialog = $('gear');
  gearView.query = '';
  const search = h('input', { id: 'g-search', type: 'search', placeholder: t('Поиск по названию'), autocomplete: 'off', 'aria-label': t('Поиск по названию') });
  const result = h('div', { id: 'gear-result' });
  search.addEventListener('input', () => {
    gearView.query = search.value;
    drawGearResult(result);
  });
  drawGearResult(result);
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Занятость техники')), closeButton(dialog)),
    h('div', { class: 'sheetbody' }, h('div', { class: 'field gearsearch' }, search), result),
  );
  dialog.showModal();
}

function refreshGear() {
  if (!$('gear').open) return;
  const box = $('gear-result');
  keepScroll(box, () => drawGearResult(box));
}

/* Настройки */

const PROBLEMS = {
  'port-busy': t('Обмен работает в другой учётной записи на этом компьютере.'),
  failed: t('Обмен не запустился. Перезапустите программу.'),
};

const STATUS = {
  'wrong-key': t('Другой ключ сети'),
  outdated: t('Старая версия программы, обмен приостановлен'),
  offline: t('Нет связи'),
  unknown: t('Связи ещё не было'),
};

function peerStatus(peer) {
  const last = peer.lastSync
    ? new Date(peer.lastSync).toLocaleString(locale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : null;
  if (peer.status === 'ok') return t('На связи, обмен {0}', [last]);
  return last && peer.status !== 'wrong-key' ? t('{0}, последний обмен {1}', [STATUS[peer.status], last]) : STATUS[peer.status];
}

function deviceList(status) {
  if (!status.enabled) {
    return [h('p', { class: 'help' }, PROBLEMS[status.problem] ?? t('Введите ключ сети, чтобы включить обмен.'))];
  }
  const rows = [
    ...status.peers.map((peer) => h('li', {}, h('strong', {}, peer.name), h('span', {}, peerStatus(peer)))),
    ...status.unreachable.map((peer) => h('li', {}, h('strong', {}, peer.address), h('span', {}, STATUS[peer.status] ?? t('Нет связи')))),
  ];
  return [
    h('p', { class: 'help' }, t('Адрес этого устройства: {0}', [status.addresses.join(', ') || t('нет подключения к сети')])),
    rows.length ? h('ul', { class: 'devices' }, rows) : h('p', { class: 'help' }, t('Других устройств пока не найдено.')),
  ];
}

function updateText(status) {
  if (!status) return t('Обновления ещё не проверялись.');
  const when = new Date(status.checkedAt).toLocaleString(locale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  if (status.result === 'installed') return t('Обновление до версии {0} установлено {1}.', [status.latest, when]);
  if (status.result === 'up-to-date') return t('Последняя проверка обновлений: {0}. Установлена новейшая версия.', [when]);
  return t('Обновления не удалось проверить {0}. Нужен доступ к github.com. Следующая попытка пройдёт сама.', [when]);
}

/** Ряд одинаковых кнопок языка. Полное название в подсказке. */
function languageButtons(selected) {
  return h('div', { class: 'targets langs', role: 'group', 'aria-labelledby': 'l-language' },
    [['auto', t('Как в Windows'), t('Авто')], ...LANGUAGES.map(([id, name]) => [id, name, id.toUpperCase()])]
      .map(([id, name, label]) => h('button', {
        type: 'button',
        title: name,
        'aria-label': name,
        'aria-pressed': String(selected === id),
        onclick: () => api.setLanguage(id),
      }, label)));
}

/** Ряд взаимоисключающих кнопок для мастера. */
function choiceRow(options, selected, pick) {
  const row = h('div', { class: 'targets' });
  const draw = (value) => row.replaceChildren(...options.map(([id, label]) => h('button', {
    type: 'button',
    'aria-pressed': String(value === id),
    onclick: () => { pick(id); draw(id); },
  }, label)));
  draw(selected);
  return row;
}

/** Мастер первого запуска: всё необязательно и позже меняется в настройках. */
function openWelcome() {
  const dialog = $('welcome');
  const current = state.settings;
  const draft = {
    deviceName: current.deviceName,
    showAll: current.showAll,
    syncKey: '',
    memoFrom: current.memoFrom,
    memoSigner: current.memoSigner,
  };
  let step = 0;
  const failure = h('p', { class: 'error' });

  const input = (id, label, key, help = null) => {
    const element = h('input', { id, value: draft[key], autocomplete: 'off', spellcheck: 'false' });
    element.addEventListener('input', () => { draft[key] = element.value; });
    return h('div', { class: 'field settingnext' }, h('label', { for: id }, label), element, help && h('p', { class: 'help' }, help));
  };

  const skip = async () => {
    await api.finishSetup();
    state.settings = await api.getSettings();
    dialog.close();
  };

  const finish = async () => {
    const result = await api.saveSettings({ ...current, ...draft, theme: undefined });
    if (!result.ok) {
      failure.textContent = result.code === 'short-key' ? t('Ключ сети должен быть не короче 12 символов') : t('Настройки не сохранены: нет доступа к файлу настроек.');
      return;
    }
    await api.finishSetup();
    state.settings = await api.getSettings();
    setEvents(state.allEvents);
    dialog.close();
    render();
    refresh();
  };

  const STEPS = [
    () => [
      h('h3', { class: 'settinghead' }, t('Язык и оформление')),
      h('div', { class: 'field' }, h('span', { class: 'label', id: 'l-language' }, t('Язык')), languageButtons(current.lang),
        h('p', { class: 'help' }, t('При смене языка программа перезапустится.'))),
      h('div', { class: 'field settingnext' }, h('span', { class: 'label' }, t('Оформление')),
        choiceRow([['dark', t('Тёмная')], ['light', t('Светлая')], ['system', t('Как в Windows')]], current.theme, (id) => api.setTheme(id))),
      h('div', { class: 'field settingnext' }, h('span', { class: 'label' }, t('Размер интерфейса')),
        choiceRow([['small', t('Мелкий')], ['medium', t('Обычный')], ['large', t('Крупный')]], current.uiSize, async (id) => {
          await api.setSize(id);
          applySize(id);
        })),
    ],
    () => [
      h('h3', { class: 'settinghead' }, t('Это устройство')),
      input('w-name', t('Название устройства'), 'deviceName', t('Например, «Ауд. 204» или «Кабинет Лебедевой». Его увидят на других устройствах.')),
      current.edition !== 'client' && h('div', { class: 'field settingnext' }, h('span', { class: 'label' }, t('Как используется это устройство?')),
        choiceRow([['room', t('Панель в аудитории')], ['teacher', t('Компьютер преподавателя')]], draft.showAll ? 'teacher' : 'room', (id) => { draft.showAll = id === 'teacher'; }),
        h('p', { class: 'help' }, t('Преподаватель видит мероприятия всех устройств.'))),
    ],
    () => {
      if (current.hasKey) return [h('h3', { class: 'settinghead' }, t('Обмен между устройствами')), h('p', { class: 'help' }, t('Ключ сети уже задан.'))];
      const key = input('w-key', t('Ключ сети'), 'syncKey', t('Создайте ключ или введите тот, что уже есть на других устройствах. Без ключа программа работает только на этом устройстве.'));
      const field = key.querySelector('input');
      const row = h('div', { class: 'adder' });
      field.replaceWith(row);
      row.append(field, h('button', {
        type: 'button',
        onclick: async () => {
          field.value = await api.generateKey();
          draft.syncKey = field.value;
        },
      }, t('Создать')));
      return [h('h3', { class: 'settinghead' }, t('Обмен между устройствами')), key];
    },
    () => [
      h('h3', { class: 'settinghead' }, t('Служебная записка')),
      input('w-from', t('От кого'), 'memoFrom', t('Как в строке «От», например Семенова И. А.')),
      input('w-signer', t('Подпись'), 'memoSigner', t('Как под запиской, например Семенов И. А. Настраивается отдельно на каждом устройстве.')),
    ],
  ];

  const draw = () => {
    const last = step === STEPS.length - 1;
    failure.textContent = '';
    dialog.replaceChildren(
      h('div', { class: 'sheethead' }, h('div', {},
        h('h2', {}, t('Добро пожаловать в Kerdiis')),
        h('p', { class: 'help' }, t('Настроим программу за минуту. Всё можно изменить позже в настройках.')))),
      h('div', { class: 'sheetbody' },
        h('p', { class: 'help welcomestep' }, t('Шаг {0} из {1}', [step + 1, STEPS.length])),
        STEPS[step](),
        failure),
      h('div', { class: 'sheetfoot' },
        step > 0 && h('button', { class: 'plain', type: 'button', onclick: () => { step -= 1; draw(); } }, t('Назад')),
        h('button', {
          class: 'primary',
          type: 'button',
          onclick: () => {
            if (last) {
              finish();
            } else {
              step += 1;
              draw();
            }
          },
        }, last ? t('Начать работу') : t('Далее')),
        h('div', { class: 'spacer' }),
        h('button', { class: 'plain', type: 'button', onclick: skip }, t('Пропустить настройку'))),
    );
  };

  dialog.addEventListener('cancel', (e) => e.preventDefault());
  draw();
  dialog.showModal();
}

async function openSettings() {
  const dialog = $('preferences');
  const current = await api.getSettings();
  const name = h('input', { id: 's-name', value: current.deviceName, autocomplete: 'off', maxlength: 60 });
  const key = h('input', { id: 's-key', value: current.syncKey, spellcheck: 'false', autocomplete: 'off' });
  const peers = h('input', { id: 's-peers', value: current.peers.join(', '), spellcheck: 'false', autocomplete: 'off' });
  const memoFrom = h('input', { id: 's-memo-from', value: current.memoFrom, autocomplete: 'off', maxlength: 60 });
  const memoSigner = h('input', { id: 's-memo-signer', value: current.memoSigner, autocomplete: 'off', maxlength: 60 });
  const showAll = h('input', { id: 's-all', type: 'checkbox', checked: current.showAll });
  const fullscreen = h('input', { id: 's-fullscreen', type: 'checkbox', checked: current.fullscreen });
  let theme = current.theme;
  const themeRow = h('div', { class: 'targets', role: 'group', 'aria-labelledby': 'l-theme' });
  const drawThemes = () => themeRow.replaceChildren(...[['dark', t('Тёмная')], ['light', t('Светлая')], ['system', t('Как в Windows')]].map(([id, label]) =>
    h('button', {
      type: 'button',
      'aria-pressed': String(theme === id),
      onclick: async () => {
        theme = id;
        await api.setTheme(id);
        drawThemes();
      },
    }, label)));
  drawThemes();
  const languageRow = languageButtons(current.lang);
  let size = current.uiSize;
  const sizeRow = h('div', { class: 'targets', role: 'group', 'aria-labelledby': 'l-size' });
  const drawSizes = () => sizeRow.replaceChildren(...[['small', t('Мелкий')], ['medium', t('Обычный')], ['large', t('Крупный')]].map(([id, label]) =>
    h('button', {
      type: 'button',
      'aria-pressed': String(size === id),
      onclick: async () => {
        size = id;
        await api.setSize(id);
        applySize(id);
        drawSizes();
      },
    }, label)));
  drawSizes();
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
        theme,
        memoFrom: memoFrom.value,
        memoSigner: memoSigner.value,
      });
      if (!result.ok) {
        message.textContent = result.code === 'short-key' ? t('Ключ сети должен быть не короче 12 символов') : t('Настройки не сохранены: нет доступа к файлу настроек.');
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
        h('span', { class: 'label', id: 'l-theme' }, t('Оформление')),
        themeRow),
      h('div', { class: 'setting field' },
        h('span', { class: 'label', id: 'l-language' }, t('Язык')),
        languageRow,
        h('p', { class: 'help' }, t('При смене языка программа перезапустится.'))),
      h('div', { class: 'setting field' },
        h('span', { class: 'label', id: 'l-size' }, t('Размер интерфейса')),
        sizeRow,
        h('p', { class: 'help' }, t('Настраивается отдельно на каждом устройстве. Для большой панели подойдёт «Крупный».'))),
      ...(isClient() ? [] : [
      h('div', { class: 'setting field' },
        h('label', { for: 's-name' }, t('Название устройства')),
        name,
        h('p', { class: 'help' }, t('Например, «Ауд. 204» или «Кабинет Лебедевой». Его увидят на других устройствах.'))),
      h('section', { class: 'setting' },
        h('h3', { class: 'settinghead' }, t('Служебная записка')),
        h('div', { class: 'field' },
          h('label', { for: 's-memo-from' }, t('От кого')),
          memoFrom,
          h('p', { class: 'help' }, t('Как в строке «От», например Семенова И. А.'))),
        h('div', { class: 'field settingnext' },
          h('label', { for: 's-memo-signer' }, t('Подпись')),
          memoSigner,
          h('p', { class: 'help' }, t('Как под запиской, например Семенов И. А. Настраивается отдельно на каждом устройстве.')))),
      templateSection(),
      backupSection(),
      clearSection(),
      h('div', { class: 'setting field' },
        h('label', { for: 's-key' }, t('Ключ сети')),
        h('div', { class: 'adder' }, key, h('button', {
          type: 'button',
          onclick: async () => { key.value = await api.generateKey(); },
        }, t('Создать'))),
        h('p', { class: 'help' }, t('Создайте ключ на одном устройстве и введите такой же на остальных. Устройства с разными ключами не видят друг друга.'))),
      h('div', { class: 'setting field' },
        h('label', { for: 's-peers' }, t('Адреса устройств в других сетях')),
        peers,
        h('p', { class: 'help' }, t('Нужны, только если устройства не находят друг друга сами, например 10.0.2.15, 10.0.3.7. Достаточно одного адреса: остальные передадутся автоматически.'))),
      h('div', { class: 'setting' },
        h('label', { class: 'check' }, showAll, t('Показывать мероприятия всех устройств')),
        h('p', { class: 'help' }, t('Включите на компьютерах преподавателей.')),
        h('label', { class: 'check' }, fullscreen, t('Открывать на весь экран'))),
      h('section', { class: 'setting' },
        h('div', { class: 'grouphead' },
          h('h3', {}, t('Устройства в сети')),
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
          }, t('Обменяться сейчас'))),
        devices),
      ]),
      h('p', { class: 'help' }, current.edition === 'client' ? t('Версия программы: клиент для панелей.') : t('Версия программы: для преподавателей.')),
      h('p', { class: 'help' }, t('Версия {0}', [current.version])),
      h('p', { class: 'help', id: 's-update' }, updateText(await api.updateStatus())),
      h('button', {
        type: 'button',
        class: 'plain checkupdate',
        id: 'check-update',
        onclick: async (e) => {
          const button = e.currentTarget;
          const line = $('s-update');
          button.disabled = true;
          line.textContent = t('Проверяю обновления. Если есть новая версия, программа закроется и откроется снова.');
          const result = await api.checkUpdate();
          button.disabled = false;
          if (!result.ok) line.textContent = t('Проверку запустить не удалось. Обновления по-прежнему проверяются сами при включении компьютера и ночью.');
          else if (!result.status) line.textContent = t('Проверка ещё идёт. Результат появится здесь при следующем открытии настроек.');
          else line.textContent = updateText(result.status);
        },
      }, t('Проверить обновления'))),
    !isClient() && h('div', { class: 'sheetfoot' }, h('button', { class: 'primary', type: 'submit' }, t('Сохранить настройки')), message));

  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Настройки')), closeButton(dialog)),
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
  if (clock.time !== state.renderedMinute) {
    render();
    refreshTicker();
    refreshGear();
  }
  if (Date.now() - state.lastActivity > IDLE_MS) resetIdle();
}

/** Панель общая: после паузы возвращается к текущей неделе. */
function resetIdle() {
  state.lastActivity = Date.now();
  if (['form', 'preferences', 'catalog', 'roll', 'reports', 'paper', 'pet', 'memo', 'welcome', 'gear', 'notices', 'deadlines', 'journal', 'quitask'].some((id) => $(id).open)) return;
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
  $('theme').addEventListener('click', () => {
    api.setTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
  });
  $('pet-open').addEventListener('click', () => {
    drawPet();
    $('pet').showModal();
  });
  $('open-gear').addEventListener('click', openGear);
  $('open-deadlines').addEventListener('click', openDeadlines);
  $('open-journal').addEventListener('click', openJournal);
  $('notices-open').addEventListener('click', openNotices);
  $('open-reports').addEventListener('click', openReports);
  $('open-catalog').addEventListener('click', () => {
    catalog.message = '';
    drawCatalog({ fromTop: true });
    $('catalog').showModal();
  });
  $('minimize').addEventListener('click', () => api.minimize());
  $('quit').addEventListener('click', askQuit);
  api.onFullscreen(showWindowButtons);
  for (const button of document.querySelectorAll('.views button')) {
    button.addEventListener('click', () => { state.view = button.dataset.view; render(); });
  }
  window.addEventListener('resize', render);
  $('details').addEventListener('click', (e) => { if (e.target === $('details')) $('details').close(); });
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, () => { state.lastActivity = Date.now(); }, { passive: true });
  }
}

function applySize(size) {
  document.documentElement.dataset.size = size;
  render();
}

async function start() {
  translatePage();
  wire();
  state.settings = await api.getSettings();
  applyEdition();
  showWindowButtons(state.settings.fullscreen);
  applySize(state.settings.uiSize);
  api.onChanged(refresh);
  render();
  tick();
  await refresh();
  if (!state.settings.setupDone) openWelcome();
}

start();
setInterval(tick, 1000);
setInterval(refresh, POLL_MS);
