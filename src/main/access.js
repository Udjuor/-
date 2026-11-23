'use strict';
// Разделение данных по ПЦК. Пока разделение не включено, все устройства видят всё, как раньше.
//
// Включает его компьютер учебной части: он создаёт секрет полного доступа. Из секрета выводятся ключи
// «пропусков»: ПЦК (unit:<id>), куратора группы (group:<id>) и аудитории с панелью (room:<название>).
// Код доступа — это набор пропусков с их ключами; полный код — сам секрет.
//
// При обмене устройства доказывают пропуска: HMAC ключом пропуска от разового вызова собеседника.
// Устройство отдаёт запись, только если собеседник доказал пропуск этой записи, и само хранит только
// записи своих пропусков. Поэтому планы и расписание чужого ПЦК на компьютер не попадают вовсе.
// Справочники (группы, студенты, преподаватели, техника) и события без ПЦК — общие.
const crypto = require('node:crypto');

const CODE_PREFIX = 'KRD1-';
const ALL = 'all';
const GRANT_RE = /^(all|unit:[\w-]{1,64}|group:[\w-]{1,64}|room:.{1,80})$/;
/** Запись политики доступа: одна на сеть, общая. */
const POLICY_ID = '5c1a7e00-0000-4000-8000-0000000000ac';

const b64 = (buffer) => Buffer.from(buffer).toString('base64url');
const unb64 = (text) => Buffer.from(String(text), 'base64url');
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();

/** Ключ пропуска из секрета полного доступа. */
const grantKey = (secret, grant) => hmac(secret, `kerdiis-grant:${grant}`);
/** Отпечаток секрета: по нему узнают, что полный код от этой сети. Сам секрет из него не получить. */
const secretPrint = (secret) => crypto.createHash('sha256').update(Buffer.concat([Buffer.from('kerdiis-access:'), secret])).digest('hex').slice(0, 16);

const roomKey = (place) => String(place ?? '').trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ').slice(0, 80);

function newSecret() {
  return crypto.randomBytes(32);
}

/** Полный код: для компьютеров учебной, методической и воспитательной части. */
function fullCode(secret) {
  return CODE_PREFIX + b64(Buffer.from(JSON.stringify({ v: 1, all: b64(secret) })));
}

/** Код с пропусками: ПЦК, кураторство групп, аудитории. Выдаёт только компьютер с полным доступом. */
function grantCode(secret, grants) {
  const list = [...new Set(grants)].filter((grant) => GRANT_RE.test(grant) && grant !== ALL);
  if (!list.length) throw Object.assign(new Error('no grants'), { code: 'invalid' });
  return CODE_PREFIX + b64(Buffer.from(JSON.stringify({ v: 1, g: list.map((grant) => [grant, b64(grantKey(secret, grant))]) })));
}

/** Разбирает код. Неверный — null. */
function parseCode(code) {
  const text = String(code ?? '').replace(/\s+/g, '');
  if (!text.startsWith(CODE_PREFIX)) return null;
  try {
    const data = JSON.parse(unb64(text.slice(CODE_PREFIX.length)).toString('utf8'));
    if (data?.v !== 1) return null;
    if (typeof data.all === 'string') {
      const secret = unb64(data.all);
      return secret.length === 32 ? { secret, grants: new Map() } : null;
    }
    if (!Array.isArray(data.g) || !data.g.length || data.g.length > 200) return null;
    const grants = new Map();
    for (const item of data.g) {
      if (!Array.isArray(item) || !GRANT_RE.test(String(item[0])) || item[0] === ALL) return null;
      const key = unb64(item[1]);
      if (key.length !== 32) return null;
      grants.set(item[0], key);
    }
    return { secret: null, grants };
  } catch {
    return null;
  }
}

/**
 * Доступ этого устройства. enabled — разделение включено в сети (общая запись политики).
 * full — полный доступ (есть секрет). Без кода при включённом разделении устройство видит только общее.
 */
class Access {
  constructor(code = '') {
    const parsed = parseCode(code);
    this.secret = parsed?.secret ?? null;
    this.grants = parsed?.grants ?? new Map();
    this.code = parsed ? String(code).replace(/\s+/g, '') : '';
  }

  get full() {
    return Boolean(this.secret);
  }

  /** Названия пропусков, которые устройство заявляет собеседнику. */
  claims() {
    return this.full ? [ALL] : [...this.grants.keys()];
  }

