import { CANCEL_REASONS, JOURNAL_ACTIONS, JOURNAL_FIELD_LABELS, SIGNAL_ABSENT_WEEK, SIGNAL_LATE_WEEK, SIGNAL_STREAK, balanceHints, attendanceIncidents, earlySignals, incidentSummary, portfolio } from './logic.mjs';
import { qrPath } from './qr.mjs';
import {
  ABSENCE_REASONS, ABSENT_FROM_MINUTE, EVENT_TYPES, STUDY_DAY, isAllDay, MAX_REPEATS, REPEATS, practiceSpan, repeatDates, seriesFrom, LATE_FROM_MINUTE, actualStart, countsLateness, startDelay, OWN_CAMERA, activeNotices, addDays, addMonths, buildReport, busyFrom, TEMPLATE_FIELDS, deadlineAlerts, deadlineList, deadlineState, equipmentCount, equipmentLabel, equipmentNow, eventState, eventsOn, findConflicts, freeStock, fromISO, groupMembers, memoApplies, memoData, fromMinutes, hourRange, layoutDay,
  monthWeeks, nameKey, needsMemo, hasPaper, hasRoles, roleOf, takesAttendance, handInOf, handInSummary, debtors, roleStats, decisionList, weekStart, weeklySummaryCsv, groupWeek, breakBoard, bestGroupOfMonth, yearChronicle, schoolYearOf, gradeReport, semesterOf, ratingPeriod, pastWorkChanges, PAST_WORK_TYPES, studentFile, GRADE_LEVELS, greetingName, birthdaysOn, pickGreeting, splitPeople, parseBirthday, rollStage, lessonIsNow, lessonOver, arrivalNow, parentGroup, pendingCertificates, parseEquipment, plural, rollCall, shortages, splitList, splitNames, suggestedStart, statusName, toCsv, toISO, toMinutes, typeName, uniqueValues, visibleOn, weekDays,
} from './logic.mjs';

import { SHAPES, SKINS, activeSkin, garlandLayout, holidayGreeting } from './skins.mjs';
import { petChange, petKindLockKey, petKindLocked, petKindOf, petLook, petPrizes, petSprite, petStatus, PET_KINDS, PRIZE_DAYS, PRIZE_HEALTH, prizeIcon, PRIZES } from './pet.mjs';
import { LANGUAGES, locale, t, tp, translatePage } from './i18n.mjs';

const POLL_MS = 10_000;
const IDLE_MS = 5 * 60_000;

const $ = (id) => document.getElementById(id);
const api = window.calendar;

