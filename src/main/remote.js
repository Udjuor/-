'use strict';
// Расписание с телефона преподавателя: страница на компьютере преподавателя.
// Телефон подключается один раз по QR-коду с экрана компьютера и получает длинный ключ;
// без ключа страница ничего не показывает и не меняет. Из интернета страница доступна,
// только если её туда выпустили (например, KeenDNS роутера Keenetic) — сама программа
// наружу ничего не открывает.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const REMOTE_PORT = 47881;
const PAGE_DIR = path.join(__dirname, '..', 'remote');
const ICON = path.join(__dirname, '..', 'renderer', 'icon.png');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/remote.js': ['remote.js', 'text/javascript; charset=utf-8'],
  '/remote.css': ['remote.css', 'text/css; charset=utf-8'],
};
const MAX_BODY = 64 * 1024;
const PAIR_MS = 10 * 60_000;
const FAILS = 20;
const FAILS_WINDOW_MS = 10 * 60_000;
/** Поля, которые можно менять с телефона. Остальное (техника, панели, цепочки) остаётся как было. */
const EDITABLE = ['type', 'title', 'date', 'start', 'end', 'allDay', 'place', 'responsible', 'notes'];
const TYPES = ['lesson', 'event', 'practice', 'task'];
const DAYS = 14;

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const addDays = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
};

class TeacherRemote {
  /**
   * @param options.store хранилище событий
   * @param options.logic logic.mjs (groupMembers)
   * @param options.phonesFile где хранятся подключённые телефоны (только отпечатки ключей)
   * @param options.onChange после правки с телефона: обновить окно и обмен
   * @param options.today () → 'YYYY-MM-DD'
   */
  constructor({ store, logic, phonesFile, onChange = () => {}, today, clock = () => Date.now(), port = REMOTE_PORT, host = '0.0.0.0', name = '' }) {
    Object.assign(this, { store, logic, phonesFile, onChange, today, clock, port, host, name });
    this.pairing = null;
    this.fails = new Map();
    this.server = null;
    this.phones = this.loadPhones();
  }

  loadPhones() {
    try {
      const list = JSON.parse(fs.readFileSync(this.phonesFile, 'utf8'));
      return Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string' && /^[0-9a-f]{64}$/.test(p.hash)) : [];
    } catch {
      return [];
    }
  }

