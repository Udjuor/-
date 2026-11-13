'use strict';
// Студенческая страница: Kerdiis на компьютере колледжа отдаёт её телефонам
// в сети колледжа. Студент видит только своё: занятия дня, задания, сроки,
// ожидание справки, свои опоздания и пропуски. Изменить он может только
// отметку «в колледже», которая ставится, когда он открывает страницу.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORTAL_PORT = 47880;
const PAGE_DIR = path.join(__dirname, '..', 'portal');
const ICON = path.join(__dirname, '..', 'renderer', 'icon.png');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/portal.js': ['portal.js', 'text/javascript; charset=utf-8'],
  '/portal.css': ['portal.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
};
const MAX_BODY = 2048;
/** Подбор кода: не больше 20 ошибок за 10 минут с одного адреса.
 *  Телефоны за роутером Kerdiis_FVT приходят с одного адреса, поэтому запас на опечатки всего класса. */
const BIND_FAILS = 20;
const BIND_WINDOW_MS = 10 * 60_000;
const UPCOMING_DAYS = 14;
/** За сколько минут до начала пары открытие страницы уже отмечает на ней. */
const AUTO_MARK_BEFORE_MINUTES = 60;

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

const pad = (n) => String(n).padStart(2, '0');
const localParts = (ms) => {
  const d = new Date(ms);
  return { iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
};
const timeOf = (iso) => localParts(Date.parse(iso)).time;
const sameName = (a, b) => a.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е') === b.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');

class StudentPortal {
  /**
   * @param options.store хранилище Kerdiis
   * @param options.logic правила учёта (logic.mjs)
   * @param options.clock текущее время в мс
   * @param options.onChange вызывается после записи: пусть изменения разойдутся по сети
   */
  constructor({ store, logic, clock = () => Date.now(), onChange = () => {}, port = PORTAL_PORT, host = '0.0.0.0' }) {
    this.store = store;
    this.logic = logic;
    this.clock = clock;
    this.onChange = onChange;
    this.port = port;
    this.host = host;
    this.fails = new Map(); // адрес → [время ошибок]
    this.server = null;
  }