const state = {
  view: 'week',
  skin: 'off', // праздничное оформление, общее для всех устройств
  proposals: [], // изменения с панелей, ждущие утверждения
  date: toISO(new Date()),
  allEvents: [], // все мероприятия сети: по ним ищутся занятые люди и техника
  events: [], // те, что показывает это устройство
  shown: [], // те, что на открытой вкладке календаря
  tab: readTab(),
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

/** Условные части разметки (`cond && h(...)`) дают false: на экран он не должен попасть никогда. */
const shown = (nodes) => nodes.flat(Infinity).filter((c) => c != null && c !== false && c !== true);
for (const name of ['append', 'prepend', 'replaceChildren']) {
  const native = Element.prototype[name];
  Element.prototype[name] = function appendVisible(...nodes) { return native.apply(this, shown(nodes)); };
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
  el.append(...children);
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
  const excusedCount = event.cancelled ? 0 : roll(event).filter((row) => row.excusedFor).length;
  if (excusedCount) details.splice(2, 0, h('span', { class: 'blockexcused' }, t('По приказу: {0}', [excusedCount])));
  if (event.pending) details.splice(1, 0, h('span', { class: 'blockpending' }, t('На согласовании')));
  if (event.cancelled) details.splice(1, 0, h('span', { class: 'blockcancelled' }, event.cancelReason ? t('Не состоялось: {0}', [event.cancelReason]) : t('Не состоялось')));
  const block = h('button', {
    class: `block t-${event.type} ${status}${event.cancelled ? ' cancelled' : ''}${event.pending ? ' pending' : ''}${!dayView && columns > 1 ? ' narrow' : ''}`,
    'aria-label': eventLabel(event),
    onclick: (e) => { e.stopPropagation(); openEvent(event.id); },
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
  const shown = state.shown.filter((e) => days.includes(e.date) && !isAllDay(e));
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
    for (const item of layoutDay(eventsOn(state.shown, iso).filter((e) => !isAllDay(e)))) column.append(eventBlock(item, range, dayView));
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
  if (dayView && !eventsOn(state.shown, days[0]).length) {
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

const deadlinesOn = (iso) => state.shown
  .filter((event) => event.deadline.startsWith(iso) && !event.deadlineDone)
  .sort((a, b) => a.deadline.localeCompare(b.deadline));

function deadlineChip(event) {
  const late = deadlineState(event, moment()) === 'overdue';
  return h('button', {
    class: `chip deadlinechip t-${event.type}${late ? ' overdue' : ''}`,
    onclick: (e) => { e.stopPropagation(); openEvent(event.id); },
  }, t('Сдать до {0}: {1}', [event.deadline.slice(11), event.title]));
}

function allDayChip(event) {
  const clock = now();
  return h('button', {
    class: `chip alldaychip t-${event.type} ${eventState(event, clock.iso, clock.time)}`,
    'aria-label': eventLabel(event),
    onclick: (e) => { e.stopPropagation(); openEvent(event.id); },
  }, event.title);
}

/** События на весь день и сроки не привязаны к часам, поэтому идут полосой над сеткой. */
function deadlineStrip(days) {
  const allDay = days.map((iso) => eventsOn(state.shown, iso).filter(isAllDay));
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
      ...eventsOn(state.shown, iso).map((e) => () => h('button', {
        class: `chip t-${e.type} ${eventState(e, clock.iso, clock.time)}`,
        onclick: (ev) => { ev.stopPropagation(); openEvent(e.id); },
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

/* Вкладки календаря: всё, задания, практика, мероприятия и расписание каждой группы. */

/** Что можно добавить с панели. Занятия и задания ведут преподаватели. */
const PANEL_TYPES = ['practice', 'event'];

const TYPE_TABS = ['lesson', 'task', 'practice', 'event', 'meeting'];
const typeTabLabel = (type) => ({ lesson: t('Занятия'), task: t('Задания'), practice: t('Практика'), event: t('Мероприятия'), meeting: t('Собрания') })[type];
const TAB_KEY = 'kerdiis-tab';

function readTab() {
  try { return localStorage.getItem('kerdiis-tab') || 'all'; } catch { return 'all'; }
}

function setTab(tab) {
  state.tab = tab;
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* без памяти вкладки */ }
  render();
}

/** Группы верхнего уровня: подгруппы входят в расписание своей группы. */
const tabGroups = () => refsOf('group').filter((group) => !parentGroup(group, refsOf('group')));

/** Открытая вкладка. Неизвестная (группу удалили или справочник ещё не загружен) — значит «Всё». */
function currentTab() {
  const [kind, value] = state.tab.split(':');
  if (kind === 'type' && TYPE_TABS.includes(value)) return state.tab;
  if (kind === 'group' && tabGroups().some((item) => item.id === value)) return state.tab;
  return 'all';
}

function shownEvents() {
  const [kind, value] = currentTab().split(':');
  if (kind === 'type') return state.events.filter((e) => e.type === value);
  if (kind === 'group') {
    const group = tabGroups().find((item) => item.id === value);
    const members = new Set(groupMembers(group, refsOf('group'), refsOf('student')).map((s) => nameKey(s.name)));
    return state.events.filter((e) => e.participants.some((name) => members.has(nameKey(name))));
  }
  return state.events;
}

function drawTabs() {
  const tab = (id, label, extra = {}) => h('button', {
    type: 'button',
    role: 'tab',
    'aria-selected': String(currentTab() === id),
    'data-tab': id,
    onclick: () => setTab(id),
    ...extra,
  }, label);
  const groups = tabGroups();
  keepTabs(() => $('tabs').replaceChildren(
    h('div', { role: 'tablist', 'aria-label': t('Вкладки календаря') },
      tab('all', t('Всё')),
      TYPE_TABS.map((type) => tab(`type:${type}`, typeTabLabel(type), { class: `t-${type}` })),
      groups.length > 0 && h('span', { class: 'tabsep', 'aria-hidden': 'true' }),
      groups.map((group) => tab(`group:${group.id}`, group.name, { class: 'grouptab' }))),
  ));
}

/** Перерисовка вкладок не сбрасывает прокрутку длинного ряда групп. */
function keepTabs(work) {
  const row = $('tabs').firstElementChild;
  const left = row?.scrollLeft ?? 0;
  work();
  const next = $('tabs').firstElementChild;
  next.scrollLeft = left;
  next.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function render() {
  state.shown = shownEvents();
  drawTabs();
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
  refreshSignals();
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
  await loadProposals();
  await loadSkin();
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

/** QR-код для экрана. */
function qrElement(text, label) {
  const { size, path } = qrPath(text);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.classList.add('qr');
  const back = document.createElementNS(ns, 'rect');
  back.setAttribute('width', size);
  back.setAttribute('height', size);
  back.setAttribute('fill', '#fff');
  const dark = document.createElementNS(ns, 'path');
  dark.setAttribute('d', path);
  dark.setAttribute('fill', '#000');
  svg.append(back, dark);
  return svg;
}

/** Ссылка СБП для поддержки проекта. Пока пусто, кнопка не показывается. */
const DONATE_SBP = 'https://www.sberbank.com/sms/pbpn?requisiteNumber=79142222833';

/** Поддержать проект: QR-код для перевода по СБП. */
function openDonate() {
  const dialog = $('donate');
  dialog.replaceChildren(
    h('div', { class: 'sheethead' },
      h('div', {}, h('h2', {}, t('Поддержать проект')), h('p', { class: 'help' }, t('Kerdiis бесплатный. Если он помогает вашему колледжу, можно поддержать разработку.'))),
      closeButton(dialog)),
    h('div', { class: 'donatebody' },
      qrElement(DONATE_SBP, t('QR-код для перевода по СБП')),
      h('div', {},
        h('ol', { class: 'portalsteps' },
          h('li', {}, t('Откройте камеру телефона или приложение своего банка.')),
          h('li', {}, t('Наведите на QR-код: откроется перевод по СБП.')),
          h('li', {}, t('Сумму выберите сами. Спасибо!'))),
        h('p', { class: 'help' }, t('Перевод идёт автору программы. Kerdiis работает одинаково, поддержали вы проект или нет.')))),
  );
  if (!dialog.open) dialog.showModal();
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
  render(); // вкладки групп и расписание группы зависят от справочника
  const dialog = $('catalog');
  const typing = dialog.contains(document.activeElement) && document.activeElement.value;
  if (dialog.open && !typing) drawCatalog();
}

const refsOf = (kind) => state.directory
  .filter((ref) => ref.kind === kind)
  .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

/** Сколько повторов можно отправить с панели за раз (столько же проверяет программа). */
const PANEL_SERIES_MAX = 30;

function setEvents(all) {
  state.allEvents = all;
  state.events = all.filter((e) => visibleOn(e, state.settings.deviceId, state.settings.showAll));
  updateApprovals();
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
        : result.code === 'cancelled'
          ? t('Занятие не состоялось: отметки на нём не ставятся.')
          : result.code === 'pending'
            ? t('Событие ещё не согласовано преподавателем: отметки появятся после согласования.')
            : result.code === 'not-found'
              ? t('Уже рассмотрено на другом устройстве.')
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
/** Участник с ролью: «Иванов Пётр — оператор». */
const roleText = (event, name) => (roleOf(event, name) ? t('{0} — {1}', [name, roleOf(event, name)]) : name);
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

/**
 * Нажатие на событие в календаре. Занятие, которое идёт сейчас или вот-вот начнётся,
 * открывается сразу на отметке: первым делом «Начать занятие», потом перекличка.
 */
function openEvent(id) {
  const event = state.allEvents.find((e) => e.id === id);
  if (event && lessonIsNow(event, attendanceOf(event.id), Date.now())) openRoll(id);
  else showDetails(id);
}

/** Сохраняет изменение события и обновляет календарь. Возвращает новую запись или null. */
async function patchEvent(event, changes) {
  const result = await api.save({ ...event, ...changes }, event.updatedAt);
  if (!result.ok) {
    toast(storeMessage(result));
    return null;
  }
  setEvents([...state.allEvents.filter((x) => x.id !== result.value.id), result.value]);
  render();
  return result.value;
}

/* Изменения с панели на утверждение */

/** Что панель может предложить изменить. Тип, отметки и сдачу меняет преподаватель. */
const PROPOSABLE = ['title', 'date', 'start', 'end', 'allDay', 'place', 'responsible', 'notes', 'participants', 'equipment', 'deadline'];
const PROPOSAL_TYPES = ['event', 'task'];

const proposalsFor = (eventId) => state.proposals.filter((proposal) => proposal.eventId === eventId);

async function loadProposals() {
  const result = await api.proposals();
  if (!result.ok) return;
  const changed = JSON.stringify(result.value) !== JSON.stringify(state.proposals);
  state.proposals = result.value;
  updateApprovals();
  if (changed && $('proposals').open) drawProposals();
}

/** Добавленные студентами с панели практика и мероприятия: ждут согласования. Ближайшие сверху. */
const pendingEvents = () => state.allEvents.filter((event) => event.pending)
  .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));

let approvalsCount = -1;

/** Кнопка «На утверждение»: правки и новые события с панелей вместе. */
function updateApprovals() {
  const button = $('open-proposals');
  if (!button) return;
  const count = (state.proposals?.length ?? 0) + pendingEvents().length;
  button.hidden = !canManage() || !count;
  $('proposal-count').textContent = String(count);
  if (count !== approvalsCount && $('proposals').open) {
    approvalsCount = count;
    drawProposals();
  }
  approvalsCount = count;
}

/** Согласовать или отклонить событие, добавленное с панели. */
async function resolvePending(event, approve) {
  const result = approve ? await api.approveEvent(event.id, event.updatedAt) : await api.declineEvent(event.id, event.updatedAt);
  if (!result.ok) {
    toast(storeMessage(result));
    return false;
  }
  const rest = state.allEvents.filter((x) => x.id !== event.id);
  setEvents(approve ? [...rest, result.value] : rest);
  render();
  toast(approve ? t('Согласовано: {0}', [event.title]) : t('Отклонено и удалено: {0}', [event.title]));
  return true;
}

/** В карточке: изменения ждут утверждения. */
function proposalNote(event) {
  const pending = proposalsFor(event.id);
  if (!pending.length) return null;
  return h('p', { class: 'notice proposalnote' }, pending.length === 1
    ? t('Изменения с устройства «{0}» ждут утверждения преподавателя.', [pending[0].device || t('панель')])
    : t('Изменения ждут утверждения преподавателя: {0}.', [pending.length]));
}

let proposalFocus = null;

function openProposals(eventId = null) {
  proposalFocus = eventId;
  drawProposals();
  $('proposals').showModal();
}

function drawProposals() {
  const dialog = $('proposals');
  const list = proposalFocus ? proposalsFor(proposalFocus) : state.proposals;
  const resolve = async (proposal, approve) => {
    const result = await api.resolveProposal(proposal.id, approve);
    if (!result.ok) {
      toast(storeMessage(result));
    } else if (result.value) {
      setEvents([...state.allEvents.filter((x) => x.id !== result.value.id), result.value]);
      render();
      toast(t('Изменения утверждены: {0}', [result.value.title]));
    } else {
      toast(t('Изменения отклонены.'));
    }
    await loadProposals();
    if (proposalFocus && !proposalsFor(proposalFocus).length) proposalFocus = null;
    if (!state.proposals.length && !pendingEvents().length) dialog.close();
    else drawProposals();
  };
  const pending = proposalFocus ? [] : pendingEvents();
  const decide = async (event, approve) => {
    if (!(await resolvePending(event, approve))) return;
    if (!state.proposals.length && !pendingEvents().length) dialog.close();
    else drawProposals();
  };
  const fresh = pending.length > 0 && h('div', { class: 'pendinglist' },
    h('h3', {}, t('Новые с панелей: {0}', [pending.length])),
    pending.map((event) => h('section', { class: 'proposal', 'data-pending': event.id },
      h('h3', {}, event.title),
      h('p', { class: 'help' }, t('{0}. Добавлено с устройства «{1}»', [
        `${typeLabel(event.type)}, ${fmt(event.date, { day: 'numeric', month: 'long' })}, ${timeRange(event)}`,
        event.pendingFrom || t('панель'),
      ])),
      h('ul', { class: 'jfields' },
        event.place && h('li', {}, h('span', { class: 'jfield' }, t('Место')), h('span', {}, event.place)),
        event.responsible && h('li', {}, h('span', { class: 'jfield' }, t('Ответственный')), h('span', {}, event.responsible)),
        event.participants.length > 0 && h('li', {}, h('span', { class: 'jfield' }, t('Участники')), h('span', {}, event.participants.join(', '))),
        event.equipment.length > 0 && h('li', {}, h('span', { class: 'jfield' }, t('Техника')), h('span', {}, event.equipment.map((name) => gearLabel(event, name)).join(', '))),
        event.notes && h('li', {}, h('span', { class: 'jfield' }, t('Примечание')), h('span', {}, event.notes))),
      h('div', { class: 'targets' },
        h('button', { type: 'button', class: 'primary', 'data-approve-event': event.id, onclick: () => decide(event, true) }, t('Согласовать')),
        h('button', { type: 'button', class: 'plain', onclick: () => { dialog.close(); openForm(event); } }, t('Изменить')),
        h('button', { type: 'button', class: 'plain', 'data-decline-event': event.id, onclick: () => decide(event, false) }, t('Отклонить'))))));
  const body = h('div', { class: 'sheetbody' },
    fresh,
    pending.length > 0 && list.length > 0 && h('h3', {}, t('Изменения: {0}', [list.length])),
    list.length ? list.map((proposal) => {
      const event = state.allEvents.find((e) => e.id === proposal.eventId);
      // Сравниваем с тем, что записано сейчас: событие могли поменять после предложения.
      const fields = Object.entries(proposal.changes).map(([field, after]) => ({ field, before: event?.[field] ?? null, after }));
      return h('section', { class: 'proposal' },
        h('h3', {}, event?.title ?? proposal.title),
        h('p', { class: 'help' }, t('{0}. Предложено с устройства «{1}», {2}', [
          event ? `${typeLabel(event.type)}, ${fmt(event.date, { day: 'numeric', month: 'long' })}` : '',
          proposal.device || t('панель'),
          stampText(proposal.at),
        ])),
        event && event.updatedAt !== proposal.base && h('p', { class: 'notice' }, t('После предложения событие уже меняли. Слева — как записано сейчас.')),
        h('ul', { class: 'jfields' }, fields.map(journalField)),
        h('div', { class: 'targets' },
          h('button', { type: 'button', class: 'primary', 'data-approve': proposal.id, onclick: () => resolve(proposal, true) }, t('Утвердить')),
          h('button', { type: 'button', class: 'plain', 'data-decline': proposal.id, onclick: () => resolve(proposal, false) }, t('Отклонить'))));
    }) : !pending.length && h('p', { class: 'help' }, t('Изменений на утверждение нет.')));
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Изменения на утверждение')), closeButton(dialog)),
    h('div', { class: 'sheetbody' },
      h('p', { class: 'help' }, t('С панелей в аудиториях ничего не меняется сразу: новые практики и мероприятия от студентов и правки ждут здесь. Утвердите или отклоните их.')),
      body),
  );
}

/** Решения и поручения собрания с отметкой выполнения. */
function decisionsSection(event) {
  if (event.type !== 'meeting' || !event.decisions?.length) return null;
  const toggle = async (id) => {
    const saved = await patchEvent(event, { decisions: event.decisions.map((item) => (item.id === id ? { ...item, done: !item.done } : item)) });
    if (saved) showDetails(saved.id);
  };
  return h('section', { class: 'group decisions' },
    h('h3', {}, t('Решения и поручения: {0}', [event.decisions.length])),
    h('ul', { class: 'decisionlist' }, event.decisions.map((item) => h('li', { class: item.done ? 'done' : '' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: item.done, disabled: !canManage(), onchange: () => toggle(item.id) }),
        h('span', {}, item.text)),
      h('span', { class: 'help' }, [item.who, item.due && t('до {0}', [shortDay(item.due)])].filter(Boolean).join(', '))))));
}

function showDetails(id) {
  const event = state.allEvents.find((e) => e.id === id);
  if (!event) return;
  const dialog = $('details');
  const footer = h('div', { class: 'sheetfoot' });
  const excused = roll(event).filter((row) => row.excusedFor);

  // Добавлено с панели и ждёт согласования: преподаватель согласует, правит или отклоняет, панель только смотрит.
  const showPending = () => footer.replaceChildren(
    canManage() && h('button', { class: 'primary', id: 'approve-event', onclick: async () => { if (await resolvePending(event, true)) { dialog.close(); showDetails(event.id); } } }, t('Согласовать')),
    canManage() && h('button', { class: 'plain', onclick: () => { dialog.close(); openForm(event); } }, t('Изменить')),
    h('div', { class: 'spacer' }),
    canManage() && h('button', { class: 'plain', id: 'decline-event', onclick: async () => { if (await resolvePending(event, false)) dialog.close(); } }, t('Отклонить')),
  );
  const showActions = () => (event.pending ? showPending() : footer.replaceChildren(
    canManage() && h('button', { class: 'plain', onclick: () => { dialog.close(); openForm(event); } }, t('Изменить')),
    // На панели мероприятие и задание не меняют сразу, а предлагают изменения преподавателю.
    isClient() && PROPOSAL_TYPES.includes(event.type) && h('button', { class: 'plain', id: 'propose-event', onclick: () => { dialog.close(); openForm(event); } }, t('Предложить изменения')),
    canManage() && proposalsFor(event.id).length > 0 && h('button', { class: 'primary', id: 'review-proposal', onclick: () => { dialog.close(); openProposals(event.id); } }, t('Рассмотреть изменения')),
    event.participants.length > 0 && !event.cancelled && !event.pending && takesAttendance(event) && h('button', {
      class: 'primary',
      onclick: () => { dialog.close(); openRoll(event.id); },
    }, t('Отметка: {0} из {1}', [countPresent(event), event.participants.length])),
    hasPaper(event) && h('button', { class: 'plain', onclick: () => { dialog.close(); openPaper(event.id); } }, t('Тех. задание')),
    canManage() && event.deadline && h('button', {
      class: 'plain',
      onclick: async () => {
        if (await setDeadlineDone(event, !event.deadlineDone)) {
          dialog.close();
          showDetails(event.id);
        }
      },
    }, event.deadlineDone ? t('Вернуть в работу') : t('Отметить сдачу')),
    canManage() && event.type === 'task' && event.deadline && event.participants.length > 0 && h('button', {
      class: 'plain',
      id: 'open-handin',
      onclick: () => { dialog.close(); openHandIn(event.id); },
    }, t('Сдача: {0} из {1}', [handInSummary(event).done, event.participants.length])),
    canManage() && memoApplies(event) && !event.cancelled && h('button', { class: 'plain', onclick: () => { dialog.close(); createMemo(event); } }, t('Служебная записка')),
    canManage() && (event.cancelled
      ? h('button', { class: 'plain', id: 'uncancel', onclick: () => setCancelled(event, false) }, t('Всё-таки состоялось'))
      : h('button', { class: 'plain', id: 'cancel-event', onclick: showCancel }, t('Не состоялось'))),
    h('div', { class: 'spacer' }),
    canManage() && h('button', { class: 'plain', onclick: showConfirm }, t('Удалить')),
  ));

  // Занятие не состоялось: причина по желанию, отметки и отчёты его больше не учитывают.
  const setCancelled = async (target, cancelled, reason = '') => {
    const result = await api.save({ ...target, cancelled, cancelReason: cancelled ? reason : '' }, target.updatedAt);
    if (!result.ok) {
      footer.replaceChildren(h('p', { class: 'message' }, storeMessage(result)), h('button', { class: 'plain', onclick: showActions }, t('Назад')));
      return;
    }
    setEvents([...state.allEvents.filter((x) => x.id !== result.value.id), result.value]);
    render();
    dialog.close();
    showDetails(result.value.id);
  };
  const showCancel = () => {
    const reason = h('input', { id: 'cancel-reason', list: 'cancel-reasons', maxlength: 200, placeholder: t('Причина, например: преподаватель на больничном') });
    footer.replaceChildren(
      h('div', { class: 'field cancelfield' },
        h('label', { for: 'cancel-reason' }, t('Почему не состоялось')),
        reason,
        h('datalist', { id: 'cancel-reasons' }, CANCEL_REASONS.map((text) => h('option', { value: t(text) }))),
        h('p', { class: 'help' }, t('Отметки на нём не ставятся, в отчёты, сигналы и здоровье питомца оно не идёт. Студенты увидят «Не состоялось» на телефоне.'))),
      h('button', { class: 'plain', onclick: showActions }, t('Оставить')),
      h('button', { class: 'danger', id: 'cancel-confirm', onclick: () => setCancelled(event, true, reason.value.trim()) }, t('Не состоялось')),
    );
    reason.focus();
  };

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
  const span = practiceSpan(event, state.allEvents);
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, event.title), closeButton(dialog)),
    h('div', { class: 'sheetbody' },
      h('dl', { class: 'facts' },
        event.cancelled ? fact(t('Не состоялось'), event.cancelReason || t('Причина не указана')) : [],
        fact(t('Тип'), typeLabel(event.type)),
        fact(t('Дата'), fmt(event.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })),
        span ? fact(t('Практика'), t('с {0} по {1}, день {2} из {3}', [shortDay(span.from), shortDay(span.to), span.day, span.days])) : [],
        fact(t('Время'), timeRange(event)),
        event.repeat && !span ? fact(t('Повтор'), t('{0}, до {1}', [repeatLabel(event.repeat.every), shortDay(event.repeat.until)])) : [],
        fact(t('Подготовка'), prepText(event)),
        event.deadline ? fact(deadlineLabel(event.type), deadlineFact(event)) : [],
        excused.length ? fact(t('Освобождены по приказу'), excused.map((row) => `${row.name} (${row.excusedFor})`).join(', ')) : [],
        fact(t('Место'), event.place),
        event.offsite ? fact(t('Отметка'), t('Проходит вне колледжа: отметки вносит преподаватель в версии для преподавателей')) : [],
        fact(t('Ответственный'), event.responsible || t('Не указан')),
        fact(t('Показывать на'), event.devices.map(deviceName).join(', '))),
      event.pending && h('p', { class: 'notice pendingnote' }, canManage()
        ? t('Добавлено с устройства «{0}» и ждёт согласования. До согласования не учитывается в отметках, грейде и отчётах.', [event.pendingFrom || t('панель')])
        : t('Ждёт согласования преподавателем. Отметки появятся после согласования.')),
      proposalNote(event),
      decisionsSection(event),
      listGroup(t('Участники: {0}', [event.participants.length]), event.participants.map((name) => roleText(event, name)), true),
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
    add: addFrom,
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
    roles: { ...(source.roles ?? {}) },
    decisions: (source.decisions ?? []).map((item) => ({ ...item })),
    // С панели добавляют только практику и мероприятия.
    type: source.type ?? (isClient() ? 'event' : 'lesson'),
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
  const formTypes = isClient() && !source.id ? EVENT_TYPES.filter(([id]) => PANEL_TYPES.includes(id)) : EVENT_TYPES;
  const drawTypes = () => typeRow.replaceChildren(...formTypes.map(([id, label]) => h('button', {
    type: 'button',
    class: `t-${id}`,
    'aria-pressed': String(draft.type === id),
    onclick: () => { draft.type = id; drawTypes(); showPrep(); showDeadline(); showRepeat(); drawRoles(); drawHints(); drawDecisions(); updateConflicts(); },
  }, t(label))));
  drawTypes();
  const typeField = h('div', { class: 'field' }, h('span', { class: 'label', id: 'l-type' }, t('Тип')), typeRow);

  const title = field(t('Название'), 'f-title', { value: source.title ?? '', autocomplete: 'off', maxlength: 200 });
  const date = field(t('Дата'), 'f-date', { type: 'date', value: source.date ?? state.date }, 'third');
  const from = field(t('Начало'), 'f-start', { type: 'time', value: start }, 'third');
  const allDayBox = h('input', { id: 'f-allday', type: 'checkbox', checked: Boolean(source.allDay) });
  const allDayField = h('div', { class: 'field' }, h('label', { class: 'check' }, allDayBox, t('Весь день')));
  // Пара в другом учреждении: на панели и с телефона её не отметить.
  const offsiteBox = h('input', { id: 'f-offsite', type: 'checkbox', checked: Boolean(source.offsite) });
  const offsiteField = h('div', { class: 'field' },
    h('label', { class: 'check' }, offsiteBox, t('Проходит вне колледжа')),
    h('p', { class: 'help' }, t('Например, физкультура в другом учреждении. На панели и с телефона такую пару не отметить, отметки вносит преподаватель.')));
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
  const repeatLabelEl = h('label', { for: 'f-repeat' }, t('Повторять'));
  const untilWord = h('span', {}, t('до'));
  const repeat = h('div', { class: 'field', 'data-for': 'f-repeat', hidden: Boolean(source.id) },
    repeatLabelEl,
    h('div', { class: 'repeatrow' }, repeatSelect, h('span', { class: 'repeatuntil' }, untilWord, until)),
    repeatHint);
  // Практика идёт несколько дней: начало — дата события, конец — последний день.
  // На каждый день создаётся своё событие, чтобы посещение отмечалось по дням.
  const isPractice = () => draft.type === 'practice';
  const repeatPlan = () => {
    const first = date.querySelector('input').value;
    return repeatSelect.value ? repeatDates(first, repeatSelect.value, until.value) : [first];
  };
  const showRepeat = () => {
    repeatLabelEl.textContent = isPractice() ? t('Конец практики') : t('Повторять');
    repeatSelect.options[0].textContent = isPractice() ? t('Один день') : t('Не повторять');
    untilWord.textContent = isPractice() ? t('по') : t('до');
    date.querySelector('label').textContent = isPractice() && !source.id ? t('Начало практики') : t('Дата');
    until.closest('.repeatuntil').hidden = !repeatSelect.value;
    const count = repeatSelect.value && until.value ? repeatPlan().length : 0;
    if (isPractice()) {
      repeatHint.textContent = count
        ? t('Практика: дней {0}, с {1} по {2}. Посещение отмечается за каждый день.', [count, shortDay(repeatPlan()[0]), shortDay(repeatPlan().at(-1))])
        : repeatSelect.value ? t('Укажите последний день практики.') : t('Практика в один день. Если она идёт несколько дней, выберите дни недели и последний день.');
      return;
    }
    repeatHint.textContent = count
      ? t('Будет создано событий: {0}, последнее {1}.', [count, shortDay(repeatPlan().at(-1))])
      : repeatSelect.value ? t('Укажите дату, до которой повторять. Например, последний день семестра.') : '';
  };
  repeatSelect.addEventListener('change', showRepeat);
  until.addEventListener('change', showRepeat);
  date.querySelector('input').addEventListener('change', showRepeat);
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

  // Решения и поручения собрания: что сделать, кто отвечает, к какому сроку.
  const decisionsBox = h('div', { class: 'field decisionsbox' });
  // Enter в строке поручения не отправляет всю форму: в тексте он добавляет следующее поручение.
  const decisionKey = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.target.classList.contains('dtext') && e.target.value.trim()) $('add-decision').click();
  };
  function drawDecisions() {
    decisionsBox.hidden = draft.type !== 'meeting';
    if (decisionsBox.hidden) return;
    const people = [...new Set([...refsOf('teacher').map((ref) => ref.name), ...draft.participants])];
    decisionsBox.replaceChildren(
      h('span', { class: 'label' }, t('Решения и поручения')),
      h('datalist', { id: 'decision-people' }, people.map((name) => h('option', { value: name }))),
      h('ul', { class: 'decisionedit' }, draft.decisions.map((item, index) => h('li', {},
        h('input', { 'aria-label': t('Поручение'), class: 'dtext', onkeydown: decisionKey, id: `f-decision-${index}`, maxlength: 300, value: item.text, placeholder: t('Что сделать'), oninput: (e) => { item.text = e.target.value; } }),
        h('input', { 'aria-label': t('Кому'), class: 'dwho', onkeydown: decisionKey, list: 'decision-people', maxlength: 80, value: item.who, placeholder: t('Кому'), oninput: (e) => { item.who = e.target.value.trim(); } }),
        h('input', { 'aria-label': t('Срок'), class: 'ddue', onkeydown: decisionKey, type: 'date', value: item.due, onchange: (e) => { item.due = e.target.value; } }),
        h('button', { type: 'button', class: 'icon', 'aria-label': t('Убрать: {0}', [item.text || t('поручение')]), onclick: () => { draft.decisions.splice(index, 1); drawDecisions(); } }, '×')))),
      h('button', {
        type: 'button',
        class: 'plain',
        id: 'add-decision',
        onclick: () => {
          draft.decisions.push({ id: crypto.randomUUID(), text: '', who: '', due: '', done: false });
          drawDecisions();
          $(`f-decision-${draft.decisions.length - 1}`)?.focus();
        },
      }, t('Добавить поручение')),
      h('p', { class: 'help' }, t('Невыполненные поручения видны в «Сроках сдачи», отметить выполнение можно там или в карточке собрания.')));
  }
  drawDecisions();

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
    offsite: offsiteBox.checked,
    // Правка не возвращает отменённое занятие: для этого есть кнопка «Всё-таки состоялось».
    cancelled: source.cancelled === true,
    cancelReason: source.cancelReason ?? '',
    prepMinutes: draft.type === 'lesson' ? 0 : Math.max(0, Math.round(Number($('f-prep').value) || 0)),
    ...readDeadline(),
    place: $('f-place').value.trim(),
    responsible: $('f-responsible').value.trim(),
    participants: draft.participants,
    roles: hasRoles({ type: draft.type }) ? Object.fromEntries(draft.participants.filter((name) => draft.roles[name]).map((name) => [name, draft.roles[name]])) : {},
    ...withOwnCameras(),
    devices: draft.devices,
    notes: $('f-notes').value.trim(),
    // Правка не выводит событие из цепочки.
    seriesId: source.seriesId ?? '',
    repeat: source.repeat ?? null,
    // Сдача и время создания меняются не в форме: правка их сохраняет.
    handIn: source.handIn ?? {},
    createdAt: source.createdAt ?? '',
    decisions: draft.type === 'meeting' ? draft.decisions.filter((item) => item.text.trim()) : [],
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

  // Роли студентов: у каждого участника свой выбор из справочника «Роли».
  const rolesBox = h('div', { class: 'field rolesbox', 'data-for': 'f-roles' });
  function drawRoles() {
    const roles = refsOf('role').map((ref) => ref.name);
    const names = draft.participants;
    rolesBox.hidden = !hasRoles({ type: draft.type }) || !names.length;
    if (rolesBox.hidden) return;
    const assigned = names.filter((name) => draft.roles[name]).length;
    rolesBox.replaceChildren(
      h('span', { class: 'label', id: 'l-roles' }, assigned ? t('Роли участников: {0} из {1}', [assigned, names.length]) : t('Роли участников')),
      !roles.length && !assigned
        ? h('p', { class: 'help' }, t('Добавьте роли в «Справочники → Роли», и здесь можно будет выбрать роль каждому участнику.'))
        : h('ul', { class: 'rolelist', 'aria-labelledby': 'l-roles' }, names.map((name, index) => {
          const current = draft.roles[name] ?? '';
          // Роль, которую удалили из справочника, остаётся у события, пока её не сменят.
          const options = current && !roles.includes(current) ? [...roles, current] : roles;
          return h('li', {},
            h('label', { for: `f-role-${index}` }, name),
            h('select', {
              id: `f-role-${index}`,
              'data-name': name,
              onchange: (e) => {
                if (e.target.value) draft.roles[name] = e.target.value;
                else delete draft.roles[name];
                drawRoles();
              },
            }, h('option', { value: '' }, t('Без роли')), options.map((role) => h('option', { value: role, selected: role === current }, role))));
        })),
    );
  }

  // Кому дать: студенты с наименьшим опытом. Преподаватель решает сам, подсказка только предлагает.
  const hintBox = h('div', { class: 'field hintbox', id: 'f-hints' });
  function drawHints() {
    const shown = canManage() && ['task', 'event', 'practice'].includes(draft.type);
    hintBox.hidden = !shown;
    if (!shown) return;
    const rows = balanceRows(draft.participants, draft.type === 'event' ? refsOf('role').map((ref) => ref.name) : []);
    hintBox.replaceChildren(
      h('span', { class: 'label' }, t('Кому дать')),
      rows.length
        ? h('ul', { class: 'hintlist' }, rows.map((row) => h('li', {},
          h('button', { type: 'button', class: 'plain small', 'data-hint': row.name, onclick: () => participants.add(row.name) }, t('+ {0}', [row.name])),
          h('small', {}, hintReason(row)))))
        : h('p', { class: 'help' }, t('Все участвуют примерно поровну.')),
      h('p', { class: 'help' }, t('Цель — опытный специалист: у этих студентов меньше всего заданий и мероприятий. Решаете вы.')));
  }

  const participants = listInput(t('Участники'), 'f-participants',
    t('Фамилия и имя, можно вставить список из таблицы'), draft.participants, () => { drawRoles(); drawHints(); updateConflicts(); },
    (changed) => {
      // На собрание, совещание и брифинг чаще зовут преподавателей: они идут первыми.
      const meeting = draft.type === 'meeting';
      const teachers = refsOf('teacher').map((ref) => ref.name);
      pickInto(draft.participants, {
        title: meeting ? t('Участники') : t('Студенты'),
        flagged: canManage(),
        sections: [
          ...(meeting && teachers.length ? [{ name: t('Преподаватели'), items: teachers }] : []),
          ...refsOf('group').map((group) => ({
            name: group.name,
            items: groupMembers(group, refsOf('group'), refsOf('student')).map((s) => s.name),
          })),
        ],
        busy: busyNames('person'),
        empty: t('Список студентов пуст. Добавьте группы и студентов в разделе «Справочники».'),
        selectAll: meeting ? null : t('Всех студентов'),
      })(changed);
    }, { suggest: people });
  drawRoles();
  drawHints();
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
      : !until.value || until.value < event.date ? (isPractice() ? t('Последний день практики не может быть раньше начала') : t('Укажите дату окончания повторов не раньше даты события'))
        : plan.length >= MAX_REPEATS ? t('Слишком длинная цепочка: не больше {0} событий', [MAX_REPEATS - 1]) : '';
    setInvalid(repeat, repeatError);
    const lacking = shortages(event, state.allEvents, refsOf('equipment'));
    message.textContent = lacking.length ? t('Не хватает: {0}. Уменьшите количество или выберите другое время.', [lacking.map((item) => item.name).join(', ')]) : '';
    return !(titleError || timeError || dateError || repeatError || lacking.length);
  };

  // На панели правка мероприятия или задания уходит преподавателю на утверждение.
  const proposing = isClient() && Boolean(source.id);
  // Новое с панели (практика или мероприятие от студентов) тоже ждёт согласования преподавателя.
  const save = h('button', { class: 'primary', type: 'submit' }, proposing ? t('Отправить на утверждение') : source.id ? t('Сохранить') : isClient() ? t('Отправить на согласование') : t('Добавить событие'));

  const finish = (date) => {
    state.date = date;
    dialog.close();
    render();
  };

  const saveSeries = async (event, every, last) => {
    const seriesId = crypto.randomUUID();
    const dates = repeatDates(event.date, every, last);
    if (isClient() && dates.length > PANEL_SERIES_MAX) {
      save.disabled = false;
      message.textContent = t('С панели можно отправить не больше {0} повторов за раз: сейчас {1}. Сократите срок повторения.', [PANEL_SERIES_MAX, dates.length]);
      return;
    }
    const result = await api.saveMany(dates
      .map((date) => ({ ...event, id: null, date, seriesId, repeat: { every, until: last } })));
    save.disabled = false;
    if (!result.ok) {
      message.textContent = storeMessage(result);
      return;
    }
    setEvents([...state.allEvents, ...result.value]);
    finish(event.date);
    toast(isClient() ? t('Отправлено на согласование преподавателю: {0}', [tp('events', result.value.length)]) : t('Добавлено событий: {0}', [result.value.length]));
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
      if (proposing) {
        const changes = Object.fromEntries(PROPOSABLE.map((field) => [field, event[field]]));
        const result = await api.propose(source.id, changes, '');
        save.disabled = false;
        if (!result.ok) {
          message.textContent = result.code === 'unchanged' ? t('Ничего не изменено.') : storeMessage(result);
          return;
        }
        dialog.close();
        await loadProposals();
        toast(t('Изменения отправлены преподавателю на утверждение.'));
        return;
      }
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
      if (result.value.pending && !source.id) toast(t('Отправлено на согласование преподавателю. До согласования событие видно с пометкой «На согласовании».'));
      else if (event.devices.length) toast(t('Событие отправлено: {0}', [event.devices.map(deviceName).join(', ')]));
      if (canManage() && needsMemo(result.value, source)) createMemo(result.value);
    },
  },
    h('div', { class: 'sheetbody' },
      h('div', { class: 'fields' },
        typeField, title, date, allDayField, from, to, repeat, prep, deadline, place, offsiteField, responsible, targets,
        participants.element, hintBox, rolesBox, decisionsBox, equipment.element, ownBox, conflictBox,
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
function openPicker({ title, sections, selected, single = false, busy = new Map(), empty, selectAll = null, flagged = false, done }) {
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
    }, h('strong', {}, name, flagged && flagDots(name)), note && h('span', {}, t('Занято: {0}', [note])));
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
    // Флажки: одним нажатием выбрать всех студентов с флажком этого цвета.
    if (flagged && !single) {
      const marked = FLAG_COLORS.map((color) => [color, [...listed.keys()].filter((key) => studentByName(listed.get(key))?.flags?.includes(color))]).filter(([, keys]) => keys.length);
      if (marked.length) {
        rows.push(h('div', { class: 'pickflags', role: 'group', 'aria-label': t('Выбрать по флажку') }, marked.map(([color, keys]) => {
          const all = keys.every((key) => chosen.has(key));
          return h('button', {
            type: 'button', class: 'plain', 'data-pickflag': color, 'aria-pressed': String(all),
            onclick: () => {
              for (const key of keys) {
                if (all) chosen.delete(key);
                else chosen.add(key);
              }
              draw();
            },
          }, h('span', { class: `flagdot flag-${color}` }), t('{0}: {1}', [flagLabel(color), keys.length]));
        })));
      }
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
  ['role', t('Роли')],
];

async function commitCatalog(result) {
  catalog.message = result.ok ? catalog.message : storeMessage(result);
  catalog.editing = null;
  catalog.confirming = null;
  const fresh = await api.directory();
  if (fresh.ok) state.directory = fresh.value;
  drawCatalog();
  // Дата рождения могла прийтись на сегодня: поздравление появляется сразу.
  refreshTicker();
}

/** Добавляет имена, пропуская те, что уже есть, и сообщает о пропущенных. */
async function addRefs(text, kind, existing, extra = {}) {
  const known = new Map(existing.map((ref) => [nameKey(ref.name), ref]));
  const fresh = [];
  const repeated = [];
  // У студентов и преподавателей в строке может быть дата рождения: «Иванов Иван 12.03.2007».
  const people = kind === 'student' || kind === 'teacher' ? splitPeople(text) : splitNames(text).map((name) => ({ name, birthday: '' }));
  for (const { name, birthday } of people) {
    const already = known.get(nameKey(name));
    if (already) {
      // Уже есть в списке, но пришла дата рождения: дописываем её.
      if (birthday && already.id && already.birthday !== birthday) fresh.push({ ref: { ...already, birthday }, base: already.updatedAt });
      else repeated.push(name);
    } else {
      known.set(nameKey(name), { name });
      fresh.push({ ref: { kind, name, ...extra, ...(birthday ? { birthday } : {}) }, base: null });
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
    const birthday = ref.kind === 'student' || ref.kind === 'teacher'
      ? h('input', { id: 'c-birthday', type: 'date', value: ref.birthday ?? '', max: now().iso, 'aria-label': t('День рождения'), title: t('День рождения') })
      : null;
    const hide = ref.kind === 'student' || ref.kind === 'teacher'
      ? h('label', { class: 'check hidepublic', title: t('Нет согласия на показ: на панелях в аудиториях человека не будет в грейде и поздравлениях') },
        h('input', { id: 'c-hide', type: 'checkbox', checked: ref.hidePublic === true }), t('Не показывать на панелях'))
      : null;
    return h('li', { class: 'refrow editing' }, input, move, limit, birthday, hide,
      h('button', {
        type: 'button',
        class: 'primary',
        onclick: async () => {
          const name = input.value.trim();
          if (!name) return;
          catalog.message = '';
          await commitCatalog(await api.saveRefs([{
            ref: { ...ref, name, ...(move ? { groupId: move.value } : {}), ...(limit ? { quantity: parseQuantity(limit.value) } : {}), ...(birthday ? { birthday: birthday.value } : {}), ...(hide ? { hidePublic: hide.querySelector('input').checked } : {}) },
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
  // У студентов и преподавателей под именем — день рождения, без года: возраст не показывается.
  if (!detail && ref.birthday) detail = t('🎂 {0}', [fmt(ref.birthday, { day: 'numeric', month: 'long' })]);
  if (ref.hidePublic) detail = [detail, t('не показывается на панелях')].filter(Boolean).join(' · ');
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
          addForm('c-add-student', t('Фамилия и имя, можно с датой рождения, или столбцы из таблицы'),
            (text) => addRefs(text, 'student', members, { groupId: current.id })),
          h('p', { class: 'help' }, t('Дату рождения можно вставить вторым столбцом из Excel: тем, кто уже в списке, она допишется. В день рождения бегущая строка поздравит, возраст нигде не показывается.')),
          refList(members.map((student) => refRow(student, {
            extra: [h('button', {
              type: 'button',
              class: 'plain fileopen',
              onclick: () => openStudentFile(student.id),
            }, t('Личное дело')), h('button', {
              type: 'button',
              class: 'plain portfolioopen',
              onclick: () => openPortfolio(student.id),
            }, t('Портфолио')), h('button', {
              type: 'button',
              class: 'plain owntoggle',
              'aria-pressed': String(student.ownCamera === true),
              onclick: async () => {
                catalog.message = '';
                await commitCatalog(await api.saveRefs([{ ref: { ...student, ownCamera: !student.ownCamera }, base: student.updatedAt }]));
              },
            }, t('Своя камера'))],
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

/* Итоги по ролям */

/** Начало учебного года: 1 сентября текущего или прошлого года. */
const schoolYearStart = (iso) => (iso.slice(5) >= '09-01' ? `${iso.slice(0, 4)}-09-01` : `${Number(iso.slice(0, 4)) - 1}-09-01`);

/** Кто сколько раз и в какой роли участвовал: видно, что одни и те же студенты делают всё. */
function openRoleStats() {
  const dialog = $('rolestats');
  let period = 'year';
  const draw = () => {
    const today = moment().slice(0, 10);
    const from = period === 'year' ? schoolYearStart(today) : period === 'month' ? `${today.slice(0, 7)}-01` : '';
    const { roles, people } = roleStats(state.allEvents, today, from);
    const groupOf = new Map(refsOf('student').map((s) => [s.name, refsOf('group').find((g) => g.id === s.groupId)?.name ?? '']));
    dialog.replaceChildren(
      h('div', { class: 'sheethead' }, h('h2', {}, t('Итоги по ролям')), closeButton(dialog)),
      h('div', { class: 'tabs', role: 'group', 'aria-label': t('Период') },
        [['month', t('Этот месяц')], ['year', t('Учебный год')], ['all', t('Всё время')]].map(([id, label]) =>
          h('button', { type: 'button', class: period === id ? 'active' : '', 'aria-pressed': String(period === id), onclick: () => { period = id; draw(); } }, label))),
      h('div', { class: 'sheetbody' },
        people.length
          ? h('div', { class: 'tablewrap' }, h('table', { class: 'rolestats' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('Студент')), h('th', { scope: 'col' }, t('Группа')),
              roles.map((role) => h('th', { scope: 'col', class: 'num' }, role)), h('th', { scope: 'col', class: 'num' }, t('Всего')))),
            h('tbody', {}, people.map((person) => h('tr', {},
              h('td', {}, person.name),
              h('td', {}, groupOf.get(person.name) ?? ''),
              roles.map((role) => h('td', { class: 'num' }, person.roles[role] ? String(person.roles[role]) : '')),
              h('td', { class: 'num' }, h('b', {}, String(person.total))))))))
          : h('p', { class: 'help' }, t('За этот период ролей не было. Роли назначаются в форме задания, практики или мероприятия.')),
        people.length > 0 && h('p', { class: 'help' }, t('Студентов с ролями: {0}. Считаются состоявшиеся события до сегодняшнего дня.', [people.length]))),
    );
  };
  draw();
  dialog.showModal();
}

function drawCatalog({ fromTop = false } = {}) {
  const dialog = $('catalog');
  const scrolled = fromTop ? 0 : dialog.querySelector('.sheetbody')?.scrollTop ?? 0;
  const pane = catalog.tab === 'groups'
    ? groupsPane()
    : catalog.tab === 'equipment'
      ? equipmentPane()
      : catalog.tab === 'role'
        ? [
          h('button', { class: 'plain', id: 'open-rolestats', onclick: openRoleStats }, t('Итоги по ролям')),
          simplePane('role', t('Например: оператор, ведущий, фотограф'), t('Добавьте роли, чтобы назначать их студентам в заданиях, практике и мероприятиях.')),
        ]
        : simplePane('teacher', t('ФИО, можно с датой рождения, или столбцы из таблицы'), t('Добавьте преподавателей, чтобы выбирать ответственных.'));
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
  if (row.auto && row.status === 'absent') return t('С телефона в {0}, с {1}-й минуты это пропуск. Ждёт подтверждения', [clockTime(row.at), ABSENT_FROM_MINUTE]);
  if (row.auto && row.late) return t('С телефона в {0}, опоздание {1} мин. Ждёт подтверждения', [clockTime(row.at), row.late]);
  if (row.auto) return t('С телефона в {0}. Ждёт подтверждения', [clockTime(row.at)]);
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
      status.admin && status.days !== null && status.days >= 2 && h('p', { class: 'error', id: 'backup-stale' }, t('Копия не делалась {0}. Проверьте, доступна ли папка.', [tp('days', status.days)])),
      status.sameDisk && h('p', { class: 'notice', id: 'backup-samedisk' }, t('Копии лежат на том же диске, что и данные. Если компьютер сломается, пропадут и они. Выберите сетевую папку или флешку.')),
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

/* Версии программы */

const isClient = () => state.settings?.edition === 'client';
const canManage = () => !isClient();

/** Клиент на панели не показывает разделы преподавателя. Запрет проверяется и в основном процессе. */
function applyEdition() {
  for (const id of ['open-catalog', 'open-reports', 'notices-open', 'open-journal', 'open-chronicle']) $(id).hidden = isClient();
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
  if (!event || !takesAttendance(event) || event.pending) return;
  const search = h('input', { id: 'r-search', type: 'search', placeholder: t('Поиск по фамилии'), autocomplete: 'off', 'aria-label': t('Поиск по фамилии') });
  const summary = h('p', { class: 'rollsummary', role: 'status' });
  const autoBox = h('div', { class: 'autobox', hidden: true });
  const retroBox = h('div', { class: 'autobox retro', hidden: true });
  const banner = h('p', { class: 'lockbanner', hidden: true });
  const startBox = h('div', { class: 'startline' });
  const list = h('ul', { class: 'rolllist' });
  const failure = h('p', { class: 'error' });
  const log = h('section', { class: 'rollhistory', hidden: true });
  const footer = h('div', { class: 'sheetfoot' });
  const stageBox = h('div', { class: 'stagebox' });
  const liveBar = h('div', { class: 'livebar', hidden: true });
  const searchField = h('div', { class: 'field' }, search);
  let confirming = false;
  // «Список без начала»: студенты на панели отмечаются сами, пока преподаватель не пришёл.
  let skipStart = false;
  // Перекличка закончена: запоминается на этом устройстве, к ней можно вернуться до 40-й минуты.
  const callKey = `kerdiis-call:${event.id}`;
  const callDone = () => { try { return localStorage.getItem(callKey) === '1'; } catch { return false; } };
  const setCallDone = (done) => { try { if (done) localStorage.setItem(callKey, '1'); else localStorage.removeItem(callKey); } catch { /* приватный режим */ } };

  const apply = (doc) => {
    state.attendance = [...state.attendance.filter((item) => item.eventId !== event.id), doc];
    draw();
  };

  const refused = (result) => {
    if (result.code === 'cancelled') {
      failure.textContent = t('Занятие не состоялось: отметки на нём не ставятся.');
    } else if (result.code === 'teacher-only' || result.code === 'offsite') {
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

  // Начать занятие и вести перекличку можно и на панели, и у преподавателя; пару вне колледжа — только у преподавателя.
  function canStartHere() {
    return !(event.offsite === true && !canManage());
  }

  function drawStart(doc, locked, teacherMode) {
    const delay = startDelay(event, doc);
    const began = doc?.start ? clockTime(actualStart(event, doc).toISOString()) : null;
    // Пара уже прошла и не начиналась: заполняется по журналу, приход — к началу по расписанию.
    if (!began && lessonOver(event, Date.now())) {
      startBox.replaceChildren();
      return;
    }
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
      // На прошедшей паре (заполнение по журналу) приход ставится к началу или через 10 минут, время правится в поле рядом.
      onclick: () => {
        const past = lessonOver(event, Date.now());
        const lateAt = new Date(new Date(startIso()).getTime() + LATE_FROM_MINUTE * 60_000).toISOString();
        return row.lateMark || row.late
          ? setMark(row.name, 'present', { late: false, at: past ? startIso() : row.at })
          : setMark(row.name, 'present', { late: true, ...(past ? { at: lateAt } : {}) });
      },
    }, t('Опоздал')),
    (row.lateMark || row.late > 0) && timeField({
      value: inputTime(row.at),
      label: t('Время прихода: {0}', [row.name]),
      onCommit: (time) => setMark(row.name, 'present', { late: true, at: new Date(`${event.date}T${time}`).toISOString() }),
    }),
  ];

  function drawFooter(doc) {
    if (confirming) {
      const missing = roll(event).filter((row) => !row.marked && !row.excusedFor && row.status === 'pending').length;
      footer.replaceChildren(
        h('p', { class: 'message' }, missing
          ? t('Не отмечены: {0} — они станут отсутствующими. Отчёт закроется для панелей, исправить его можно будет только в версии для преподавателей.', [missing])
          : t('Все отмечены. Отчёт закроется для панелей, исправить его можно будет только в версии для преподавателей.')),
        h('button', { type: 'button', class: 'plain', onclick: () => { confirming = false; draw(); } }, t('Отмена')),
        h('button', { type: 'button', class: 'primary', id: 'lock-confirm', onclick: lock }, t('Зафиксировать')),
      );
      return;
    }
    // На панели отчёт фиксируют после начала занятия, когда все отмечены.
    if (isClient() && !doc?.start) {
      footer.replaceChildren(h('p', { class: 'message' }, t('Подтверждение справки, остальные причины и отчёт ведутся в версии для преподавателей.')));
      return;
    }
    footer.replaceChildren(...(doc?.lock ? [] : [
      isClient() && h('p', { class: 'message' }, t('Справки и остальные причины — в версии для преподавателей.')),
      h('button', { type: 'button', class: 'primary', id: 'lock-report', onclick: () => { confirming = true; draw(); } }, t('Зафиксировать и отправить')),
    ].filter(Boolean)));
  }

  const startIso = () => actualStart(event, attendanceOf(event.id)).toISOString();

  // «Отметить всех»: каждый, кто ещё не отмечен и не освобождён, пришёл к началу.
  const markAll = async (names) => {
    const result = await api.markAll(event.id, names, startIso());
    if (result.ok && result.value) {
      failure.textContent = '';
      apply(result.value);
    } else if (!result.ok) refused(result);
  };

  /** Экран до начала: одна большая кнопка. */
  function drawStartStage(rows) {
    const excusedCount = rows.filter((row) => row.excusedFor).length;
    stageBox.replaceChildren(h('div', { class: 'startstage' },
      h('p', { class: 'stagetime' }, timeRange(event), event.place ? ` · ${event.place}` : ''),
      h('p', {}, t('Студентов: {0}', [rows.length]), excusedCount ? ` · ${t('освобождены приказом: {0}', [excusedCount])}` : ''),
      h('button', { type: 'button', class: 'primary bigstart', id: 'start-lesson', onclick: () => start() }, t('Начать занятие')),
      h('p', { class: 'help' }, t('Нажмите, когда занятие фактически началось. Затем отметьте, кто на месте: они придут к началу. Опоздавших отметите позже, по факту прихода.'))));
  }

  /** Перекличка: крупные карточки, «Отметить всех», приход записывается временем начала. */
  function drawCallStage(rows, doc) {
    const open = rows.filter((row) => !row.marked && !row.excusedFor && row.status === 'pending');
    const marked = rows.filter((row) => row.marked);
    const began = clockTime(actualStart(event, doc).toISOString());
    stageBox.replaceChildren(
      h('div', { class: 'callhead' },
        h('div', {},
          h('p', { class: 'stagetime' }, t('Перекличка · занятие идёт с {0}', [began])),
          h('p', { class: 'help' }, t('Отметьте, кто на месте. Всем им запишется приход в {0}, сколько бы ни шла перекличка.', [began]))),
        h('div', { class: 'callactions' },
          open.length > 0 && h('button', { type: 'button', class: 'primary', id: 'mark-all', onclick: () => markAll(open.map((row) => row.name)) }, marked.length ? t('Отметить оставшихся ({0})', [open.length]) : t('Отметить всех ({0})', [open.length])),
          marked.length > 0 && open.length === 0 && h('span', { class: 'allmarked' }, t('Все отмечены. Снимите отметку с тех, кого нет.')))),
      h('ul', { class: 'calltiles' }, rows.map((row) => {
        const off = Boolean(row.excusedFor) || (!row.marked && row.status !== 'pending');
        return h('li', {}, h('button', {
          type: 'button',
          class: `calltile${row.auto ? ' auto' : ''}`,
          'aria-pressed': String(Boolean(row.marked)),
          disabled: off,
          onclick: () => (row.marked && !row.auto
            ? setMark(row.name, null)
            : setMark(row.name, 'present', { at: row.auto ? row.at : startIso() })),
        }, h('strong', {}, row.name), h('span', {}, row.excusedFor
          ? t('Освобождён: {0}', [row.excusedFor])
          : row.auto ? t('Отметился с телефона, нажмите для подтверждения') : off ? rowNote(row) : row.marked ? t('На месте') : t('Нет'))));
      })));
  }

  /** После переклички: что запишется опоздавшему, если он войдёт сейчас. */
  function drawLiveBar(doc, rows) {
    const arrival = arrivalNow(event, doc, new Date().toISOString());
    const missing = rows.filter((row) => !row.marked && !row.excusedFor && row.status === 'pending').length;
    liveBar.dataset.verdict = arrival.verdict;
    liveBar.replaceChildren(
      h('span', {}, t('Идёт {0}-я минута занятия.', [arrival.minutes + 1]), ' ', {
        ontime: t('Вошедшему сейчас — вовремя.'),
        late: t('Вошедшему сейчас — опоздание {0} мин.', [arrival.minutes]),
        absent: t('Вошедшему сейчас — пропуск: прошло больше {0} минут.', [ABSENT_FROM_MINUTE - 1]),
      }[arrival.verdict], missing ? ` ${t('Ещё не пришли: {0}. Нажмите на фамилию, когда студент войдёт.', [missing])}` : ''),
      arrival.minutes < ABSENT_FROM_MINUTE && h('button', { type: 'button', class: 'plain', onclick: () => { setCallDone(false); draw(); } }, t('Вернуться к перекличке')));
  }

  function draw() {
    const rows = roll(event);
    const doc = attendanceOf(event.id);
    let stage = canStartHere() ? rollStage(event, doc, Date.now(), callDone()) : 'list';
    if (stage === 'start' && skipStart) stage = 'list';
    dialog.dataset.stage = stage;
    const staged = stage === 'start' || stage === 'call';
    stageBox.hidden = !staged;
    if (!staged) stageBox.replaceChildren();
    for (const part of [startBox, summary, searchField, list, log]) part.hidden = staged;
    liveBar.hidden = stage !== 'live';
    if (stage === 'start') {
      drawStartStage(rows);
      footer.replaceChildren(
        h('button', { type: 'button', class: 'plain', onclick: () => { dialog.close(); showDetails(event.id); } }, t('Карточка занятия')),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'plain', id: 'skip-start', onclick: () => { skipStart = true; draw(); } }, t('Список без начала занятия')));
      return;
    }
    if (stage === 'call') {
      const everyone = rows.every((row) => row.marked || row.excusedFor || row.status !== 'pending');
      drawCallStage(rows, doc);
      autoBox.hidden = true;
      footer.replaceChildren(...[
        h('button', { type: 'button', class: 'plain', onclick: () => { dialog.close(); showDetails(event.id); } }, t('Карточка занятия')),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: everyone ? 'plain' : 'primary', id: 'call-done', onclick: () => { setCallDone(true); draw(); } }, t('Перекличка закончена')),
        // Все на месте — опоздавших не ждём, отчёт можно зафиксировать сразу.
        everyone && h('button', { type: 'button', class: 'primary', id: 'lock-report', onclick: () => { setCallDone(true); confirming = true; draw(); } }, t('Зафиксировать и отправить')),
      ].filter(Boolean));
      if (confirming) drawFooter(doc);
      return;
    }
    if (stage === 'live') drawLiveBar(doc, rows);
    const cancelled = event.cancelled === true;
    const teacherMode = canManage() && !cancelled;
    // Пару вне колледжа на панели не отмечают: только смотрят, что внёс преподаватель.
    const away = (event.offsite === true && !teacherMode) || cancelled;
    const locked = Boolean(doc?.lock) || away;
    const count = (status) => rows.filter((row) => row.status === status).length;
    const parts = [
      t('Отмечены: {0} из {1}', [count('present'), rows.length]),
      countsLateness(event) && t('с опозданием: {0}', [rows.filter((row) => row.late).length]),
      ...ABSENCE_REASONS.map(([reason, label]) => `${t(label).toLowerCase()}: ${count(reason)}`),
    ];
    summary.textContent = parts.filter(Boolean).join(', ');
    // Отметки со страницы студента ждут преподавателя: подтвердить или поправить время прихода.
    const pendingAuto = rows.filter((row) => row.auto);
    autoBox.hidden = locked || !pendingAuto.length;
    autoBox.replaceChildren(...(autoBox.hidden ? [] : [
      h('span', {}, t('Отметились с телефона и ждут подтверждения: {0}. Если студент пришёл в аудиторию позже, нажмите «Опоздал» и поправьте время.', [pendingAuto.length])),
      h('button', {
        type: 'button',
        id: 'confirm-auto',
        onclick: async () => {
          for (const row of pendingAuto) await setMark(row.name, 'present', { at: row.at });
        },
      }, t('Подтвердить всех ({0})', [pendingAuto.length])),
    ]));
    // Прошедшая пара без переклички: заполнение по бумажному журналу. «Все были», затем снять тех, кого не было.
    const unmarkedRows = rows.filter((row) => !row.marked && !row.excusedFor && ['unmarked', 'absent'].includes(row.status) && !row.lateMark);
    const retro = teacherMode && !locked && lessonOver(event, Date.now()) && unmarkedRows.length > 0;
    retroBox.hidden = !retro;
    retroBox.replaceChildren(...(retro ? [
      h('span', {}, rows.some((row) => row.status === 'unmarked')
        ? t('Перекличку на этом занятии не проводили: пока оно не отмечено, в баллы и посещаемость не входит. Заполните по журналу: «Все были», затем снимите отметку с отсутствовавших и отметьте опоздавших.')
        : t('Не отмечены: {0}. Им засчитан прогул.', [unmarkedRows.length])),
      h('button', { type: 'button', class: 'primary', id: 'mark-all-past', onclick: () => markAll(unmarkedRows.map((row) => row.name)) },
        t('Все были ({0})', [unmarkedRows.length])),
    ] : []));
    if (countsLateness(event) && !cancelled) drawStart(doc, locked, teacherMode);
    banner.hidden = !locked;
    banner.textContent = doc?.lock
      ? t('Отчёт зафиксирован: {0}, {1}', [doc.lock.teacher, stampText(doc.lock.at)])
      : cancelled ? t('Занятие не состоялось. Отметки на нём не ставятся.')
      : away ? t('Пара проходит вне колледжа. Отметки вносит преподаватель в версии для преподавателей.') : '';
    const query = nameKey(search.value);
    // Во время занятия сверху те, кого ещё нет: их отмечают по факту прихода.
    const waiting = (row) => (stage === 'live' && !row.marked && !row.excusedFor && row.status === 'pending' ? 0 : 1);
    const ordered = [...rows].sort((a, b) => waiting(a) - waiting(b));
    keepScroll(list, () => list.replaceChildren(...ordered.filter((row) => !query || nameKey(row.name).includes(query)).map((row) => {
      const settled = !row.excusedFor && !row.unconfirmed && !['present', 'pending', 'absent'].includes(row.status);
      return h('li', { class: `rollrow${row.excusedFor ? ' excused' : ''}` },
        h('button', {
          type: 'button',
          class: 'rollname',
          'aria-pressed': String(Boolean(row.marked)),
          disabled: !teacherMode && (locked || settled),
          onclick: () => setMark(row.name, row.marked ? null : 'present', lessonOver(event, Date.now()) && countsLateness(event) ? { at: startIso() } : {}),
        }, h('strong', {}, row.name), h('span', { class: row.late ? 'late' : '' }, rowNote(row))),
        row.auto && !locked && h('button', {
          type: 'button',
          class: 'reason confirmauto',
          onclick: () => setMark(row.name, 'present', { at: row.at, late: row.lateMark === true }),
        }, t('Подтвердить')),
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
    if (away) footer.replaceChildren();
    else drawFooter(doc);
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
    h('div', { class: 'sheetbody' }, banner, stageBox, liveBar, startBox, summary, retroBox, autoBox, failure, searchField, list, log),
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
        const role = roleOf(event, name);
        return h('li', {}, checkBox(), h('span', {}, [name, group, role && t('роль: {0}', [role])].filter(Boolean).join(', ')));
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
  ['lateness', t('Кто опаздывает и в какие дни'), t('Опоздания'), [
    [t('Группа'), (r) => r.group],
    [t('Студент'), (r) => r.name],
    [t('Опозданий'), (r) => r.late],
    [t('Минут всего'), (r) => r.minutes],
    [t('В среднем, мин'), (r) => r.average || ''],
    ...[1, 2, 3, 4, 5, 6].map((day) => [weekdayShort(day), (r) => r.byWeekday[day - 1] || '', { heat: (r) => r.byWeekday[day - 1] }]),
    [t('Чаще всего'), (r) => r.worstDays.map(weekdayLong).join(', ')],
    [t('С 40-й минуты'), (r) => r.tooLate || ''],
    [t('Последнее'), (r) => (r.last ? shortDate(r.last) : '')],
  ]],
];

/** Названия дней недели на языке программы: понедельник 1. */
function weekdayDate(day) {
  return addDays('2024-01-01', day - 1);
}
function weekdayShort(day) {
  return fmt(weekdayDate(day), { weekday: 'short' });
}
function weekdayLong(day) {
  return fmt(weekdayDate(day), { weekday: 'long' });
}

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
  if (reports.tab === 'lateness') {
    const lates = report.latenessByWeekday.reduce((sum, n) => sum + n, 0);
    if (!lates) return t('Опозданий за этот период нет.');
    const most = Math.max(...report.latenessByWeekday);
    const days = report.latenessByWeekday.map((n, i) => (n === most ? weekdayLong(i + 1) : null)).filter(Boolean);
    return t('Опозданий: {0}, опаздывали студентов: {1}. Больше всего опозданий: {2} ({3}).', [lates, report.lateness.filter((r) => r.late).length, days.join(', '), most]);
  }
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
        h('tbody', {}, rows.map((row) => h('tr', {}, columns.map(([, value, options]) => h('td', {
          class: options?.heat ? `heat heat-${Math.min(4, options.heat(row) ?? 0)}` : null,
        }, String(value(row) ?? ''))))))))
      : h('p', { class: 'help' }, reports.tab === 'lateness' ? t('Опозданий за этот период нет.') : t('За этот период проведённых пар нет. Измените период или условия отбора.')),
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

/* Сводка за неделю для учебной части */

const SUMMARY_LABELS = () => ({
  groups: t('Посещаемость по группам'),
  groupHeader: [t('Группа'), t('Отметок'), t('Пришли'), t('Опоздания'), t('Без причины'), t('Болезнь'), t('Без справки'), t('По приказу'), t('Уважительная'), t('Посещаемость, %')],
  absent: t('Пропуски без причины и опоздания'),
  absentHeader: [t('Студент'), t('Группа'), t('Без причины'), t('Опоздания'), t('Отметок')],
  certificates: t('Ждём справку'),
  certificatesHeader: [t('Студент'), t('Занятий'), t('С какого дня')],
  debts: t('Не сдали работы в срок'),
  debtsHeader: [t('Студент'), t('Долгов'), t('Что не сдано')],
});

/** Сводка с понедельника по воскресенье указанной недели. */
function weeklySummary(monday) {
  const clock = now();
  const sunday = addDays(monday, 6);
  const text = weeklySummaryCsv({
    events: state.allEvents,
    attendance: state.attendance,
    students: refsOf('student'),
    groups: refsOf('group'),
    from: monday,
    to: sunday,
    nowISO: clock.iso,
    nowTime: clock.time,
    labels: { ...SUMMARY_LABELS(), title: t('Сводка Kerdiis за неделю с {0} по {1}', [shortDay(monday), shortDay(sunday)]) },
  });
  return { text, fileName: t('Сводка за неделю {0} – {1}.csv', [monday, sunday]) };
}

/** По понедельникам версия для преподавателей сама сохраняет сводку за прошлую неделю. */
async function autoSummary() {
  if (state.settings?.edition !== 'admin' || !state.allEvents.length) return;
  const status = await api.summaryStatus();
  if (!status.auto) return;
  const lastMonday = addDays(weekStart(now().iso), -7);
  if (status.week >= lastMonday) return;
  const { text, fileName } = weeklySummary(lastMonday);
  const result = await api.summaryWrite(fileName, text, lastMonday);
  if (result.ok) toast(t('Сводка за прошлую неделю сохранена в папку сводок.'));
}

function summarySection() {
  const box = h('section', { class: 'setting', id: 's-summary' });
  const message = h('p', { class: 'help', role: 'status' });
  const draw = async () => {
    const status = await api.summaryStatus();
    const auto = h('input', { id: 's-summary-auto', type: 'checkbox', checked: status.auto });
    auto.addEventListener('change', async () => { await api.summarySet(auto.checked); draw(); });
    const save = async (monday) => {
      const { text, fileName } = weeklySummary(monday);
      const result = await api.summaryWrite(fileName, text, '');
      message.replaceChildren(result.ok
        ? h('span', {}, t('Сохранено: {0}. ', [fileName]), h('button', { type: 'button', class: 'linkbutton', onclick: () => api.summaryShow(result.value) }, t('Показать в папке')))
        : t('Сводка не сохранена. Проверьте, доступна ли папка.'));
    };
    const thisMonday = weekStart(now().iso);
    box.replaceChildren(
      h('h3', { class: 'settinghead' }, t('Сводка для учебной части')),
      h('p', {}, t('Файл для Excel: посещаемость по группам, пропуски без причины, кто должен справку и кто не сдал работы в срок.')),
      h('label', { class: 'check' }, auto, t('Сохранять сводку за прошлую неделю каждый понедельник')),
      status.week && h('p', { class: 'help' }, t('Последняя сохранённая: неделя с {0}.', [shortDay(status.week)])),
      h('p', { class: 'help backupdir' }, t('Папка: {0}', [status.dir])),
      h('div', { class: 'targets' },
        h('button', { type: 'button', id: 's-summary-last', onclick: () => save(addDays(thisMonday, -7)) }, t('Сводка за прошлую неделю')),
        h('button', { type: 'button', id: 's-summary-this', onclick: () => save(thisMonday) }, t('За эту неделю')),
        h('button', { type: 'button', onclick: async () => { const r = await api.summaryChooseDir(); if (r.ok && r.value) draw(); } }, t('Выбрать папку'))),
      message,
      h('p', { class: 'help' }, t('Удобно выбрать общую сетевую папку учебной части: файл появится там сам, отправлять его не нужно.')),
    );
  };
  draw();
  return box;
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
  const key = `${group.id}:${group.petName}:${group.petKind}:${pet.mood}:${pet.health}`;
  if (key !== petButtonKey) {
    petButtonKey = key;
    button.setAttribute('aria-label', t('Тамагочи группы {0}', [group.name]));
    button.replaceChildren(petSprite(pet.mood, null, group.petKind), h('span', {}, group.petName || group.name));
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
  const saveName = async () => {
    const result = await api.namePet(group.id, name.value);
    if (!result.ok) {
      failure.textContent = t('Не удалось сохранить. Попробуйте ещё раз.');
      return;
    }
    await loadDirectory();
    petButtonKey = '';
    refreshPet();
    drawPet();
  };
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
  }, petSprite(pet.mood, look, group.petKind));

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
      (pet.mood === 'dead'
        ? canManage() && h('button', {
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
      pet.mood !== 'dead' && kindSection(group, saveGroup, failure),
      pet.mood !== 'dead' && prizeSection(pet, prizes, look, (next) => saveGroup({ petLook: next })),
      healthChart(pet),
      petGraves(group),
      petOverview(groups),
      h('p', { class: 'help' }, t('Питомец живёт посещаемостью группы: пропуски без причины и опоздания вредят ему, хорошая посещаемость лечит. Уважительные причины не вредят.'))),
  );
}

/**
 * Вид питомца. Преподаватель выбирает в любой момент. Студент на панели выбирает один раз:
 * после выбора вид не меняется до смерти питомца (или заведения нового).
 */
function kindSection(group, saveGroup, failure) {
  const teacher = canManage();
  const locked = !teacher && petKindLocked(group);
  const current = petKindOf(group.petKind);
  let picked = current;
  const buttons = PET_KINDS.map((kind) => h('button', {
    type: 'button',
    class: 'petkind',
    'data-kind': kind.id,
    disabled: locked,
    'aria-pressed': String(kind.id === current),
    onclick: () => {
      if (teacher) {
        if (kind.id !== current) saveGroup({ petKind: kind.id, petKindFor: petKindLockKey(group) });
        return;
      }
      picked = kind.id;
      paint();
    },
  }, petSprite('fine', null, kind.id), h('span', {}, t(kind.name))));
  const confirm = h('button', {
    type: 'button',
    class: 'primary petchoose',
    hidden: teacher || locked,
    onclick: async () => {
      const result = await api.choosePetKind(group.id, picked);
      if (!result.ok) {
        failure.textContent = result.code === 'locked' ? t('Вид уже выбран для этого питомца.') : t('Не удалось сохранить. Попробуйте ещё раз.');
        return;
      }
      await loadDirectory();
      petButtonKey = '';
      refreshPet();
      drawPet();
    },
  }, t('Выбрать этот вид'));
  const hint = h('p', { class: 'help' }, teacher
    ? t('Студент на панели выбирает вид один раз. Ваш выбор тоже закрывает его до смерти питомца.')
    : locked
      ? t('Вид выбран. Поменять его можно только после смерти питомца.')
      : t('Выбрать вид можно один раз. До смерти питомца он не поменяется.'));
  const paint = () => {
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.kind === picked));
  };
  return h('section', { class: 'petsection' },
    h('h3', {}, t('Вид питомца')),
    h('div', { class: 'petkinds', role: 'group', 'aria-label': t('Вид питомца') }, buttons),
    hint,
    confirm);
}

/** Призы питомца: полученные, следующий и наряд, который выбирает преподаватель. */
function prizeSection(pet, prizes, look, saveLook) {
  const owned = new Map(prizes.earned.map((prize) => [prize.id, prize]));
  const progress = prizes.next
    ? t('До приза «{0}»: {1} из {2} дней подряд со здоровьем от {3}.', [t(prizes.next.name), prizes.streak, PRIZE_DAYS, PRIZE_HEALTH])
    : t('Все призы получены. Каждые {0} дня подряд со здоровьем от {1} приносят звезду.', [PRIZE_DAYS, PRIZE_HEALTH]);
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

/* Праздничное оформление */

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  el.append(...children);
  return el;
};

let garlandKey = '';
/** Фигуры с лучами и стеблями: их линии рисуются цветом фигуры. */
const LINE_SHAPES = new Set(['sun', 'flower', 'cap', 'leaf', 'apple']);

async function loadSkin() {
  const result = await api.skin();
  if (result.ok) state.skin = result.value;
  applySkin();
}

/** Включает скин на всём экране: гирлянда под верхней строкой, на Новый год — снег. */
function applySkin() {
  const skin = activeSkin(state.skin, now().iso);
  document.body.dataset.skin = skin?.id ?? '';
  const box = $('garland');
  const width = Math.round(box.parentElement.clientWidth);
  const key = `${skin?.id ?? ''}|${width}`;
  if (key === garlandKey) return;
  garlandKey = key;
  box.hidden = !skin;
  drawSnow(skin?.snow === true);
  if (!skin) {
    box.replaceChildren();
    return;
  }
  const { path, points } = garlandLayout(width);
  const wire = skin.wire === 'ribbon'
    // Георгиевская лента: оранжевая с чёрными полосами.
    ? [svg('path', { d: path, class: 'wire', stroke: '#111', 'stroke-width': 9 }),
      svg('path', { d: path, class: 'wire', stroke: '#f77f00', 'stroke-width': 7 }),
      svg('path', { d: path, class: 'wire', stroke: '#111', 'stroke-width': 1.6 })]
    : [svg('path', { d: path, class: 'wire', stroke: skin.wire, 'stroke-width': 1.6 })];
  const items = points.map((point, index) => {
    const color = skin.colors[index % skin.colors.length];
    // Сдвиг — на внешней группе, покачивание — на внутренней: иначе анимация сбросит положение.
    const lines = LINE_SHAPES.has(skin.shape);
    return svg('g', { transform: `translate(${point.x - 15} ${point.y - 2}) scale(1.25)` },
      svg('g', { class: `garlanditem g${index % 3}` },
        svg('path', { d: SHAPES[skin.shape], fill: color, stroke: lines ? color : 'rgba(0,0,0,.35)', 'stroke-width': lines ? 1.6 : 0.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })));
  });
  box.replaceChildren(svg('svg', { width, height: 54, viewBox: `0 0 ${width} 54`, class: `garlandsvg shape-${skin.shape}` }, ...wire, ...items));
}

/** Лёгкий снег: несколько снежинок падают поверх календаря и не мешают нажимать. */
function drawSnow(on) {
  const box = $('snow');
  box.hidden = !on;
  if (!on) {
    box.replaceChildren();
    return;
  }
  if (box.childElementCount) return;
  box.replaceChildren(...Array.from({ length: 28 }, (_, i) => {
    const flake = h('span', { class: 'flake' }, '❄');
    flake.style.setProperty('--x', `${(i * 37) % 100}vw`);
    flake.style.setProperty('--delay', `${-((i * 7) % 23)}s`);
    flake.style.setProperty('--dur', `${14 + (i % 9)}s`);
    flake.style.setProperty('--size', `${0.6 + (i % 4) * 0.25}rem`);
    return flake;
  }));
}

function skinSection() {
  const select = h('select', { id: 's-skin', 'aria-label': t('Оформление') },
    h('option', { value: 'auto', selected: state.skin === 'auto' }, t('По праздникам — включается само')),
    h('option', { value: 'off', selected: state.skin === 'off' }, t('Выключено')),
    SKINS.map((skin) => h('option', { value: skin.id, selected: state.skin === skin.id }, t(skin.name))));
  const message = h('p', { class: 'help', role: 'status' });
  select.addEventListener('change', async () => {
    const result = await api.setSkin(select.value);
    if (!result.ok) {
      message.textContent = storeMessage(result);
      return;
    }
    state.skin = result.value;
    garlandKey = '';
    applySkin();
    refreshTicker();
    const skin = activeSkin(state.skin, now().iso);
    message.textContent = skin ? t('Сейчас: {0}. Видно на всех устройствах.', [t(skin.name)]) : t('Сейчас праздничного оформления нет.');
  });
  const calendar = SKINS.map((skin) => `${t(skin.name)}: ${skinDates(skin)}`).join('; ');
  return h('section', { class: 'setting', id: 's-skin-box' },
    h('h3', { class: 'settinghead' }, t('Праздничное оформление')),
    h('p', {}, t('Гирлянда под верхней строкой, на Новый год — снег, в сам праздник — поздравление в бегущей строке. Выбор действует на всех компьютерах и панелях.')),
    select,
    message,
    h('p', { class: 'help' }, t('По праздникам: {0}.', [calendar])));
}

/** «20 декабря – 10 января» для подсказки. */
function skinDates(skin) {
  const day = (md) => fmt(`2026-${md}`, { day: 'numeric', month: 'long' });
  return skin.from === skin.to ? day(skin.from) : `${day(skin.from)} – ${day(skin.to)}`;
}

/* Дни рождения в бегущей строке */

/** Поздравления: у каждого человека в этот день своё, весь день одно и то же. */
const GREETINGS = (name) => [
  t('🎂 {0} — с днём рождения! Пусть сегодня всё получается с первого дубля!', [name]),
  t('🎉 {0}, с днём рождения! Ярких кадров, громких оваций и пятёрок без пересдач!', [name]),
  t('🥳 {0} — с днём рождения! Свет выставлен, камера пишет, праздник начинается!', [name]),
  t('🎁 С днём рождения, {0}! Пусть всё будет на пять с плюсом!', [name]),
  t('⭐ {0}, с днём рождения! Сегодня главная звезда колледжа — это вы!', [name]),
  t('🎈 {0} — с днём рождения! Пусть год будет как лучший монтаж: без лишнего и с крутыми переходами!', [name]),
  t('🎶 С днём рождения, {0}! Пусть сегодня играет только ваша любимая музыка!', [name]),
  t('🍰 {0}, с днём рождения! Торт уже в кадре, осталось задуть свечи!', [name]),
];
const LATE_GREETINGS = (name) => [
  t('🎂 {0} — с прошедшим днём рождения! Поздравляем всем колледжем!', [name]),
  t('🎉 {0}, с прошедшим днём рождения! Праздник продолжается!', [name]),
];

/** На панелях не показываются те, кто не дал согласия на показ. */
const shownPublicly = (person) => !(isClient() && person.hidePublic);
const hiddenOnPanel = () => new Set(isClient() ? refsOf('student').filter((s) => s.hidePublic).map((s) => nameKey(s.name)) : []);

function birthdayItems() {
  const today = now().iso;
  return birthdaysOn([...refsOf('student'), ...refsOf('teacher')].filter(shownPublicly), today).map((person) => {
    const texts = person.late ? LATE_GREETINGS(person.name) : GREETINGS(person.name);
    return { id: `birthday-${person.id}`, color: 'birthday', name: texts[pickGreeting(person.name, today, texts.length)] };
  });
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
  const holiday = holidayGreeting(state.skin, now().iso);
  const notices = [...(holiday ? [{ id: holiday.id, color: 'birthday', name: t(holiday.text) }] : []), ...birthdayItems(), ...bestGroupItems(), ...gradeItems(), ...activeNotices(refsOf('notice'), moment()), ...deadlineItems(), ...certificateItems(), ...petItems()];
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
      h('thead', {}, h('tr', {}, [t('Событие'), t('Что сдать'), t('Срок'), t('Ответственный'), t('Сдали'), ''].map((name) => h('th', { scope: 'col' }, name)))),
      h('tbody', {}, events.map((event) => h('tr', {},
        h('td', {}, h('button', { class: 'linkbutton', onclick: () => { $('deadlines').close(); showDetails(event.id); } }, event.title)),
        h('td', {}, event.type === 'task' ? t('Задание') : t('Материалы')),
        h('td', {}, event.deadlineDone ? t('{0}. Сдано: {1}', [momentText(event.deadline), momentText(event.deadlineDone)]) : momentText(event.deadline)),
        h('td', {}, event.responsible || t('Не указан')),
        h('td', {}, event.type === 'task' && event.participants.length
          ? (canManage()
            ? h('button', { class: 'linkbutton', onclick: () => openHandIn(event.id) }, t('{0} из {1}', [handInSummary(event).done, event.participants.length]))
            : t('{0} из {1}', [handInSummary(event).done, event.participants.length]))
          : '—'),
        h('td', {}, canManage() && h('button', {
          class: 'plain',
          onclick: () => setDeadlineDone(event, !event.deadlineDone),
        }, event.deadlineDone ? t('Вернуть в работу') : t('Отметить сдачу')))))))));
}

/* Сдача по студентам */

const handInLabel = (status) => ({ done: t('Сдал'), rework: t('На доработке'), missing: t('Не сдал') })[status];

/** Кто из участников сдал работу. Каждое нажатие сохраняется сразу. */
function openHandIn(id) {
  const dialog = $('handin');
  const draw = () => {
    const event = state.allEvents.find((e) => e.id === id);
    if (!event) return dialog.close();
    const summary = handInSummary(event);
    const setStatus = async (names, status) => {
      const handIn = { ...event.handIn };
      for (const name of names) {
        if (status === 'missing') delete handIn[name];
        else handIn[name] = status;
      }
      if (await patchEvent(event, { handIn })) draw();
    };
    // Сначала те, кто ещё не сдал: их куратор ищет глазами.
    const order = { missing: 0, rework: 1, done: 2 };
    const names = [...event.participants].sort((a, b) => order[handInOf(event, a)] - order[handInOf(event, b)] || a.localeCompare(b, 'ru'));
    const body = h('div', { class: 'sheetbody' },
      h('p', { class: 'help' }, t('{0}. Срок: {1}', [event.title, deadlineFact(event)])),
      h('p', { class: 'handsum' }, t('Сдали: {0}, на доработке: {1}, не сдали: {2}', [summary.done, summary.rework, summary.missing])),
      h('ul', { class: 'handlist' }, names.map((name) => {
        const status = handInOf(event, name);
        return h('li', { class: `hand-${status}` },
          h('span', { class: 'who' }, roleText(event, name)),
          h('div', { class: 'seg', role: 'group', 'aria-label': name },
            ['done', 'rework', 'missing'].map((option) => h('button', {
              type: 'button',
              class: option === status ? 'on' : '',
              'aria-pressed': String(option === status),
              'data-status': option,
              onclick: () => option !== status && setStatus([name], option),
            }, handInLabel(option)))));
      })));
    const top = dialog.querySelector('.sheetbody')?.scrollTop ?? 0;
    dialog.replaceChildren(
      h('div', { class: 'sheethead' }, h('h2', {}, t('Сдача по студентам')), closeButton(dialog)),
      body,
      h('div', { class: 'sheetfoot' },
        summary.done < summary.total && h('button', { class: 'plain', id: 'handin-all', onclick: () => setStatus(event.participants, 'done') }, t('Все сдали')),
        h('div', { class: 'spacer' }),
        h('button', {
          class: event.deadlineDone ? 'plain' : 'primary',
          onclick: async () => { if (await setDeadlineDone(event, !event.deadlineDone)) draw(); },
        }, event.deadlineDone ? t('Вернуть в работу') : t('Закрыть срок'))),
    );
    body.scrollTop = top;
  };
  draw();
  if (!dialog.open) dialog.showModal();
}

/** Должники по всем заданиям: у кого срок прошёл, а работа не сдана. */
function debtorTable() {
  const people = debtors(state.events, moment());
  if (!people.length) return null;
  return h('section', { class: 'petsection' },
    h('h3', { class: 'deadlinelate' }, t('Должники: {0}', [people.length])),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, [t('Студент'), t('Долги'), t('Что не сдано')].map((name) => h('th', { scope: 'col' }, name)))),
      h('tbody', {}, people.map((person) => h('tr', {},
        h('td', {}, person.name),
        h('td', {}, String(person.items.length)),
        h('td', {}, person.items.map(({ event, status }) => (status === 'rework' ? t('{0} (на доработке)', [event.title]) : event.title)).join('; '))))))));
}

/** Невыполненные поручения собраний. */
function decisionTable() {
  const items = decisionList(state.events, moment().slice(0, 10));
  if (!items.length) return null;
  return h('section', { class: 'petsection' },
    h('h3', {}, t('Поручения собраний: {0}', [items.length])),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, [t('Поручение'), t('Кому'), t('Срок'), t('Собрание'), ''].map((name) => h('th', { scope: 'col' }, name)))),
      h('tbody', {}, items.map(({ event, item, state: when }) => h('tr', { class: when === 'overdue' ? 'late' : '' },
        h('td', {}, item.text),
        h('td', {}, item.who || t('Не указан')),
        h('td', {}, item.due ? (when === 'overdue' ? t('{0}, просрочено', [shortDay(item.due)]) : shortDay(item.due)) : t('Без срока')),
        h('td', {}, h('button', { class: 'linkbutton', onclick: () => { $('deadlines').close(); showDetails(event.id); } }, event.title)),
        h('td', {}, canManage() && h('button', {
          class: 'plain',
          onclick: () => patchEvent(event, { decisions: event.decisions.map((x) => (x.id === item.id ? { ...x, done: true } : x)) }).then(drawDeadlines),
        }, t('Выполнено')))))))));
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
  const empty = !certificates && !decisionList(state.events, moment().slice(0, 10)).length && !Object.values(list).some((events) => events.length);
  const sections = [
    certificates,
    debtorTable(),
    decisionTable(),
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

/* Ранний сигнал для кураторов */

const SIGNAL_TEXT = {
  streak: (n) => t('Пропусков без причины подряд: {0}', [n]),
  absentWeek: (n) => t('Пропусков без причины за неделю: {0}', [n]),
  lateWeek: (n) => t('Опозданий за неделю: {0}', [n]),
};

function currentSignals() {
  if (isClient()) return [];
  const clock = now();
  return earlySignals({ events: state.allEvents, attendance: state.attendance, students: refsOf('student'), groups: refsOf('group'), nowISO: clock.iso, nowTime: clock.time });
}

/** Счётчик на кнопке «Сигналы». Студенты здесь видны по именам, поэтому только в версии для преподавателей. */
function refreshSignals() {
  const list = currentSignals();
  const badge = $('signal-count');
  $('open-signals').hidden = isClient();
  badge.hidden = !list.length;
  badge.textContent = String(list.length);
  if ($('signals').open) drawSignals();
}

const SIGNAL_DAYS_SHOWN = 14;
const signalOpen = new Set();

/** Нарушения студента в окне сигнала: две недели или с «Разобрались», если это позже. */
function signalIncidents(student) {
  const clock = now();
  return attendanceIncidents({
    events: state.allEvents, attendance: state.attendance, name: student.name, from: addDays(clock.iso, -(SIGNAL_DAYS_SHOWN - 1)), to: clock.iso,
    nowISO: clock.iso, nowTime: clock.time, since: student.signalSince ?? '',
  });
}

const weekdayName = (index) => fmt(addDays('2026-11-02', index), { weekday: 'long' });
const incidentText = (item) => (item.kind === 'late' ? t('Опоздание на {0} мин', [item.minutes])
  : item.came ? t('Прогул: пришёл через 40 мин и позже') : t('Прогул без причины'));

/** Как изменились баллы рейтинга за окно сигнала и сколько сняли прогулы и опоздания. */
function signalRating(name, from) {
  const row = currentGrades().find((item) => nameKey(item.name) === nameKey(name));
  const days = (row?.history ?? []).filter((day) => day.date >= from);
  if (!days.length) return null;
  const lostBy = (kind) => days.flatMap((day) => day.items).filter((item) => item.kind === kind).reduce((sum, item) => sum + item.points, 0);
  return { before: days[0].before, after: days.at(-1).after, absent: lostBy('absent'), late: lostBy('late') };
}

/** Подробности сигнала: где и как просел, каждая пара с прогулом или опозданием. */
function signalDetails(student, incidents) {
  const sum = incidentSummary(incidents);
  const from = addDays(now().iso, -(SIGNAL_DAYS_SHOWN - 1));
  const rating = signalRating(student.name, from);
  const subjectText = (subject) => [
    subject.absent && t('прогулов: {0}', [subject.absent]),
    subject.late && t('опозданий: {0} ({1} мин)', [subject.late, subject.minutes]),
  ].filter(Boolean).join(', ');
  const worstDay = sum.weekdays[0];
  return h('div', { class: 'signaldetail' },
    h('p', {}, t('За две недели: пар с прогулом {0} (дней {1}), опозданий {2}, всего {3} мин.', [sum.absent, sum.absentDays, sum.late, sum.lateMinutes])),
    rating && h('p', {}, [
      t('Рейтинг за две недели: было {0}, стало {1}.', [rating.before, rating.after]),
      rating.absent && t('Прогулы: {0}.', [signed(rating.absent)]),
      rating.late && t('Опоздания: {0}.', [signed(rating.late)]),
      rating.after === 0 && rating.absent + rating.late < 0 && t('Ниже нуля баллы не опускаются, поэтому минус виден не весь.'),
    ].filter(Boolean).join(' ')),
    sum.subjects.length > 0 && [
      h('h4', {}, t('Где проседает')),
      h('ul', { class: 'signalsubjects' }, sum.subjects.map((subject) => h('li', {},
        h('b', {}, subject.title), subject.teacher && h('span', { class: 'help' }, t(' — {0}', [subject.teacher])), ': ', subjectText(subject)))),
      worstDay && worstDay.absent + worstDay.late > 1 && h('p', { class: 'help' }, t('Чаще всего — {0}: прогулов {1}, опозданий {2}.', [weekdayName(worstDay.weekday), worstDay.absent, worstDay.late])),
    ],
    incidents.length > 0 && h('div', { class: 'tablewrap' }, h('table', { class: 'filetable signaltable' },
      h('thead', {}, h('tr', {}, [t('Дата'), t('Время'), t('Пара'), t('Преподаватель'), t('Что случилось')].map((name) => h('th', { scope: 'col' }, name)))),
      h('tbody', {}, incidents.map((item) => h('tr', { class: `incident-${item.kind}` },
        h('td', {}, shortDay(item.date)), h('td', {}, `${item.start}–${item.end}`), h('td', {}, item.title),
        h('td', {}, item.teacher || '—'), h('td', {}, incidentText(item))))))));
}

function drawSignals() {
  const box = $('signals-list');
  const list = currentSignals();
  if (!list.length) {
    box.replaceChildren(h('p', { class: 'help' }, t('Сигналов нет: ни у кого не копятся пропуски и опоздания.')));
    return;
  }
  keepScroll(box.closest('.sheetbody') ?? box, () => box.replaceChildren(h('ul', { class: 'signals' }, list.map((item) => {
    const student = state.directory.find((ref) => ref.id === item.id);
    const incidents = student ? signalIncidents(student) : [];
    const open = signalOpen.has(item.id);
    return h('li', { class: 'signal', 'data-signal': item.name },
      h('div', { class: 'signalhead' },
        h('strong', {}, item.name),
        h('span', { class: 'help' }, [item.group, item.last && t('последний раз {0}', [shortDay(item.last)])].filter(Boolean).join(', '))),
      h('ul', { class: 'signalreasons' }, item.reasons.map((reason) => h('li', { class: `reason-${reason.kind}` }, SIGNAL_TEXT[reason.kind](reason.count)))),
      open && student && signalDetails(student, incidents),
      h('div', { class: 'targets' },
        h('button', { type: 'button', class: 'plain', 'aria-expanded': String(open), 'data-detail': item.name, onclick: () => {
          if (open) signalOpen.delete(item.id);
          else signalOpen.add(item.id);
          drawSignals();
        } }, open ? t('Свернуть') : t('Подробнее')),
        h('button', { type: 'button', class: 'plain', onclick: () => openPortfolio(item.id) }, t('Портфолио')),
        student && h('button', { type: 'button', class: 'plain', 'data-report': item.name, onclick: () => openMisconduct(student.id) }, t('Докладная')),
        h('button', {
          type: 'button',
          class: 'primary',
          onclick: async () => {
            if (!student) return;
            const result = await api.saveRefs([{ ref: { ...student, signalSince: new Date().toISOString() }, base: student.updatedAt }]);
            if (result.ok) {
              await loadDirectory();
              refreshSignals();
            }
          },
        }, t('Разобрались'))));
  }))));
}

/*
 * Докладная о нарушениях посещаемости: период, все пропуски без причины и опоздания
 * с датами, парами и преподавателями — основание для разговора или взыскания.
 * Текст и меры, которые уже приняты, преподаватель дописывает сам, подпись — как в служебной записке.
 */
const misconductState = { id: null, period: 'month', measures: '' };

function misconductPeriod(kind) {
  const today = now().iso;
  if (kind === 'two') return { from: addDays(today, -13), to: today };
  if (kind === 'semester') return { from: semesterOf(today).from, to: today };
  if (kind === 'all') return { from: ratingPeriod(today).from, to: today };
  return { from: addDays(today, -29), to: today };
}

function openMisconduct(studentId) {
  Object.assign(misconductState, { id: studentId, period: 'month', measures: '' });
  drawMisconduct();
  $('misconduct').showModal();
}

function drawMisconduct() {
  const dialog = $('misconduct');
  const student = state.directory.find((ref) => ref.id === misconductState.id);
  const periods = [['two', t('2 недели')], ['month', t('Месяц')], ['semester', t('Семестр')], ['all', t('С начала учёта')]];
  const measures = h('textarea', {
    id: 'mc-measures', rows: 3, maxlength: 1000, placeholder: t('Например: проведены беседы 10 и 17 ноября, сообщено родителям'),
    oninput: (e) => { misconductState.measures = e.target.value; },
  });
  measures.value = misconductState.measures;
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Докладная: {0}', [student?.name ?? ''])), closeButton(dialog)),
    h('div', { class: 'tabs weektools', role: 'group', 'aria-label': t('Период') },
      periods.map(([id, label]) => h('button', { type: 'button', 'data-period': id, 'aria-pressed': String(misconductState.period === id), onclick: () => { misconductState.period = id; drawMisconduct(); } }, label))),
    h('div', { class: 'sheetbody' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('Какие меры уже приняты')), measures,
        h('p', { class: 'help' }, t('Попадёт в докладную. Если пусто — останется строка, чтобы дописать от руки.'))),
      h('div', { class: 'paperview', id: 'mc-preview' }, misconductSheet())),
    h('div', { class: 'sheetfoot' }, printButtons(misconductSheet, () => t('Докладная {0}.pdf', [student?.name ?? '']))),
  );
  measures.addEventListener('change', () => $('mc-preview').replaceChildren(misconductSheet()));
}

function misconductSheet() {
  const student = state.directory.find((ref) => ref.id === misconductState.id);
  if (!student) return h('p', { class: 'help' }, t('Студент не найден.'));
  const clock = now();
  const { from, to } = misconductPeriod(misconductState.period);
  const incidents = attendanceIncidents({ events: state.allEvents, attendance: state.attendance, name: student.name, from, to, nowISO: clock.iso, nowTime: clock.time });
  const sum = incidentSummary(incidents);
  const long = (iso) => fmt(iso, { day: 'numeric', month: 'long', year: 'numeric' });
  const numeric = (iso) => fmt(iso, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const group = groupOfStudent(student) || '—';
  const from_ = state.settings?.memoFrom ?? '';
  const signer = state.settings?.memoSigner ?? '';
  return h('article', { class: 'paper misconductpaper' },
    h('div', { class: 'addressee' },
      h('p', {}, t('Заместителю директора по учебной работе')),
      h('p', {}, from_ ? t('от {0}', [from_]) : t('от ____________________'))),
    h('h2', {}, t('Докладная записка')),
    h('p', { class: 'docdate' }, long(clock.iso)),
    h('p', {}, t('Довожу до Вашего сведения, что обучающийся группы {0} {1} за период с {2} по {3} допустил нарушения учебной дисциплины:', [group, student.name, long(from), long(to)])),
    h('ul', {},
      h('li', {}, t('пропуски учебных занятий без уважительной причины: {0} (в {1} дн.);', [sum.absent, sum.absentDays])),
      h('li', {}, t('опоздания на учебные занятия: {0}, всего {1} мин.', [sum.late, sum.lateMinutes]))),
    incidents.length
      ? h('table', {},
        h('thead', {}, h('tr', {}, [t('№'), t('Дата'), t('Время'), t('Занятие'), t('Преподаватель'), t('Нарушение')].map((name) => h('th', {}, name)))),
        h('tbody', {}, incidents.map((item, index) => h('tr', {},
          h('td', {}, String(index + 1)), h('td', {}, numeric(item.date)), h('td', {}, `${item.start}–${item.end}`),
          h('td', {}, item.title), h('td', {}, item.teacher || '—'), h('td', {}, incidentText(item))))))
      : h('p', {}, t('Нарушений посещаемости за этот период нет.')),
    sum.subjects.length > 0 && h('p', {}, t('Больше всего нарушений: {0}.', [sum.subjects.slice(0, 3).map((subject) => t('{0} — {1}', [subject.title, subject.absent + subject.late])).join('; ')])),
    h('p', {}, misconductState.measures.trim()
      ? t('Принятые меры: {0}', [misconductState.measures.trim()])
      : t('Принятые меры: ________________________________________________')),
    h('p', {}, t('Прошу рассмотреть вопрос о мерах дисциплинарного воздействия в соответствии с частью 4 статьи 43 Федерального закона от 29.12.2012 № 273-ФЗ «Об образовании в Российской Федерации» и правилами внутреннего распорядка обучающихся.')),
    h('p', { class: 'signature' }, t('Подпись ____________ / {0}', [signer || '____________'])));
}

function openSignals() {
  const dialog = $('signals');
  dialog.replaceChildren(
    h('div', { class: 'sheethead' },
      h('div', {}, h('h2', {}, t('Ранние сигналы')),
        h('p', { class: 'help' }, t('Студенты, у которых за последние две недели {0} и больше пропусков без причины подряд, {1} и больше пропусков без причины или {2} и больше опозданий за неделю. «Разобрались» убирает студента, пока не накопится новое.', [SIGNAL_STREAK, SIGNAL_ABSENT_WEEK, SIGNAL_LATE_WEEK]))),
      closeButton(dialog)),
    h('div', { class: 'sheetbody' }, h('div', { id: 'signals-list' })),
  );
  drawSignals();
  dialog.showModal();
}

/* Портфолио студента */

function portfolioData(student) {
  const clock = now();
  return portfolio({ name: student.name, events: state.allEvents, attendance: state.attendance, achievements: refsOf('achievement'), nowISO: clock.iso, nowTime: clock.time });
}

const groupOfStudent = (student) => state.directory.find((ref) => ref.id === student.groupId)?.name ?? '';

/** Лист для печати и PDF: достижения и участие. */
function portfolioSheet(student) {
  const data = portfolioData(student);
  return h('article', { class: 'paper reportpaper' },
    h('header', {},
      h('p', { class: 'kicker' }, [t('Портфолио студента'), groupOfStudent(student)].filter(Boolean).join(', ')),
      h('h2', {}, student.name)),
    h('p', { class: 'own' }, portfolioSummary(data)),
    (() => {
      const grade = currentGrades().find((row) => nameKey(row.name) === nameKey(student.name));
      return grade && h('p', { class: 'own' }, t('Грейд за семестр: {0}, {1} баллов.', [gradeName(grade.level), grade.points]));
    })(),
    data.awards.length > 0 && [h('h3', {}, t('Достижения')), h('table', {},
      h('thead', {}, h('tr', {}, [t('Дата'), t('Название'), t('Результат')].map((name) => h('th', {}, name)))),
      h('tbody', {}, data.awards.map((item) => h('tr', {}, h('td', {}, shortDate(item.date)), h('td', {}, item.name), h('td', {}, item.result))))),
    ],
    data.items.length > 0 && [h('h3', {}, t('Участие')), h('table', {},
      h('thead', {}, h('tr', {}, [t('Дата'), t('Вид'), t('Название'), t('Роль'), t('Место'), t('Ответственный')].map((name) => h('th', {}, name)))),
      h('tbody', {}, data.items.map((item) => h('tr', {}, h('td', {}, shortDate(item.date)), h('td', {}, typeLabel(item.type)), h('td', {}, item.title), h('td', {}, item.role), h('td', {}, item.place), h('td', {}, item.responsible))))),
    ],
    h('p', { class: 'stamp' }, t('Сформировано {0}', [fmt(now().iso, { day: 'numeric', month: 'long', year: 'numeric' })])));
}

const portfolioSummary = (data) => t('Мероприятий: {0}, заданий: {1}, практик: {2}, достижений: {3}.', [data.counts.event, data.counts.task, data.counts.practice, data.awards.length]);

function openPortfolio(studentId) {
  const dialog = $('portfolio');
  const failure = h('p', { class: 'message error' });
  const draw = () => {
    const student = state.directory.find((ref) => ref.id === studentId);
    if (!student) {
      dialog.close();
      return;
    }
    const data = portfolioData(student);
    const date = h('input', { type: 'date', id: 'pf-date', value: now().iso, 'aria-label': t('Дата') });
    const title = h('input', { id: 'pf-title', placeholder: t('Конкурс, фестиваль, выставка'), 'aria-label': t('Название') });
    const result = h('input', { id: 'pf-result', placeholder: t('Например, диплом I степени'), 'aria-label': t('Результат') });
    const add = h('form', {
      class: 'adder portfolioadd',
      onsubmit: async (e) => {
        e.preventDefault();
        failure.textContent = '';
        if (!title.value.trim() || !date.value) return;
        const saved = await api.saveRefs([{ ref: { kind: 'achievement', name: title.value.trim(), student: student.name, date: date.value, result: result.value.trim() } }]);
        if (!saved.ok) {
          failure.textContent = storeMessage(saved);
          return;
        }
        await loadDirectory();
        draw();
      },
    }, date, title, result, h('button', { type: 'submit' }, t('Добавить')));
    dialog.replaceChildren(
      h('div', { class: 'sheethead' },
        h('div', {}, h('h2', {}, t('Портфолио: {0}', [student.name])), h('p', { class: 'help' }, [groupOfStudent(student), portfolioSummary(data)].filter(Boolean).join('. '))),
        closeButton(dialog)),
      h('div', { class: 'sheetbody' },
        h('section', { class: 'group' },
          h('h3', {}, t('Достижения')),
          canManage() && add,
          failure,
          data.awards.length
            ? h('ul', { class: 'awards' }, data.awards.map((item) => h('li', {},
              h('span', { class: 'awarddate' }, shortDate(item.date)),
              h('strong', {}, item.name),
              item.result && h('span', { class: 'awardresult' }, item.result),
              canManage() && h('button', {
                type: 'button',
                class: 'plain small',
                'aria-label': t('Удалить {0}', [item.name]),
                onclick: async () => {
                  await api.removeRefs([{ id: item.id, base: item.updatedAt }]);
                  await loadDirectory();
                  draw();
                },
              }, '×'))))
            : h('p', { class: 'help' }, t('Дипломы, места и грамоты вносит преподаватель. Участие ниже Kerdiis собирает сам.'))),
        h('section', { class: 'group' },
          h('h3', {}, t('Участие')),
          data.items.length
            ? h('div', { class: 'tablewrap' }, h('table', {},
              h('thead', {}, h('tr', {}, [t('Дата'), t('Вид'), t('Название'), t('Место'), t('Ответственный')].map((name) => h('th', {}, name)))),
              h('tbody', {}, data.items.map((item) => h('tr', {}, h('td', {}, shortDate(item.date)), h('td', {}, typeLabel(item.type)), h('td', {}, item.title), h('td', {}, item.place), h('td', {}, item.responsible))))))
            : h('p', { class: 'help' }, t('Пока нет мероприятий, заданий и практик, где студент был отмечен или записан.')))),
      h('div', { class: 'sheetfoot' }, printButtons(() => portfolioSheet(student), () => t('Портфолио {0}.pdf', [student.name]))),
    );
  };
  draw();
  if (!dialog.open) dialog.showModal();
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
      summarySection(),
      skinSection(),
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
        h('p', { class: 'help' }, t('Включите на компьютерах преподавателей.'))),
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
          }, t('Обменяться сейчас')),
          h('button', { type: 'button', class: 'plain', id: 's-netcheck', onclick: () => { dialog.close(); openNetCheck(); } }, t('Проверка связи'))),
        devices),
      ]),
      h('p', { class: 'help' }, current.edition === 'client' ? t('Версия программы: клиент для панелей.') : t('Версия программы: для преподавателей.')),
      h('p', { class: 'help' }, t('Версия {0}', [current.version])),
      DONATE_SBP && h('button', { type: 'button', class: 'plain donate', id: 'open-donate', onclick: openDonate }, t('Поддержать проект ♥')),
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

