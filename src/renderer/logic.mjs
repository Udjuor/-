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

/** Учебный день студентов. */
export const STUDY_DAY = { start: '08:30', end: '20:00' };

/**
 * Событие на весь день: отмечено так или вместе с подготовкой и завозом техники
 * перекрывает весь учебный день. Такие события идут полосой над сеткой часов.
 */
export const isAllDay = (event) => event.allDay === true || (busyFrom(event) <= STUDY_DAY.start && event.end >= STUDY_DAY.end);

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
/** Занятие не состоялось: не занимает людей и технику, не идёт в отчёты, питомца и сигналы. */
/** Состоялось и учитывается: не отменено и не ждёт согласования (добавлено с панели). */
export const isHeld = (event) => event.cancelled !== true && event.pending !== true;

/** Подсказки причины, почему занятие не состоялось. Можно написать свою. */
export const CANCEL_REASONS = ['Преподаватель на больничном', 'Перенесено на другой день', 'Замена в расписании', 'Мероприятие колледжа', 'Технические причины'];

export function findConflicts(draft, events, stock = []) {
  const result = [];
  if (!draft.date || !draft.start || !draft.end || draft.start >= draft.end) return result;
  // Ждущие согласования тоже занимают место и технику: иначе их нельзя будет утвердить.
  const others = events.filter((e) => e.id !== draft.id && e.cancelled !== true && overlaps(draft, e)).sort(byTime);
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
    if (event.id === draft.id || event.cancelled === true || !overlaps(draft, event)) continue;
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
  events = events.filter(isHeld);
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
  const items = events.filter((event) => event.deadline && isHeld(event))
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

/** Кто должен принести справку: по студенту, с занятиями в порядке дат. */
export function pendingCertificates(attendance, events) {
  const byId = new Map(events.map((event) => [event.id, event]));
  const people = new Map();
  for (const doc of attendance) {
    const event = byId.get(doc.eventId);
    if (!event || !isHeld(event)) continue;
    for (const [name, mark] of Object.entries(doc.marks ?? {})) {
      if (mark.status !== 'sick' || mark.confirmed !== false) continue;
      if (!people.has(name)) people.set(name, { name, classes: [] });
      people.get(name).classes.push({ event, at: mark.at });
    }
  }
  const list = [...people.values()];
  for (const person of list) person.classes.sort((a, b) => a.event.date.localeCompare(b.event.date) || byTime(a.event, b.event));
  return list.sort((a, b) => a.classes[0].event.date.localeCompare(b.classes[0].event.date) || a.name.localeCompare(b.name, 'ru'));
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
  ['meeting', 'Собрание'],
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
  unmarked: 'Перекличка не проводилась',
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
  // Пару вне колледжа преподаватель отмечает позже: до фиксации отчёта неотмеченные не прогульщики.
  const closed = Boolean(doc?.lock) || (hasEnded(event, nowISO, nowTime) && event.offsite !== true);
  // После фиксации освобождения берутся из отчёта: изменения расписания его не трогают.
  const excused = doc?.lock ? new Map(Object.entries(doc.lock.excused ?? {})) : excusedBy(event, events);
  const names = doc?.lock?.participants ?? event.participants;
  // Пара прошла, а не отмечен никто: перекличку не проводили (панель выключена, журнал на бумаге).
  // Это не прогул всей группы — такая пара ждёт отметок и в баллы и проценты не входит. Отчёт, зафиксированный без отметок, — прогул.
  const untouched = !doc?.lock && !names.some((name) => doc?.marks?.[name]?.status);
  return names.map((name) => {
    const mark = doc?.marks?.[name];
    if (mark?.status) return markedRow(event, name, mark, doc);
    if (excused.has(name)) return { name, status: 'order', at: null, late: 0, excusedFor: excused.get(name) };
    return { name, status: !closed ? 'pending' : untouched ? 'unmarked' : 'absent', at: null, late: 0 };
  });
}

const EXCUSING_TYPES = new Set(['task', 'event', 'practice']);
const EXCUSED_TYPES = new Set(['lesson', 'practice']);

/** Кто освобождён от занятия по приказу: внесён в задание, практику или мероприятие в это же время. */
export function excusedBy(event, events) {
  const excused = new Map();
  if (!EXCUSED_TYPES.has(event.type)) return excused;
  const others = events.filter((other) => other.id !== event.id && other.date === event.date && EXCUSING_TYPES.has(other.type) && isHeld(other)
    && busyFrom(other) < event.end && event.start < other.end);
  for (const name of event.participants) {
    const other = others.find((item) => item.participants.some((person) => nameKey(person) === nameKey(name)));
    if (other) excused.set(name, other.title);
  }
  return excused;
}

// Время прихода считается от фактического начала занятия. Первые 10 минут опозданием не считаются,
// с 10-й по 39-ю это опоздание, с 40-й пропуск.
export const LATE_FROM_MINUTE = 10;
export const ABSENT_FROM_MINUTE = 40;

/** Поля шаблона служебной записки, как их пишут в Word. */
export const TEMPLATE_FIELDS = {
  ru: { memo: ['Мероприятие', 'Дата и время', 'Освобождение', 'Место', 'Ответственный', 'От кого', 'Подпись', 'День', 'Месяц', 'Год'], row: ['№', 'ФИО', 'Группа'] },
  en: { memo: ['Event', 'When', 'Release', 'Place', 'Responsible', 'From', 'Signature', 'Day', 'Month', 'Year'], row: ['No', 'Name', 'Group'] },
};

/** ФВТ-24-1 считается подгруппой, если есть группа ФВТ-24. Отдельная настройка не нужна. */
export function parentGroup(group, groups) {
  const base = String(group.name ?? '').trim().match(/^(.+)-\d+$/)?.[1];
  return base ? groups.find((item) => nameKey(item.name) === nameKey(base)) ?? null : null;
}

/** Студенты группы вместе со студентами её подгрупп, без повторов. */
export function groupMembers(group, groups, students) {
  const included = new Set([group.id, ...groups.filter((item) => parentGroup(item, groups)?.id === group.id).map((item) => item.id)]);
  const people = new Map();
  for (const student of students) {
    if (included.has(student.groupId) && !people.has(nameKey(student.name))) people.set(nameKey(student.name), student);
  }
  return [...people.values()];
}

/** Группа каждого студента. Если он записан и в группе, и в подгруппе, важнее подгруппа. */
function groupsByStudent(students, groups) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const found = new Map();
  for (const student of students) {
    const key = nameKey(student.name);
    const group = byId.get(student.groupId);
    if (!found.has(key) || (group && parentGroup(group, groups))) found.set(key, group ?? null);
  }
  return found;
}

