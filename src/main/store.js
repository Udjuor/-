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

/** Роли студентов в событии: имя участника → роль. Только для тех, кто в списке участников. */
function cleanRoles(value, participants) {
  const listed = new Set(participants);
  const roles = {};
  for (const [name, role] of Object.entries(value && typeof value === 'object' ? value : {})) {
    const text = String(role ?? '').trim().slice(0, 60);
    if (listed.has(name) && text) roles[name] = text;
  }
  return roles;
}

/** Сдача по студентам: имя → 'done' (сдал) или 'rework' (на доработке). Нет записи — не сдал. */
function cleanHandIn(value, participants) {
  const listed = new Set(participants);
  const handIn = {};
  for (const [name, status] of Object.entries(value && typeof value === 'object' ? value : {})) {
    if (listed.has(name) && HAND_IN.has(status)) handIn[name] = status;
  }
  return handIn;
}

/** Решения и поручения собрания: что сделать, кто отвечает, к какому сроку, выполнено ли. */
function cleanDecisions(value) {
  return (Array.isArray(value) ? value : []).slice(0, 50).map((item) => ({
    id: ID_RE.test(item?.id ?? '') ? item.id : crypto.randomUUID(),
    text: String(item?.text ?? '').trim().slice(0, 300),
    who: String(item?.who ?? '').trim().slice(0, 80),
    due: DATE_RE.test(item?.due ?? '') ? item.due : '',
    done: item?.done === true,
  })).filter((item) => item.text);
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
  // Роли бывают у заданий, практики и мероприятий: оператор, ведущий, фотограф.
  event.roles = ROLE_TYPES.has(event.type) ? cleanRoles(raw.roles, event.participants) : {};
  event.allDay = raw.allDay === true;
  // Пара вне колледжа (физкультура в другом учреждении): отметки вносит только преподаватель.
  event.offsite = raw.offsite === true;
  // Занятие не состоялось (преподаватель заболел, перенос): отметок нет, в отчёты не идёт.
  // Добавлено с панели студентами и ждёт согласования преподавателем: в учёт не входит.
  if (raw.pending === true) {
    event.pending = true;
    event.pendingFrom = String(raw.pendingFrom ?? '').slice(0, 80);
  } else {
    delete event.pending;
    delete event.pendingFrom;
  }
  event.cancelled = raw.cancelled === true;
  event.cancelReason = event.cancelled ? String(raw.cancelReason ?? '').trim().slice(0, 200) : '';
  // Цепочка повторяющихся событий: у каждого своя запись, общий номер цепочки.
  event.seriesId = ID_RE.test(raw.seriesId ?? '') ? raw.seriesId : '';
  event.repeat = event.seriesId && REPEAT_EVERY.has(raw.repeat?.every) && DATE_RE.test(raw.repeat?.until ?? '')
    ? { every: raw.repeat.every, until: raw.repeat.until }
    : null;
  // Срок есть только у заданий и мероприятий; без срока нечего отмечать сданным.
  const canHaveDeadline = event.type === 'task' || event.type === 'event';
  event.deadline = canHaveDeadline && MOMENT_RE.test(raw.deadline ?? '') ? raw.deadline : '';
  event.deadlineDone = event.deadline && MOMENT_RE.test(raw.deadlineDone ?? '') ? raw.deadlineDone : '';
  // Сдача по студентам — у заданий. Материалы мероприятия сдаются целиком, отметкой «Сдано».
  event.handIn = event.deadline && event.type === 'task' ? cleanHandIn(raw.handIn, event.participants) : {};
  event.decisions = event.type === 'meeting' ? cleanDecisions(raw.decisions) : [];
  // Запись со страницы студента из 1.44 убрана вместе со страницей.
  delete event.signup;
  delete event.requests;
  // Когда событие появилось.
  event.createdAt = /^\d{4}-\d{2}-\d{2}T/.test(raw.createdAt ?? '') ? String(raw.createdAt) : '';
  const valid =
    ID_RE.test(event.id) &&
    event.title &&
    DATE_RE.test(event.date) &&
    TIME_RE.test(event.start) &&
    TIME_RE.test(event.end) &&
    event.start < event.end;
  return valid ? event : null;
}