/* Связь с другими устройствами: индикатор в шапке и проверка с восстановлением */

const NET_GOOD_MS = 10 * 60_000;
const NET_WARN_MS = 2 * 60 * 60_000;

function agoText(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return t('только что');
  if (minutes < 60) return t('{0} мин назад', [minutes]);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('{0} ч назад', [hours]);
  return t('{0} дн. назад', [Math.round(hours / 24)]);
}

/** Состояние связи для индикатора: good, warn, bad или off (обмен не настроен). */
function netState(status) {
  if (!status.enabled) {
    return status.problem
      ? { level: 'bad', text: t('Обмен не работает'), title: PROBLEMS[status.problem] ?? '' }
      : { level: 'off', text: t('Обмен выключен'), title: t('Введите ключ сети, чтобы включить обмен.') };
  }
  const online = status.peers.filter((p) => p.status === 'ok').length;
  const ago = status.lastOkAt ? (status.now ?? Date.now()) - status.lastOkAt : null;
  const title = [
    ago === null ? t('Обмена ещё не было') : t('Последний обмен {0}', [agoText(ago)]),
    t('На связи устройств: {0} из {1}', [online, status.peers.length]),
    t('Нажмите, чтобы проверить связь'),
  ].join('\n');
  if (ago !== null && ago <= NET_GOOD_MS) return { level: 'good', text: t('На связи'), title };
  if (ago !== null && ago <= NET_WARN_MS) return { level: 'warn', text: t('Связь {0}', [agoText(ago)]), title };
  return { level: 'bad', text: t('Нет связи'), title };
}