/** Опоздание ставят кнопкой. Старые отметки без этого поля считаются, как раньше. */
function markedRow(event, name, mark, doc) {
  const row = { name, status: mark.status, at: mark.at, late: 0 };
  if (mark.auto === true) row.auto = true;
  // Болезнь без справки предварительная. У старых отметок поля нет: они считаются подтверждёнными.
  if (mark.status === 'sick' && mark.confirmed === false) return { ...row, unconfirmed: true };
  if (mark.status !== 'present') return row;
  if (!countsLateness(event)) return { ...row, marked: true };
  // Отметка поставлена после конца пары — это запись задним числом (по журналу), а не время прихода.
  // Опозданием она становится, только если преподаватель сам отметил «Опоздал» и время прихода.
  if (mark.late !== true && mark.at && new Date(mark.at) > scheduledEnd(event)) return { ...row, marked: true, lateMark: false };
  const minutes = minutesAfterStart(event, doc, mark.at);
  const lateMark = mark.late === true;
  row.marked = true;
  if (minutes >= ABSENT_FROM_MINUTE) return { ...row, status: 'absent', lateMark: true };
  if (minutes >= LATE_FROM_MINUTE) return { ...row, late: minutes, lateMark };
  return { ...row, lateMark };
}

// Only lessons record lateness; events, practice and tasks are present or absent.
export const countsLateness = (event) => event.type === 'lesson';

/** Отметка присутствия ведётся только на занятиях и мероприятиях. Практика и задания — без отметки. */
export const MARKED_TYPES = new Set(['lesson', 'event']);
export const takesAttendance = (event) => MARKED_TYPES.has(event.type);

/** Как часто повторяется событие. */
export const REPEATS = [
  ['day', 'Каждый день'],
  ['weekdays', 'По будням'],
  ['monsat', 'С понедельника по субботу'],
  ['week', 'Каждую неделю'],
  ['2weeks', 'Раз в две недели'],
  ['month', 'Каждый месяц'],
];

export const MAX_REPEATS = 370;

/**
 * Даты цепочки от первой до последней включительно. Месяц без такого числа
 * (31-е в ноябре) пропускается: перенос на другое число путал бы расписание.
 */
export function repeatDates(firstISO, every, untilISO) {
  if (!untilISO || untilISO < firstISO) return [firstISO];
  const dates = [];
  const [y, m, d] = firstISO.split('-').map(Number);
  for (let i = 0; dates.length < MAX_REPEATS; i += 1) {
    let next;
    if (every === 'month') {
      const candidate = new Date(y, m - 1 + i, d);
      if (candidate.getDate() !== d) continue;
      next = toISO(candidate);
    } else {
      const step = { day: 1, weekdays: 1, monsat: 1, week: 7, '2weeks': 14 }[every] ?? 0;
      if (!step) return [firstISO];
      next = addDays(firstISO, i * step);
    }
    if (next > untilISO) break;
    if (every === 'weekdays' && [0, 6].includes(fromISO(next).getDay())) continue;
    if (every === 'monsat' && fromISO(next).getDay() === 0) continue;
    dates.push(next);
  }
  return dates;
}

/** Многодневная практика: первый и последний день, номер дня. Null, если событие одно. */
export function practiceSpan(event, events) {
  if (event.type !== 'practice' || !event.seriesId) return null;
  const days = events.filter((other) => other.seriesId === event.seriesId).map((other) => other.date).sort();
  if (days.length < 2) return null;
  return { from: days[0], to: days.at(-1), day: days.indexOf(event.date) + 1, days: days.length };
}

/** События цепочки с этой даты и дальше, по порядку. */
export const seriesFrom = (event, events) => (event.seriesId
  ? events.filter((other) => other.seriesId === event.seriesId && other.date >= event.date).sort((a, b) => a.date.localeCompare(b.date))
  : [event]);

/** Начало занятия по расписанию как дата. */
function scheduledStart(event) {
  const [y, m, d] = event.date.split('-').map(Number);
  return new Date(y, m - 1, d, ...event.start.split(':').map(Number));
}

/**
 * Фактическое начало: когда нажали «Начать занятие». Раньше расписания занятие не начинается:
 * пришедший к началу по расписанию не опоздал, даже если преподаватель начал раньше.
 */
export function actualStart(event, doc) {
  const scheduled = scheduledStart(event);
  const pressed = doc?.start?.at ? new Date(doc.start.at) : null;
  return pressed && pressed > scheduled ? pressed : scheduled;
}

/** Задержка начала занятия в минутах. */
export const startDelay = (event, doc) => Math.floor((actualStart(event, doc) - scheduledStart(event)) / 60000);

const minutesAfterStart = (event, doc, at) => Math.max(0, Math.floor((new Date(at) - actualStart(event, doc)) / 60000));

/** Начать занятие можно за 30 минут до расписания и до 40-й минуты: так же проверяет хранилище. */
export const START_EARLY_MINUTES = 30;

/** Пара закончилась по расписанию: отметки после этого — запись задним числом. */
export const lessonOver = (event, nowMs) => nowMs > scheduledEnd(event).getTime();

const scheduledEnd = (event) => {
  const [y, m, d] = event.date.split('-').map(Number);
  return new Date(y, m - 1, d, ...event.end.split(':').map(Number));
};

/**
 * Какой экран отметки показать преподавателю:
 * start — занятие пора начинать, первым делом кнопка «Начать занятие»;
 * call — занятие начато, идёт перекличка: все, кто на месте, отмечаются приходом к началу;
 * live — перекличка закончена, опоздавших отмечают по факту прихода;
 * list — обычный список: не занятие, не время, отменено или отчёт закрыт.
 */
export function rollStage(event, doc, nowMs, callDone = false) {
  if (!countsLateness(event) || !isHeld(event) || doc?.lock || !event.participants.length) return 'list';
  const scheduled = scheduledStart(event).getTime();
  if (!doc?.start) {
    const open = nowMs >= scheduled - START_EARLY_MINUTES * 60_000 && nowMs <= scheduled + ABSENT_FROM_MINUTE * 60_000;
    return open ? 'start' : 'list';
  }
  if (nowMs > scheduledEnd(event).getTime()) return 'list';
  const minutes = (nowMs - actualStart(event, doc).getTime()) / 60_000;
  return !callDone && minutes < ABSENT_FROM_MINUTE ? 'call' : 'live';
}

/** Открывать ли занятие сразу на отметке, а не карточкой: сегодня, от 30 минут до начала и до конца. */
export function lessonIsNow(event, doc, nowMs) {
  if (!countsLateness(event) || !isHeld(event) || doc?.lock || !event.participants.length) return false;
  return nowMs >= scheduledStart(event).getTime() - START_EARLY_MINUTES * 60_000 && nowMs <= scheduledEnd(event).getTime();
}

/** Что запишется, если студент войдёт сейчас: вовремя, опоздание или пропуск, и на сколько минут. */
export function arrivalNow(event, doc, nowISO) {
  const minutes = minutesAfterStart(event, doc, nowISO);
  return { minutes, verdict: minutes >= ABSENT_FROM_MINUTE ? 'absent' : minutes >= LATE_FROM_MINUTE ? 'late' : 'ontime' };
}