  async savePhones() {
    const temp = `${this.phonesFile}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(this.phones, null, 2), 'utf8');
    await fsp.rename(temp, this.phonesFile);
  }

  /** Подключённые телефоны для настроек: без ключей. */
  list() {
    return this.phones.map(({ id, name, created, lastSeen }) => ({ id, name, created, lastSeen }));
  }

  async forget(id) {
    this.phones = this.phones.filter((p) => p.id !== id);
    await this.savePhones();
  }

  /** Одноразовый код подключения на 10 минут: показывается QR-кодом только на экране компьютера. */
  newPairing() {
    const code = crypto.randomBytes(9).toString('base64url');
    this.pairing = { code, until: this.clock() + PAIR_MS };
    return { code, until: new Date(this.pairing.until).toISOString() };
  }

  start() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error('Телефон преподавателя:', err.message);
        if (!res.headersSent) this.json(res, 500, { error: 'server' });
      });
    });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  json(res, status, body) {
    res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  // Подбор ключа: считаем ошибки по адресу и все вместе (через KeenDNS все приходят с одного адреса).
  blocked(req) {
    const now = this.clock();
    const keys = [req.socket.remoteAddress ?? '', '*'];
    return keys.some((key) => {
      const recent = (this.fails.get(key) ?? []).filter((at) => now - at < FAILS_WINDOW_MS);
      this.fails.set(key, recent);
      return recent.length >= (key === '*' ? FAILS * 5 : FAILS);
    });
  }

  failed(req) {
    for (const key of [req.socket.remoteAddress ?? '', '*']) this.fails.set(key, [...(this.fails.get(key) ?? []), this.clock()]);
  }

  phoneOf(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(req.headers.authorization ?? '');
    if (!match) return null;
    const digest = hash(match[1]);
    return this.phones.find((p) => sameHash(p.hash, digest)) ?? null;
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://remote');
    if (req.method === 'GET' && FILES[url.pathname]) {
      const [file, type] = FILES[url.pathname];
      res.writeHead(200, { ...HEADERS, 'Content-Type': type });
      res.end(await fsp.readFile(path.join(PAGE_DIR, file)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/icon.png') {
      res.writeHead(200, { ...HEADERS, 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      res.end(await fsp.readFile(ICON));
      return;
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) {
      this.json(res, 404, { error: 'not-found' });
      return;
    }
    // Только со своей страницы. За KeenDNS страница открыта по https, а сюда приходит http — сравниваем имя хоста.
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* не адрес */ }
      if (host !== req.headers.host && host !== req.headers['x-forwarded-host']) {
        this.json(res, 403, { error: 'origin' });
        return;
      }
    }
    if (this.blocked(req)) {
      this.json(res, 429, { error: 'too-many' });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      this.json(res, err.code === 'too-big' ? 413 : 400, { error: 'body' });
      return;
    }
    if (url.pathname === '/api/pair') {
      await this.pair(req, res, body);
      return;
    }
    const phone = this.phoneOf(req);
    if (!phone) {
      this.failed(req);
      this.json(res, 401, { error: 'unknown' });
      return;
    }
    phone.lastSeen = new Date(this.clock()).toISOString();
    try {
      if (url.pathname === '/api/state') return this.json(res, 200, await this.state(body.from));
      if (url.pathname === '/api/save') return this.json(res, 200, await this.save(body));
      if (url.pathname === '/api/cancel') return this.json(res, 200, await this.cancel(body));
      if (url.pathname === '/api/delete') return this.json(res, 200, await this.remove(body));
    } catch (err) {
      // Ошибки хранилища — понятные коды: конфликт правок, неверное время, занято и т. п.
      return this.json(res, 409, { error: err.code ?? 'failed', message: err.message });
    }
    return this.json(res, 404, { error: 'not-found' });
  }

  async pair(req, res, body) {
    const ok = this.pairing && this.clock() < this.pairing.until && typeof body.code === 'string'
      && body.code.length === this.pairing.code.length && crypto.timingSafeEqual(Buffer.from(body.code), Buffer.from(this.pairing.code));
    if (!ok) {
      this.failed(req);
      this.json(res, 401, { error: 'pair' });
      return;
    }
    // Код одноразовый: второй телефон по тому же QR не подключится.
    this.pairing = null;
    const token = crypto.randomBytes(32).toString('base64url');
    const at = new Date(this.clock()).toISOString();
    this.phones.push({ id: crypto.randomUUID(), name: String(body.name ?? '').slice(0, 60) || 'Телефон', hash: hash(token), created: at, lastSeen: at });
    await this.savePhones();
    this.onChange('phones');
    this.json(res, 200, { token, name: this.name });
  }

  /** Расписание на две недели от даты и справочник для формы. Имён студентов на телефон не уходит. */
  async state(fromRaw) {
    const today = this.today();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw ?? '') ? fromRaw : today;
    const to = addDays(from, DAYS - 1);
    const refs = await this.store.directory();
    const groups = refs.filter((r) => r.kind === 'group');
    const students = refs.filter((r) => r.kind === 'student');
    const keyOf = this.logic.nameKey;
    const groupOf = (event) => groups.filter((g) => {
      const members = this.logic.groupMembers(g, groups, students).map((s) => keyOf(s.name));
      return members.length > 0 && members.every((m) => event.participants.some((p) => keyOf(p) === m));
    }).map((g) => g.name);
    const events = (await this.store.list())
      .filter((e) => e.date >= from && e.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))
      .map((e) => ({
        id: e.id, updatedAt: e.updatedAt, type: e.type, title: e.title, date: e.date, start: e.start, end: e.end, allDay: e.allDay,
        place: e.place, responsible: e.responsible, notes: e.notes, cancelled: e.cancelled === true, cancelReason: e.cancelReason ?? '',
        groups: groupOf(e), count: e.participants.length, series: Boolean(e.seriesId),
      }));
    return {
      name: this.name,
      today,
      from,
      to,
      events,
      groups: groups.map((g) => ({ id: g.id, name: g.name })).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      teachers: refs.filter((r) => r.kind === 'teacher').map((r) => r.name).sort((a, b) => a.localeCompare(b, 'ru')),
      places: [...new Set((await this.store.list()).map((e) => e.place).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')).slice(0, 60),
    };
  }

  async participantsOf(groupIds) {
    const refs = await this.store.directory();
    const groups = refs.filter((r) => r.kind === 'group');
    const students = refs.filter((r) => r.kind === 'student');
    const names = new Map();
    for (const id of groupIds) {
      const group = groups.find((g) => g.id === id);
      if (!group) continue;
      for (const s of this.logic.groupMembers(group, groups, students)) names.set(this.logic.nameKey(s.name), s.name);
    }
    return [...names.values()];
  }

  /** Новое событие или правка: меняются только поля формы, участники — если выбраны группы. */
  async save({ event: input, base, groupIds }) {
    if (!input || typeof input !== 'object' || !TYPES.includes(input.type)) throw Object.assign(new Error('invalid'), { code: 'invalid' });
    const fields = Object.fromEntries(EDITABLE.filter((key) => key in input).map((key) => [key, input[key]]));
    const list = await this.store.list();
    const existing = input.id ? list.find((e) => e.id === input.id) : null;
    if (input.id && !existing) throw Object.assign(new Error('gone'), { code: 'not-found' });
    const event = existing ? { ...existing, ...fields } : { participants: [], equipment: [], devices: [], ...fields };
    if (Array.isArray(groupIds)) event.participants = await this.participantsOf(groupIds.map(String).slice(0, 50));
    const saved = await this.store.save(event, existing ? base ?? existing.updatedAt : null);
    this.onChange('events');
    return { id: saved.id, updatedAt: saved.updatedAt };
  }

  async cancel({ id, base, cancelled, reason }) {
    const existing = (await this.store.list()).find((e) => e.id === id);
    if (!existing) throw Object.assign(new Error('gone'), { code: 'not-found' });
    const saved = await this.store.save({ ...existing, cancelled: cancelled === true, cancelReason: cancelled === true ? String(reason ?? '').slice(0, 200) : '' }, base ?? existing.updatedAt);
    this.onChange('events');
    return { id: saved.id, updatedAt: saved.updatedAt };
  }

  async remove({ id, base }) {
    const existing = (await this.store.list()).find((e) => e.id === id);
    if (!existing) throw Object.assign(new Error('gone'), { code: 'not-found' });
    await this.store.remove(id, base ?? existing.updatedAt);
    this.onChange('events');
    return { ok: true };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too big'), { code: 'too-big' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(value && typeof value === 'object' ? value : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

module.exports = { TeacherRemote, REMOTE_PORT };