/** Часы этого компьютера расходятся с другими: опоздания и «идёт сейчас» будут неверны. */
function skewText(skew) {
  const minutes = Math.round(Math.abs(skew.ms) / 60000);
  const amount = minutes >= 120 ? t('{0} ч', [Math.round(minutes / 60)]) : t('{0} мин', [minutes]);
  return skew.ms > 0
    ? t('Часы этого компьютера отстают от других устройств примерно на {0}. Опоздания и время отметок будут неверны: проверьте дату и время Windows.', [amount])
    : t('Часы этого компьютера спешат относительно других устройств примерно на {0}. Опоздания и время отметок будут неверны: проверьте дату и время Windows.', [amount]);
}

async function refreshNet() {
  const status = await api.syncStatus();
  const net = status.clockSkew
    ? { level: 'bad', text: t('Неверные часы'), title: skewText(status.clockSkew) }
    : netState(status);
  const button = $('net');
  button.dataset.level = net.level;
  button.title = net.title;
  button.setAttribute('aria-label', `${net.text}. ${t('Проверка связи')}`);
  $('net-text').textContent = net.text;
}

const PEER_RESULT = {
  ok: () => t('На связи'),
  timeout: () => t('Не отвечает: компьютер выключен, спит или его закрывает брандмауэр'),
  refused: () => t('Компьютер включён, но Kerdiis на нём не запущен'),
  unreachable: () => t('Нет пути по сети: устройство в другой сети или за роутером'),
  'wrong-key': () => t('Другой ключ сети'),
  outdated: () => t('Старая версия программы, обмен приостановлен'),
  offline: () => t('Нет связи'),
  unknown: () => t('Связи ещё не было'),
};

