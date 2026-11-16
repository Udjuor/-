// Расписание Kerdiis на телефоне преподавателя.
// Телефон подключается один раз по QR-коду с экрана компьютера; ключ хранится только на нём.
const app = document.getElementById('app');
const sheet = document.getElementById('sheet');
const ru = (navigator.language || 'ru').toLowerCase().startsWith('ru');
const T = ru ? {
  pairTitle: 'Подключите телефон', pairText: 'Откройте на компьютере преподавателя «Настройки → Телефон преподавателя → Подключить телефон» и отсканируйте QR-код.',
  pairing: 'Подключаем телефон…', pairBad: 'Код устарел или уже использован. Покажите на компьютере новый QR-код.', unpaired: 'Этот телефон отключён от компьютера. Подключите его заново.',
  offline: 'Нет связи с компьютером. Он должен быть включён, Kerdiis — запущен.', many: 'Слишком много неверных попыток. Подождите 10 минут.',
  prev: '← Раньше', next: 'Дальше →', today: 'Сегодня', none: 'Ничего нет', add: 'Добавить', newTitle: 'Новое событие', editTitle: 'Изменить',
  type: { lesson: 'Занятие', event: 'Мероприятие', practice: 'Практика', task: 'Задание' }, title: 'Название', date: 'Дата', start: 'Начало', end: 'Конец', place: 'Место',
  groups: 'Группы', groupsKeep: 'Группы не меняются, пока вы их не выберете', responsible: 'Ответственный', notes: 'Заметки', save: 'Сохранить', cancel: 'Отмена', close: 'Закрыть',
  notHeld: 'Не состоялось', held: 'Всё-таки состоялось', reason: 'Причина (не обязательно)', remove: 'Удалить', removeAsk: 'Удалить «{0}»?', yes: 'Да, удалить',
  saved: 'Сохранено', students: '{0} студ.', cancelled: 'Не состоялось', conflict: 'Событие уже изменили на другом устройстве. Обновите и повторите.',
  locked: 'Отчёт по занятию зафиксирован: время и состав меняются только на компьютере.', invalid: 'Проверьте название, дату и время.', failed: 'Не удалось сохранить: {0}', series: 'из цепочки',
  forget: 'Отключить этот телефон', allDay: 'Весь день',
} : {
  pairTitle: 'Connect your phone', pairText: 'On the teacher computer open “Settings → Teacher phone → Connect a phone” and scan the QR code.',
  pairing: 'Connecting…', pairBad: 'The code expired or was already used. Show a new QR code on the computer.', unpaired: 'This phone was disconnected. Connect it again.',
  offline: 'Cannot reach the computer. It must be on with Kerdiis running.', many: 'Too many wrong attempts. Wait 10 minutes.',
  prev: '← Earlier', next: 'Later →', today: 'Today', none: 'Nothing', add: 'Add', newTitle: 'New event', editTitle: 'Edit',
  type: { lesson: 'Lesson', event: 'Event', practice: 'Practice', task: 'Task' }, title: 'Title', date: 'Date', start: 'Start', end: 'End', place: 'Place',
  groups: 'Groups', groupsKeep: 'Groups stay as they are until you pick some', responsible: 'Responsible', notes: 'Notes', save: 'Save', cancel: 'Cancel', close: 'Close',
  notHeld: 'Did not take place', held: 'Took place after all', reason: 'Reason (optional)', remove: 'Delete', removeAsk: 'Delete “{0}”?', yes: 'Yes, delete',
  saved: 'Saved', students: '{0} students', cancelled: 'Did not take place', conflict: 'Someone changed this event on another device. Refresh and try again.',
  locked: 'The lesson report is locked: time and participants change only on the computer.', invalid: 'Check the title, date and time.', failed: 'Could not save: {0}', series: 'part of a series',
  forget: 'Disconnect this phone', allDay: 'All day',
};
const f = (text, ...args) => text.replace(/\{(\d)\}/g, (_, i) => args[i] ?? '');

let token = '';
let state = null;
let from = null;

try { token = localStorage.getItem('kerdiis-remote') || ''; } catch { token = ''; }

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false && c !== ''));
  return el;
}
const fill = (el, ...children) => el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false && c !== ''));

