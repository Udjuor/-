'use strict';
// Каждое мероприятие — отдельный JSON-файл в <папка данных>/events.
// Запись одного мероприятия не затрагивает остальные, а файл заменяется атомарно.
// Удалённое мероприятие остаётся отметкой { deleted: true }: иначе устройство,
// которое было выключено, вернуло бы его при следующем обмене.
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const text = String(item).trim();
    const key = text.toLocaleLowerCase('ru');
    if (text && !seen.has(key)) {
      seen.add(key);
      result.push(text);
    }
  }
  return result;
}

/** Количество техники в мероприятии: { название: целое число от 1 }. */
function cleanCounts(value) {
  const counts = {};
  for (const [name, count] of Object.entries(value && typeof value === 'object' ? value : {})) {
    if (Number.isInteger(count) && count > 0) counts[name] = count;
  }
  return counts;
}

/** Приводит запись к единому виду. Возвращает null, если она непригодна. */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const event = {
    ...raw, // поля из будущих версий не должны теряться при пересылке
    id: String(raw.id ?? ''),
    type: EVENT_TYPES.has(raw.type) ? raw.type : 'event',
    title: String(raw.title ?? '').trim(),
    date: String(raw.date ?? ''),
    start: String(raw.start ?? ''),
    end: String(raw.end ?? ''),
    place: String(raw.place ?? '').trim(),
    responsible: String(raw.responsible ?? '').trim(),
    participants: cleanList(raw.participants),
    equipment: cleanList(raw.equipment),
    equipmentQty: cleanCounts(raw.equipmentQty),
    ownCameras: cleanList(raw.ownCameras),
    prepMinutes: Number.isInteger(raw.prepMinutes) && raw.prepMinutes > 0 ? Math.min(raw.prepMinutes, 720) : 0,
    notes: String(raw.notes ?? '').trim(),
    devices: cleanList(raw.devices),
    updatedAt: String(raw.updatedAt ?? ''),
    updatedBy: String(raw.updatedBy ?? ''),
  };
  event.allDay = raw.allDay === true;
  // Пара вне колледжа (физкультура в другом учреждении): отметки вносит только преподаватель.
  event.offsite = raw.offsite === true;
  // Цепочка повторяющихся событий: у каждого своя запись, общий номер цепочки.
  event.seriesId = ID_RE.test(raw.seriesId ?? '') ? raw.seriesId : '';
  event.repeat = event.seriesId && REPEAT_EVERY.has(raw.repeat?.every) && DATE_RE.test(raw.repeat?.until ?? '')
    ? { every: raw.repeat.every, until: raw.repeat.until }
    : null;
  // Срок есть только у заданий и мероприятий; без срока нечего отмечать сданным.
  const canHaveDeadline = event.type === 'task' || event.type === 'event';
  event.deadline = canHaveDeadline && MOMENT_RE.test(raw.deadline ?? '') ? raw.deadline : '';
  event.deadlineDone = event.deadline && MOMENT_RE.test(raw.deadlineDone ?? '') ? raw.deadlineDone : '';
  const valid =
    ID_RE.test(event.id) &&
    event.title &&
    DATE_RE.test(event.date) &&
    TIME_RE.test(event.start) &&
    TIME_RE.test(event.end) &&
    event.start < event.end;
  return valid ? event : null;
}

const EVENT_TYPES = new Set(['lesson', 'practice', 'task', 'event']);
const REPEAT_EVERY = new Set(['day', 'weekdays', 'week', '2weeks', 'month']);
const MARK_STATUSES = new Set(['present', 'sick', 'order', 'excused']);
const REF_KINDS = new Set(['group', 'student', 'equipment', 'teacher', 'notice', 'achievement']);
const NOTICE_COLORS = new Set(['blue', 'green', 'yellow', 'red']);
const MOMENT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const NICK_RE = /^[\p{L}\p{N}_.-]{3,20}$/u;
const HASH_RE = /^[0-9a-f]{64}$/;
/** Код привязки телефона действует две недели. */
const PHONE_CODE_DAYS = 14;

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const nickKey = (nick) => String(nick).toLocaleLowerCase('ru').replace(/ё/g, 'е');