/** Счётчики по списку отметок. Посещаемость считается от всех, кто должен был прийти. */
function tally(all) {
  // Пары без переклички в проценты не входят, их число показывается отдельно.
  const rows = all.filter((row) => row.status !== 'unmarked');
  const count = (status) => rows.filter((row) => row.status === status).length;
  const present = count('present');
  return {
    unmarked: all.length - rows.length,
    total: rows.length,
    present,
    late: rows.filter((row) => row.late > 0).length,
    sick: count('sick'),
    noCertificate: rows.filter((row) => row.unconfirmed).length,
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
  const studentGroups = groupsByStudent(students, groups);
  const groupOf = new Map([...studentGroups].map(([key, group]) => [key, group?.name ?? '']));
  const docs = new Map(attendance.map((doc) => [doc.eventId, doc]));
  // Выбранная группа включает свои подгруппы.
  const inGroup = (name) => {
    if (!filters.group) return true;
    const group = studentGroups.get(nameKey(name));
    return group?.name === filters.group || (group && parentGroup(group, groups)?.name === filters.group);
  };

  const pairs = [];
  const byStudent = new Map();
  const held = events
    .filter((event) => hasEnded(event, nowISO, nowTime) && isHeld(event) && takesAttendance(event)
      && event.date >= filters.from && event.date <= filters.to
      && filters.types.includes(event.type)
      && (!filters.teacher || event.responsible === filters.teacher))
    .sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));

  for (const event of held) {
    const roster = rollCall(event, docs.get(event.id), nowISO, nowTime, events).filter((row) => inGroup(row.name));
    if (filters.group && !roster.length) continue;
    const eventGroups = [...new Set(event.participants.map((name) => groupOf.get(nameKey(name))).filter(Boolean))].sort();
    const doc = docs.get(event.id);
    pairs.push({ event, groups: eventGroups, locked: doc?.lock ?? null, startedAt: doc?.start?.at ?? null, delay: startDelay(event, doc), ...tally(roster) });
    for (const row of roster) {
      const key = nameKey(row.name);
      if (!byStudent.has(key)) byStudent.set(key, { name: row.name, group: groupOf.get(key) ?? '', rows: [] });
      byStudent.get(key).rows.push({ ...row, date: event.date });
    }
  }

  const studentRows = [...byStudent.values()]
    .map(({ name, group, rows }) => ({ name, group, ...tally(rows) }))
    .sort((a, b) => a.group.localeCompare(b.group, 'ru') || a.name.localeCompare(b.name, 'ru'));

  const byGroup = new Map();
  for (const student of byStudent.values()) {
    const name = student.group || 'Без группы';
    const group = groups.find((item) => item.name === name);
    for (const title of [name, group && parentGroup(group, groups)?.name].filter(Boolean)) {
      if (!byGroup.has(title)) byGroup.set(title, []);
      byGroup.get(title).push(...student.rows);
    }
  }
  const groupRows = [...byGroup].map(([name, rows]) => ({ name, ...tally(rows) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  return { pairs, students: studentRows, groups: groupRows, ...latenessReport(byStudent.values()) };
}

/** День недели: понедельник 1, воскресенье 7. */
export const weekdayOf = (iso) => fromISO(iso).getDay() || 7;

/**
 * Кто чаще опаздывает и в какие дни недели. Опоздание — пришёл с 10-й по 39-ю минуту;
 * пришедший с 40-й минуты считается пропуском, но тоже виден отдельной колонкой.
 */
function latenessReport(students) {
  const days = [0, 0, 0, 0, 0, 0, 0];
  const lateness = [];
  for (const { name, group, rows } of students) {
    const late = rows.filter((row) => row.late > 0);
    const tooLate = rows.filter((row) => row.status === 'absent' && row.lateMark).length;
    if (!late.length && !tooLate) continue;
    const byWeekday = [0, 0, 0, 0, 0, 0, 0];
    for (const row of late) byWeekday[weekdayOf(row.date) - 1] += 1;
    byWeekday.forEach((n, i) => { days[i] += n; });
    const minutes = late.reduce((sum, row) => sum + row.late, 0);
    const most = Math.max(...byWeekday);
    lateness.push({
      name,
      group,
      late: late.length,
      minutes,
      average: late.length ? Math.round(minutes / late.length) : 0,
      tooLate,
      byWeekday,
      // Дни, когда опозданий больше всего; при равенстве — все такие дни.
      worstDays: most ? byWeekday.map((n, i) => (n === most ? i + 1 : 0)).filter(Boolean) : [],
      last: late.map((row) => row.date).sort().at(-1) ?? null,
    });
  }
  lateness.sort((a, b) => b.late - a.late || b.minutes - a.minutes || a.name.localeCompare(b.name, 'ru'));
  return { lateness, latenessByWeekday: days };
}

/** CSV для Excel: точка с запятой и метка кодировки, чтобы кириллица открылась верно. */
export function toCsv(header, rows) {
  const cell = (value) => {
    let text = String(value ?? '');
    // Текст, который Excel принял бы за формулу (=, +, @, «-» не перед числом), открывается как текст:
    // названия и имена могут ввести студенты на панелях.
    if (typeof value !== 'number' && /^(?:[=+@\t\r]|-(?!\d+(?:[.,]\d+)?$))/.test(text)) text = `'${text}`;
    return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `\uFEFF${[header, ...rows].map((row) => row.map(cell).join(';')).join('\r\n')}\r\n`;
}

const memoFields = (event) => [
  event.title, event.date, event.start, event.end, event.prepMinutes ?? 0, event.place, event.responsible, ...event.participants,
];

/** Записка нужна всем, кроме обычных занятий, если есть кого освобождать. */
/** Собрание проходит вне занятий: служебная записка об освобождении ему не нужна. */
export const memoApplies = (event) => !NO_MEMO_TYPES.has(event.type) && event.participants.length > 0;
const NO_MEMO_TYPES = new Set(['lesson', 'meeting']);

/** Роли студентов (оператор, ведущий) назначаются на задания, практику и мероприятия. */
export const ROLE_TYPES = ['practice', 'task', 'event'];
export const hasRoles = (event) => ROLE_TYPES.includes(event.type);

/** Роль участника в событии или пустая строка. Имя сравнивается без учёта регистра и «ё». */
export function roleOf(event, name) {
  const key = nameKey(name);
  for (const [who, role] of Object.entries(event.roles ?? {})) if (nameKey(who) === key) return role;
  return '';
}

/** Техническое задание бывает у мероприятий, практики и заданий; у занятий и собраний его нет. */
export const PAPER_TYPES = ['practice', 'task', 'event'];
export const hasPaper = (event) => PAPER_TYPES.includes(event.type);

/** Новая записка нужна, если изменилось то, что в ней написано. */
export function needsMemo(saved, previous) {
  if (!memoApplies(saved)) return false;
  return !previous?.id || JSON.stringify(memoFields(saved)) !== JSON.stringify(memoFields(previous));
}

/** Значения для шаблона служебной записки. */
export function memoData(event, students, groups, todayISO) {
  // В документе пишется основная группа, а не подгруппа.
  const groupOf = new Map([...groupsByStudent(students, groups)].map(([key, group]) => [key, group ? (parentGroup(group, groups) ?? group).name : '']));
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

/** Подписи полей и действий в журнале изменений событий. */
export const JOURNAL_FIELD_LABELS = {
  title: 'Название',
  type: 'Вид',
  date: 'Дата',
  start: 'Начало',
  end: 'Конец',
  allDay: 'Весь день',
  offsite: 'Вне колледжа',
  cancelled: 'Не состоялось',
  cancelReason: 'Причина отмены',
  place: 'Место',
  responsible: 'Ответственный',
  participants: 'Участники',
  equipment: 'Техника',
  equipmentQty: 'Количество техники',
  ownCameras: 'Свои камеры',
  prepMinutes: 'Подготовка',
  notes: 'Примечания',
  deadline: 'Срок сдачи',
  deadlineDone: 'Сдано',
  devices: 'Устройства',
  roles: 'Роли',
  handIn: 'Сдача по студентам',
  decisions: 'Решения и поручения',
};

export const JOURNAL_ACTIONS = {
  create: 'Добавлено',
  edit: 'Изменено',
  delete: 'Удалено',
  'create-series': 'Добавлена цепочка',
  'delete-range': 'Удалены события за период',
  restore: 'Восстановлено из копии',
  approve: 'Согласовано',
  decline: 'Отклонено',
};

/* Ранний сигнал для кураторов */

/** Пропуски без причины подряд, после которых куратору стоит вмешаться. */
export const SIGNAL_STREAK = 3;
/** За последние 7 дней: столько пропусков без причины или опозданий — повод поговорить. */
export const SIGNAL_ABSENT_WEEK = 4;
export const SIGNAL_LATE_WEEK = 3;
const SIGNAL_DAYS = 14;

/**
 * Студенты, у которых в последние две недели копятся пропуски или опоздания.
 * since — когда куратор в последний раз нажал «Разобрались»: раньше этого не считается.
 */
export function earlySignals({ events, attendance, students, groups, nowISO, nowTime }) {
  const docOf = new Map(attendance.map((doc) => [doc.eventId, doc]));
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const weekFrom = addDays(nowISO, -6);
  const from = addDays(nowISO, -(SIGNAL_DAYS - 1));
  const held = events
    .filter((event) => event.date >= from && isHeld(event) && takesAttendance(event) && hasEnded(event, nowISO, nowTime) && docOf.get(event.id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const rowsOf = new Map();
  for (const event of held) {
    for (const row of rollCall(event, docOf.get(event.id), nowISO, nowTime, events)) {
      const key = nameKey(row.name);
      if (!rowsOf.has(key)) rowsOf.set(key, []);
      rowsOf.get(key).push({ ...row, date: event.date, end: event.end });
    }
  }
  const signals = [];
  for (const student of students) {
    const since = student.signalSince ?? '';
    const rows = (rowsOf.get(nameKey(student.name)) ?? []).filter((row) => !since || `${row.date}T${row.end}` > localMoment(since));
    let streak = 0;
    let longest = 0;
    for (const row of rows) {
      if (row.status === 'absent') longest = Math.max(longest, ++streak);
      else if (row.status === 'present') streak = 0;
    }
    const week = rows.filter((row) => row.date >= weekFrom);
    const absentWeek = week.filter((row) => row.status === 'absent').length;
    const lateWeek = week.filter((row) => row.status === 'present' && row.late > 0).length;
    const reasons = [];
    if (longest >= SIGNAL_STREAK) reasons.push({ kind: 'streak', count: longest });
    if (absentWeek >= SIGNAL_ABSENT_WEEK) reasons.push({ kind: 'absentWeek', count: absentWeek });
    if (lateWeek >= SIGNAL_LATE_WEEK) reasons.push({ kind: 'lateWeek', count: lateWeek });
    if (!reasons.length) continue;
    signals.push({ id: student.id, name: student.name, group: groupName.get(student.groupId) ?? '', reasons, last: rows.at(-1)?.date ?? null, weight: longest * 2 + absentWeek * 2 + lateWeek });
  }
  return signals.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name, 'ru'));
}

/** Момент «ГГГГ-ММ-ДДTЧЧ:ММ» по местному времени из отметки ISO. */
function localMoment(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* Портфолио студента */

const PORTFOLIO_TYPES = ['event', 'task', 'practice'];

/**
 * Участие студента в мероприятиях, заданиях и практике плюс достижения, внесённые вручную.
 * Где велась отметка, считается только пришедший; без отметки — по списку участников.
 */
export function portfolio({ name, events, attendance, achievements, nowISO, nowTime }) {
  const key = nameKey(name);
  const docOf = new Map(attendance.map((doc) => [doc.eventId, doc]));
  const items = events
    .filter((event) => PORTFOLIO_TYPES.includes(event.type) && isHeld(event) && event.date <= nowISO && event.participants.some((p) => nameKey(p) === key))
    .filter((event) => {
      if (!hasEnded(event, nowISO, nowTime)) return false;
      const doc = docOf.get(event.id);
      if (!doc) return true;
      const row = rollCall(event, doc, nowISO, nowTime, events).find((r) => nameKey(r.name) === key);
      return row && ['present', 'order'].includes(row.status);
    })
    .map((event) => ({ id: event.id, date: event.date, type: event.type, title: event.title, role: roleOf(event, name), place: event.place ?? '', responsible: event.responsible ?? '' }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const awards = achievements
    .filter((item) => nameKey(item.student) === key)
    .sort((a, b) => b.date.localeCompare(a.date));
  const counts = Object.fromEntries(PORTFOLIO_TYPES.map((type) => [type, items.filter((item) => item.type === type).length]));
  return { items, awards, counts };
}

/* Сдача по студентам */

/** Статусы сдачи у одного студента. Нет записи — не сдал. */
export const HAND_IN_STATES = ['done', 'rework', 'missing'];

export function handInOf(event, name) {
  const key = nameKey(name);
  for (const [who, status] of Object.entries(event.handIn ?? {})) if (nameKey(who) === key) return status;
  return 'missing';
}

/** Сколько участников сдали, на доработке и не сдали. */
export function handInSummary(event) {
  const summary = { done: 0, rework: 0, missing: 0, total: event.participants.length };
  for (const name of event.participants) summary[handInOf(event, name)] += 1;
  return summary;
}


/** Должники: студенты, у которых срок задания прошёл, а работа не сдана. Больше долгов — выше в списке. */
export function debtors(events, moment) {
  const people = new Map();
  for (const event of events) {
    if (event.type !== 'task' || !event.deadline || !isHeld(event) || event.deadlineDone || event.deadline > moment) continue;
    for (const name of event.participants) {
      if (handInOf(event, name) === 'done') continue;
      const key = nameKey(name);
      if (!people.has(key)) people.set(key, { name, items: [] });
      people.get(key).items.push({ event, status: handInOf(event, name) });
    }
  }
  return [...people.values()]
    .map((person) => ({ ...person, items: person.items.sort((a, b) => a.event.deadline.localeCompare(b.event.deadline)) }))
    .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name, 'ru'));
}

/* Итоги по ролям */

/** Кто сколько раз и в какой роли участвовал. Только состоявшиеся события до указанного дня. */
export function roleStats(events, untilISO, fromISO = '') {
  const people = new Map();
  const roles = new Set();
  for (const event of events) {
    if (!isHeld(event) || event.date > untilISO || (fromISO && event.date < fromISO)) continue;
    for (const [name, role] of Object.entries(event.roles ?? {})) {
      const key = nameKey(name);
      if (!people.has(key)) people.set(key, { name, roles: {}, total: 0 });
      const person = people.get(key);
      person.roles[role] = (person.roles[role] ?? 0) + 1;
      person.total += 1;
      roles.add(role);
    }
  }
  return {
    roles: [...roles].sort((a, b) => a.localeCompare(b, 'ru')),
    people: [...people.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ru')),
  };
}

/* Поручения собраний */

/** Невыполненные поручения со всех собраний: просроченные, на неделе, позже. */
export function decisionList(events, todayISO) {
  const items = [];
  for (const event of events) {
    if (event.type !== 'meeting' || !isHeld(event)) continue;
    for (const item of event.decisions ?? []) {
      if (item.done) continue;
      const state = !item.due ? 'later' : item.due < todayISO ? 'overdue' : item.due <= addDays(todayISO, 7) ? 'soon' : 'later';
      items.push({ event, item, state });
    }
  }
  const order = { overdue: 0, soon: 1, later: 2 };
  return items.sort((a, b) => order[a.state] - order[b.state] || (a.item.due || '9999').localeCompare(b.item.due || '9999'));
}


/* Недельная сводка для учебной части */


/**
 * Сводка за неделю одним файлом для Excel: посещаемость по группам, пропуски без причины,
 * кто должен справку и кто не сдал работы в срок.
 */
export function weeklySummaryCsv({ events, attendance, students, groups, from, to, nowISO, nowTime, labels }) {
  const report = buildReport({ events, attendance, students, groups, filters: { from, to, types: [...MARKED_TYPES] }, nowISO, nowTime });
  const certificates = pendingCertificates(attendance, events);
  const debts = debtors(events, `${nowISO}T${nowTime}`);
  const L = labels;
  const blank = [];
  const rows = [
    [L.title],
    blank,
    [L.groups],
    L.groupHeader,
    ...report.groups.map((g) => [g.name, g.total, g.present, g.late, g.absent, g.sick, g.noCertificate, g.order, g.excused, g.percent ?? '']),
    blank,
    [L.absent],
    L.absentHeader,
    ...report.students.filter((s) => s.absent > 0 || s.late > 0)
      .sort((a, b) => b.absent - a.absent || b.late - a.late || a.name.localeCompare(b.name, 'ru'))
      .map((s) => [s.name, s.group, s.absent, s.late, s.total]),
    blank,
    [L.certificates],
    L.certificatesHeader,
    ...certificates.map((person) => [person.name, person.classes.length, person.classes[0]?.event.date ?? '']),
    blank,
    [L.debts],
    L.debtsHeader,
    ...debts.map((person) => [person.name, person.items.length, person.items.map(({ event }) => event.title).join('; ')]),
  ];
  const width = Math.max(...rows.map((row) => row.length));
  return toCsv(rows[0].concat(Array(width - 1).fill('')), rows.slice(1));
}

/* Дни рождения */

/** Дата рождения из текста: 12.03.2007, 2.3.07 или 2007-03-12. Неверная дата — пустая строка. */
export function parseBirthday(text) {
  const value = String(text ?? '').trim();
  let y;
  let m;
  let d;
  let match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) [, y, m, d] = match.map(Number);
  else if ((match = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/))) {
    [, d, m, y] = match.map(Number);
    if (y < 100) y += y > 30 ? 1900 : 2000;
  } else return '';
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d || y < 1920) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Список людей из вставленного текста: в строке имя и, по желанию, дата рождения в конце,
 * через табуляцию или пробел. Так можно вставить два столбца из Excel.
 */
export function splitPeople(text) {
  return String(text ?? '').split(/[\r\n;]+/).map((line) => {
    const cells = line.split('\t').map((cell) => cell.trim()).filter(Boolean);
    let birthday = cells.length > 1 ? parseBirthday(cells.at(-1)) : '';
    let name = birthday ? cells.slice(0, -1).join(' ') : cells.join(' ');
    if (!birthday) {
      const tail = name.match(/^(.*\S)\s+(\S+)$/);
      if (tail && parseBirthday(tail[2])) {
        name = tail[1];
        birthday = parseBirthday(tail[2]);
      }
    }
    return { name: name.replace(/\s+/g, ' ').trim(), birthday };
  }).filter((person) => person.name);
}

/**
 * Как обращаться в поздравлении: студента «Фамилия Имя» — «Имя Фамилия»,
 * преподавателя «Фамилия Имя Отчество» — по имени и отчеству. С инициалами — как записано.
 */
export function greetingName(name, kind = 'student') {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length < 2 || parts.slice(1).some((part) => /\./.test(part) || /^\p{Lu}$/u.test(part))) return parts.join(' ');
  if (kind === 'teacher' && parts.length >= 3) return parts.slice(1, 3).join(' ');
  return `${parts[1]} ${parts[0]}`;
}

const leap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** День рождения в этом году: 29 февраля в невисокосный год празднуется 28-го. */
function birthdayThisYear(birthday, year) {
  const md = birthday.slice(5);
  return `${year}-${md === '02-29' && !leap(year) ? '02-28' : md}`;
}

/**
 * Кого поздравить сегодня. В понедельник — ещё и тех, у кого день рождения был в выходные.
 * Возвращает { id, name, late } без возраста: возраст на панели не показывается.
 */
export function birthdaysOn(refs, iso) {
  const days = [iso];
  if (weekdayOf(iso) === 1) days.push(addDays(iso, -1), addDays(iso, -2));
  const people = [];
  for (const ref of refs) {
    if (!['student', 'teacher'].includes(ref.kind) || ref.deleted || !/^\d{4}-\d{2}-\d{2}$/.test(ref.birthday ?? '')) continue;
    const day = days.find((d) => birthdayThisYear(ref.birthday, Number(d.slice(0, 4))) === d);
    if (day) people.push({ id: ref.id, name: greetingName(ref.name, ref.kind), late: day !== iso });
  }
  return people.sort((a, b) => Number(a.late) - Number(b.late) || a.name.localeCompare(b.name, 'ru'));
}

/** Выбор поздравления: у человека в этот день всегда одно и то же, у разных людей — разные. */
export function pickGreeting(name, iso, count) {
  let hash = 0;
  for (const char of `${name}|${iso}`) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % count;
}

/* Расписание группы на неделю */

/** События группы (хотя бы один её студент участвует) с понедельника по субботу, по дням. */
export function groupWeek({ events, group, groups, students, monday }) {
  const members = new Set(groupMembers(group, groups, students).map((student) => nameKey(student.name)));
  const days = Array.from({ length: 6 }, (_, i) => ({ date: addDays(monday, i), events: [] }));
  for (const event of events) {
    const day = days.find((d) => d.date === event.date);
    if (day && event.pending !== true && event.participants.some((name) => members.has(nameKey(name)))) day.events.push(event);
  }
  for (const day of days) day.events.sort(byTime);
  return days;
}

/* Табло перемены на панели */

/** Что показать на панели между парами: ближайшее событие сегодня или в ближайшие дни. Во время пары — ничего. */
export function breakBoard(events, nowISO, nowTime) {
  const held = events.filter(isHeld).sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));
  const today = held.filter((event) => event.date === nowISO && !event.allDay);
  if (today.some((event) => event.start <= nowTime && event.end > nowTime)) return null;
  const next = today.find((event) => event.start > nowTime);
  if (next) return { next, minutes: toMinutes(next.start) - toMinutes(nowTime), today: true };
  const later = held.find((event) => event.date > nowISO && event.date <= addDays(nowISO, 3) && !event.allDay);
  return later ? { next: later, minutes: null, today: false } : { next: null, minutes: null, today: false };
}

/* Лучшая группа месяца */

/** Посещаемость без учёта уважительных причин: пришли из тех, кто должен был прийти. */
const presentShare = (row) => (row.present + row.absent ? row.present / (row.present + row.absent) : null);

/** Лучшие группы за период: только конечные группы (без подгрупп) и с достаточным числом отметок. */
export function groupRanking({ events, attendance, students, groups, from, to, nowISO, nowTime, minMarks = 20 }) {
  const report = buildReport({ events, attendance, students, groups, filters: { from, to, types: [...MARKED_TYPES] }, nowISO, nowTime });
  const parents = new Set(groups.map((group) => parentGroup(group, groups)?.name).filter(Boolean));
  return report.groups
    .filter((row) => !parents.has(row.name) && groups.some((group) => group.name === row.name) && row.present + row.absent >= minMarks)
    .map((row) => ({ name: row.name, share: presentShare(row), marks: row.present + row.absent }))
    .sort((a, b) => b.share - a.share || b.marks - a.marks || a.name.localeCompare(b.name, 'ru'));
}

/** Ниже этой посещаемости лучшую группу не объявляем: хвалить не за что. */
export const BEST_GROUP_MIN = 75;

/** Лучшая группа прошлого месяца: объявляется первую неделю нового месяца. */
export function bestGroupOfMonth({ events, attendance, students, groups, nowISO, nowTime }) {
  if (Number(nowISO.slice(8, 10)) > 7) return null;
  const firstOfThis = `${nowISO.slice(0, 7)}-01`;
  const from = `${addDays(firstOfThis, -1).slice(0, 7)}-01`;
  const to = addDays(firstOfThis, -1);
  const [best] = groupRanking({ events, attendance, students, groups, from, to, nowISO, nowTime });
  if (!best || best.share * 100 < BEST_GROUP_MIN) return null;
  return { ...best, month: from.slice(0, 7), percent: Math.round(best.share * 100) };
}

/* Летопись года */

/** Начало учебного года: 1 сентября того же или прошлого года. */
export const schoolYearOf = (iso) => (iso.slice(5) >= '09-01' ? Number(iso.slice(0, 4)) : Number(iso.slice(0, 4)) - 1);

/** Итоги учебного года: что прошло, кто участвовал, кто в каких ролях, лучшие группы и достижения. */
export function yearChronicle({ events, attendance, students, groups, achievements, year, nowISO, nowTime, bonuses = [], pastWorks = [] }) {
  const from = `${year}-09-01`;
  const to = `${year + 1}-08-31`;
  const until = nowISO < to ? nowISO : to;
  const held = events.filter((event) => isHeld(event) && event.date >= from && event.date <= until && hasEnded(event, nowISO, nowTime));
  const counts = Object.fromEntries(EVENT_TYPES.map(([type]) => [type, held.filter((event) => event.type === type).length]));
  const marked = groupRanking({ events, attendance, students, groups, from, to: until, nowISO, nowTime, minMarks: 1 });
  const totals = marked.reduce((sum, row) => ({ present: sum.present + row.share * row.marks, marks: sum.marks + row.marks }), { present: 0, marks: 0 });

  // Кто чаще всех участвовал в заданиях, практике и мероприятиях и в каких ролях.
  const groupOf = new Map([...groupsByStudent(students, groups)].map(([key, group]) => [key, group?.name ?? '']));
  const people = new Map();
  for (const event of held.filter((item) => PORTFOLIO_TYPES.includes(item.type))) {
    for (const name of event.participants) {
      const key = nameKey(name);
      if (!people.has(key)) people.set(key, { name, group: groupOf.get(key) ?? '', count: 0, roles: {} });
      const person = people.get(key);
      person.count += 1;
      const role = roleOf(event, name);
      if (role) person.roles[role] = (person.roles[role] ?? 0) + 1;
    }
  }
  const active = [...people.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru')).slice(0, 10);

  // Кто чаще всех был в каждой роли (по прошедшим событиям, как и активность).
  const roles = [...new Set([...people.values()].flatMap((person) => Object.keys(person.roles)))].sort((a, b) => a.localeCompare(b, 'ru'));
  const roleLeaders = roles.map((role) => {
    const [leader] = [...people.values()].filter((person) => person.roles[role]).sort((a, b) => b.roles[role] - a.roles[role] || a.name.localeCompare(b.name, 'ru'));
    return { role, name: leader.name, count: leader.roles[role] };
  });

  // Лучшая группа каждого месяца.
  const months = [];
  for (let month = from; month <= until; month = `${addDays(`${month.slice(0, 7)}-28`, 7).slice(0, 7)}-01`) {
    const end = addDays(`${addDays(`${month.slice(0, 7)}-28`, 7).slice(0, 7)}-01`, -1);
    const [best] = groupRanking({ events, attendance, students, groups, from: month, to: end < until ? end : until, nowISO, nowTime });
    if (best) months.push({ month: month.slice(0, 7), name: best.name, percent: Math.round(best.share * 100) });
  }

  return {
    from,
    to: until,
    counts,
    attendance: totals.marks ? Math.round((totals.present / totals.marks) * 100) : null,
    events: held.filter((event) => event.type === 'event').sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b))
      .map((event) => ({ date: event.date, title: event.title, people: event.participants.length, responsible: event.responsible ?? '' })),
    active,
    roleLeaders,
    groups: groupRanking({ events, attendance, students, groups, from, to: until, nowISO, nowTime, minMarks: 50 }).slice(0, 5)
      .map((row) => ({ name: row.name, percent: Math.round(row.share * 100), marks: row.marks })),
    months,
    awards: achievements.filter((item) => item.date >= from && item.date <= until).sort((a, b) => a.date.localeCompare(b.date)),
    // Лучшие по грейду за год: сумма баллов обоих семестров.
    grades: [{ from, to: `${year + 1}-01-31` }, { from: `${year + 1}-02-01`, to }]
      .flatMap((semester) => (semester.from <= until ? gradeReport({ events, attendance, students, groups, ...semester, nowISO, nowTime, bonuses, pastWorks }) : []))
      .reduce((all, row) => {
        const found = all.find((item) => item.name === row.name);
        if (found) found.points += row.points;
        else all.push({ name: row.name, group: row.group, points: row.points });
        return all;
      }, [])
      .filter((row) => row.points > 0)
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'ru'))
      .slice(0, 10),
  };
}