const editionName = (edition) => (edition === 'client' ? t('панель') : edition === 'admin' ? t('преподаватель') : '');

/** Проверки по пунктам: что в порядке, что нет и что с этим делать. */
function netChecks(report) {
  const items = [];
  const add = (level, title, text, advice) => items.push({ level, title, text, advice });
  if (!report.enabled) {
    add('bad', t('Обмен'), report.problem ? PROBLEMS[report.problem] ?? t('Обмен не запустился.') : t('Ключ сети не введён.'),
      report.problem ? t('Нажмите «Перезапустить обмен». Если не помогло — перезапустите компьютер.') : t('Ключ сети вводит преподаватель в настройках.'));
    return items;
  }
  add('good', t('Ключ сети'), t('Отпечаток ключа: {0}', [report.device.keyPrint]), t('На всех устройствах колледжа отпечаток должен быть одинаковым.'));
  add(report.subnets.length ? 'good' : 'bad', t('Подключение к сети'),
    report.subnets.length ? report.subnets.map((n) => `${n.name}: ${n.address} / ${n.netmask}`).join('; ') : t('Компьютер не подключён ни к одной сети.'),
    report.subnets.length ? '' : t('Проверьте кабель или Wi-Fi.'));
  add(report.listening && report.discovery ? 'good' : 'bad', t('Обмен на этом компьютере'),
    report.listening ? t('Работает, порт {0}', [report.device.port]) : t('Не принимает подключения'),
    report.listening && report.discovery ? '' : t('Нажмите «Перезапустить обмен».'));
  add(report.heard ? 'good' : 'warn', t('Поиск устройств в своей сети'),
    report.heard ? t('Отозвались на рассылку: {0}', [report.heard]) : t('Никто не отозвался на рассылку.'),
    report.heard ? '' : t('Устройства в другой подсети или роутер не пропускает рассылку. Добавьте ниже адрес компьютера преподавателя с постоянным IP — обмен пойдёт напрямую.'));
  const online = report.peers.filter((p) => p.status === 'ok');
  add(online.length ? (online.length === report.peers.length ? 'good' : 'warn') : 'bad', t('Связь с устройствами'),
    t('На связи: {0} из {1}', [online.length, report.peers.length]),
    online.length ? '' : t('Ни одно устройство не отвечает. Проверьте, что компьютеры преподавателей включены, и добавьте адрес одного из них ниже.'));
  add(report.clockSkew ? 'bad' : 'good', t('Часы компьютера'),
    report.clockSkew ? skewText(report.clockSkew) : t('Совпадают с другими устройствами'),
    report.clockSkew ? t('Включите в Windows «Устанавливать время автоматически» или поправьте дату и время вручную, затем перезапустите Kerdiis.') : '');
  if (report.inbound === 'blocked') {
    add('bad', t('Другие видят этот компьютер'), t('Нет: другие устройства не могут подключиться к нему.'),
      t('Обычно это брандмауэр Windows. Нажмите «Починить брандмауэр» — понадобится пароль администратора компьютера. Пока он не починен, этот компьютер сам забирает и отправляет данные раз в минуту.'));
  } else if (report.inbound === 'ok') {
    add('good', t('Другие видят этот компьютер'), t('Да'), '');
  } else {
    add('warn', t('Другие видят этот компьютер'), t('Не проверено: нет устройств на связи, через которые можно проверить.'), '');
  }
  const w = report.windows;
  if (w && !w.error) {
    const rulesOk = w.programRule === 'ok' && w.portRule && w.udpRule;
    add(rulesOk ? 'good' : 'warn', t('Брандмауэр Windows'),
      rulesOk ? t('Правила для Kerdiis на месте') : ({
        missing: t('Нет правила для Kerdiis'),
        'wrong-path': t('Правило есть, но на другую папку программы'),
        disabled: t('Правило для Kerdiis выключено'),
      }[w.programRule] ?? t('Нет правил для портов обмена')),
      rulesOk ? '' : t('Нажмите «Починить брандмауэр».'));
    const publicNets = w.profiles.filter((p) => p.category === 'Public');
    if (publicNets.length) {
      add('warn', t('Тип сети'), t('Общественная сеть: {0}', [publicNets.map((p) => p.alias || p.name).join(', ')]),
        t('В общественной сети Windows строже закрывает входящие подключения. Если починка брандмауэра не помогла, попросите администратора сделать эту сеть частной.'));
    }
    if (w.localRulesBlocked) {
      add('bad', t('Политика сети'), t('Политика колледжа запрещает свои правила брандмауэра.'), t('Нужен администратор сети: пусть разрешит Kerdiis.exe и порты 47800, 47801, 47880.'));
    }
  }
  return items;
}