/** Постоянный номер записи из её смысла: одна запись на студента в день, один адрес страницы. */
function hashId(text) {
  const hex = sha256(text);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Студент для интерфейса: вместо отпечатков — есть ли привязанный телефон и действующий код. */
function publicStudent(record, now) {
  const { phoneKey, phoneCode, phoneCodeAt, ...rest } = record;
  const since = new Date(now - PHONE_CODE_DAYS * 86400000).toISOString();
  return { ...rest, phoneBound: Boolean(phoneKey), codeActive: Boolean(phoneCode) && phoneCodeAt >= since };
}

/** Дата по местному времени компьютера. */
function localDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Студент открыл свою страницу в сети колледжа: «в колледже с …». */
function normalizePresence(raw) {
  const id = String(raw.id ?? '');
  const student = String(raw.student ?? '').trim().slice(0, 200);
  if (!ID_RE.test(id) || !student || !DATE_RE.test(raw.date ?? '') || !STAMP_RE.test(raw.at ?? '')) return null;
  return { id, kind: 'presence', student, date: raw.date, at: raw.at, updatedAt: String(raw.updatedAt ?? ''), updatedBy: String(raw.updatedBy ?? '') };
}

/** Где открыта студенческая страница: панели показывают её адрес QR-кодом. */
function normalizePortal(raw) {
  const id = String(raw.id ?? '');
  const urls = (Array.isArray(raw.urls) ? raw.urls : []).map(String).filter((url) => /^http:\/\/[\w.:-]+\/?$/.test(url)).slice(0, 8);
  if (!ID_RE.test(id)) return null;
  return {
    id,
    kind: 'portal',
    urls,
    device: String(raw.device ?? '').slice(0, 80),
    on: raw.on === true && urls.length > 0,
    updatedAt: String(raw.updatedAt ?? ''),
    updatedBy: String(raw.updatedBy ?? ''),
  };
}

/** Запись справочника: группа, студент, техника или преподаватель. */
function normalizeRef(raw) {
  if (!raw || !REF_KINDS.has(raw.kind)) return null;
  const ref = {
    ...raw,
    id: String(raw.id ?? ''),
    kind: raw.kind,
    name: String(raw.name ?? '').trim(),
    updatedAt: String(raw.updatedAt ?? ''),
    updatedBy: String(raw.updatedBy ?? ''),
  };
  if (raw.kind === 'student') {
    ref.groupId = String(raw.groupId ?? '');
    ref.ownCamera = raw.ownCamera === true;
    // Ник для студенческой страницы: его придумывает студент, подтверждает куратор.
    ref.nick = NICK_RE.test(raw.nick ?? '') ? raw.nick : '';
    ref.nickOk = Boolean(ref.nick) && raw.nickOk === true;
    // Хранятся только отпечатки кода и ключа телефона, сами они не сохраняются.
    ref.phoneKey = HASH_RE.test(raw.phoneKey ?? '') ? raw.phoneKey : '';
    ref.phoneCode = HASH_RE.test(raw.phoneCode ?? '') ? raw.phoneCode : '';
    ref.phoneCodeAt = STAMP_RE.test(raw.phoneCodeAt ?? '') && ref.phoneCode ? raw.phoneCodeAt : '';
    if (!ref.phoneCode) ref.phoneCodeAt = '';
    // Когда куратор нажал «Разобрались»: ранний сигнал считает только то, что было позже.
    ref.signalSince = STAMP_RE.test(raw.signalSince ?? '') ? raw.signalSince : '';
  }
  if (raw.kind === 'achievement') {
    // Достижение в портфолио: название — в name, студент, дата и результат (диплом, место).
    ref.student = String(raw.student ?? '').trim().slice(0, 200);
    ref.date = DATE_RE.test(raw.date ?? '') ? raw.date : '';
    ref.result = String(raw.result ?? '').trim().slice(0, 200);
    if (!ref.student || !ref.date) return null;
  }
  if (raw.kind === 'group') {
    ref.petName = String(raw.petName ?? '').trim().slice(0, 24);
    ref.petSince = MOMENT_RE.test(raw.petSince ?? '') ? raw.petSince : '';
    // Что надето на питомце и что стоит рядом: только названия призов.
    const look = raw.petLook && typeof raw.petLook === 'object' ? raw.petLook : null;
    if (look) ref.petLook = Object.fromEntries(['head', 'left', 'right'].map((slot) => [slot, /^[a-z]{0,20}$/.test(look[slot] ?? '') ? look[slot] ?? '' : '']));
    else delete ref.petLook;
    ref.petDeaths = (Array.isArray(raw.petDeaths) ? raw.petDeaths : []).slice(-200).map((death) => ({
      name: String(death?.name ?? '').slice(0, 24),
      bornOn: String(death?.bornOn ?? ''),
      diedOn: String(death?.diedOn ?? ''),
      pairs: Number.isInteger(death?.pairs) ? death.pairs : 0,
    }));
  }
  if (raw.kind === 'notice') {
    ref.name = ref.name.slice(0, 200);
    ref.color = NOTICE_COLORS.has(raw.color) ? raw.color : 'blue';
    ref.until = MOMENT_RE.test(raw.until ?? '') ? raw.until : '';
    if (!ref.until) return null;
  }
  if (raw.kind === 'teacher') {
    // PIN были в версиях 1.18 и 1.19.
    delete ref.pin;
    delete ref.hasPin;
  }
  if (raw.kind === 'equipment') {
    // Пустое количество означает «без лимита».
    ref.quantity = Number.isInteger(raw.quantity) && raw.quantity >= 0 ? raw.quantity : null;
  }
  const valid = ID_RE.test(ref.id) && ref.name && (raw.kind !== 'student' || ID_RE.test(ref.groupId));
  return valid ? ref : null;
}

/**
 * Отметки одной пары: { eventId, marks: { имя: { status, at, t, by } } }.
 * Одна запись на пару, а не на студента: иначе за год набрались бы сотни тысяч
 * файлов и обмен между устройствами перестал бы справляться.
 * Снятая отметка хранится со status: null, чтобы не вернуться при обмене.
 */
function normalizeAttendance(raw) {
  const doc = {
    ...raw,
    id: String(raw.id ?? ''),
    kind: 'attendance',
    eventId: String(raw.eventId ?? ''),
    marks: {},
    updatedAt: String(raw.updatedAt ?? ''),
    updatedBy: String(raw.updatedBy ?? ''),
  };
  if (!ID_RE.test(doc.id) || !ID_RE.test(doc.eventId) || typeof raw.marks !== 'object' || !raw.marks) return null;
  for (const [name, mark] of Object.entries(raw.marks)) {
    const status = mark?.status ?? null;
    if ((status === null || MARK_STATUSES.has(status)) && STAMP_RE.test(mark?.t ?? '')) {
      doc.marks[name] = { status, at: mark.at ?? null, t: mark.t, by: String(mark.by ?? '') };
      // У старых отметок поля нет: их опоздание считается по времени, как раньше.
      if (typeof mark.late === 'boolean') doc.marks[name].late = mark.late;
      if (typeof mark.confirmed === 'boolean') doc.marks[name].confirmed = mark.confirmed;
      if (mark.teacher) doc.marks[name].teacher = String(mark.teacher);
      // Отметка со страницы студента: предварительная, пока её не подтвердит преподаватель.
      if (mark.auto === true && status === 'present') doc.marks[name].auto = true;
    }
  }
  const lock = raw.lock;
  doc.lock = typeof lock?.at === 'string' && lock.at && typeof lock.teacher === 'string'
    ? {
      at: lock.at,
      teacher: lock.teacher,
      device: String(lock.device ?? ''),
      participants: cleanList(lock.participants),
      excused: Object.fromEntries(Object.entries(lock.excused ?? {}).map(([name, title]) => [String(name), String(title)])),
    }
    : null;
  doc.history = doc.lock && Array.isArray(raw.history) ? raw.history.slice(-500) : [];
  const start = raw.start;
  doc.start = typeof start?.at === 'string' && !Number.isNaN(Date.parse(start.at)) && STAMP_RE.test(start.t ?? '')
    ? { at: start.at, t: start.t, by: String(start.by ?? '') }
    : null;
  return doc;
}

/** Номер записи отметок выводится из пары: на всех устройствах он одинаковый. */
function attendanceId(eventId) {
  const hex = crypto.createHash('sha256').update(`attendance:${eventId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Объединяет отметки: по каждому студенту остаётся более поздняя. */
function mergeMarks(a, b) {
  const merged = { ...a };
  for (const [name, mark] of Object.entries(b)) {
    const mine = merged[name];
    if (!mine || `${mark.t}|${mark.by}` > `${mine.t}|${mine.by}`) merged[name] = mark;
  }
  return merged;
}

/**
 * Зафиксированный отчёт главнее незафиксированной копии: отметки, сделанные
 * на другой панели без связи, не должны менять его задним числом.
 */
function mergeAttendance(a, b) {
  const start = [a.start, b.start].filter(Boolean).sort((x, y) => x.t.localeCompare(y.t)).at(-1) ?? null;
  if (!a.lock && !b.lock) return { marks: mergeMarks(a.marks, b.marks), lock: null, history: [], start };
  if (!a.lock || !b.lock) {
    const { marks, lock, history, start: lockedStart } = a.lock ? a : b;
    return { marks, lock, history, start: lockedStart ?? null };
  }
  const entries = new Map([...a.history, ...b.history].map((entry) => [JSON.stringify(entry), entry]));
  return {
    marks: mergeMarks(a.marks, b.marks),
    lock: a.lock.at <= b.lock.at ? a.lock : b.lock,
    start: (a.lock.at <= b.lock.at ? a : b).start ?? null,
    history: [...entries.values()].sort((x, y) => String(x.at).localeCompare(String(y.at))),
  };
}

const sameAttendance = (a, b) => {
  const sorted = (doc) => JSON.stringify([
    Object.keys(doc.marks).sort().map((name) => [name, doc.marks[name]]), doc.lock ?? null, doc.history ?? [], doc.start ?? null,
  ]);
  return sorted(a) === sorted(b);
};

const LOCKED_FIELDS = ['title', 'type', 'date', 'start', 'end', 'participants'];

/** Записи журнала хранятся полгода. */
const CHANGE_DAYS = 180;

/** Поля события, изменения которых попадают в журнал. Служебные метки не нужны. */
const JOURNAL_FIELDS = ['title', 'type', 'date', 'start', 'end', 'allDay', 'offsite', 'place', 'responsible', 'participants', 'equipment', 'equipmentQty', 'ownCameras', 'prepMinutes', 'notes', 'deadline', 'deadlineDone', 'devices'];
const CHANGE_ACTIONS = new Set(['create', 'edit', 'delete', 'create-series', 'delete-range', 'restore']);

const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

/** Что изменилось в событии: поле, было, стало. */
function eventDiff(before, after) {
  return JOURNAL_FIELDS
    .filter((field) => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null))
    .map((field) => ({ field, before: plain(before?.[field] ?? null), after: plain(after?.[field] ?? null) }));
}

/** Запись журнала изменений. Она не меняется после записи, поэтому слияние не нужно. */
function normalizeChange(raw) {
  const id = String(raw.id ?? '');
  if (!ID_RE.test(id) || !CHANGE_ACTIONS.has(raw.action) || !STAMP_RE.test(String(raw.at ?? ''))) return null;
  const text = (value, max = 300) => String(value ?? '').slice(0, max);
  return {
    id,
    kind: 'change',
    action: raw.action,
    at: raw.at,
    by: text(raw.by, 80),
    device: text(raw.device, 80),
    eventId: text(raw.eventId, 80),
    title: text(raw.title),
    type: text(raw.type, 20),
    date: text(raw.date, 10),
    start: text(raw.start, 5),
    end: text(raw.end, 5),
    from: text(raw.from, 10),
    to: text(raw.to, 10),
    count: Number.isInteger(raw.count) && raw.count > 0 ? raw.count : 0,
    fields: (Array.isArray(raw.fields) ? raw.fields : [])
      .filter((item) => JOURNAL_FIELDS.includes(item?.field))
      .map((item) => ({ field: item.field, before: plain(item.before ?? null), after: plain(item.after ?? null) })),
    updatedAt: String(raw.updatedAt ?? ''),
    updatedBy: String(raw.updatedBy ?? ''),
  };
}

/** Запись для хранения и обмена: мероприятие, справочник, отметки или отметка об удалении. */
function normalizeRecord(raw) {
  if (raw && raw.deleted === true) {
    const id = String(raw.id ?? '');
    return ID_RE.test(id)
      ? { id, deleted: true, updatedAt: String(raw.updatedAt ?? ''), updatedBy: String(raw.updatedBy ?? '') }
      : null;
  }
  if (raw?.kind === 'attendance') return normalizeAttendance(raw);
  if (raw?.kind === 'change') return normalizeChange(raw);
  if (raw?.kind === 'presence') return normalizePresence(raw);
  if (raw?.kind === 'portal') return normalizePortal(raw);
  return raw?.kind ? normalizeRef(raw) : normalizeEvent(raw);
}

/** Какая запись новее. Равные метки времени разводит номер устройства. */
const revision = (record) => `${record.updatedAt}|${record.updatedBy ?? ''}`;

/** Метка новой версии всегда позже предыдущей, даже если часы устройства отстают. */
function nextStamp(previous) {
  const now = Date.now();
  const before = previous ? Date.parse(previous) : 0;
  return new Date(Math.max(now, (before || 0) + 1)).toISOString();
}

class EventStore {
  /** clock: часы для времени отметок; в проверках их ставят на день сценария. */
  constructor(dataDir, deviceId = '', { clock = () => Date.now(), deviceName = () => '' } = {}) {
    this.deviceName = deviceName;
    this.clock = clock;
    this.dir = path.join(dataDir, 'events');
    this.deviceId = deviceId;
    this.cache = new Map(); // имя файла → { stamp, record }
    this.queue = Promise.resolve();
  }

  /** Отметки меняются чтением и записью: операции идут строго по очереди. */
  exclusive(work) {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  fileFor(id) {
    return path.join(this.dir, `${id}.json`);
  }

  /** Читает папку. Неизменившиеся файлы берёт из памяти: по сети это важно. */
  async records() {
    await fsp.mkdir(this.dir, { recursive: true });
    const names = (await fsp.readdir(this.dir)).filter((name) => name.endsWith('.json'));
    const fresh = new Map();
    await Promise.all(
      names.map(async (name) => {
        try {
          const full = path.join(this.dir, name);
          const stat = await fsp.stat(full);
          const stamp = `${stat.mtimeMs}:${stat.size}`;
          const known = this.cache.get(name);
          if (known && known.stamp === stamp) {
            fresh.set(name, known);
            return;
          }
          const record = normalizeRecord(JSON.parse(await fsp.readFile(full, 'utf8')));
          if (record) fresh.set(name, { stamp, record });
          else console.error('Пропущен неверный файл мероприятия:', name);
        } catch (err) {
          // Файл могли удалить на другой панели, пока мы читали папку.
          if (err.code !== 'ENOENT') console.error('Файл мероприятия не прочитан:', name, err.message);
        }
      }),
    );
    this.cache = fresh;
    return [...fresh.values()].map((entry) => entry.record).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Действующие мероприятия, без отметок об удалении. */
  async list() {
    return (await this.records()).filter((record) => !record.deleted && !record.kind);
  }

  /** Записи справочников. */
  async directory() {
    // Отпечатки кода и ключа телефона наружу не отдаются: только есть или нет.
    return (await this.records())
      .filter((record) => !record.deleted && REF_KINDS.has(record.kind))
      .map((record) => (record.kind === 'student' ? publicStudent(record, this.clock()) : record));
  }

  /* Студенческая страница */

  /** Новый код привязки телефона. Сам код возвращается один раз и нигде не хранится. */
  async studentCode(id) {
    const current = await this.read(id);
    if (current?.kind !== 'student') throw new StoreError('not-found', 'Студент не найден');
    const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
    await this.write({ ...current, phoneCode: sha256(code), phoneCodeAt: new Date(this.clock()).toISOString(), updatedAt: nextStamp(current.updatedAt), updatedBy: this.deviceId });
    return code;
  }

  /** Отвязывает телефон и гасит неиспользованный код. */
  async unbindPhone(id) {
    const current = await this.read(id);
    if (current?.kind !== 'student') throw new StoreError('not-found', 'Студент не найден');
    await this.write({ ...current, phoneKey: '', phoneCode: '', phoneCodeAt: '', updatedAt: nextStamp(current.updatedAt), updatedBy: this.deviceId });
  }

  /**
   * Привязка телефона по коду куратора. Ник предлагает студент; подтверждённый
   * куратором ник не меняется. Возвращает ключ, который хранит только телефон.
   */
  async bindPhone(code, nick) {
    const digits = String(code ?? '').replace(/\D/g, '');
    if (digits.length !== 8) throw new StoreError('bad-code', 'Неверный код');
    const students = (await this.records()).filter((record) => record.kind === 'student' && !record.deleted);
    const since = new Date(this.clock() - PHONE_CODE_DAYS * 86400000).toISOString();
    const student = students.find((record) => record.phoneCode === sha256(digits) && record.phoneCodeAt >= since);
    if (!student) throw new StoreError('bad-code', 'Неверный код');
    let nextNick = student.nick;
    let nickOk = student.nickOk;
    if (!student.nickOk) {
      const wanted = String(nick ?? '').trim();
      if (!NICK_RE.test(wanted)) throw new StoreError('bad-nick', 'Неверный ник');
      if (students.some((record) => record.id !== student.id && record.nick && nickKey(record.nick) === nickKey(wanted))) throw new StoreError('nick-taken', 'Ник занят');
      nextNick = wanted;
      nickOk = false;
    }
    const token = crypto.randomBytes(32).toString('hex');
    await this.write({
      ...student,
      nick: nextNick,
      nickOk,
      phoneKey: sha256(token),
      phoneCode: '',
      phoneCodeAt: '',
      updatedAt: nextStamp(student.updatedAt),
      updatedBy: this.deviceId,
    });
    return { token, student: student.name };
  }

  /** Студент по ключу телефона или null. */
  async studentByToken(token) {
    if (!/^[0-9a-f]{64}$/.test(String(token ?? ''))) return null;
    const key = sha256(token);
    return (await this.records()).find((record) => record.kind === 'student' && !record.deleted && record.phoneKey === key) ?? null;
  }

  /** Отметка «в колледже»: первая за день остаётся. */
  async markPresence(student, at = new Date(this.clock()).toISOString()) {
    const date = localDate(at);
    const id = hashId(`presence:${nickKey(student)}:${date}`);
    const current = await this.read(id);
    if (current && !current.deleted) return current;
    const record = normalizePresence({ id, student, date, at, updatedAt: nextStamp(current?.updatedAt), updatedBy: this.deviceId });
    await this.write(record);
    return record;
  }

  /** Кто был в колледже в этот день. */
  async presenceOn(date) {
    return (await this.records()).filter((record) => record.kind === 'presence' && record.date === date);
  }

  /** Адрес студенческой страницы для панелей. */
  async portal() {
    return (await this.read(hashId('portal'))) ?? null;
  }

  async setPortal(urls, device, on) {
    const id = hashId('portal');
    const current = await this.read(id);
    const record = normalizePortal({ id, urls, device, on, updatedAt: nextStamp(current?.updatedAt), updatedBy: this.deviceId });
    const same = current && JSON.stringify([current.urls, current.device, current.on]) === JSON.stringify([record.urls, record.device, record.on]);
    if (!same) await this.write(record);
    return same ? current : record;
  }

  /** Журнал изменений событий, новые сверху, за последние полгода. */
  async changes() {
    const since = new Date(this.clock() - CHANGE_DAYS * 86400000).toISOString();
    return (await this.records())
      .filter((record) => record.kind === 'change' && record.at >= since)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  }

  /** Записывает действие в журнал. Ошибка журнала не должна мешать самому изменению. */
  async journal(action, event, extra = {}) {
    try {
      const at = new Date(this.clock()).toISOString();
      const entry = normalizeChange({
        id: crypto.randomUUID(),
        action,
        at,
        by: this.deviceId,
        device: this.deviceName(),
        eventId: event?.id,
        title: event?.title,
        type: event?.type,
        date: event?.date,
        start: event?.start,
        end: event?.end,
        ...extra,
        updatedAt: nextStamp(),
        updatedBy: this.deviceId,
      });
      if (entry) await this.write(entry);
      return entry;
    } catch (err) {
      console.error('Журнал не записан:', err.message);
      return null;
    }
  }

  /** Удаляет записи журнала старше полугода. */
  async pruneChanges() {
    const since = new Date(this.clock() - CHANGE_DAYS * 86400000).toISOString();
    let removed = 0;
    for (const record of await this.records()) {
      if (record.kind !== 'change' || record.at >= since) continue;
      await fsp.rm(this.fileFor(record.id), { force: true });
      removed += 1;
    }
    return removed;
  }

  /** Записи отметок всех пар. */
  async attendance() {
    return (await this.records()).filter((record) => record.kind === 'attendance');
  }

  /**
   * Ставит или снимает отметку студента.
   * student: отметка с клиента на панели: присутствие, опоздание и предварительная болезнь.
   * teacher: устройство с версией для преподавателей, только оно может исправить зафиксированный отчёт.
   */
  saveMark(eventId, name, status, { teacher = null, student = false, late = false, at = null, confirmed = false, auto = false, onlyIfEmpty = false } = {}) {
    return this.exclusive(async () => {
      const validTime = at === null || !Number.isNaN(Date.parse(at));
      if (!ID_RE.test(String(eventId)) || !String(name).trim() || !(status === null || MARK_STATUSES.has(status)) || !validTime) {
        throw new StoreError('invalid', 'Неверная отметка');
      }
      const id = attendanceId(eventId);
      const current = await this.readCurrent(id);
      const before = current?.marks?.[name];
      // Автоматическая отметка не трогает поставленную вручную и зафиксированный отчёт.
      if (onlyIfEmpty && (before?.status || current?.lock)) return current ? normalizeAttendance(current) : null;
      if (current?.lock && !teacher) throw new StoreError('locked', 'Отчёт по паре зафиксирован');
      if (student) {
        const event = await this.readCurrent(eventId);
        if (event?.offsite === true) throw new StoreError('offsite', 'Пара проходит вне колледжа');
        // На панели отмечают приход, опоздание и предварительную болезнь. Остальное делает преподаватель.
        const preliminary = before?.status === 'sick' && before.confirmed === false && !before.teacher;
        const fixed = before?.status && before.status !== 'present' && !preliminary;
        if (fixed || (status && status !== 'present' && status !== 'sick') || confirmed) {
          throw new StoreError('teacher-only', 'Только в версии для преподавателей');
        }
      }
      const mark = {
        status,
        at: status ? at ?? new Date(this.clock()).toISOString() : null,
        t: nextStamp(before?.t),
        by: this.deviceId,
        late: status === 'present' && late,
      };
      if (status === 'sick') mark.confirmed = Boolean(confirmed);
      if (status === 'present' && auto) mark.auto = true;
      if (teacher) mark.teacher = teacher;
      const history = [...(current?.history ?? [])];
      if (current?.lock) {
        const brief = (m) => ({ status: m?.status ?? null, at: m?.at ?? null, late: m?.late ?? null, confirmed: m?.confirmed ?? null });
        history.push({ at: new Date(this.clock()).toISOString(), teacher, name, before: brief(before), after: brief(mark) });
      }
      const doc = normalizeAttendance({
        id,
        eventId,
        marks: { ...(current?.marks ?? {}), [name]: mark },
        lock: current?.lock,
        start: current?.start,
        history,
        updatedAt: nextStamp(current?.updatedAt),
        updatedBy: this.deviceId,
      });
      await this.write(doc);
      return doc;
    });
  }

  /**
   * «Начать занятие». С панели нажимается один раз, время берётся с часов, не позже 40-й минуты
   * по расписанию: иначе опоздавший мог бы начать занятие за себя. В версии для преподавателей
   * время можно поправить, пока отчёт не зафиксирован.
   */
  startLesson(eventId, { admin = false, at = null, now = this.clock() } = {}) {
    return this.exclusive(async () => {
      const event = await this.readCurrent(String(eventId));
      if (!event || event.deleted || event.kind || event.type !== 'lesson') throw new StoreError('invalid', 'Занятие не найдено');
      if ((at !== null && !admin) || (at !== null && Number.isNaN(Date.parse(at)))) throw new StoreError('teacher-only', 'Время меняет преподаватель');
      const id = attendanceId(eventId);
      const current = await this.readCurrent(id);
      if (current?.lock) throw new StoreError('locked', 'Отчёт по паре зафиксирован');
      if (!admin) {
        if (current?.start) throw new StoreError('started', 'Занятие уже начато');
        const [y, m, d] = event.date.split('-').map(Number);
        const scheduled = new Date(y, m - 1, d, ...event.start.split(':').map(Number)).getTime();
        if (now < scheduled - 30 * 60_000 || now > scheduled + 40 * 60_000) throw new StoreError('not-now', 'Сейчас занятие начать нельзя');
      }
      const doc = normalizeAttendance({
        id,
        eventId,
        marks: current?.marks ?? {},
        history: current?.history ?? [],
        start: { at: at ?? new Date(now).toISOString(), t: nextStamp(current?.start?.t), by: this.deviceId },
        updatedAt: nextStamp(current?.updatedAt),
        updatedBy: this.deviceId,
      });
      await this.write(doc);
      return doc;
    });
  }

  /** Фиксирует отчёт: состав пары запоминается, дальше правки только в версии для преподавателей. */
  lockReport(eventId, teacher, excused = {}) {
    return this.exclusive(async () => {
      if (!ID_RE.test(String(eventId)) || !teacher) throw new StoreError('invalid', 'Неверная фиксация');
      const event = await this.readCurrent(eventId);
      if (!event || event.deleted) throw new StoreError('conflict', 'Мероприятие удалено');
      const id = attendanceId(eventId);
      const current = await this.readCurrent(id);
      if (current?.lock) throw new StoreError('locked', 'Отчёт уже зафиксирован');
      // Фиксация отчёта подтверждает и отметки со страницы студента.
      const marks = Object.fromEntries(Object.entries(current?.marks ?? {}).map(([name, { auto, ...mark }]) => [name, mark]));
      const doc = normalizeAttendance({
        id,
        eventId,
        marks,
        start: current?.start,
        lock: { at: new Date(this.clock()).toISOString(), teacher, device: this.deviceId, participants: event.participants, excused },
        updatedAt: nextStamp(current?.updatedAt),
        updatedBy: this.deviceId,
      });
      await this.write(doc);
      return doc;
    });
  }

  /** Одна запись в проверенном виде или null. */
  async read(id) {
    const raw = await this.readCurrent(id);
    return raw ? normalizeRecord(raw) : null;
  }

  async readCurrent(id) {
    try {
      return JSON.parse(await fsp.readFile(this.fileFor(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Отказывает, если запись успели изменить или удалить на другом устройстве. */
  async assertUnchanged(id, baseUpdatedAt) {
    const current = await this.readCurrent(id);
    if (!current || current.deleted || current.updatedAt !== baseUpdatedAt) {
      throw new StoreError('conflict', 'Мероприятие изменили на другом устройстве');
    }
    return current;
  }

  async write(record) {
    await fsp.mkdir(this.dir, { recursive: true });
    const target = this.fileFor(record.id);
    const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(record, null, 2), 'utf8');
    await fsp.rename(temp, target);
  }

  async save(input, baseUpdatedAt = null, { journal = true } = {}) {
    const isNew = !input.id;
    const draft = normalizeEvent({
      ...input,
      id: input.id || crypto.randomUUID(),
      updatedAt: '',
      updatedBy: this.deviceId,
    });
    if (!draft) throw new StoreError('invalid', 'Проверьте название, дату и время');
    const current = isNew ? null : await this.assertUnchanged(draft.id, baseUpdatedAt);
    if (current && LOCKED_FIELDS.some((field) => JSON.stringify(current[field]) !== JSON.stringify(draft[field]))) {
      await this.assertNotLocked(draft.id);
    }
    const event = { ...draft, updatedAt: nextStamp(current?.updatedAt) };
    await this.write(event);
    if (journal) {
      const fields = eventDiff(current, event);
      if (isNew) await this.journal('create', event);
      else if (fields.length) await this.journal('edit', event, { fields });
    }
    return event;
  }

  async saveRef(input, baseUpdatedAt = null) {
    const isNew = !input.id;
    const draft = normalizeRef({ ...input, id: input.id || crypto.randomUUID(), updatedAt: '', updatedBy: this.deviceId });
    if (!draft) throw new StoreError('invalid', 'Проверьте название');
    const current = isNew ? null : await this.assertUnchanged(draft.id, baseUpdatedAt);
    const ref = { ...draft, updatedAt: nextStamp(current?.updatedAt) };
    if (ref.kind === 'student') {
      // Код и ключ телефона меняются только своими командами, правка справочника их не трогает.
      for (const field of ['phoneKey', 'phoneCode', 'phoneCodeAt']) ref[field] = current?.[field] ?? '';
      delete ref.phoneBound;
      delete ref.codeActive;
    }
    await this.write(ref);
    return ref.kind === 'student' ? publicStudent(ref, this.clock()) : ref;
  }

  /**
   * Возвращает из резервной копии записи, которых сейчас нет или которые удалены.
   * Существующие записи не трогает: в копии они старее. Восстановленное получает
   * новое время, иначе удаление с другого устройства снова бы его стёрло.
   */
  restoreFrom(folder) {
    return this.exclusive(async () => {
      let restored = 0;
      for (const name of (await fsp.readdir(folder)).filter((file) => file.endsWith('.json'))) {
        let record;
        try {
          record = JSON.parse(await fsp.readFile(path.join(folder, name), 'utf8'));
        } catch {
          continue;
        }
        if (!record?.id || record.deleted || !ID_RE.test(String(record.id))) continue;
        const current = await this.readCurrent(record.id);
        if (current && !current.deleted) continue;
        await this.write({ ...record, updatedAt: nextStamp(current?.updatedAt), updatedBy: this.deviceId });
        restored += 1;
      }
      if (restored) await this.journal('restore', null, { count: restored });
      return restored;
    });
  }

  async assertNotLocked(eventId) {
    if ((await this.readCurrent(attendanceId(eventId)))?.lock) throw new StoreError('locked', 'Отчёт по паре зафиксирован');
  }

  /** Удаляет события за период. Зафиксированные пары остаются: их отчёты нельзя потерять. */
  async removeRange(from, to, types) {
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to || !Array.isArray(types)) throw new StoreError('invalid', 'Неверный период');
    let removed = 0;
    let kept = 0;
    for (const event of await this.list()) {
      if (event.date < from || event.date > to || !types.includes(event.type)) continue;
      try {
        await this.remove(event.id, event.updatedAt, { journal: false });
        removed += 1;
      } catch (err) {
        if (err.code !== 'locked' && err.code !== 'conflict') throw err;
        kept += 1;
      }
    }
    if (removed) await this.journal('delete-range', null, { from, to, count: removed });
    return { removed, kept };
  }

  async remove(id, baseUpdatedAt, { journal = true } = {}) {
    if (!ID_RE.test(String(id))) throw new StoreError('invalid', 'Неверный номер мероприятия');
    const current = await this.assertUnchanged(id, baseUpdatedAt);
    if (!current.kind) await this.assertNotLocked(id);
    await this.write({ id, deleted: true, updatedAt: nextStamp(current.updatedAt), updatedBy: this.deviceId });
    if (journal && !current.kind) await this.journal('delete', current);
  }

  /** Принимает записи с другого устройства, оставляя более новую версию. */
  merge(incoming) {
    return this.exclusive(() => this.mergeNow(incoming));
  }

  async mergeNow(incoming) {
    const known = new Map((await this.records()).map((record) => [record.id, record]));
    let changed = 0;
    for (const raw of incoming) {
      const record = normalizeRecord(raw);
      if (!record || !STAMP_RE.test(record.updatedAt)) continue;
      if (record.kind === 'change' && record.at < new Date(this.clock() - CHANGE_DAYS * 86400000).toISOString()) continue;
      const mine = known.get(record.id);
      let result = record;
      if (mine?.kind === 'attendance' && record.kind === 'attendance') {
        // Разные панели могли отметить разных студентов: сохраняем всех.
        const merged = mergeAttendance(mine, record);
        const newest = revision(mine) >= revision(record);
        if (sameAttendance(merged, mine) && newest) continue;
        if (!sameAttendance(merged, record)) {
          const stamp = nextStamp(newest ? mine.updatedAt : record.updatedAt);
          result = { ...record, ...merged, updatedAt: stamp, updatedBy: this.deviceId };
        }
      } else if (mine && revision(mine) >= revision(record)) {
        continue;
      }
      await this.write(result);
      known.set(result.id, result);
      changed += 1;
    }
    return changed;
  }
}

module.exports = { EventStore, StoreError, normalizeEvent, normalizeRecord, revision, attendanceId, eventDiff, CHANGE_DAYS };