const EVENT_TYPES = new Set(['lesson', 'practice', 'task', 'event', 'meeting']);
const REPEAT_EVERY = new Set(['day', 'weekdays', 'monsat', 'week', '2weeks', 'month']);
const MARK_STATUSES = new Set(['present', 'sick', 'order', 'excused']);
const ROLE_TYPES = new Set(['practice', 'task', 'event']);
const HAND_IN = new Set(['done', 'rework']);
const REF_KINDS = new Set(['group', 'student', 'equipment', 'teacher', 'role', 'notice', 'achievement', 'bonus']);
const NOTICE_COLORS = new Set(['blue', 'green', 'yellow', 'red']);
const MOMENT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
// Виды питомцев. Список совпадает с PET_KINDS в src/renderer/pet.mjs.
const PET_KINDS = ['mammoth', 'foal', 'hare', 'lynx', 'owl'];
// Вид выбран на текущего питомца: студенты его больше не меняют до смерти питомца.
// Ключ — дата заведения питомца (petSince). Новый питомец меняет ключ, и выбор снова открыт.
// Правило то же, что petKindLocked в pet.mjs.
const petKindLockKey = (group) => group.petSince || 'pet';
const petKindLocked = (group) => Boolean(group.petKindFor) && group.petKindFor === petKindLockKey(group);

/** «В колледже с …» со страницы студента прежних версий: запись принимается при обмене, но не используется. */
function normalizePresence(raw) {
  const id = String(raw.id ?? '');
  const student = String(raw.student ?? '').trim().slice(0, 200);
  if (!ID_RE.test(id) || !student || !DATE_RE.test(raw.date ?? '') || !STAMP_RE.test(raw.at ?? '')) return null;
  return { id, kind: 'presence', student, date: raw.date, at: raw.at, updatedAt: String(raw.updatedAt ?? ''), updatedBy: String(raw.updatedBy ?? '') };
}

/** Адрес студенческой страницы прежних версий: запись принимается при обмене, но не используется. */
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

/** Сколько раз и с какой паузой повторять замену файла, занятого другой программой. */
const REPLACE_TRIES = 12;
const REPLACE_PAUSE_MS = 60;

/**
 * Заменяет файл готовой копией. В Windows файл может на мгновение держать антивирус,
 * индексатор или чтение с другого устройства — тогда rename отвечает EPERM/EBUSY/EACCES.
 * Повторяем с растущей паузой (до ~5 с), а если не вышло — убираем черновик и сообщаем об ошибке.
 */