/* Грейд студента: баллы за семестр и звание */

/** Баллы. День считается целиком: прогул в этот день −4, опоздание −2 (и +1 за то, что пришёл), иначе +1. */
export const GRADE_POINTS = { day: 1, absent: -4, late: -2, task: 3, taskMissed: -2, event: 5, role: 2, practice: 2 };
/** Болезнь без справки становится пропуском, если справку не принесли за неделю. */
// Справку о болезни ждут месяц; не принесли — пропуск без причины.
export const CERTIFICATE_DAYS = 30;
/**
 * Рейтинг — один непрерывный счёт с первого курса до выпуска, без сброса по семестрам.
 * Учёт в Kerdiis начат 1 сентября 2026 года: с этой даты считаются все курсы.
 */
export const RATING_FROM = '2026-09-01';
/**
 * Достижения до начала учёта (хакатоны, практики прошлых курсов) преподаватель вносит задним числом:
 * «Прошлые работы» и поощрения. Они засчитываются с любой даты обучения, но только плюсы —
 * минусы за время до начала учёта не ставятся (обратной силы нет).
 */
export const RETRO_FROM = '2000-01-01';
/** Период рейтинга: автоматический учёт с начала учёта, внесённое задним числом — с любой даты. */
export const ratingPeriod = (iso) => ({ from: RATING_FROM, to: iso, retroFrom: RETRO_FROM });