const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dayName = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(ru ? 'ru-RU' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

async function api(route, body = {}) {
  const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function message(text, cls = 'muted') {
  fill(app, h('div', { class: 'pair' }, h('h2', {}, T.pairTitle), h('p', { class: cls }, text), h('p', { class: 'muted' }, T.pairText)));
}

async function pair(code) {
  fill(app, h('p', { class: 'muted' }, T.pairing));
  let res;
  try {
    res = await api('/api/pair', { code, name: phoneName() });
  } catch {
    return message(T.offline, 'error');
  }
  if (res.status !== 200) return message(res.status === 429 ? T.many : T.pairBad, 'error');
  token = res.data.token;
  try { localStorage.setItem('kerdiis-remote', token); } catch { /* приватный режим: ключ живёт до закрытия вкладки */ }
  return load();
}

function phoneName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  const android = ua.match(/Android[^;]*;\s*([^;)]+)/);
  return android ? android[1].trim().slice(0, 40) : 'Телефон';
}

async function load() {
  if (!token) return message('');
  let res;
  try {
    res = await api('/api/state', { from });
  } catch {
    return state ? draw(T.offline) : message(T.offline, 'error');
  }
  if (res.status === 401) {
    try { localStorage.removeItem('kerdiis-remote'); } catch { /* */ }
    token = '';
    return message(T.unpaired, 'error');
  }
  if (res.status !== 200) return message(res.status === 429 ? T.many : T.offline, 'error');
  state = res.data;
  from = state.from;
  return draw();
}

function draw(problem) {
  document.getElementById('where').textContent = state.name;
  const days = [];
  for (let i = 0; i < 14; i += 1) days.push(addDays(state.from, i));
  fill(app,
    problem && h('p', { class: 'error' }, problem),
    h('div', { class: 'nav' },
      h('button', { type: 'button', onclick: () => { from = addDays(state.from, -7); load(); } }, T.prev),
      h('b', {}, state.from === state.today ? T.today : dayName(state.from)),
      h('button', { type: 'button', onclick: () => { from = addDays(state.from, 7); load(); } }, T.next)),
    state.from !== state.today && h('button', { type: 'button', onclick: () => { from = state.today; load(); } }, T.today),
    days.map((day) => {
      const list = state.events.filter((e) => e.date === day);
      return [
        h('h3', { class: `day${day === state.today ? ' today' : ''}` }, dayName(day)),
        list.length ? list.map((e) => h('button', { type: 'button', class: `ev t-${e.type}${e.cancelled ? ' cancelled' : ''}`, onclick: () => edit(e) },
          h('span', {},
            h('div', { class: 'time' }, e.allDay ? T.allDay : `${e.start}–${e.end}`, ` · ${T.type[e.type] ?? e.type}`),
            h('div', { class: 'title' }, e.title),
            h('div', { class: 'meta' }, [e.cancelled && T.cancelled, e.groups.join(', '), e.count && !e.groups.length ? f(T.students, e.count) : '', e.place, e.responsible].filter(Boolean).join(' · '))))) : h('p', { class: 'empty' }, T.none),
      ];
    }),
    h('button', { type: 'button', class: 'primary fab', 'aria-label': T.add, onclick: () => edit(null) }, '+'),
    h('p', { class: 'muted' }, h('button', { type: 'button', onclick: () => { try { localStorage.removeItem('kerdiis-remote'); } catch { /* */ } token = ''; state = null; message(''); } }, T.forget)));
}

function errorText(data) {
  if (data.error === 'conflict' || data.error === 'changed') return T.conflict;
  if (data.error === 'locked') return T.locked;
  if (data.error === 'invalid') return data.message || T.invalid;
  return f(T.failed, data.message || data.error || '');
}