async function replaceFile(temp, target) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(temp, target);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt >= REPLACE_TRIES) {
        await fsp.rm(temp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, REPLACE_PAUSE_MS * attempt));
    }
  }
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
  // День рождения студента или преподавателя: поздравление в бегущей строке. Возраст нигде не показывается.
  if (raw.kind === 'student' || raw.kind === 'teacher') ref.birthday = DATE_RE.test(raw.birthday ?? '') ? raw.birthday : '';
  else delete ref.birthday;
  // Нет согласия на показ: на панелях студента не видно в грейде и поздравлениях.
  if ((raw.kind === 'student' || raw.kind === 'teacher') && raw.hidePublic === true) ref.hidePublic = true;
  else delete ref.hidePublic;
  if (raw.kind === 'student') {
    ref.groupId = String(raw.groupId ?? '');
    ref.ownCamera = raw.ownCamera === true;
    // Ник и привязка телефона из прежних версий (страница студента убрана) не хранятся.
    for (const field of ['nick', 'nickOk', 'phoneKey', 'phoneCode', 'phoneCodeAt', 'phoneBound', 'codeActive']) delete ref[field];
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
  if (raw.kind === 'bonus') {
    // Баллы грейда вручную: за что — в name, студент, дата и сколько (от −100 до +100, не ноль).
    ref.student = String(raw.student ?? '').trim().slice(0, 200);
    ref.date = DATE_RE.test(raw.date ?? '') ? raw.date : '';
    ref.points = Number.isInteger(raw.points) && raw.points !== 0 && Math.abs(raw.points) <= 100 ? raw.points : 0;
    ref.by = String(raw.by ?? '').trim().slice(0, 80);
    if (!ref.student || !ref.date || !ref.points) return null;
  }
  if (raw.kind === 'group') {
    ref.petName = String(raw.petName ?? '').trim().slice(0, 24);
    ref.petSince = MOMENT_RE.test(raw.petSince ?? '') ? raw.petSince : '';
    // Вид питомца: мамонт, кулунчук, куобах, бэдэр, хаар эбэ. Зайчонок из 1.56 стал куобахом.
    const petKind = raw.petKind === 'bunny' ? 'hare' : raw.petKind;
    if (PET_KINDS.includes(petKind)) ref.petKind = petKind;
    else delete ref.petKind;
    // Ключ выбора вида: на какого питомца (его дата заведения) вид уже выбран. См. petKindLocked.
    ref.petKindFor = /^[\w:.-]{0,40}$/.test(raw.petKindFor ?? '') ? String(raw.petKindFor ?? '') : '';
    if (!ref.petKindFor) delete ref.petKindFor;
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
  if (raw.kind !== 'group') delete ref.petKind;
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
const JOURNAL_FIELDS = ['title', 'type', 'date', 'start', 'end', 'allDay', 'offsite', 'cancelled', 'cancelReason', 'place', 'responsible', 'participants', 'equipment', 'equipmentQty', 'ownCameras', 'prepMinutes', 'notes', 'deadline', 'deadlineDone', 'devices', 'roles', 'handIn', 'decisions'];
const CHANGE_ACTIONS = new Set(['create', 'edit', 'delete', 'create-series', 'delete-range', 'restore', 'approve', 'decline']);

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
/** Что можно предложить изменить с панели. Тип, отметки и сдачу меняет только преподаватель. */
const PROPOSABLE = ['title', 'date', 'start', 'end', 'allDay', 'place', 'responsible', 'notes', 'participants', 'equipment', 'deadline'];
/** С панели изменения предлагают для мероприятий и заданий. */
const PROPOSAL_TYPES = new Set(['event', 'task']);

/** Предложенные с панели изменения события: ждут утверждения преподавателем. */
function normalizeProposal(raw) {
  const id = String(raw.id ?? '');
  const eventId = String(raw.eventId ?? '');
  if (!ID_RE.test(id) || !ID_RE.test(eventId) || !STAMP_RE.test(String(raw.at ?? ''))) return null;
  const source = raw.changes && typeof raw.changes === 'object' ? raw.changes : {};
  const changes = Object.fromEntries(PROPOSABLE.filter((field) => field in source).map((field) => [field, plain(source[field])]));
  if (!Object.keys(changes).length) return null;
  return {
    id,
    kind: 'proposal',
    eventId,
    base: String(raw.base ?? ''),
    title: String(raw.title ?? '').slice(0, 200),
    by: String(raw.by ?? '').slice(0, 80),
    device: String(raw.device ?? '').slice(0, 80),
    note: String(raw.note ?? '').trim().slice(0, 300),
    at: raw.at,
    changes,
    updatedAt: String(raw.updatedAt ?? ''),
    updatedBy: String(raw.updatedBy ?? ''),
  };
}

/** Оформление общее для всех устройств сети: одна запись с постоянным номером. */
const SKIN_ID = '5c1a7e00-0000-4000-8000-000000000001';
const SKIN_RE = /^[a-z]{2,20}$/;

function normalizeSkin(raw) {
  if (String(raw.id) !== SKIN_ID || !SKIN_RE.test(String(raw.mode ?? ''))) return null;
  return { id: SKIN_ID, kind: 'skin', mode: raw.mode, updatedAt: String(raw.updatedAt ?? ''), updatedBy: String(raw.updatedBy ?? '') };
}

function normalizeRecord(raw) {
  if (raw && raw.deleted === true) {
    const id = String(raw.id ?? '');
    return ID_RE.test(id)
      ? { id, deleted: true, updatedAt: String(raw.updatedAt ?? ''), updatedBy: String(raw.updatedBy ?? '') }
      : null;
  }
  if (raw?.kind === 'attendance') return normalizeAttendance(raw);
  if (raw?.kind === 'change') return normalizeChange(raw);
  if (raw?.kind === 'proposal') return normalizeProposal(raw);
  if (raw?.kind === 'skin') return normalizeSkin(raw);
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
    return (await this.records())
      .filter((record) => !record.deleted && REF_KINDS.has(record.kind));
  }

  /* Оформление */

  /** Скин для всех устройств: 'off', 'auto' (по праздникам) или конкретный. По умолчанию — по праздникам. */
  async skin() {
    return (await this.records()).find((record) => record.id === SKIN_ID && !record.deleted)?.mode ?? 'auto';
  }

  async setSkin(mode) {
    const current = (await this.records()).find((record) => record.id === SKIN_ID);
    const record = normalizeSkin({ id: SKIN_ID, kind: 'skin', mode, updatedAt: nextStamp(current?.updatedAt), updatedBy: this.deviceId });
    if (!record) throw new StoreError('invalid', 'Неверный скин');
    await this.write(record);
    return record.mode;
  }

  /* Изменения с панели на утверждение */

  /** Ждущие утверждения предложения, старые сверху. Предложения к удалённым событиям не показываются. */
  async proposals() {
    const records = await this.records();
    const events = new Set(records.filter((record) => !record.deleted && !record.kind).map((record) => record.id));
    return records
      .filter((record) => record.kind === 'proposal' && events.has(record.eventId))
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * Панель предлагает изменить мероприятие или задание. Повторное предложение с того же устройства
   * к тому же событию заменяет прежнее.
   */
  async propose(eventId, changes, note = '') {
    return this.exclusive(async () => {
      const event = (await this.list()).find((item) => item.id === eventId);
      if (!event) throw new StoreError('not-found', 'Событие не найдено');
      if (!PROPOSAL_TYPES.has(event.type)) throw new StoreError('invalid', 'Изменения предлагают только для мероприятий и заданий');
      // Оставляем только то, что действительно отличается от записанного.
      const differs = Object.fromEntries(Object.entries(changes ?? {})
        .filter(([field, value]) => PROPOSABLE.includes(field) && JSON.stringify(value ?? '') !== JSON.stringify(event[field] ?? '')));
      if (!Object.keys(differs).length) throw new StoreError('unchanged', 'Ничего не изменено');
      const previous = (await this.records()).find((record) => record.kind === 'proposal' && record.eventId === eventId && record.by === this.deviceId);
      const proposal = normalizeProposal({
        id: previous?.id ?? crypto.randomUUID(),
        eventId,
        base: event.updatedAt,
        title: event.title,
        by: this.deviceId,
        device: this.deviceName(),
        note,
        at: new Date(this.clock()).toISOString(),
        changes: differs,
        updatedAt: nextStamp(previous?.updatedAt),
        updatedBy: this.deviceId,
      });
      if (!proposal) throw new StoreError('invalid', 'Неверное предложение');
      // Проверяем, что событие с изменениями останется правильным, до того как отправлять его преподавателю.
      if (!normalizeEvent({ ...event, ...proposal.changes })) throw new StoreError('invalid', 'Неверные данные');
      await this.write(proposal);
      return proposal;
    });
  }

  /** Преподаватель утверждает предложение (изменения ложатся на текущую версию события) или отклоняет его. */
  async resolveProposal(id, approve) {
    const proposal = (await this.records()).find((record) => record.id === id && record.kind === 'proposal');
    if (!proposal) throw new StoreError('not-found', 'Предложение уже рассмотрено');
    let saved = null;
    if (approve) {
      const event = (await this.list()).find((item) => item.id === proposal.eventId);
      if (!event) throw new StoreError('not-found', 'Событие удалено');
      saved = await this.save({ ...event, ...proposal.changes }, event.updatedAt);
    }
    await this.write({ id, deleted: true, updatedAt: nextStamp(proposal.updatedAt), updatedBy: this.deviceId });
    return saved;
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
      const event = await this.readCurrent(eventId);
      if (event?.cancelled === true && status) throw new StoreError('cancelled', 'Занятие не состоялось');
      if (event?.pending === true && status) throw new StoreError('pending', 'Событие ещё не согласовано');
      // Отметка ведётся только на занятиях и мероприятиях.
      if (status && event && !event.kind && !['lesson', 'event'].includes(event.type)) throw new StoreError('no-attendance', 'Отметки нет у практики и заданий');
      if (student) {
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
    await replaceFile(temp, target);
    // Две записи подряд могут получить то же время изменения и размер: свою запись читаем заново.
    this.cache.delete(path.basename(target));
  }

  /**
   * pending: событие добавлено с панели и ждёт согласования. Признак ставит только сама программа
   * по версии: присланный с панели флаг не учитывается, а снять его можно только утверждением.
   */
  async save(input, baseUpdatedAt = null, { journal = true, pending = false } = {}) {
    const isNew = !input.id;
    const draft = normalizeEvent({
      ...input,
      id: input.id || crypto.randomUUID(),
      updatedAt: '',
      updatedBy: this.deviceId,
    });
    if (!draft) throw new StoreError('invalid', 'Проверьте название, дату и время');
    const current = isNew ? null : await this.assertUnchanged(draft.id, baseUpdatedAt);
    delete draft.pending;
    delete draft.pendingFrom;
    if (isNew ? pending : current.pending) {
      draft.pending = true;
      draft.pendingFrom = isNew ? this.deviceName() : current.pendingFrom ?? '';
    }
    if (current && LOCKED_FIELDS.some((field) => JSON.stringify(current[field]) !== JSON.stringify(draft[field]))) {
      await this.assertNotLocked(draft.id);
    }
    const event = { ...draft, updatedAt: nextStamp(current?.updatedAt) };
    if (isNew && !event.createdAt) event.createdAt = new Date(this.clock()).toISOString();
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
    await this.write(ref);
    return ref;
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

  /** Преподаватель согласует событие, добавленное с панели: оно становится обычным. */
  async approve(id, baseUpdatedAt = null) {
    const current = await this.assertUnchanged(String(id), baseUpdatedAt);
    if (current.kind || !current.pending) throw new StoreError('not-found', 'Событие уже согласовано');
    const event = { ...current, updatedAt: nextStamp(current.updatedAt), updatedBy: this.deviceId };
    delete event.pending;
    delete event.pendingFrom;
    await this.write(event);
    await this.journal('approve', event);
    return event;
  }

  /** Преподаватель отклоняет событие, добавленное с панели: оно удаляется. */
  async decline(id, baseUpdatedAt = null) {
    const current = await this.assertUnchanged(String(id), baseUpdatedAt);
    if (current.kind || !current.pending) throw new StoreError('not-found', 'Событие уже согласовано');
    await this.write({ id: current.id, deleted: true, updatedAt: nextStamp(current.updatedAt), updatedBy: this.deviceId });
    await this.journal('decline', current);
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

module.exports = { EventStore, StoreError, normalizeEvent, normalizeRecord, revision, attendanceId, eventDiff, CHANGE_DAYS, PET_KINDS, petKindLockKey, petKindLocked };
