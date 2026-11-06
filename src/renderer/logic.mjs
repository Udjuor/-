// Чистая логика календаря без обращения к странице: её проверяют тесты.

const pad = (n) => String(n).padStart(2, '0');

export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function fromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso, days) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

export function addMonths(iso, months) {
  const d = fromISO(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISO(d);
}

/** Понедельник недели, в которую попадает дата. */
export function weekStart(iso) {
  const weekday = (fromISO(iso).getDay() + 6) % 7;
  return addDays(iso, -weekday);
}

export const weekDays = (iso) => {
  const monday = weekStart(iso);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
};

/** Полные недели (с понедельника по воскресенье), покрывающие месяц. */
export function monthWeeks(iso) {
  const d = fromISO(iso);
  const first = toISO(new Date(d.getFullYear(), d.getMonth(), 1));
  const last = toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const weeks = [];
  for (let monday = weekStart(first); monday <= last; monday = addDays(monday, 7)) {
    weeks.push(weekDays(monday));
  }
  return weeks;
}

export const toMinutes = (time) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

export const fromMinutes = (total) => `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;

export const byTime = (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title, 'ru');

export const eventsOn = (events, iso) => events.filter((e) => e.date === iso).sort(byTime);

/** Часы, которые показывает сетка: рабочий день, расширенный под мероприятия. */
export function hourRange(events, from = 8, to = 20) {
  let first = from;
  let last = to;
  for (const e of events) {
    first = Math.min(first, Math.floor(toMinutes(e.start) / 60));
    last = Math.max(last, Math.ceil(toMinutes(e.end) / 60));
  }
  return { first, last };
}

/**
 * Раскладывает мероприятия одного дня по колонкам, чтобы пересекающиеся
 * стояли рядом. Возвращает [{ event, column, columns }].
 */
export function layoutDay(dayEvents) {
  const sorted = [...dayEvents].sort(byTime);
  const placed = [];
  let group = [];
  let groupEnd = '';

  const flush = () => {
    const columnEnds = [];
    const items = group.map((event) => {
      let column = columnEnds.findIndex((end) => end <= event.start);
      if (column === -1) column = columnEnds.length;
      columnEnds[column] = event.end;
      return { event, column };
    });
    for (const item of items) placed.push({ ...item, columns: columnEnds.length });
    group = [];
  };

  for (const event of sorted) {
    if (group.length && event.start >= groupEnd) flush();
    group.push(event);
    groupEnd = group.length === 1 || event.end > groupEnd ? event.end : groupEnd;
  }
  if (group.length) flush();
  return placed;
}

/** Когда участники заняты: с начала подготовки. Раньше полуночи время не уходит. */
export const busyFrom = (event) => fromMinutes(Math.max(0, toMinutes(event.start) - (event.prepMinutes ?? 0)));

export const overlaps = (a, b) => a.date === b.date && busyFrom(a) < b.end && busyFrom(b) < a.end;

export const nameKey = (name) => name.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');

/**
 * Находит, кто из участников, какая техника и какой ответственный уже заняты
 * в пересекающихся по времени мероприятиях.
 */
export function findConflicts(draft, events, stock = []) {
  const result = [];
  if (!draft.date || !draft.start || !draft.end || draft.start >= draft.end) return result;
  const others = events.filter((e) => e.id !== draft.id && overlaps(draft, e)).sort(byTime);
  const people = [...draft.participants];
  if (draft.responsible) people.push(draft.responsible);

  const check = (names, kind, listOf) => {
    const reported = new Set();
    for (const name of names) {
      const key = nameKey(name);
      if (reported.has(key)) continue;
      const clash = others.find((e) => listOf(e).some((other) => nameKey(other) === key));
      if (clash) {
        reported.add(key);
        result.push({ kind, name, event: clash });
      }
    }
  };
  check(people, 'person', (e) => (e.responsible ? [...e.participants, e.responsible] : e.participants));
  // Техника из справочника считается по количеству, см. shortages.
  const counted = new Set(stock.map((item) => nameKey(item.name)));
  counted.add(nameKey(OWN_CAMERA));
  check(draft.equipment.filter((name) => !counted.has(nameKey(name))), 'equipment', (e) => e.equipment);
  return result;
}

/** Своя камера студента: без лимита и не из наличия. */
export const OWN_CAMERA = 'Своя камера';

export const equipmentCount = (event, name) => event.equipmentQty?.[name] ?? 1;

export function equipmentLabel(event, name) {
  const count = equipmentCount(event, name);
  return count > 1 ? `${name} × ${count}` : name;
}

/** Сколько единицы техники занято другими событиями в то же время. */
function usedElsewhere(draft, events, name) {
  if (!draft.date || !draft.start || !draft.end || draft.start >= draft.end) return 0;
  const key = nameKey(name);
  let used = 0;
  for (const event of events) {
    if (event.id === draft.id || !overlaps(draft, event)) continue;
    const match = event.equipment.find((item) => nameKey(item) === key);
    if (match) used += equipmentCount(event, match);
  }
  return used;
}

/** Сколько свободно на время события. null, если лимита нет. */
export function freeStock(draft, events, item) {
  if (item.quantity === null || item.quantity === undefined) return null;
  return Math.max(0, item.quantity - usedElsewhere(draft, events, item.name));
}

/** Техника, которой не хватает: выбрано больше, чем свободно. */
export function shortages(draft, events, stock) {
  const result = [];
  for (const name of draft.equipment) {
    const item = stock.find((candidate) => nameKey(candidate.name) === nameKey(name));
    const free = item ? freeStock(draft, events, item) : null;
    const need = equipmentCount(draft, name);
    if (free !== null && need > free) result.push({ name, need, free, total: item.quantity });
  }
  return result;
}

/** Занятость техники на этот момент: сколько занято, у кого и что дальше. */
export function equipmentNow(stock, events, nowISO, nowTime) {
  const active = (event) => event.date === nowISO && busyFrom(event) <= nowTime && nowTime < event.end;
  const upcoming = (event) => event.date > nowISO || (event.date === nowISO && busyFrom(event) > nowTime);
  const rows = new Map(stock.filter((item) => item.name !== OWN_CAMERA)
    .map((item) => [nameKey(item.name), { name: item.name, total: item.quantity ?? null, listed: true }]));
  for (const event of events.filter(active)) {
    for (const name of event.equipment) {
      if (!rows.has(nameKey(name))) rows.set(nameKey(name), { name, total: null, listed: false });
    }
  }
  const soon = [...events].filter(upcoming).sort((a, b) => a.date.localeCompare(b.date) || busyFrom(a).localeCompare(busyFrom(b)));
  return [...rows.entries()].map(([key, row]) => {
    const uses = (event) => event.equipment.find((name) => nameKey(name) === key);
    const holders = events.filter((event) => active(event) && uses(event))
      .map((event) => ({ event, count: equipmentCount(event, uses(event)) }));
    const used = holders.reduce((sum, holder) => sum + holder.count, 0);
    return { ...row, used, holders, next: soon.find(uses) ?? null };
  }).sort((a, b) => Number(b.used > 0) - Number(a.used > 0) || a.name.localeCompare(b.name, 'ru'));
}

/** Состояние срока сдачи: сдано, просрочено, сегодня-завтра или позже. Без срока null. */
export function deadlineState(event, moment) {
  if (!event.deadline) return null;
  if (event.deadlineDone) return 'done';
  if (event.deadline <= moment) return 'overdue';
  return event.deadline.slice(0, 10) <= addDays(moment.slice(0, 10), 1) ? 'soon' : 'later';
}

/** Сроки по порядку: ближайшие и просроченные первыми, сданные недавние первыми. */
export function deadlineList(events, moment) {
  const items = events.filter((event) => event.deadline)
    .map((event) => ({ event, state: deadlineState(event, moment) }));
  return {
    overdue: pickDeadlines(items, 'overdue'),
    soon: pickDeadlines(items, 'soon'),
    later: pickDeadlines(items, 'later'),
    done: pickDeadlines(items, 'done').reverse(),
  };
}

const pickDeadlines = (items, state) => items.filter((item) => item.state === state)
  .map((item) => item.event).sort((a, b) => a.deadline.localeCompare(b.deadline));

/** Что напоминать в бегущей строке: просроченное не дольше трёх дней и то, что поджимает. */
export function deadlineAlerts(events, moment) {
  const { overdue, soon } = deadlineList(events, moment);
  const oldest = addDays(moment.slice(0, 10), -3);
  return [
    ...overdue.filter((event) => event.deadline.slice(0, 10) >= oldest).reverse().map((event) => ({ event, late: true })),
    ...soon.map((event) => ({ event, late: false })),
  ];
}

/** Напоминания, срок которых ещё не вышел: сначала те, что заканчиваются раньше. */
export function activeNotices(notices, moment) {
  return notices.filter((notice) => notice.until > moment).sort((a, b) => a.until.localeCompare(b.until));
}

/** Разбирает вставленные строки техники: последний числовой столбец — количество. */
export function parseEquipment(text) {
  return text.split(/[\r\n;]+/).map((line) => {
    const cells = line.split('\t').map((cell) => cell.trim()).filter(Boolean);
    const last = cells.at(-1);
    const quantity = cells.length > 1 && /^\d+$/.test(last) ? Number(cells.pop()) : null;
    return { name: cells.join(' ').replace(/\s+/g, ' ').trim(), quantity };
  }).filter((row) => row.name);
}

/** Разбирает вставленный список: столбец из Excel или строку через точку с запятой. */
export const splitList = (text) => text.split(/[\r\n;\t]+/).map((s) => s.trim()).filter(Boolean);

/** Разбирает список имён: столбцы одной строки таблицы (фамилия, имя) склеивает. */
export const splitNames = (text) => text.split(/[\r\n;]+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

/** Значения для подсказок: все, что уже встречалось, без учёта регистра. */
export function uniqueValues(values) {
  const map = new Map();
  for (const value of values) {
    if (value && !map.has(nameKey(value))) map.set(nameKey(value), value);
  }
  return [...map.values()].sort((a, b) => a.localeCompare(b, 'ru'));
}

/** Мероприятие без выбранных устройств показывается везде. */
export const visibleOn = (event, deviceId, showAll) =>
  showAll || !event.devices?.length || event.devices.includes(deviceId);

export const EVENT_TYPES = [
  ['lesson', 'Занятие'],
  ['practice', 'Практика'],
  ['task', 'Задание'],
  ['event', 'Мероприятие'],
];

export const typeName = (type) => (EVENT_TYPES.find(([id]) => id === type) ?? EVENT_TYPES[3])[1];

export const ABSENCE_REASONS = [
  ['sick', 'Болезнь'],
  ['order', 'По приказу'],
  ['excused', 'Уважительная'],
];

export const statusName = (status) => ({
  present: 'Присутствовал',
  late: 'Опоздал',
  sick: 'Болезнь',
  order: 'По приказу',
  excused: 'Уважительная причина',
  absent: 'Без причины',
  pending: 'Нет отметки',
}[status]);

/** Минуты опоздания: 0, если студент отметился вовремя. */
export function lateMinutes(event, at) {
  const [y, m, d] = event.date.split('-').map(Number);
  const start = new Date(y, m - 1, d, ...event.start.split(':').map(Number));
  return Math.max(0, Math.floor((new Date(at) - start) / 60000));
}

const hasEnded = (event, nowISO, nowTime) => eventState(event, nowISO, nowTime) === 'past';

/**
 * Положение каждого участника пары. Если пара закончилась, а отметки нет,
 * это пропуск без причины; пока она идёт — просто «нет отметки».
 */
export function rollCall(event, doc, nowISO, nowTime, events = []) {
  const closed = Boolean(doc?.lock) || hasEnded(event, nowISO, nowTime);
  // После фиксации освобождения берутся из отчёта: изменения расписания его не трогают.
  const excused = doc?.lock ? new Map(Object.entries(doc.lock.excused ?? {})) : excusedBy(event, events);
  return (doc?.lock?.participants ?? event.participants).map((name) => {
    const mark = doc?.marks?.[name];
    if (mark?.status) return markedRow(event, name, mark);
    if (excused.has(name)) return { name, status: 'order', at: null, late: 0, excusedFor: excused.get(name) };
    return { name, status: closed ? 'absent' : 'pending', at: null, late: 0 };
  });
}

const EXCUSING_TYPES = new Set(['task', 'event', 'practice']);
const EXCUSED_TYPES = new Set(['lesson', 'practice']);

/** Кто освобождён от занятия по приказу: внесён в задание, практику или мероприятие в это же время. */
export function excusedBy(event, events) {
  const excused = new Map();
  if (!EXCUSED_TYPES.has(event.type)) return excused;
  const others = events.filter((other) => other.id !== event.id && other.date === event.date && EXCUSING_TYPES.has(other.type)
    && busyFrom(other) < event.end && event.start < other.end);
  for (const name of event.participants) {
    const other = others.find((item) => item.participants.some((person) => nameKey(person) === nameKey(name)));
    if (other) excused.set(name, other.title);
  }
  return excused;
}

// Опоздание засчитывается, если его зафиксировали до конца 10-й минуты. Позже оно не считается,
// а с 40-й минуты это пропуск.
export const LATE_UNTIL_MINUTE = 10;
export const ABSENT_FROM_MINUTE = 40;

/** Опоздание ставят кнопкой. Старые отметки без этого поля считаются, как раньше. */
function markedRow(event, name, mark) {
  const row = { name, status: mark.status, at: mark.at, late: 0 };
  if (mark.status !== 'present') return row;
  const minutes = lateMinutes(event, mark.at);
  if (mark.late === undefined) return { ...row, late: minutes };
  if (!mark.late) return row;
  if (minutes >= ABSENT_FROM_MINUTE) return { ...row, status: 'absent', lateMark: true };
  return { ...row, late: minutes <= LATE_UNTIL_MINUTE ? Math.max(1, minutes) : 0, lateMark: true };
}

/** Счётчики по списку отметок. Посещаемость считается от всех, кто должен был прийти. */
function tally(rows) {
  const count = (status) => rows.filter((row) => row.status === status).length;
  const present = count('present');
  return {
    total: rows.length,
    present,
    late: rows.filter((row) => row.late > 0).length,
    sick: count('sick'),
    order: count('order'),
    excused: count('excused'),
    absent: count('absent'),
    percent: rows.length ? Math.round((present / rows.length) * 100) : null,
  };
}

/**
 * Данные отчёта за период.
 * filters: { from, to, types: [..], group: название, teacher: имя }
 * Проведённой считается пара, время окончания которой прошло.
 */
export function buildReport({ events, attendance, students, groups, filters, nowISO, nowTime }) {
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const groupOf = new Map(students.map((student) => [nameKey(student.name), groupName.get(student.groupId) ?? '']));
  const docs = new Map(attendance.map((doc) => [doc.eventId, doc]));
  const inGroup = (name) => !filters.group || groupOf.get(nameKey(name)) === filters.group;

  const pairs = [];
  const byStudent = new Map();
  const held = events
    .filter((event) => hasEnded(event, nowISO, nowTime)
      && event.date >= filters.from && event.date <= filters.to
      && filters.types.includes(event.type)
      && (!filters.teacher || event.responsible === filters.teacher))
    .sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));

  for (const event of held) {
    const roster = rollCall(event, docs.get(event.id), nowISO, nowTime, events).filter((row) => inGroup(row.name));
    if (filters.group && !roster.length) continue;
    const eventGroups = [...new Set(event.participants.map((name) => groupOf.get(nameKey(name))).filter(Boolean))].sort();
    pairs.push({ event, groups: eventGroups, locked: docs.get(event.id)?.lock ?? null, ...tally(roster) });
    for (const row of roster) {
      const key = nameKey(row.name);
      if (!byStudent.has(key)) byStudent.set(key, { name: row.name, group: groupOf.get(key) ?? '', rows: [] });
      byStudent.get(key).rows.push(row);
    }
  }

  const studentRows = [...byStudent.values()]
    .map(({ name, group, rows }) => ({ name, group, ...tally(rows) }))
    .sort((a, b) => a.group.localeCompare(b.group, 'ru') || a.name.localeCompare(b.name, 'ru'));

  const byGroup = new Map();
  for (const student of byStudent.values()) {
    const name = student.group || 'Без группы';
    if (!byGroup.has(name)) byGroup.set(name, []);
    byGroup.get(name).push(...student.rows);
  }
  const groupRows = [...byGroup].map(([name, rows]) => ({ name, ...tally(rows) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  return { pairs, students: studentRows, groups: groupRows };
}

/** CSV для Excel: точка с запятой и метка кодировки, чтобы кириллица открылась верно. */
export function toCsv(header, rows) {
  const cell = (value) => {
    const text = String(value ?? '');
    return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `\uFEFF${[header, ...rows].map((row) => row.map(cell).join(';')).join('\r\n')}\r\n`;
}

const memoFields = (event) => [
  event.title, event.date, event.start, event.end, event.prepMinutes ?? 0, event.place, event.responsible, ...event.participants,
];

/** Записка нужна всем, кроме обычных занятий, если есть кого освобождать. */
export const memoApplies = (event) => event.type !== 'lesson' && event.participants.length > 0;

/** Новая записка нужна, если изменилось то, что в ней написано. */
export function needsMemo(saved, previous) {
  if (!memoApplies(saved)) return false;
  return !previous?.id || JSON.stringify(memoFields(saved)) !== JSON.stringify(memoFields(previous));
}

/** Значения для шаблона служебной записки. */
export function memoData(event, students, groups, todayISO) {
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const groupOf = new Map(students.map((student) => [nameKey(student.name), groupName.get(student.groupId) ?? '']));
  const longDate = (iso, options) => new Intl.DateTimeFormat('ru-RU', options).format(fromISO(iso));
  const eventDate = longDate(event.date, { day: 'numeric', month: 'long', year: 'numeric' }).replace(/ г\.$/, '');
  const [year, , day] = todayISO.split('-');
  const month = longDate(todayISO, { day: 'numeric', month: 'long' }).split(' ')[1];
  return {
    day,
    month,
    year,
    title: event.title,
    when: `${eventDate}, ${event.start}`,
    release: `${busyFrom(event)}–${event.end}`,
    place: event.place,
    responsible: event.responsible,
    students: event.participants.map((name) => ({ name, group: groupOf.get(nameKey(name)) ?? '' })),
  };
}

/** Состояние мероприятия относительно текущего момента. */
export function eventState(event, nowISO, nowTime) {
  if (event.date < nowISO || (event.date === nowISO && event.end <= nowTime)) return 'past';
  if (event.date === nowISO && event.start <= nowTime) return 'now';
  return 'future';
}

export function plural(n, one, few, many) {
  const tens = n % 100;
  const units = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

/** Начало нового мероприятия: следующий целый час, но не позже 22:00. */
export function suggestedStart(nowTime) {
  const hour = Math.min(Math.floor(toMinutes(nowTime) / 60) + 1, 22);
  return fromMinutes(hour * 60);
}