function netReportText(report, checks) {
  const lines = [`Kerdiis ${report.device?.version ?? report.version ?? ''} · ${report.device?.name ?? report.name ?? ''} · ${editionName(report.device?.edition ?? report.edition)}`, report.at ?? new Date().toISOString(), ''];
  for (const c of checks) lines.push(`${{ good: '✓', warn: '!', bad: '✗' }[c.level]} ${c.title}: ${c.text}${c.advice ? ` — ${c.advice}` : ''}`);
  if (report.peers?.length) {
    lines.push('');
    for (const p of report.peers) lines.push(`${p.status === 'ok' ? '✓' : '✗'} ${p.name} (${p.address}${p.version ? `, ${p.version}` : ''}${p.edition ? `, ${editionName(p.edition)}` : ''}): ${PEER_RESULT[p.status]?.() ?? p.status}${p.ms != null ? `, ${p.ms} ms` : ''}${p.sameSubnet ? '' : `, ${t('другая подсеть')}`}`);
  }
  return lines.join('\n');
}

async function openNetCheck() {
  const dialog = $('netcheck');
  const body = h('div', { class: 'netbody' });
  const message = h('p', { class: 'message', role: 'status' });
  let report = null;
  let checks = [];
  const busy = (on) => { for (const b of dialog.querySelectorAll('button[data-act]')) b.disabled = on; };
  const run = async (before) => {
    busy(true);
    body.replaceChildren(h('p', { class: 'help' }, t('Проверяем связь, это займёт до 15 секунд…')));
    if (before) await before();
    const result = await api.syncDiagnose();
    report = result.ok ? result.value : { enabled: false, problem: 'failed', subnets: [], peers: [] };
    checks = netChecks(report);
    draw();
    busy(false);
    refreshNet();
  };
  const action = (act, label, work, cls = 'plain') => h('button', {
    type: 'button',
    class: cls,
    'data-act': act,
    onclick: async () => {
      message.textContent = '';
      await work();
    },
  }, label);
  const peerRow = (p) => h('li', { class: `netpeer ${p.status === 'ok' ? 'good' : 'bad'}` },
    h('span', { class: 'netmark', 'aria-hidden': 'true' }, p.status === 'ok' ? '✓' : '✗'),
    h('div', {},
      h('strong', {}, p.name),
      h('span', { class: 'help' }, [p.address, editionName(p.edition), p.version && t('версия {0}', [p.version]), !p.sameSubnet && t('другая подсеть'), p.manual && t('адрес вручную')].filter(Boolean).join(' · ')),
      h('span', {}, PEER_RESULT[p.status]?.() ?? p.status, p.status === 'ok' && p.ms != null ? ` · ${p.ms} ms` : ''),
      p.version && report.device?.version && p.version !== report.device.version && h('span', { class: 'netnote' }, t('Версия отличается от этого компьютера ({0}) — обновите старую.', [report.device.version]))));
  const draw = () => {
    const online = report.peers?.filter((p) => p.status === 'ok').length ?? 0;
    const total = report.peers?.length ?? 0;
    // Итог по главному: связь со всеми — в порядке, даже если что-то ниже стоит проверить.
    const worst = checks.some((c) => c.level === 'bad') ? 'bad' : online > 0 && online === total ? 'good' : 'warn';
    const address = h('input', { type: 'text', id: 'net-address', placeholder: '10.0.2.15', inputmode: 'decimal', 'aria-label': t('Адрес компьютера') });
    body.replaceChildren(...[
      h('p', { class: `netverdict ${worst}` }, worst === 'good'
        ? t('Связь в порядке: на связи {0} из {1}', [online, report.peers.length])
        : worst === 'warn' ? t('Связь есть, но не со всеми: на связи {0} из {1}', [online, report.peers?.length ?? 0]) : t('Связи нет. Ниже — что не так и как починить.')),
      h('ul', { class: 'netchecks' }, checks.map((c) => h('li', { class: c.level },
        h('span', { class: 'netmark', 'aria-hidden': 'true' }, { good: '✓', warn: '!', bad: '✗' }[c.level]),
        h('div', {}, h('strong', {}, c.title), h('span', {}, c.text), c.advice && h('span', { class: 'netnote' }, c.advice))))),
      report.peers?.length > 0 && [h('h3', {}, t('Устройства')), h('ul', { class: 'netpeers' }, report.peers.map(peerRow))],
      report.enabled && [
        h('h3', {}, t('Связать с компьютером по адресу')),
        h('p', { class: 'help' }, t('Если устройства в разных подсетях, укажите постоянный IP компьютера преподавателя: обмен пойдёт напрямую.')),
        h('form', {
          class: 'netadd',
          onsubmit: async (e) => {
            e.preventDefault();
            busy(true);
            const r = await api.syncAddPeer(address.value);
            busy(false);
            if (!r.ok) message.textContent = r.code === 'bad-address' ? t('Адрес вида 10.0.2.15') : t('Не удалось добавить адрес.');
            else message.textContent = r.value.status === 'ok' ? t('Связь с {0} есть, обмен прошёл.', [r.value.address]) : t('Адрес добавлен, но {0} не отвечает: {1}', [r.value.address, PEER_RESULT[r.value.status]?.() ?? r.value.status]);
            if (r.ok) await run();
          },
        }, address, h('button', { type: 'submit', class: 'plain', 'data-act': 'add' }, t('Связать'))),
      ],
    ].flat().filter(Boolean));
  };
  dialog.replaceChildren(
    h('div', { class: 'sheethead' },
      h('div', {}, h('h2', {}, t('Проверка связи')), h('p', { class: 'help' }, t('Проверяет сеть этого компьютера, связь с каждым устройством и доходят ли другие до него.'))),
      closeButton(dialog)),
    body,
    h('div', { class: 'netactions' },
      action('again', t('Проверить снова'), () => run(), 'primary'),
      action('sync', t('Обменяться со всеми'), () => run(() => api.syncNow())),
      action('restart', t('Перезапустить обмен'), () => run(() => api.syncRestart())),
      state.settings.platform === 'win32' && action('firewall', t('Починить брандмауэр'), async () => {
        busy(true);
        message.textContent = t('Windows спросит разрешение администратора…');
        const r = await api.syncRepairFirewall();
        busy(false);
        message.textContent = r.ok ? t('Правила брандмауэра обновлены.') : r.code === 'cancelled' ? t('Починка отменена: нужен пароль администратора компьютера.') : t('Не удалось починить брандмауэр: {0}', [r.message]);
        await run();
      }),
      action('forget', t('Забыть старые адреса'), () => run(async () => { await api.syncForget(); })),
      action('copy', t('Скопировать отчёт'), async () => {
        try {
          await navigator.clipboard.writeText(netReportText(report ?? {}, checks));
          message.textContent = t('Отчёт скопирован: его можно вставить в сообщение.');
        } catch {
          message.textContent = t('Не удалось скопировать.');
        }
      })),
    message,
  );
  if (!dialog.open) dialog.showModal();
  await run();
}

/* Расписание группы на неделю для доски объявлений */

const weekPrint = { groupId: '', monday: '' };

function openGroupWeek() {
  const groups = refsOf('group');
  if (!weekPrint.groupId || !groups.some((g) => g.id === weekPrint.groupId)) weekPrint.groupId = groups[0]?.id ?? '';
  weekPrint.monday = weekStart(state.date);
  drawGroupWeek();
  $('groupweek').showModal();
}

function groupWeekSheet() {
  const group = refsOf('group').find((g) => g.id === weekPrint.groupId);
  if (!group) return h('p', { class: 'help' }, t('Добавьте группы и студентов в «Справочниках».'));
  const days = groupWeek({ events: state.allEvents, group, groups: refsOf('group'), students: refsOf('student'), monday: weekPrint.monday });
  const saturday = addDays(weekPrint.monday, 5);
  return h('article', { class: 'paper weekpaper' },
    h('header', {},
      h('p', { class: 'kicker' }, t('Расписание группы')),
      h('h2', {}, t('{0}: неделя с {1} по {2}', [group.name, shortDay(weekPrint.monday), fmt(saturday, { day: 'numeric', month: 'long', year: 'numeric' })]))),
    h('div', { class: 'weekgrid' }, days.map((day) => h('section', { class: 'weekday' },
      h('h3', {}, capitalize(fmt(day.date, { weekday: 'long', day: 'numeric', month: 'long' }))),
      day.events.length
        ? h('ul', {}, day.events.map((event) => h('li', { class: event.cancelled ? 'cancelled' : '' },
          h('b', {}, event.allDay ? t('Весь день') : `${event.start}–${event.end}`),
          h('span', { class: 'what' }, event.title),
          h('span', { class: 'meta' }, [event.type !== 'lesson' && typeLabel(event.type), event.place, event.responsible, event.cancelled && t('не состоится')].filter(Boolean).join(', ')))))
        : h('p', { class: 'free' }, t('Нет занятий'))))),
    h('footer', { class: 'weekfoot' }, h('p', {}, t('Составлено в Kerdiis {0}', [fmt(now().iso, { day: 'numeric', month: 'long', year: 'numeric' })]))));
}

function drawGroupWeek() {
  const dialog = $('groupweek');
  const select = h('select', { id: 'gw-group', 'aria-label': t('Группа'), onchange: (e) => { weekPrint.groupId = e.target.value; drawGroupWeek(); } },
    refsOf('group').map((g) => h('option', { value: g.id, selected: g.id === weekPrint.groupId }, g.name)));
  const move = (days) => { weekPrint.monday = addDays(weekPrint.monday, days); drawGroupWeek(); };
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Расписание группы')), closeButton(dialog)),
    h('div', { class: 'targets weektools' },
      select,
      h('button', { type: 'button', class: 'plain', id: 'gw-prev', onclick: () => move(-7) }, t('Прошлая неделя')),
      h('button', { type: 'button', class: 'plain', id: 'gw-this', onclick: () => { weekPrint.monday = weekStart(now().iso); drawGroupWeek(); } }, t('Эта неделя')),
      h('button', { type: 'button', class: 'plain', id: 'gw-next', onclick: () => move(7) }, t('Следующая неделя'))),
    h('div', { class: 'sheetbody paperview' }, groupWeekSheet()),
    h('div', { class: 'sheetfoot' }, printButtons(groupWeekSheet, () => {
      const group = refsOf('group').find((g) => g.id === weekPrint.groupId);
      return t('Расписание {0} {1}.pdf', [group?.name ?? '', weekPrint.monday]);
    })),
  );
}

/* Табло перемены на панели */

/** Сколько секунд без касаний, прежде чем панель покажет табло. */
const BOARD_IDLE_SECONDS = 60;
let lastTouch = Date.now();

function touched() {
  lastTouch = Date.now();
  if (!$('breakboard').hidden) $('breakboard').hidden = true;
}

/** Между парами панель крупно показывает, что будет в аудитории дальше. Любое касание убирает табло. */
function refreshBoard() {
  const box = $('breakboard');
  const clock = now();
  const anyOpen = document.querySelector('dialog[open]');
  const board = isClient() && !anyOpen && Date.now() - lastTouch >= BOARD_IDLE_SECONDS * 1000
    ? breakBoard(state.events, clock.iso, clock.time) : null;
  if (!board) {
    box.hidden = true;
    return;
  }
  const { next } = board;
  const when = !next ? ''
    : board.today
      ? (board.minutes <= 60 ? t('через {0} мин, в {1}', [board.minutes, next.start]) : t('сегодня в {0}', [next.start]))
      : t('{0} в {1}', [fmt(next.date, { weekday: 'long', day: 'numeric', month: 'long' }), next.start]);
  box.replaceChildren(
    h('div', { class: 'boardinner' },
      h('p', { class: 'boardroom' }, state.settings.deviceName || t('Аудитория')),
      h('time', { class: 'boardclock' }, clock.time),
      next
        ? [h('p', { class: 'boardlabel' }, board.today ? t('Следующее в этой аудитории') : t('Сегодня здесь больше ничего нет. Ближайшее')),
          h('p', { class: `boardtitle t-${next.type}` }, next.title),
          h('p', { class: 'boardwhen' }, when),
          h('p', { class: 'boardmeta' }, [typeLabel(next.type), next.responsible].filter(Boolean).join(' · '))]
        : h('p', { class: 'boardlabel' }, t('В ближайшие дни в этой аудитории ничего не запланировано')),
      h('p', { class: 'boardhint' }, t('Коснитесь экрана, чтобы открыть календарь'))),
  );
  box.hidden = false;
}

/* Лучшая группа месяца */

function bestGroupItems() {
  const clock = now();
  const best = bestGroupOfMonth({ events: state.allEvents, attendance: state.attendance, students: refsOf('student'), groups: refsOf('group'), nowISO: clock.iso, nowTime: clock.time });
  if (!best) return [];
  const month = fmt(`${best.month}-01`, { month: 'long' });
  return [{ id: `best-${best.month}`, color: 'trophy', name: t('🏆 Лучшая группа за {0} — {1}: посещаемость {2}%! Так держать!', [month, best.name, best.percent]) }];
}

/* Летопись года */

let chronicleYear = null;

function openChronicle() {
  chronicleYear = chronicleYear ?? schoolYearOf(now().iso);
  drawChronicle();
  $('chronicle').showModal();
}

function chronicleSheet() {
  const clock = now();
  const data = yearChronicle({
    events: state.allEvents, attendance: state.attendance, students: refsOf('student'), groups: refsOf('group'),
    achievements: refsOf('achievement'), bonuses: refsOf('bonus'), pastWorks: refsOf('pastwork'), year: chronicleYear, nowISO: clock.iso, nowTime: clock.time,
  });
  const day = (iso) => fmt(iso, { day: 'numeric', month: 'long' });
  const monthName = (month) => fmt(`${month}-01`, { month: 'long', year: 'numeric' });
  const table = (head, rows) => h('table', {}, h('thead', {}, h('tr', {}, head.map((name) => h('th', {}, name)))), h('tbody', {}, rows));
  const nothing = (text) => h('p', { class: 'free' }, text);
  return h('article', { class: 'paper chroniclepaper' },
    h('header', {},
      h('p', { class: 'kicker' }, t('Летопись года')),
      h('h2', {}, t('{0}–{1} учебный год', [chronicleYear, chronicleYear + 1])),
      h('p', {}, t('С {0} по {1}', [fmt(data.from, { day: 'numeric', month: 'long', year: 'numeric' }), fmt(data.to, { day: 'numeric', month: 'long', year: 'numeric' })]))),
    h('h3', {}, t('Год в цифрах')),
    h('ul', { class: 'yearnumbers' },
      h('li', {}, h('b', {}, String(data.counts.lesson)), t('занятий')),
      h('li', {}, h('b', {}, String(data.counts.event)), t('мероприятий')),
      h('li', {}, h('b', {}, String(data.counts.practice)), t('практик')),
      h('li', {}, h('b', {}, String(data.counts.task)), t('заданий')),
      h('li', {}, h('b', {}, String(data.counts.meeting)), t('собраний')),
      data.attendance !== null && h('li', {}, h('b', {}, `${data.attendance}%`), t('посещаемость'))),
    h('h3', {}, t('Мероприятия года')),
    data.events.length
      ? table([t('Дата'), t('Мероприятие'), t('Участников'), t('Ответственный')], data.events.map((e) => h('tr', {}, h('td', {}, day(e.date)), h('td', {}, e.title), h('td', {}, String(e.people)), h('td', {}, e.responsible))))
      : nothing(t('Мероприятий пока не было.')),
    h('h3', {}, t('Самые активные студенты')),
    data.active.length
      ? table([t('Студент'), t('Группа'), t('Участий'), t('Роли')], data.active.map((p) => h('tr', {}, h('td', {}, p.name), h('td', {}, p.group), h('td', {}, String(p.count)),
        h('td', {}, Object.entries(p.roles).map(([role, n]) => (n > 1 ? `${role} ×${n}` : role)).join(', ')))))
      : nothing(t('Участий в заданиях, практике и мероприятиях пока нет.')),
    data.grades.length > 0 && [h('h3', {}, t('Лучшие по грейду')),
      table([t('Студент'), t('Группа'), t('Баллы за год')], data.grades.map((g) => h('tr', {}, h('td', {}, g.name), h('td', {}, g.group), h('td', {}, String(g.points)))))],
    data.roleLeaders.length > 0 && [h('h3', {}, t('Лидеры по ролям')),
      table([t('Роль'), t('Студент'), t('Раз')], data.roleLeaders.map((r) => h('tr', {}, h('td', {}, r.role), h('td', {}, r.name), h('td', {}, String(r.count)))))],
    h('h3', {}, t('Лучшие группы по посещаемости')),
    data.groups.length
      ? table([t('Группа'), t('Посещаемость'), t('Отметок')], data.groups.map((g) => h('tr', {}, h('td', {}, g.name), h('td', {}, `${g.percent}%`), h('td', {}, String(g.marks)))))
      : nothing(t('Отметок пока мало для сравнения.')),
    data.months.length > 0 && [h('h3', {}, t('Лучшая группа каждого месяца')),
      table([t('Месяц'), t('Группа'), t('Посещаемость')], data.months.map((m) => h('tr', {}, h('td', {}, monthName(m.month)), h('td', {}, m.name), h('td', {}, `${m.percent}%`))))],
    data.awards.length > 0 && [h('h3', {}, t('Достижения студентов')),
      table([t('Дата'), t('Студент'), t('Достижение'), t('Результат')], data.awards.map((a) => h('tr', {}, h('td', {}, day(a.date)), h('td', {}, a.student), h('td', {}, a.name), h('td', {}, a.result))))],
    h('footer', { class: 'weekfoot' }, h('p', {}, t('Составлено в Kerdiis {0}', [fmt(clock.iso, { day: 'numeric', month: 'long', year: 'numeric' })]))));
}

function drawChronicle() {
  const dialog = $('chronicle');
  const first = state.allEvents.reduce((min, e) => (e.date < min ? e.date : min), now().iso);
  const years = [];
  for (let y = schoolYearOf(now().iso); y >= schoolYearOf(first); y -= 1) years.push(y);
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Летопись года')), closeButton(dialog)),
    h('div', { class: 'targets weektools' },
      h('select', { id: 'ch-year', 'aria-label': t('Учебный год'), onchange: (e) => { chronicleYear = Number(e.target.value); drawChronicle(); } },
        years.map((y) => h('option', { value: y, selected: y === chronicleYear }, t('{0}–{1} учебный год', [y, y + 1]))))),
    h('div', { class: 'sheetbody paperview' }, chronicleSheet()),
    h('div', { class: 'sheetfoot' }, printButtons(chronicleSheet, () => t('Летопись {0}-{1}.pdf', [chronicleYear, chronicleYear + 1]))),
  );
}

/* Грейд студентов */

let gradeCache = { key: null, rows: [] };

/** Баллы всех студентов за текущий семестр. Пересчёт — только когда поменялись события, отметки или день. */
function currentGrades() {
  const clock = now();
  const key = [state.allEvents, state.attendance, state.directory, clock.iso, clock.time.slice(0, 4)];
  if (gradeCache.key && key.every((part, i) => part === gradeCache.key[i])) return gradeCache.rows;
  const { from, to, retroFrom } = ratingPeriod(clock.iso);
  const rows = gradeReport({ events: state.allEvents, attendance: state.attendance, students: refsOf('student'), groups: refsOf('group'), bonuses: refsOf('bonus'), pastWorks: refsOf('pastwork'), from, to, retroFrom, nowISO: clock.iso, nowTime: clock.time });
  gradeCache = { key, rows };
  return rows;
}