  start() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error('Студенческая страница:', err.message);
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
    res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://portal');
    if (req.method === 'GET' && FILES[url.pathname]) {
      const [file, type] = FILES[url.pathname];
      res.writeHead(200, { ...HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(await fs.readFile(path.join(PAGE_DIR, file)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/icon.png') {
      res.writeHead(200, { ...HEADERS, 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      res.end(await fs.readFile(ICON));
      return;
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) {
      this.json(res, 404, { error: 'not-found' });
      return;
    }
    // Запросы только со своей страницы: чужой сайт не отправит их от имени телефона.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) {
      this.json(res, 403, { error: 'origin' });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      this.json(res, err.code === 'too-big' ? 413 : 400, { error: 'body' });
      return;
    }
    if (url.pathname === '/api/bind') return this.bind(req, res, body);
    if (url.pathname === '/api/open') return this.open(req, res);
    this.json(res, 404, { error: 'not-found' });
  }

  /** Привязка телефона: код от куратора и ник. */
  async bind(req, res, body) {
    const address = req.socket.remoteAddress ?? '';
    const now = this.clock();
    const recent = (this.fails.get(address) ?? []).filter((at) => now - at < BIND_WINDOW_MS);
    if (recent.length >= BIND_FAILS) {
      this.json(res, 429, { error: 'too-many' });
      return;
    }
    try {
      const { token } = await this.store.bindPhone(body.code, body.nick);
      this.fails.delete(address);
      this.onChange();
      this.json(res, 200, { token });
    } catch (err) {
      if (!['bad-code', 'bad-nick', 'nick-taken'].includes(err.code)) throw err;
      if (err.code === 'bad-code') this.fails.set(address, [...recent, now]);
      this.json(res, 400, { error: err.code });
    }
  }

  /** Студент открыл страницу: отметка «в колледже» и всё его на сегодня. */
  async open(req, res) {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const student = await this.store.studentByToken(token);
    if (!student) {
      this.json(res, 401, { error: 'unbound' });
      return;
    }
    const now = this.clock();
    const before = (await this.store.presenceOn(localParts(now).iso)).some((p) => sameName(p.student, student.name));
    const presence = await this.store.markPresence(student.name, new Date(now).toISOString());
    const marked = await this.autoMark(student, now);
    if (!before || marked) this.onChange();
    this.json(res, 200, await this.summary(student, presence, now));
  }

  /**
   * Предварительная отметка «пришёл» на идущей паре и на той, что начнётся в ближайший час.
   * Время — момент, когда студент открыл страницу. Поставленные отметки не меняются.
   */
  async autoMark(student, now) {
    const L = this.logic;
    const { iso, time } = localParts(now);
    const events = await this.store.list();
    const docOf = new Map((await this.store.attendance()).map((doc) => [doc.eventId, doc]));
    let marked = 0;
    for (const event of events) {
      if (event.date !== iso || !event.participants.some((name) => sameName(name, student.name))) continue;
      if (event.offsite || event.cancelled) continue; // пару в другом учреждении или отменённую с телефона не отметить
      const state = L.eventState(event, iso, time);
      const soon = state === 'future' && L.toMinutes(event.start) - L.toMinutes(time) <= AUTO_MARK_BEFORE_MINUTES;
      if (state !== 'now' && !soon) continue;
      const row = L.rollCall(event, docOf.get(event.id), iso, time, events).find((r) => sameName(r.name, student.name));
      if (!row || row.status !== 'pending') continue;
      const doc = await this.store.saveMark(event.id, row.name, 'present', { at: new Date(now).toISOString(), auto: true, student: true, onlyIfEmpty: true });
      if (doc?.marks?.[row.name]?.auto) marked += 1;
    }
    return marked;
  }

  /** Сводка для студента. Имена других студентов в неё не попадают. */
  async summary(student, presence, now) {
    const L = this.logic;
    const { iso, time } = localParts(now);
    const moment = `${iso}T${time}`;
    const events = await this.store.list();
    const docs = await this.store.attendance();
    const docOf = new Map(docs.map((doc) => [doc.eventId, doc]));
    const mine = events.filter((event) => event.participants.some((name) => sameName(name, student.name)));
    const row = (event) => L.rollCall(event, docOf.get(event.id), iso, time, events).find((r) => sameName(r.name, student.name));
    const brief = (event) => ({
      id: event.id,
      title: event.title,
      type: event.type,
      typeName: L.typeName(event.type),
      date: event.date,
      start: event.start,
      end: event.end,
      place: event.place ?? '',
      responsible: event.responsible ?? '',
      offsite: event.offsite === true,
      cancelled: event.cancelled === true,
      cancelReason: event.cancelReason ?? '',
    });
    const statusOf = (event) => {
      if (event.cancelled) return { code: 'cancelled', text: event.cancelReason ? `Не состоялось: ${event.cancelReason}` : 'Не состоялось' };
      const r = row(event);
      if (!r) return null;
      let text = L.statusName(r.status) ?? '';
      if (r.status === 'present' && r.late > 0) text = `Опоздание ${r.late} мин`;
      if (r.status === 'present' && !r.late && r.at) text = `Отмечен в ${timeOf(r.at)}`;
      if (r.status === 'present' && r.auto) text += ', ждёт подтверждения преподавателя';
      if (r.status === 'sick' && r.unconfirmed) text = 'Болезнь, ждём справку';
      if (r.status === 'order' && r.excusedFor) text = `По приказу: ${r.excusedFor.title ?? r.excusedFor}`;
      return { code: r.status === 'present' && r.late > 0 ? 'late' : r.status, text };
    };

    const today = mine.filter((event) => event.date === iso).sort(L.byTime)
      .map((event) => ({ ...brief(event), state: L.eventState(event, iso, time), status: statusOf(event) }));

    const until = L.addDays(iso, UPCOMING_DAYS);
    const upcoming = mine
      .filter((event) => event.type !== 'lesson' && !event.cancelled && event.date > iso && event.date <= until)
      .sort((a, b) => a.date.localeCompare(b.date) || L.byTime(a, b))
      .map(brief);

    const deadlines = mine
      .filter((event) => event.deadline && !event.cancelled && L.deadlineState(event, moment) !== 'done')
      .sort((a, b) => a.deadline.localeCompare(b.deadline))
      .map((event) => ({ ...brief(event), deadline: event.deadline, state: L.deadlineState(event, moment) }));

    const waiting = L.pendingCertificates(docs, events).find((person) => sameName(person.name, student.name));

    // Свои итоги за месяц по занятиям, где велась отметка.
    const month = { lessons: 0, late: 0, lateMinutes: 0, absent: 0, valid: 0 };
    for (const event of mine) {
      if (event.cancelled || event.date.slice(0, 7) !== iso.slice(0, 7) || event.date > iso || !docOf.get(event.id)) continue;
      const r = row(event);
      if (!r || r.status === 'pending') continue;
      month.lessons += 1;
      if (r.status === 'present' && r.late > 0) {
        month.late += 1;
        month.lateMinutes += r.late;
      }
      if (r.status === 'absent') month.absent += 1;
      if (['sick', 'order', 'excused'].includes(r.status)) month.valid += 1;
    }

    // Портфолио: только свои достижения и участие.
    const achievements = (await this.store.directory()).filter((ref) => ref.kind === 'achievement');
    const mineAll = L.portfolio({ name: student.name, events, attendance: docs, achievements, nowISO: iso, nowTime: time });

    return {
      portfolio: {
        counts: mineAll.counts,
        awards: mineAll.awards.map((item) => ({ date: item.date, title: item.name, result: item.result })),
        items: mineAll.items.map((item) => ({ date: item.date, title: item.title, typeName: L.typeName(item.type) })),
      },
      nick: student.nick,
      nickOk: student.nickOk,
      here: timeOf(presence.at),
      date: iso,
      today,
      upcoming,
      deadlines,
      certificate: waiting ? { from: waiting.classes[0].event.date, classes: waiting.classes.length } : null,
      month,
    };
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

module.exports = { StudentPortal, PORTAL_PORT, AUTO_MARK_BEFORE_MINUTES };