/**
 * Звания и сколько баллов за всё обучение для них нужно. Хороший студент набирает
 * около 120–150 баллов за семестр: после первого семестра — Junior+, к выпуску — Lead или Principal.
 */
export const GRADE_LEVELS = [
  { name: 'Intern', from: 0 },
  { name: 'Junior', from: 60 },
  { name: 'Junior+', from: 150 },
  { name: 'Middle', from: 280 },
  { name: 'Middle+', from: 430 },
  { name: 'Senior', from: 600 },
  { name: 'Lead', from: 800 },
  { name: 'Principal', from: 1000 },
];

/** Семестр, в который входит день: с 1 сентября по 31 января и с 1 февраля по 31 августа. */
export function semesterOf(iso) {
  const year = Number(iso.slice(0, 4));
  const md = iso.slice(5);
  if (md >= '09-01') return { from: `${year}-09-01`, to: `${year + 1}-01-31` };
  if (md <= '01-31') return { from: `${year - 1}-09-01`, to: `${year}-01-31` };
  return { from: `${year}-02-01`, to: `${year}-08-31` };
}

/** Виды прошлых работ, которые вносятся задним числом. */
export const PAST_WORK_TYPES = ['task', 'practice', 'event'];

/**
 * Баллы за прошлую работу: задание — сдавшим, и минус не сдавшим, если их внесли;
 * практика — участникам; мероприятие — бывшим, и ещё за роль.
 */