/** Звания — названия грейдов из IT, одинаковые на всех языках. */
const gradeName = (name) => name;
const studentByName = (name) => refsOf('student').find((s) => nameKey(s.name) === nameKey(name));

/** Поздравления с новым званием: три дня после того, как студент его получил. */
function gradeItems() {
  const today = now().iso;
  const hidden = hiddenOnPanel();
  return currentGrades().filter((row) => !hidden.has(nameKey(row.name))).flatMap((row) => row.levelUps
    .filter((up) => up.date >= addDays(today, -2))
    .slice(-1)
    .map((up) => ({ id: `grade-${row.name}-${up.level}`, color: 'trophy', name: t('⭐ {0} — новое звание «{1}»! Так держать!', [greetingName(row.name), gradeName(up.level)]) })));
}

let gradeGroup = '';

/*
 * Флажки студентов: жёлтый, красный, синий, зелёный — деление на команды.
 * Названия команд общие для всех устройств. Флажки видит только преподаватель, на панелях их нет.
 */
const FLAG_COLORS = ['yellow', 'red', 'blue', 'green'];
const flagColorName = (color) => ({ yellow: t('Жёлтый'), red: t('Красный'), blue: t('Синий'), green: t('Зелёный') }[color]);
const flagLabel = (color) => refsOf('flagname').find((ref) => ref.color === color)?.name || flagColorName(color);

/** Закрашенные кружки флажков у имени: только смотреть. */
function flagDots(name) {
  if (!canManage()) return null;
  const flags = studentByName(name)?.flags ?? [];
  return flags.length ? h('span', { class: 'flagdots' }, FLAG_COLORS.filter((color) => flags.includes(color)).map((color) => h('span', { class: `flagdot flag-${color}`, title: flagLabel(color) }))) : null;
}

/** Четыре флажка, нажатие ставит или снимает. */
function flagToggles(student) {
  if (!canManage() || !student) return null;
  const flags = student.flags ?? [];
  return h('span', { class: 'flags', role: 'group', 'aria-label': t('Флажки: {0}', [student.name]) }, FLAG_COLORS.map((color) => h('button', {
    type: 'button',
    class: `flag flag-${color}`,
    'data-flag': color,
    'aria-pressed': String(flags.includes(color)),
    title: flagLabel(color),
    'aria-label': t('{0}: {1}', [flagLabel(color), student.name]),
    onclick: () => toggleFlag(student.id, color),
  })));
}

async function toggleFlag(studentId, color) {
  const student = state.directory.find((ref) => ref.id === studentId);
  if (!student) return;
  const flags = student.flags?.includes(color) ? student.flags.filter((item) => item !== color) : [...(student.flags ?? []), color];
  const result = await api.saveRefs([{ ref: { ...student, flags }, base: student.updatedAt }]);
  if (!result.ok) {
    toast(storeMessage(result));
    return;
  }
  await loadDirectory();
  redrawFlagged();
}

/** Перерисовать открытые окна, где видны флажки. */
function redrawFlagged() {
  if ($('grade').open) drawGrades();
  if ($('studentfile').open) drawStudentFile();
}

/** Название команды для цвета: «Красный — Команда А». Пустое возвращает название цвета. */
async function saveFlagName(color, value) {
  const name = value.trim();
  const existing = refsOf('flagname').find((ref) => ref.color === color);
  if ((existing?.name ?? '') === name) return;
  const result = name
    ? await api.saveRefs([{ ref: { ...(existing ?? { kind: 'flagname', color }), name }, base: existing?.updatedAt }])
    : await api.removeRefs([{ id: existing.id, base: existing.updatedAt }]);
  if (!result.ok) {
    toast(storeMessage(result));
    return;
  }
  await loadDirectory();
  redrawFlagged();
}

let gradeFlag = '';
let gradeByFlag = false;
let flagNamesOpen = false;

/** Строка фильтра по флажкам над таблицей грейда. */
function gradeFlagBar(all) {
  const count = (color) => all.filter((row) => (color === 'none' ? !(studentByName(row.name)?.flags ?? []).length : studentByName(row.name)?.flags?.includes(color))).length;
  const chip = (value, label, dot) => h('button', {
    type: 'button', class: 'flagchip', 'data-grflag': value || 'all', 'aria-pressed': String(gradeFlag === value),
    onclick: () => { gradeFlag = value; drawGrades(); },
  }, dot && h('span', { class: `flagdot flag-${dot}` }), label);
  return h('div', { class: 'flagbar' },
    h('div', { class: 'flagchips', role: 'group', 'aria-label': t('Флажки') },
      chip('', t('Все')),
      FLAG_COLORS.map((color) => chip(color, t('{0}: {1}', [flagLabel(color), count(color)]), color)),
      chip('none', t('Без флажка: {0}', [count('none')]))),
    h('label', { class: 'checkrow' }, h('input', { type: 'checkbox', id: 'gr-byflag', checked: gradeByFlag, onchange: (e) => { gradeByFlag = e.target.checked; drawGrades(); } }), t('Группировать по флажкам')),
    h('button', { type: 'button', class: 'plain small', id: 'gr-flagnames', 'aria-expanded': String(flagNamesOpen), onclick: () => { flagNamesOpen = !flagNamesOpen; drawGrades(); } }, t('Названия команд')),
    flagNamesOpen && h('div', { class: 'flagnames' }, FLAG_COLORS.map((color) => h('label', {},
      h('span', { class: `flagdot flag-${color}` }),
      h('input', {
        value: refsOf('flagname').find((ref) => ref.color === color)?.name ?? '', maxlength: 60, placeholder: flagColorName(color),
        'aria-label': t('Подпись: {0}', [flagColorName(color)]), 'data-flagname': color,
        onchange: (e) => saveFlagName(color, e.target.value),
      })))));
}

function openGrades() {
  drawGrades();
  $('grade').showModal();
}

function drawGrades() {
  const dialog = $('grade');
  const { from, to } = ratingPeriod(now().iso);
  const hidden = hiddenOnPanel();
  const inGroup = currentGrades().filter((row) => (!gradeGroup || row.group === gradeGroup) && !hidden.has(nameKey(row.name)));
  const flagsOfRow = (row) => (canManage() ? studentByName(row.name)?.flags ?? [] : []);
  const rows = inGroup.filter((row) => !gradeFlag || (gradeFlag === 'none' ? !flagsOfRow(row).length : flagsOfRow(row).includes(gradeFlag)));
  // Группировка по флажкам: разделы по цветам, студент с двумя флажками — в обоих.
  const sections = canManage() && gradeByFlag
    ? [...FLAG_COLORS.map((color) => ({ color, label: flagLabel(color), rows: rows.filter((row) => flagsOfRow(row).includes(color)) })),
      { color: '', label: t('Без флажка'), rows: rows.filter((row) => !flagsOfRow(row).length) }].filter((section) => section.rows.length)
    : [{ color: null, rows }];
  const columns = canManage() ? 16 : 14;
  const groups = [...new Set(currentGrades().map((row) => row.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Грейд студентов')), closeButton(dialog)),
    h('div', { class: 'targets weektools' },
      h('select', { id: 'gr-group', 'aria-label': t('Группа'), onchange: (e) => { gradeGroup = e.target.value; drawGrades(); } },
        h('option', { value: '' }, t('Все группы')),
        groups.map((name) => h('option', { value: name, selected: name === gradeGroup }, name))),
      canManage() && h('button', { type: 'button', id: 'gr-past', onclick: openPastWorks }, t('Прошлые работы'))),
    h('div', { class: 'sheetbody' },
      canManage() && inGroup.length > 0 && gradeFlagBar(inGroup),
      h('p', { class: 'help' }, t('Рейтинг за всё обучение, без сброса по семестрам: учёт с {0}. День на парах +1, прогул −4, опоздание −2, сданное задание +3, несданное в срок −2, мероприятие +5 и ещё +2 за роль, практика +2. Ниже нуля баллы не опускаются.', [shortDay(from)])),
      h('p', { class: 'help' }, GRADE_LEVELS.map((level) => t('{0} — от {1}', [gradeName(level.name), level.from])).join(' · ')),
      rows.length
        ? h('div', { class: 'tablewrap' }, h('table', { class: 'gradetable' },
          h('thead', {}, h('tr', {}, ['№', canManage() ? t('Флажки') : null, t('Студент'), t('Группа'), t('Звание'), t('Баллы'), t('До следующего'), t('Дни'), t('Прогулы'), t('Опоздания'), t('Задания'), t('Мероприятия'), t('Практика'), t('Поощрения'), t('Поведение'), canManage() ? '' : null].filter((name) => name !== null)
            .map((name) => h('th', { scope: 'col' }, name)))),
          h('tbody', {}, sections.flatMap((section) => [
            section.color !== null && h('tr', { class: 'flaghead', 'data-section': section.color || 'none' }, h('th', { colspan: columns, scope: 'colgroup' },
              section.color && h('span', { class: `flagdot flag-${section.color}` }), t('{0}: {1}', [section.label, section.rows.length]))),
            ...section.rows.map((row, index) => h('tr', { 'data-student': row.name },
            h('td', {}, String(index + 1)),
            canManage() && h('td', {}, flagToggles(studentByName(row.name))),
            h('td', {}, canManage() && studentByName(row.name)
              ? h('button', { type: 'button', class: 'linkbutton', onclick: () => openStudentFile(studentByName(row.name).id) }, row.name)
              : row.name),
            h('td', {}, row.group),
            h('td', {}, h('span', { class: `gradebadge level-${GRADE_LEVELS.findIndex((l) => l.name === row.level)}` }, gradeName(row.level))),
            h('td', { class: 'num' }, canManage()
              ? h('button', { type: 'button', class: 'linkbutton', 'data-calc': row.name, title: t('Расчёт баллов'), onclick: () => openCalc(row.name) }, h('b', {}, String(row.points)))
              : h('b', {}, String(row.points))),
            h('td', {}, row.next ? t('{0}: ещё {1}', [gradeName(row.next.name), row.next.need]) : t('высшее звание')),
            h('td', { class: 'num' }, String(row.breakdown.day)),
            h('td', { class: 'num' }, String(row.breakdown.absent)),
            h('td', { class: 'num' }, String(row.breakdown.late)),
            h('td', { class: 'num' }, `${row.breakdown.task}${row.breakdown.taskMissed ? ` / −${row.breakdown.taskMissed}` : ''}`),
            h('td', { class: 'num' }, String(row.breakdown.event)),
            h('td', { class: 'num' }, String(row.breakdown.practice)),
            h('td', { class: 'num' }, signed(row.breakdown.reward)),
            h('td', { class: 'num' }, signed(row.breakdown.conduct)),
            canManage() && studentByName(row.name) && h('td', {},
              h('button', { type: 'button', class: 'plain small', 'aria-label': t('Поощрения и поведение: {0}', [row.name]), onclick: () => openBonus(studentByName(row.name).id) }, '±')))),
          ]))))
        : h('p', { class: 'help' }, inGroup.length ? t('Нет студентов с таким флажком.') : t('Добавьте студентов в «Справочниках».'))),
  );
}

/*
 * Расчёт баллов студента: каждый день — за что начислено или снято, сумма после дня
 * и сколько минуса не засчитано, потому что баллы не опускаются ниже нуля. Только преподаватель:
 * в расчёте пары с прогулами по датам и причины ручных баллов.
 */

const CALC_KINDS = ['day', 'absent', 'late', 'task', 'taskMissed', 'event', 'role', 'practice', 'reward', 'conduct'];
/** Ручные баллы делятся по знаку: плюс — поощрение, минус — за поведение. */
const calcKind = (item) => (item.kind === 'manual' ? (item.points > 0 ? 'reward' : 'conduct') : item.kind);
const calcLabel = (kind) => ({
  day: t('Дни на парах'), absent: t('Прогулы (дни)'), late: t('Опоздания (дни)'), task: t('Задания сданы'),
  taskMissed: t('Задания не сданы в срок'), event: t('Мероприятия'), role: t('Роли на мероприятиях'), practice: t('Практики'), reward: t('Поощрения'), conduct: t('Поведение'),
}[kind]);

/** Пары дня через запятую: «Монтаж 09:00, Операторское 10:40». */
const lessonList = (lessons, extra = () => '') => lessons.map((l) => `${l.title} ${l.start}${extra(l)}`).join(', ');

function calcText(item) {
  const past = item.past ? h('small', { class: 'pastmark' }, t('внесено задним числом')) : null;
  switch (item.kind) {
    case 'day': return t('Был на парах: {0}', [lessonList(item.lessons)]);
    case 'late': return t('Опоздание: {0}', [lessonList(item.lessons, (l) => t(' — {0} мин', [l.late]))]);
    case 'absent': return [
      t('Прогул за день: {0}', [lessonList(item.lessons, (l) => (l.certificate ? t(' (нет справки)') : l.late ? t(' (пришёл через {0} мин)', [l.late]) : ''))]),
      item.attended?.length ? h('small', { class: 'pastmark' }, t('на других парах был, но за день с прогулом +1 не начисляется')) : null,
    ];
    case 'task': return [t('Задание «{0}» сдано', [item.title]), past];
    case 'taskMissed': return [t('Задание «{0}» не сдано в срок', [item.title]), past];
    case 'event': return [t('Мероприятие «{0}»', [item.title]), past];
    case 'role': return [item.role ? t('Роль «{0}» на мероприятии «{1}»', [item.role, item.title]) : t('Роль на мероприятии «{0}»', [item.title]), past];
    case 'practice': return [t('Практика «{0}»', [item.title]), past];
    case 'manual': {
      const text = item.by ? t('{0} ({1})', [item.title, item.by]) : item.title;
      return item.points > 0 ? t('Поощрение: {0}', [text]) : t('Поведение: {0}', [text]);
    }
    default: return item.kind;
  }
}

function openCalc(name) {
  const dialog = $('gradecalc');
  const { from, to } = ratingPeriod(now().iso);
  const row = currentGrades().find((item) => nameKey(item.name) === nameKey(name));
  if (!row) return;
  const totals = CALC_KINDS
    .map((kind) => {
      const label = calcLabel(kind);
      const items = row.history.flatMap((day) => day.items).filter((item) => calcKind(item) === kind);
      return { kind, label, count: items.length, points: items.reduce((sum, item) => sum + item.points, 0) };
    })
    .filter((line) => line.count > 0);
  // Последний день, когда сумма упёрлась в ноль: с него и считается нынешний итог.
  const zeroDay = [...row.history].reverse().find((day) => day.lost > 0);
  const ledger = [];
  for (const day of row.history) {
    day.items.forEach((item, index) => {
      const last = index === day.items.length - 1;
      ledger.push(h('tr', { class: last ? 'daylast' : '' },
        h('td', {}, index === 0 ? shortDate(day.date) : ''),
        h('td', {}, calcText(item)),
        h('td', { class: `num ${item.points > 0 ? 'plus' : 'minus'}` }, signed(item.points)),
        h('td', { class: 'num' }, last
          ? [h('b', {}, String(day.after)), day.lost > 0 && h('small', { class: 'calclost' }, t('не засчитано {0}', [signed(-day.lost)]))]
          : '')));
    });
  }
  dialog.replaceChildren(
    h('div', { class: 'sheethead' },
      h('div', {}, h('h2', {}, t('Расчёт баллов: {0}', [row.name])),
        h('p', { class: 'help' }, t('За всё обучение, с {0}. Баллы считаются по дням и не опускаются ниже нуля: минус, который увёл бы сумму ниже нуля, не засчитывается.', [shortDate(from)]))),
      closeButton(dialog)),
    h('div', { class: 'sheetbody' },
      h('p', { class: 'calctotal' }, t('Итого: {0} — {1}', [row.points, gradeName(row.level)])),
      row.points === 0 && row.history.length > 0 && h('p', { class: 'calcwhy' }, zeroDay
        ? t('Почему 0: последний раз сумма упёрлась в ноль {0}, и с тех пор минусов было не меньше, чем плюсов. Подробности — по дням ниже.', [shortDate(zeroDay.date)])
        : t('Почему 0: плюсов и минусов поровну.')),
      row.history.length === 0 && h('p', { class: 'calcwhy' }, t('Почему 0: в этом семестре у студента нет ни одной засчитанной пары, задания, мероприятия или практики. Проверьте, внесён ли он в группу и отмечены ли пары.')),
      totals.length > 0 && h('table', { class: 'filetable calcsum' },
        h('thead', {}, h('tr', {}, h('th', {}, t('За что')), h('th', { class: 'num' }, t('Сколько')), h('th', { class: 'num' }, t('Баллы')))),
        h('tbody', {},
          totals.map((line) => h('tr', {}, h('td', {}, line.label), h('td', { class: 'num' }, String(line.count)), h('td', { class: 'num' }, signed(line.points) || '0'))),
          h('tr', { class: 'daylast' }, h('td', {}, t('Сумма начислений')), h('td', {}), h('td', { class: 'num' }, signed(row.earned) || '0')),
          row.lost > 0 && h('tr', {}, h('td', {}, t('Не засчитано: баллы не опускаются ниже нуля')), h('td', {}), h('td', { class: 'num plus' }, signed(row.lost))),
          h('tr', { class: 'daylast' }, h('td', {}, h('b', {}, t('Итого'))), h('td', {}), h('td', { class: 'num' }, h('b', {}, String(row.points)))))),
      row.history.length > 0 && [
        h('h3', {}, t('По дням')),
        h('table', { class: 'filetable calcledger' },
          h('thead', {}, h('tr', {}, h('th', {}, t('Дата')), h('th', {}, t('За что')), h('th', { class: 'num' }, t('Баллы')), h('th', { class: 'num' }, t('Итого')))),
          h('tbody', {}, ledger)),
      ]),
  );
  if (!dialog.open) dialog.showModal();
}

/** Ручные баллы со знаком: «+5», «−3», пусто для нуля. */
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '');

/* Баллы грейда вручную: за олимпиаду, помощь, дежурство — или штраф. Только преподаватель. */

const bonusState = { id: null, message: '' };

function openBonus(studentId) {
  bonusState.id = studentId;
  bonusState.message = '';
  drawBonus();
  const dialog = $('gradebonus');
  if (!dialog.open) dialog.showModal();
  $('gb-points')?.focus();
}

function drawBonus() {
  const dialog = $('gradebonus');
  const student = state.directory.find((ref) => ref.id === bonusState.id);
  if (!student) {
    dialog.close();
    return;
  }
  const { from, to, retroFrom } = ratingPeriod(now().iso);
  const mine = refsOf('bonus')
    .filter((item) => nameKey(item.student) === nameKey(student.name) && item.date >= retroFrom && item.date <= to)
    .sort((a, b) => b.date.localeCompare(a.date));
  const points = h('input', { id: 'gb-points', type: 'number', min: -100, max: 100, step: 1, required: true, placeholder: t('+5 или −3'), 'aria-label': t('Баллы') });
  const reason = h('input', { id: 'gb-reason', required: true, maxlength: 200, placeholder: t('За что: олимпиада, помощь на мероприятии…'), 'aria-label': t('За что') });
  // Поощрения за прошлые курсы можно внести задним числом; минус до начала учёта не засчитается.
  const date = h('input', { id: 'gb-date', type: 'date', value: now().iso, min: retroFrom, max: now().iso, required: true, 'aria-label': t('Дата') });
  const retroNote = h('p', { class: 'help' }, t('Поощрение за прошлые курсы можно поставить задним числом. Минус с датой до {0} не засчитывается.', [shortDate(from)]));
  const form = h('form', {
    class: 'adder bonusadd',
    onsubmit: async (e) => {
      e.preventDefault();
      const value = Number(points.value);
      if (!Number.isInteger(value) || value === 0 || Math.abs(value) > 100) {
        bonusState.message = t('Баллы — целое число от −100 до 100, не ноль.');
        drawBonus();
        return;
      }
      if (!reason.value.trim() || !date.value) return;
      const saved = await api.saveRefs([{ ref: { kind: 'bonus', name: reason.value.trim(), student: student.name, date: date.value, points: value } }]);
      bonusState.message = saved.ok ? '' : storeMessage(saved);
      await loadDirectory();
      drawBonus();
      if ($('grade').open) drawGrades();
      refreshTicker();
    },
  }, points, reason, date, h('button', { type: 'submit' }, t('Добавить')));
  const total = mine.reduce((sum, item) => sum + item.points, 0);
  dialog.replaceChildren(
    h('div', { class: 'sheethead' },
      h('div', {}, h('h2', {}, t('Поощрения и поведение: {0}', [student.name])),
        h('p', { class: 'help' }, t('Плюс — поощрение за то, чего программа не видит сама: олимпиада, помощь, активность. Минус — за поведение: нарушение правил колледжа. В грейде это отдельные столбцы «Поощрения» и «Поведение»; причину видят только преподаватели, она есть в личном деле.'))),
      closeButton(dialog)),
    h('div', { class: 'sheetbody' },
      form,
      retroNote,
      bonusState.message && h('p', { class: 'message error' }, bonusState.message),
      mine.length
        ? [h('p', { class: 'help' }, t('Вручную за всё обучение: {0}', [signed(total) || '0'])),
          h('ul', { class: 'bonuslist' }, mine.map((item) => h('li', {},
            h('span', { class: 'awarddate' }, shortDate(item.date)),
            h('b', { class: item.points > 0 ? 'plus' : 'minus' }, signed(item.points)),
            h('span', {}, item.by ? t('{0} ({1})', [item.name, item.by]) : item.name),
            h('button', {
              type: 'button',
              class: 'plain small',
              'aria-label': t('Удалить {0}', [item.name]),
              onclick: async () => {
                const removed = await api.removeRefs([{ id: item.id, base: item.updatedAt }]);
                bonusState.message = removed.ok ? '' : storeMessage(removed);
                await loadDirectory();
                drawBonus();
                if ($('grade').open) drawGrades();
              },
            }, '✕'))))]
        : h('p', { class: 'free' }, t('Ручных баллов пока нет.'))),
  );
}

/*
 * Прошлые работы: задания, практики и мероприятия, которые прошли до начала работы в Kerdiis.
 * Вносятся задним числом одной записью на работу, баллы грейда начисляются как обычно. Только преподаватель.
 */

const pastState = { id: null, work: 'task', title: '', date: '', group: '', picked: new Map(), roles: new Set(), penalty: false, message: '', confirm: null };

function openPastWorks() {
  resetPastForm();
  pastState.group = pastState.group || refsOf('group').map((g) => g.id)[0] || '';
  drawPastWorks();
  const dialog = $('pastworks');
  if (!dialog.open) dialog.showModal();
}

function resetPastForm(keep = true) {
  pastState.id = null;
  pastState.title = '';
  if (!keep) pastState.date = '';
  pastState.picked = new Map();
  pastState.roles = new Set();
  pastState.penalty = false;
  pastState.confirm = null;
}

/** Студенты группы по алфавиту. */
const studentsOfGroup = (groupId) => refsOf('student').filter((s) => s.groupId === groupId).sort((a, b) => a.name.localeCompare(b.name, 'ru'));

function editPastWork(work) {
  const byName = new Map(refsOf('student').map((s) => [nameKey(s.name), s]));
  pastState.id = work.id;
  pastState.work = work.work;
  pastState.title = work.name;
  pastState.date = work.date;
  pastState.picked = new Map(work.students.map((name) => [nameKey(name), name]));
  pastState.roles = new Set((work.roles ?? []).map(nameKey));
  pastState.penalty = (work.missed ?? []).length > 0;
  const first = byName.get(nameKey(work.students[0] ?? work.missed?.[0] ?? ''));
  if (first) pastState.group = first.groupId;
  pastState.message = '';
  pastState.confirm = null;
  drawPastWorks();
}

async function savePastWork() {
  const title = pastState.title.trim();
  const today = now().iso;
  if (!title || !pastState.date) {
    pastState.message = t('Укажите название и дату работы.');
    return drawPastWorks();
  }
  if (pastState.date > today) {
    pastState.message = t('Дата прошлой работы не может быть позже сегодняшней. Будущие задания и мероприятия вносите обычным способом.');
    return drawPastWorks();
  }
  const students = [...pastState.picked.values()];
  // Не сдавшие — все остальные из групп, где кто-то сдал, и из выбранной группы.
  let missed = [];
  if (pastState.work === 'task' && pastState.penalty) {
    const groupIds = new Set([pastState.group]);
    for (const s of refsOf('student')) if (pastState.picked.has(nameKey(s.name))) groupIds.add(s.groupId);
    missed = refsOf('student').filter((s) => groupIds.has(s.groupId) && !pastState.picked.has(nameKey(s.name))).map((s) => s.name);
  }
  if (!students.length && !missed.length) {
    pastState.message = t('Отметьте хотя бы одного студента.');
    return drawPastWorks();
  }
  const existing = pastState.id ? refsOf('pastwork').find((w) => w.id === pastState.id) : null;
  const ref = {
    ...(existing ?? {}),
    kind: 'pastwork',
    name: title,
    work: pastState.work,
    date: pastState.date,
    students,
    roles: pastState.work === 'event' ? students.filter((name) => pastState.roles.has(nameKey(name))) : [],
    missed,
  };
  const saved = await api.saveRefs([{ ref, base: existing?.updatedAt }]);
  if (!saved.ok) {
    pastState.message = storeMessage(saved);
    return drawPastWorks();
  }
  pastState.message = '';
  resetPastForm();
  await loadDirectory();
  drawPastWorks();
  if ($('grade').open) drawGrades();
}

/** Сколько баллов даёт работа всем вместе: для списка внесённого. */
function pastWorkSummary(work) {
  const changes = pastWorkChanges(work);
  const count = (kind) => changes.filter((c) => c.kind === kind).length;
  if (work.work === 'task') {
    return count('taskMissed')
      ? t('сдали {0}, не сдали {1}', [count('task'), count('taskMissed')])
      : t('сдали {0}', [count('task')]);
  }
  if (work.work === 'event') {
    return count('role') ? t('были {0}, с ролью {1}', [count('event'), count('role')]) : t('были {0}', [count('event')]);
  }
  return t('участников {0}', [count('practice')]);
}

function drawPastWorks() {
  const dialog = $('pastworks');
  const today = now().iso;
  const { from: ratingFrom, retroFrom } = ratingPeriod(today);
  const groups = refsOf('group').sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const list = studentsOfGroup(pastState.group);
  const markLabel = { task: t('сдал'), practice: t('участвовал'), event: t('был') }[pastState.work];
  const pick = (student, on) => {
    if (on) pastState.picked.set(nameKey(student.name), student.name);
    else {
      pastState.picked.delete(nameKey(student.name));
      pastState.roles.delete(nameKey(student.name));
    }
  };

  const form = h('form', {
    class: 'pastform',
    onsubmit: (e) => {
      e.preventDefault();
      savePastWork();
    },
  },
  h('div', { class: 'pastfields' },
    h('label', {}, h('span', {}, t('Что')),
      h('select', { id: 'pw-type', onchange: (e) => { pastState.work = e.target.value; drawPastWorks(); } },
        PAST_WORK_TYPES.map((type) => h('option', { value: type, selected: type === pastState.work }, typeLabel(type))))),
    h('label', { class: 'grow' }, h('span', {}, t('Название')),
      h('input', { id: 'pw-title', required: true, maxlength: 200, value: pastState.title, placeholder: t('Например: Курсовой проект, Неделя кино, Практика на ТВ'), oninput: (e) => { pastState.title = e.target.value; } })),
    h('label', {}, h('span', {}, pastState.work === 'task' ? t('Срок сдачи') : t('Дата')),
      h('input', { id: 'pw-date', type: 'date', required: true, min: retroFrom, max: today, value: pastState.date, oninput: (e) => { pastState.date = e.target.value; } })),
    h('label', {}, h('span', {}, t('Группа')),
      h('select', { id: 'pw-group', onchange: (e) => { pastState.group = e.target.value; drawPastWorks(); } },
        groups.map((group) => h('option', { value: group.id, selected: group.id === pastState.group }, group.name))))),
  list.length
    ? [
      h('div', { class: 'pasttools' },
        h('button', { type: 'button', id: 'pw-all', onclick: () => { list.forEach((s) => pick(s, true)); drawPastWorks(); } }, t('Отметить всю группу')),
        h('button', { type: 'button', onclick: () => { list.forEach((s) => pick(s, false)); drawPastWorks(); } }, t('Снять отметки')),
        h('span', { class: 'help' }, t('Отмечено: {0}', [pastState.picked.size]))),
      h('ul', { class: 'pastlist' }, list.map((student) => {
        const key = nameKey(student.name);
        const on = pastState.picked.has(key);
        return h('li', {},
          h('label', { class: 'checkrow' },
            h('input', { type: 'checkbox', 'data-student': student.name, checked: on, onchange: (e) => { pick(student, e.target.checked); drawPastWorks(); } }),
            h('span', {}, student.name)),
          h('span', { class: 'help' }, on ? markLabel : ''),
          pastState.work === 'event' && h('label', { class: 'checkrow role' },
            h('input', { type: 'checkbox', 'data-role': student.name, checked: pastState.roles.has(key), disabled: !on, onchange: (e) => {
              if (e.target.checked) pastState.roles.add(key);
              else pastState.roles.delete(key);
            } }),
            h('span', {}, t('с ролью'))));
      })),
    ]
    : h('p', { class: 'free' }, t('В этой группе нет студентов. Добавьте их в «Справочниках».')),
  pastState.work === 'task' && h('label', { class: 'checkrow' },
    h('input', { type: 'checkbox', id: 'pw-penalty', checked: pastState.penalty, onchange: (e) => { pastState.penalty = e.target.checked; } }),
    h('span', {}, t('Не отмеченным в группе — минус {0}, как за несданное в срок', [2]))),
  pastState.message && h('p', { class: 'message error' }, pastState.message),
  h('div', { class: 'pasttools' },
    h('button', { type: 'submit', class: 'primary', id: 'pw-save' }, pastState.id ? t('Сохранить изменения') : t('Добавить работу')),
    pastState.id && h('button', { type: 'button', onclick: () => { resetPastForm(); pastState.message = ''; drawPastWorks(); } }, t('Отмена'))));

  const works = refsOf('pastwork').sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name, 'ru'));
  dialog.replaceChildren(
    h('div', { class: 'sheethead' },
      h('div', {}, h('h2', {}, t('Прошлые работы')),
        h('p', { class: 'help' }, t('Задания, практики и мероприятия, которые прошли до того, как колледж начал вести их в Kerdiis. Баллы грейда начисляются как обычно: сданное задание +3, практика +2, мероприятие +5 и ещё +2 за роль.')),
        h('p', { class: 'help' }, t('Можно вносить и прошлые курсы — это накопленный опыт в портфолио. До {0} засчитываются только плюсы: штраф за несданное за то время не ставится.', [shortDate(ratingFrom)]))),
      closeButton(dialog)),
    h('div', { class: 'sheetbody' },
      h('h3', {}, pastState.id ? t('Изменить работу') : t('Новая работа')),
      form,
      h('h3', {}, t('Всё внесённое')),
      works.length
        ? h('ul', { class: 'bonuslist pastworks' }, works.map((work) => h('li', { 'data-work': work.id },
          h('span', { class: 'awarddate' }, shortDate(work.date)),
          h('b', {}, typeLabel(work.work)),
          h('span', {}, work.by ? t('{0} ({1})', [work.name, work.by]) : work.name),
          h('span', { class: 'help' }, pastWorkSummary(work)),
          h('button', { type: 'button', class: 'plain small', onclick: () => editPastWork(work) }, t('Изменить')),
          h('button', {
            type: 'button',
            class: `plain small${pastState.confirm === work.id ? ' danger' : ''}`,
            'aria-label': t('Удалить {0}', [work.name]),
            onclick: async () => {
              if (pastState.confirm !== work.id) {
                pastState.confirm = work.id;
                return drawPastWorks();
              }
              const removed = await api.removeRefs([{ id: work.id, base: work.updatedAt }]);
              pastState.message = removed.ok ? '' : storeMessage(removed);
              if (pastState.id === work.id) resetPastForm();
              pastState.confirm = null;
              await loadDirectory();
              drawPastWorks();
              if ($('grade').open) drawGrades();
            },
          }, pastState.confirm === work.id ? t('Удалить?') : '✕'))))
        : h('p', { class: 'free' }, t('Пока ничего не внесено.'))),
  );
}