/** Новое событие или правка: тип, название, дата, время, место, группы. */
function edit(event) {
  const draft = event ? { ...event } : { type: 'lesson', title: '', date: state.from <= state.today && state.today <= state.to ? state.today : state.from, start: '09:00', end: '10:30', place: '', responsible: '', notes: '' };
  let groupIds = null; // null — участников не трогаем
  const error = h('p', { class: 'error', role: 'alert' });
  const types = h('div', { class: 'types' });
  const drawTypes = () => fill(types, Object.entries(T.type).map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(draft.type === id), onclick: () => { draft.type = id; drawTypes(); } }, label)));
  drawTypes();
  const chips = h('div', { class: 'chips' });
  const picked = new Set(event ? state.groups.filter((g) => event.groups.includes(g.name)).map((g) => g.id) : []);
  const drawChips = () => fill(chips, state.groups.map((g) => h('button', { type: 'button', 'aria-pressed': String(picked.has(g.id)), onclick: () => { if (picked.has(g.id)) picked.delete(g.id); else picked.add(g.id); groupIds = [...picked]; drawChips(); } }, g.name)));
  drawChips();
  const input = (key, attrs = {}) => h('input', { id: `r-${key}`, value: draft[key] ?? '', ...attrs });
  const places = h('datalist', { id: 'r-places' }, state.places.map((p) => h('option', { value: p })));
  const teachers = h('datalist', { id: 'r-teachers' }, state.teachers.map((p) => h('option', { value: p })));
  const read = () => {
    for (const key of ['title', 'date', 'start', 'end', 'place', 'responsible']) draft[key] = sheet.querySelector(`#r-${key}`).value.trim();
    draft.notes = sheet.querySelector('#r-notes').value.trim();
  };
  const run = async (route, body) => {
    error.textContent = '';
    let res;
    try {
      res = await api(route, body);
    } catch {
      error.textContent = T.offline;
      return;
    }
    if (res.status !== 200) {
      error.textContent = errorText(res.data);
      return;
    }
    sheet.close();
    await load();
  };
  const save = () => {
    read();
    const { id, type, title, date, start, end, place, responsible, notes } = draft;
    run('/api/save', { event: { id, type, title, date, start, end, place, responsible, notes }, base: event?.updatedAt, groupIds: groupIds ?? (event ? undefined : []) });
  };
  const footer = h('div', { class: 'actions' });
  const drawFooter = () => fill(footer,
    h('button', { type: 'button', class: 'primary', id: 'r-save', onclick: save }, T.save),
    h('button', { type: 'button', onclick: () => sheet.close() }, T.close),
    h('span', { class: 'grow' }),
    event && (event.cancelled
      ? h('button', { type: 'button', onclick: () => run('/api/cancel', { id: event.id, base: event.updatedAt, cancelled: false }) }, T.held)
      : h('button', { type: 'button', onclick: askCancel }, T.notHeld)),
    event && h('button', { type: 'button', class: 'danger', onclick: askRemove }, T.remove));
  const askCancel = () => {
    const reason = h('input', { id: 'r-reason', placeholder: T.reason });
    fill(footer, reason,
      h('button', { type: 'button', class: 'primary', onclick: () => run('/api/cancel', { id: event.id, base: event.updatedAt, cancelled: true, reason: reason.value.trim() }) }, T.notHeld),
      h('button', { type: 'button', onclick: drawFooter }, T.cancel));
  };
  const askRemove = () => fill(footer, h('p', {}, f(T.removeAsk, event.title)),
    h('button', { type: 'button', class: 'danger', id: 'r-remove', onclick: () => run('/api/delete', { id: event.id, base: event.updatedAt }) }, T.yes),
    h('button', { type: 'button', onclick: drawFooter }, T.cancel));
  drawFooter();
  fill(sheet, h('div', { class: 'sheet' },
    h('h2', {}, event ? T.editTitle : T.newTitle),
    event?.series && h('p', { class: 'muted' }, T.series),
    types,
    h('label', {}, T.title, input('title', { autocomplete: 'off' })),
    h('div', { class: 'row' },
      h('label', {}, T.date, input('date', { type: 'date' })),
      h('label', {}, T.start, input('start', { type: 'time' })),
      h('label', {}, T.end, input('end', { type: 'time' }))),
    h('label', {}, T.place, input('place', { list: 'r-places', autocomplete: 'off' })), places,
    h('div', {}, h('label', {}, T.groups), chips, event && h('p', { class: 'muted' }, T.groupsKeep)),
    h('label', {}, T.responsible, input('responsible', { list: 'r-teachers', autocomplete: 'off' })), teachers,
    h('label', {}, T.notes, h('textarea', { id: 'r-notes', rows: 2, value: draft.notes ?? '' })),
    error,
    footer));
  sheet.showModal();
}

const pairCode = new URLSearchParams(location.hash.slice(1)).get('pair');
if (pairCode) {
  history.replaceState(null, '', location.pathname);
  pair(pairCode);
} else {
  load();
}
// Расписание обновляется само, пока страница открыта.
setInterval(() => { if (state && !sheet.open) load(); }, 60_000);