export function pastWorkChanges(work) {
  const has = (list, name) => list.some((item) => nameKey(item) === nameKey(name));
  const changes = [];
  if (work.work === 'task') {
    for (const name of work.students) changes.push({ name, kind: 'task' });
    for (const name of work.missed ?? []) if (!has(work.students, name)) changes.push({ name, kind: 'taskMissed' });
  } else if (work.work === 'practice') {
    for (const name of work.students) changes.push({ name, kind: 'practice' });
  } else if (work.work === 'event') {
    for (const name of work.students) {
      changes.push({ name, kind: 'event' });
      if (has(work.roles ?? [], name)) changes.push({ name, kind: 'role' });
    }
  }
  return changes;
}

/** Роль студента в прошлой работе или хакатоне, если она названа. */
function roleNameOf(work, name) {
  for (const [who, role] of Object.entries(work.roleNames ?? {})) if (nameKey(who) === nameKey(name)) return role;
  return '';
}

export const gradeLevel = (points) => [...GRADE_LEVELS].reverse().find((level) => points >= level.from);

/**
 * Баллы каждого студента за период. Возвращает строки с баллами, званием, разбивкой
 * и днями, когда студент получил каждое новое звание (для поздравления в бегущей строке).
 */
export function gradeReport({ events, attendance, students, groups, from, to, nowISO, nowTime, bonuses = [], pastWorks = [], retroFrom = from }) {
  const docs = new Map(attendance.map((doc) => [doc.eventId, doc]));
  const groupOf = new Map([...groupsByStudent(students, groups)].map(([key, group]) => [key, group?.name ?? '']));
  const people = new Map(students.map((student) => [nameKey(student.name), {
    name: student.name, group: groupOf.get(nameKey(student.name)) ?? '', changes: [], days: new Map(),
  }]));
  // detail — за что именно: название события, причина ручных баллов, пары дня (для расчёта баллов по дням).
  const add = (name, date, kind, points, detail = {}) => people.get(nameKey(name))?.changes.push({ date, kind, points, ...detail });
  const until = nowISO < to ? nowISO : to;
  const held = events.filter((event) => isHeld(event) && event.date >= from && event.date <= until && hasEnded(event, nowISO, nowTime));

  for (const event of held) {
    if (event.type === 'lesson') {
      for (const row of rollCall(event, docs.get(event.id), nowISO, nowTime, events)) {
        const person = people.get(nameKey(row.name));
        if (!person) continue;
        if (!person.days.has(event.date)) person.days.set(event.date, { present: false, late: false, absent: false, presentAt: [], lateAt: [], absentAt: [] });
        const day = person.days.get(event.date);
        const lesson = { title: event.title, start: event.start };
        const overdueCertificate = row.status === 'sick' && row.unconfirmed && addDays(event.date, CERTIFICATE_DAYS) < nowISO;
        if (row.status === 'absent' || overdueCertificate) {
          day.absent = true;
          day.absentAt.push({ ...lesson, certificate: overdueCertificate, late: row.lateMark ? row.late : 0 });
        } else if (row.status === 'present') {
          day.present = true;
          day.presentAt.push(lesson);
          if (row.late > 0) {
            day.late = true;
            day.lateAt.push({ ...lesson, late: row.late });
          }
        }
      }
    } else if (event.type === 'event' && takesAttendance(event)) {
      for (const row of rollCall(event, docs.get(event.id), nowISO, nowTime, events)) {
        if (row.status !== 'present') continue;
        add(row.name, event.date, 'event', GRADE_POINTS.event, { title: event.title });
        if (roleOf(event, row.name)) add(row.name, event.date, 'role', GRADE_POINTS.role, { title: event.title, role: roleOf(event, row.name) });
      }
    } else if (event.type === 'practice') {
      for (const name of event.participants) add(name, event.date, 'practice', GRADE_POINTS.practice, { title: event.title });
    }
  }
  // Задания со сдачей по студентам: сдал — плюс, срок прошёл, а не сдал — минус.
  const moment = `${nowISO}T${nowTime}`;
  for (const event of events) {
    if (event.type !== 'task' || !event.deadline || !isHeld(event)) continue;
    const date = event.deadline.slice(0, 10);
    if (date < from || date > until) continue;
    for (const name of event.participants) {
      const status = handInOf(event, name);
      if (status === 'done') add(name, date, 'task', GRADE_POINTS.task, { title: event.title });
      else if (event.deadline <= moment) add(name, date, 'taskMissed', GRADE_POINTS.taskMissed, { title: event.title });
    }
  }

  // Баллы, добавленные или снятые преподавателем вручную.
  for (const bonus of bonuses) {
    const counted = bonus.date >= from || (bonus.date >= retroFrom && bonus.points > 0);
    if (counted && bonus.date <= until) add(bonus.student, bonus.date, 'manual', bonus.points, { title: bonus.name, by: bonus.by ?? '', ...(bonus.place ? { place: bonus.place, team: bonus.team ?? '' } : {}) });
  }

  // Прошлые работы, внесённые задним числом: до того, как колледж начал вести их в программе.
  for (const work of pastWorks) {
    if (work.date < retroFrom || work.date > until) continue;
    // До начала учёта — только плюсы.
    const early = work.date < from;
    for (const change of pastWorkChanges(work)) {
      if (early && GRADE_POINTS[change.kind] < 0) continue;
      const role = change.kind === 'role' ? roleNameOf(work, change.name) : '';
      add(change.name, work.date, change.kind, GRADE_POINTS[change.kind], work.hackathon ? { title: work.name, hackathon: true, role } : { title: work.name, past: true, role });
    }
  }

  return [...people.values()].map((person) => {
    for (const [date, day] of person.days) {
      // Прогул хотя бы одной пары — прогул за день: −4 и без +1 за остальные пары этого дня.
      if (day.absent) person.changes.push({ date, kind: 'absent', points: GRADE_POINTS.absent, lessons: day.absentAt, attended: day.presentAt });
      else if (day.present) {
        person.changes.push({ date, kind: 'day', points: GRADE_POINTS.day, lessons: day.presentAt });
        if (day.late) person.changes.push({ date, kind: 'late', points: GRADE_POINTS.late, lessons: day.lateAt });
      }
    }
    // Сумма по дням: ниже нуля не опускается, по ней видно, когда получено каждое звание.
    // history — расчёт по дням: что было, сумма до и после, и сколько минуса не засчитано из-за нуля.
    const byDate = new Map();
    for (const change of person.changes) {
      if (!byDate.has(change.date)) byDate.set(change.date, []);
      byDate.get(change.date).push(change);
    }
    let points = 0;
    let level = GRADE_LEVELS[0];
    const levelUps = [];
    const history = [];
    for (const date of [...byDate.keys()].sort()) {
      const items = byDate.get(date);
      const sum = items.reduce((total, item) => total + item.points, 0);
      const before = points;
      points = Math.max(0, points + sum);
      history.push({ date, items, sum, before, after: points, lost: points - (before + sum) });
      const reached = gradeLevel(points);
      if (reached.from > level.from) levelUps.push({ level: reached.name, date });
      if (reached.from > level.from) level = reached;
    }
    const breakdown = Object.fromEntries(Object.keys(GRADE_POINTS).map((kind) => [kind, person.changes.filter((c) => c.kind === kind).length]));
    breakdown.manual = person.changes.filter((c) => c.kind === 'manual').reduce((sum, c) => sum + c.points, 0);
    // Ручные баллы по смыслу: плюсы — поощрения, минусы — за поведение.
    breakdown.reward = person.changes.filter((c) => c.kind === 'manual' && c.points > 0).reduce((sum, c) => sum + c.points, 0);
    breakdown.conduct = person.changes.filter((c) => c.kind === 'manual' && c.points < 0).reduce((sum, c) => sum + c.points, 0);
    const current = gradeLevel(points);
    const next = GRADE_LEVELS.find((item) => item.from > points) ?? null;
    const earned = person.changes.reduce((sum, c) => sum + c.points, 0);
    const lost = history.reduce((sum, day) => sum + day.lost, 0);
    return { name: person.name, group: person.group, points, level: current.name, next: next ? { name: next.name, need: next.from - points } : null, breakdown, levelUps, history, earned, lost };
  }).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'ru'));
}