/* Личное дело студента: для аттестации, педсовета и родителей. Только на компьютерах преподавателей. */

// Личное дело — портфолио студента: по умолчанию за всё обучение, с первого курса.
const fileState = { id: null, period: 'all' };

/** Периоды личного дела: всё обучение, этот семестр, прошлый, учебный год. */
/** Опыт студента — его баллы рейтинга за всё обучение. */
function experienceMap() {
  return new Map(currentGrades().map((row) => [nameKey(row.name), row.points]));
}

/** Сколько раз студент был в каждой роли на мероприятиях, практике и заданиях. */
function roleCountsMap() {
  const map = new Map();
  for (const person of roleStats(state.allEvents, now().iso).people) map.set(nameKey(person.name), { ...person.roles });
  return map;
}

/* Кому дать: студенты без инициативы получают больше заданий, цель — опытный специалист */

/** Задания, мероприятия, практики и хакатоны с начала учёта: кто в чём участвовал. */
function hintWorks() {
  const { from } = ratingPeriod(now().iso);
  return [
    ...state.allEvents
      .filter((event) => ['task', 'event', 'practice'].includes(event.type) && event.cancelled !== true && event.pending !== true && event.date >= from)
      .map((event) => ({ date: event.type === 'task' && event.deadline ? event.deadline.slice(0, 10) : event.date, students: event.participants })),
    ...refsOf('pastwork').filter((work) => work.date >= from).map((work) => ({ date: work.date, students: work.students })),
  ];
}

/** Подсказки «кому дать»: из групп уже выбранных участников, а если никого нет — из всех. */
function balanceRows(chosen, roles = []) {
  const students = refsOf('student');
  const keys = new Set(chosen.map(nameKey));
  const groupIds = new Set(students.filter((student) => keys.has(nameKey(student.name))).map((student) => student.groupId));
  const candidates = students.filter((student) => !groupIds.size || groupIds.has(student.groupId)).map((student) => student.name);
  return balanceHints({
    candidates, works: hintWorks(), points: experienceMap(), roleCounts: roleCountsMap(), roles, todayISO: now().iso, exclude: chosen,
  });
}

function hintReason(row) {
  const parts = [];
  if (row.reasons.includes('none')) parts.push(t('ни одного задания и мероприятия в этом году'));
  else parts.push(t('участий: {0}', [row.count]));
  if (row.reasons.includes('long')) parts.push(t('последнее {0} дн. назад', [row.days]));
  parts.push(t('баллов: {0}', [row.points]));
  if (row.untried.length) parts.push(t('не пробовал роли: {0}', [row.untried.slice(0, 3).join(', ')]));
  return parts.join('; ');
}

function filePeriod(kind) {
  const today = now().iso;
  // Портфолио за всё обучение: с первого курса, включая внесённое задним числом.
  if (kind === 'all') return { from: ratingPeriod(today).retroFrom, to: today };
  const current = semesterOf(today);
  if (kind === 'previous') return semesterOf(addDays(current.from, -1));
  if (kind === 'year') {
    const year = schoolYearOf(today);
    return { from: `${year}-09-01`, to: `${year + 1}-08-31` };
  }
  return current;
}

function openStudentFile(studentId) {
  fileState.id = studentId;
  drawStudentFile();
  const dialog = $('studentfile');
  if (!dialog.open) dialog.showModal();
}

function studentFileSheet() {
  const student = state.directory.find((ref) => ref.id === fileState.id);
  if (!student) return h('p', { class: 'help' }, t('Студент не найден.'));
  const clock = now();
  const { from, to } = filePeriod(fileState.period);
  const data = studentFile({
    student, events: state.allEvents, attendance: state.attendance, students: refsOf('student'), groups: refsOf('group'),
    achievements: refsOf('achievement'), bonuses: refsOf('bonus'), pastWorks: refsOf('pastwork'), from, to, nowISO: clock.iso, nowTime: clock.time,
  });
  const long = (iso) => fmt(iso, { day: 'numeric', month: 'long', year: 'numeric' });
  const a = data.attendance;
  const weekdays = Array.from({ length: 6 }, (_, i) => fmt(addDays('2026-11-02', i), { weekday: 'short' }));
  const taskState = { done: t('сдано'), open: t('в работе'), rework: t('на доработке'), 'rework-late': t('на доработке, срок прошёл'), missed: t('не сдано, срок прошёл') };
  const table = (head, rows) => h('table', {}, h('thead', {}, h('tr', {}, head.map((name) => h('th', {}, name)))), h('tbody', {}, rows));
  const fact = (label, value) => [h('dt', {}, label), h('dd', {}, value)];
  return h('article', { class: 'paper filepaper' },
    h('header', {},
      h('p', { class: 'kicker' }, t('Личное дело студента')),
      h('h2', {}, student.name),
      h('p', {}, t('За период с {0} по {1}', [long(data.from), long(data.to)]))),
    h('dl', {},
      fact(t('Группа'), groupOfStudent(student) || '—'),
      student.birthday ? fact(t('Дата рождения'), long(student.birthday)) : [],
      data.grade ? fact(t('Грейд'), t('{0}, баллов: {1}', [gradeName(data.grade.level), data.grade.points])) : []),

    h('h3', {}, t('Посещаемость')),
    a.total
      ? [h('p', { class: 'filebig' },
        h('b', {}, a.share === null ? '—' : `${a.share}%`), ' ',
        t('пришёл из тех занятий, где должен был быть'),
        data.groupShare !== null ? t(' (в среднем по группе {0}%)', [data.groupShare]) : ''),
      h('table', { class: 'compact' }, h('thead', {}, h('tr', {}, [t('Отметок'), t('Пришёл'), t('Опоздал'), t('Прогулы'), t('Болел'), t('Без справки'), t('Приказ'), t('Уваж.')].map((name) => h('th', {}, name)))), h('tbody', {},
        [h('tr', {}, [a.total, a.present, a.late, a.absent, a.sick, a.noCertificate, a.order, a.excused].map((n) => h('td', { class: 'num' }, String(n))))]))]
      : h('p', { class: 'free' }, t('За этот период отметок нет.')),
    a.unmarked > 0 && h('p', { class: 'filewarn' }, t('Занятий без переклички: {0}. Они не считаются ни присутствием, ни прогулом, пока их не отметят.', [a.unmarked])),
    data.lateness && [
      h('p', {}, t('Опозданий: {0}, в среднем на {1} мин. Чаще всего: {2}.', [data.lateness.count, data.lateness.average, data.lateness.worstDays.map((d) => weekdays[d - 1]).join(', ')])),
      table(weekdays, [h('tr', {}, data.lateness.byWeekday.slice(0, 6).map((n) => h('td', { class: 'num' }, n ? String(n) : '')))])],
    data.certificates > 0 && h('p', { class: 'filewarn' }, t('Ждём справку о болезни: занятий без справки — {0}.', [data.certificates])),

    h('h3', {}, t('Задания')),
    data.tasks.length
      ? table([t('Срок'), t('Задание'), t('Состояние')], data.tasks.map((task) => h('tr', { class: ['missed', 'rework-late'].includes(task.state) ? 'late' : '' },
        h('td', {}, task.past ? shortDate(task.deadline.slice(0, 10)) : stampText(task.deadline)), h('td', {}, task.title, task.past && h('small', { class: 'pastmark' }, t('внесено задним числом'))), h('td', {}, taskState[task.state]))))
      : h('p', { class: 'free' }, t('Заданий со сдачей за период не было.')),

    data.grade && [h('h3', {}, t('Грейд')),
      h('p', {}, t('Рейтинг за всё обучение: {0}, баллов: {1}.', [gradeName(data.grade.level), data.grade.points]),
        data.grade.next ? t(' До {0} — ещё {1}.', [gradeName(data.grade.next.name), data.grade.next.need]) : ''),
      data.manual.length > 0 && table([t('Дата'), t('Поощрения и поведение'), t('За что'), t('Кто поставил')], data.manual.map((item) => h('tr', {},
        h('td', {}, shortDate(item.date)), h('td', { class: 'num' }, signed(item.points)), h('td', {}, item.name), h('td', {}, item.by || '—')))),
      data.grade.levelUps.length > 0 && h('p', {}, t('Получен: {0}', [data.grade.levelUps.map((up) => `${up.level} — ${fmt(up.date, { day: 'numeric', month: 'long' })}`).join('; ')]))],

    h('h3', {}, t('Участие и достижения')),
    data.items.length || data.awards.length
      ? [data.items.length > 0 && table([t('Дата'), t('Вид'), t('Название'), t('Роль')], data.items.map((item) => h('tr', {},
        h('td', {}, shortDate(item.date)), h('td', {}, typeLabel(item.type)), h('td', {}, item.title, item.past && h('small', { class: 'pastmark' }, t('внесено задним числом'))), h('td', {}, item.past && item.role ? t('с ролью') : item.role)))),
      data.awards.length > 0 && table([t('Дата'), t('Достижение'), t('Результат')], data.awards.map((item) => h('tr', {},
        h('td', {}, shortDate(item.date)), h('td', {}, item.name), h('td', {}, item.result))))]
      : h('p', { class: 'free' }, t('За период участий и достижений нет.')),

    h('footer', { class: 'filesign' },
      h('p', {}, h('span', {}, t('Куратор')), h('i'), h('span', {}, t('подпись'))),
      h('p', { class: 'weekfoot' }, t('Составлено в Kerdiis {0}', [long(clock.iso)]))));
}

function drawStudentFile() {
  const dialog = $('studentfile');
  const student = state.directory.find((ref) => ref.id === fileState.id);
  const periods = [['all', t('За всё обучение')], ['semester', t('Этот семестр')], ['previous', t('Прошлый семестр')], ['year', t('Учебный год')]];
  dialog.replaceChildren(
    h('div', { class: 'sheethead' }, h('h2', {}, t('Личное дело студента')), closeButton(dialog)),
    h('div', { class: 'tabs weektools', role: 'group', 'aria-label': t('Период') },
      periods.map(([id, label]) => h('button', { type: 'button', class: fileState.period === id ? 'active' : '', 'aria-pressed': String(fileState.period === id), onclick: () => { fileState.period = id; drawStudentFile(); } }, label)),
      student && h('span', { class: 'fileflags' }, flagToggles(student))),
    h('div', { class: 'sheetbody paperview' }, studentFileSheet()),
    h('div', { class: 'sheetfoot' }, printButtons(studentFileSheet, () => t('Личное дело {0}.pdf', [student?.name ?? '']))),
  );
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
  if (['form', 'preferences', 'catalog', 'roll', 'reports', 'paper', 'pet', 'memo', 'welcome', 'gear', 'notices', 'deadlines', 'journal', 'netcheck', 'handin', 'rolestats', 'proposals', 'groupweek', 'chronicle', 'grade', 'studentfile'].some((id) => $(id).open)) return;
  if ($('details').open) $('details').close();
  state.view = 'week';
  state.date = now().iso;
  // На общей панели вкладка тоже возвращается к «Всё».
  if (isClient()) state.tab = 'all';
  render();
}

function wire() {
  $('prev').addEventListener('click', () => move(-1));
  $('next').addEventListener('click', () => move(1));
  $('today').addEventListener('click', () => { state.date = now().iso; render(); });
  $('add').addEventListener('click', () => openForm());
  $('settings').addEventListener('click', openSettings);
  $('net').addEventListener('click', openNetCheck);
  $('theme').addEventListener('click', () => {
    api.setTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
  });
  $('pet-open').addEventListener('click', () => {
    drawPet();
    $('pet').showModal();
  });
  // Пункт меню «Разделы» открывает своё окно, а само меню закрывается.
  $('sections').addEventListener('click', (event) => {
    if (event.target.closest('button')) $('sections').hidePopover();
  });
  $('open-gear').addEventListener('click', openGear);
  $('open-groupweek').addEventListener('click', openGroupWeek);
  $('open-chronicle').addEventListener('click', openChronicle);
  $('open-grade').addEventListener('click', openGrades);
  // Табло перемены: любое касание или нажатие убирает его и откладывает на минуту.
  for (const type of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(type, touched, { capture: true, passive: true });
  setInterval(refreshBoard, 5000);
  $('open-proposals').addEventListener('click', () => openProposals());
  $('open-deadlines').addEventListener('click', openDeadlines);
  $('open-journal').addEventListener('click', openJournal);
  $('open-signals').addEventListener('click', openSignals);
  $('notices-open').addEventListener('click', openNotices);
  $('open-reports').addEventListener('click', openReports);
  $('open-catalog').addEventListener('click', () => {
    catalog.message = '';
    drawCatalog({ fromTop: true });
    $('catalog').showModal();
  });
  for (const button of document.querySelectorAll('.views button')) {
    button.addEventListener('click', () => { state.view = button.dataset.view; render(); });
  }
  window.addEventListener('resize', () => { render(); applySkin(); });
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
  applySize(state.settings.uiSize);
  api.onChanged(refresh);
  render();
  tick();
  await refresh();
  if (!state.settings.setupDone) openWelcome();
  setTimeout(autoSummary, 90_000);
}

start();
setInterval(tick, 1000);
setInterval(refresh, POLL_MS);
refreshNet();
setInterval(refreshNet, 20_000);
setInterval(autoSummary, 60 * 60_000);
