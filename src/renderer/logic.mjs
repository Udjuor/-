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

export const overlaps = (a, b) => a.date === b.date && a.start < b.end && b.start < a.end;

const nameKey = (name) => name.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');

/**
 * Находит, кто из участников, какая техника и какой ответственный уже заняты
 * в пересекающихся по времени мероприятиях.
 */
export function findConflicts(draft, events) {
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
  check(draft.equipment, 'equipment', (e) => e.equipment);
  return result;
}

/** Разбирает вставленный список: столбец из Excel или строку через точку с запятой. */
export const splitList = (text) => text.split(/[\r\n;\t]+/).map((s) => s.trim()).filter(Boolean);

/** Значения для подсказок: все, что уже встречалось, без учёта регистра. */
export function uniqueValues(values) {
  const map = new Map();
  for (const value of values) {
    if (value && !map.has(nameKey(value))) map.set(nameKey(value), value);
  }
  return [...map.values()].sort((a, b) => a.localeCompare(b, 'ru'));
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