  keyFor(grant) {
    if (this.secret) return grantKey(this.secret, grant);
    return this.grants.get(grant) ?? null;
  }

  /**
   * Доказательства для собеседника: свои пропуска, а с полным доступом — ещё и все, что он заявил.
   * Привязаны к его разовому вызову и номеру этого устройства.
   */
  prove(challenge, selfId, theirClaims = []) {
    const names = this.full ? [ALL, ...theirClaims.filter((grant) => GRANT_RE.test(grant) && grant !== ALL)] : [...this.grants.keys()];
    const proofs = {};
    for (const grant of new Set(names)) {
      const key = this.keyFor(grant);
      if (key) proofs[grant] = b64(hmac(key, `${challenge}|${selfId}`));
    }
    return proofs;
  }

  /** Пропуска собеседника, которые это устройство смогло проверить. */
  verify(proofs, challenge, peerId) {
    const ok = new Set();
    for (const [grant, proof] of Object.entries(proofs && typeof proofs === 'object' ? proofs : {})) {
      if (!GRANT_RE.test(grant)) continue;
      const key = this.keyFor(grant);
      if (!key) continue;
      const expected = hmac(key, `${challenge}|${peerId}`);
      const given = unb64(proof);
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) ok.add(grant);
    }
    return ok;
  }

  /** Совпадает ли полный код с политикой сети. */
  matches(policy) {
    return !this.secret || !policy?.print || secretPrint(this.secret) === policy.print;
  }
}

/**
 * Пропуска записей. null — запись общая. Событие относится к ПЦК, заданному в нём, а если не задан —
 * к ПЦК ответственного преподавателя. Видят его ещё кураторы групп его участников и панель его аудитории.
 * Отметки, журнал и предложения с панели идут за своим событием.
 */
function scopeContext(records) {
  const refs = records.filter((record) => !record.deleted && record.kind);
  const groups = refs.filter((ref) => ref.kind === 'group');
  const key = (name) => String(name ?? '').trim().toLowerCase().replaceAll('ё', 'е');
  const groupByName = new Map(groups.map((group) => [key(group.name), group]));
  const parentOf = (group) => {
    const base = String(group.name ?? '').trim().match(/^(.+)-\d+$/)?.[1];
    return base ? groupByName.get(key(base)) ?? null : null;
  };
  const groupsOfStudent = new Map();
  const groupById = new Map(groups.map((group) => [group.id, group]));
  for (const student of refs.filter((ref) => ref.kind === 'student')) {
    const group = groupById.get(student.groupId);
    if (!group) continue;
    const ids = [group.id, parentOf(group)?.id].filter(Boolean);
    groupsOfStudent.set(key(student.name), ids);
  }
  const teacherUnit = new Map(refs.filter((ref) => ref.kind === 'teacher' && ref.unit).map((ref) => [key(ref.name), ref.unit]));
  const events = new Map(records.filter((record) => !record.deleted && !record.kind).map((event) => [event.id, event]));
  return { key, groupsOfStudent, teacherUnit, events };
}

function eventScope(event, ctx) {
  if (event.unit === 'all') return null;
  const unit = event.unit || ctx.teacherUnit.get(ctx.key(event.responsible)) || '';
  if (!unit) return null;
  const grants = new Set([`unit:${unit}`]);
  for (const name of event.participants ?? []) for (const id of ctx.groupsOfStudent.get(ctx.key(name)) ?? []) grants.add(`group:${id}`);
  const room = roomKey(event.place);
  if (room) grants.add(`room:${room}`);
  return grants;
}

function recordScope(record, ctx) {
  if (record.deleted) return null;
  if (!record.kind) return eventScope(record, ctx);
  if (['attendance', 'change', 'proposal'].includes(record.kind)) {
    const event = ctx.events.get(record.eventId);
    // Событие ещё не пришло: отметки отдаём только полному доступу, пока не станет ясно, чьи они.
    if (!event) return record.kind === 'change' && !record.eventId ? null : new Set(['unknown']);
    return eventScope(event, ctx);
  }
  return null;
}

/** Можно ли отдать запись устройству с такими проверенными пропусками. */
function allowed(scope, grants) {
  if (!scope) return true;
  if (grants.has(ALL)) return true;
  for (const grant of scope) if (grants.has(grant)) return true;
  return false;
}

module.exports = {
  Access, ALL, CODE_PREFIX, POLICY_ID, allowed, fullCode, grantCode, grantKey, newSecret, parseCode, recordScope, roomKey, scopeContext, secretPrint,
};