/* Личное дело студента */

/**
 * Всё о студенте за период одним листом: посещаемость, опоздания по дням недели, справки,
 * задания, грейд, участие и достижения. Без контактов и записей — только то, что считает программа.
 */
export function studentFile({ student, events, attendance, students, groups, achievements, from, to, nowISO, nowTime, bonuses = [], pastWorks = [] }) {
  const key = nameKey(student.name);
  const until = nowISO < to ? nowISO : to;
  const report = buildReport({ events, attendance, students, groups, filters: { from, to: until, types: [...MARKED_TYPES] }, nowISO, nowTime });
  const row = report.students.find((item) => nameKey(item.name) === key)
    ?? { total: 0, present: 0, late: 0, sick: 0, noCertificate: 0, order: 0, excused: 0, absent: 0, percent: null };
  const late = report.lateness.find((item) => nameKey(item.name) === key) ?? null;
  const groupRow = report.groups.find((item) => item.name === row.group);

  const moment = `${nowISO}T${nowTime}`;
  const tasks = events
    .filter((event) => event.type === 'task' && event.deadline && isHeld(event) && event.deadline.slice(0, 10) >= from && event.deadline.slice(0, 10) <= to
      && event.participants.some((name) => nameKey(name) === key))
    .map((event) => {
      const own = handInOf(event, student.name);
      const state = own === 'done' ? 'done' : event.deadline <= moment ? (own === 'rework' ? 'rework-late' : 'missed') : (own === 'rework' ? 'rework' : 'open');
      return { title: event.title, deadline: event.deadline, state };
    })
    .concat(pastWorks
      .filter((work) => work.work === 'task' && work.date >= from && work.date <= to)
      .flatMap((work) => pastWorkChanges(work).filter((c) => nameKey(c.name) === key && c.kind !== 'role')
        .map((c) => ({ title: work.name, deadline: `${work.date}T23:59`, state: c.kind === 'task' ? 'done' : 'missed', past: true }))))
    .sort((a, b) => a.deadline.localeCompare(b.deadline));

  // Рейтинг — за всё обучение, а не за период личного дела.
  const grade = gradeReport({ events, attendance, students, groups, from: RATING_FROM, retroFrom: RETRO_FROM, to: until, nowISO, nowTime, bonuses, pastWorks }).find((item) => nameKey(item.name) === key) ?? null;
  // Практики и мероприятия из прошлых работ — в портфолио личного дела, как и проведённые в программе.
  const pastItems = pastWorks
    .filter((work) => work.work !== 'task' && work.date >= from && work.date <= to && work.students.some((name) => nameKey(name) === key))
    .map((work) => ({
      id: work.id, date: work.date, type: work.work, title: work.name, place: '', responsible: work.by ?? '', past: !work.hackathon, hackathon: Boolean(work.hackathon),
      role: work.work === 'event' && work.roles.some((name) => nameKey(name) === key) ? roleNameOf(work, student.name) || 'role' : '',
    }));
  const manual = bonuses.filter((bonus) => nameKey(bonus.student) === key && bonus.date >= from && bonus.date <= until).sort((a, b) => a.date.localeCompare(b.date));
  const work = portfolio({ name: student.name, events, attendance, achievements, nowISO, nowTime });
  return {
    from,
    to: until,
    attendance: { ...row, share: row.present + row.absent ? Math.round((row.present / (row.present + row.absent)) * 100) : null },
    groupShare: groupRow && groupRow.present + groupRow.absent ? Math.round((groupRow.present / (groupRow.present + groupRow.absent)) * 100) : null,
    lateness: late ? { count: late.late, average: late.average, byWeekday: late.byWeekday, worstDays: late.worstDays } : null,
    certificates: pendingCertificates(attendance, events).find((person) => nameKey(person.name) === key)?.classes.length ?? 0,
    tasks,
    grade,
    items: [...work.items.filter((item) => item.date >= from && item.date <= to), ...pastItems].sort((a, b) => b.date.localeCompare(a.date)),
    awards: work.awards.filter((item) => item.date >= from && item.date <= to),
    manual,
  };
}
