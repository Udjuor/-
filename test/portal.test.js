'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore } = require('../src/main/store');
const { StudentPortal } = require('../src/main/portal');

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-'));
  const logic = await import('../src/renderer/logic.mjs');
  let now = new Date(2026, 10, 10, 9, 5).getTime();
  const clock = () => now;
  const store = new EventStore(dir, 'dev-1', { clock });
  let changes = 0;
  const portal = new StudentPortal({ store, logic, clock, port: 0, host: '127.0.0.1', onChange: () => { changes += 1; } });
  const port = await portal.start();
  t.after(async () => {
    await portal.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (route, body = {}, token = '', headers = {}) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...headers }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return { store, base, call, changes: () => changes, setNow: (ms) => { now = ms; } };
}

test('страница отдаётся с запретом чужих скриптов', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await res.text(), /portal\.js/);
  assert.equal((await fetch(base + '/../main/main.js')).status, 404);
  assert.equal((await fetch(base + '/icon.png')).headers.get('content-type'), 'image/png');
});

test('привязка, «в колледже», только свои занятия и итоги', async (t) => {
  const { store, call, changes } = await setup(t);
  const group = await store.saveRef({ kind: 'group', name: 'ИС-21' });
  const anna = await store.saveRef({ kind: 'student', name: 'Иванова Анна', groupId: group.id });
  await store.saveRef({ kind: 'student', name: 'Петров Олег', groupId: group.id });
  const lesson = await store.save({ type: 'lesson', title: 'Сети', date: '2026-11-10', start: '09:00', end: '10:30', participants: ['Иванова Анна', 'Петров Олег'] });
  await store.save({ type: 'lesson', title: 'Чужая пара', date: '2026-11-10', start: '11:00', end: '12:30', participants: ['Петров Олег'] });
  await store.save({ type: 'task', title: 'Съёмка концерта', date: '2026-11-12', start: '15:00', end: '17:00', participants: ['Иванова Анна'], deadline: '2026-11-14T18:00' });
  await store.saveMark(lesson.id, 'Иванова Анна', 'present', { at: new Date(2026, 10, 10, 9, 20).toISOString() });

  assert.equal((await call('/api/open', {}, 'f'.repeat(64))).status, 401);
  const code = await store.studentCode(anna.id);
  const bound = await call('/api/bind', { code, nick: 'Ануся' });
  assert.equal(bound.status, 200);
  const { status, data } = await call('/api/open', {}, bound.data.token);
  assert.equal(status, 200);
  assert.equal(data.nick, 'Ануся');
  assert.equal(data.nickOk, false);
  assert.equal(data.here, '09:05');
  assert.deepEqual(data.today.map((e) => e.title), ['Сети']);
  assert.equal(data.today[0].status.code, 'late');
  assert.match(data.today[0].status.text, /Опоздание 20 мин/);
  assert.deepEqual(data.upcoming.map((e) => e.title), ['Съёмка концерта']);
  assert.equal(data.deadlines[0].deadline, '2026-11-14T18:00');
  assert.equal(data.month.late, 1);
  assert.ok(!JSON.stringify(data).includes('Петров'), 'чужих имён нет');
  assert.ok(!JSON.stringify(data).includes('Иванова'), 'и своего ФИО тоже');
  const presence = await store.presenceOn('2026-11-10');
  assert.equal(presence.length, 1);
  assert.equal(presence[0].student, 'Иванова Анна');
  assert.ok(changes() >= 2, 'изменения уходят в сеть');
});

test('подбор кода ограничен, чужой сайт не может отправить запрос', async (t) => {
  const { call } = await setup(t);
  for (let i = 0; i < 5; i += 1) assert.equal((await call('/api/bind', { code: '00000000', nick: 'Nick' })).status, 400);
  assert.equal((await call('/api/bind', { code: '00000000', nick: 'Nick' })).status, 429);
  assert.equal((await call('/api/open', {}, '', { Origin: 'http://evil.example' })).status, 403);
});

test('открытие страницы отмечает на идущей и ближайшей паре, предварительно', async (t) => {
  const { store, call } = await setup(t); // сейчас 10.11.2026 09:05
  const group = await store.saveRef({ kind: 'group', name: 'ФВТ-24' });
  const me = await store.saveRef({ kind: 'student', name: 'Иванова Анна', groupId: group.id });
  const who = ['Иванова Анна', 'Петров Олег'];
  const running = await store.save({ type: 'lesson', title: 'Идёт', date: '2026-11-10', start: '08:30', end: '10:00', participants: who });
  const soon = await store.save({ type: 'lesson', title: 'Скоро', date: '2026-11-10', start: '10:00', end: '11:30', participants: who });
  const later = await store.save({ type: 'lesson', title: 'Позже', date: '2026-11-10', start: '12:00', end: '13:30', participants: who });
  const marked = await store.save({ type: 'lesson', title: 'Уже отмечен', date: '2026-11-10', start: '09:00', end: '10:30', participants: who });
  await store.saveMark(marked.id, 'Иванова Анна', 'sick');
  const locked = await store.save({ type: 'lesson', title: 'Зафиксирован', date: '2026-11-10', start: '08:00', end: '09:30', participants: who });
  await store.lockReport(locked.id, 'Преподаватель');

  const code = await store.studentCode(me.id);
  const { data: { token } } = await call('/api/bind', { code, nick: 'Anna' });
  const { data } = await call('/api/open', {}, token);
  const docs = new Map((await store.attendance()).map((doc) => [doc.eventId, doc]));
  const mark = (event) => docs.get(event.id)?.marks?.['Иванова Анна'];
  assert.equal(mark(running).auto, true);
  assert.equal(mark(running).at, new Date(2026, 10, 10, 9, 5).toISOString());
  assert.equal(mark(soon).auto, true, 'пара через час');
  assert.equal(mark(later), undefined, 'дальше часа не отмечается');
  assert.equal(mark(marked).status, 'sick', 'поставленное вручную не меняется');
  assert.equal(mark(locked), undefined, 'зафиксированный отчёт не трогается');
  assert.equal(docs.get(running.id).marks['Петров Олег'], undefined, 'только себя');
  const today = data.today.find((e) => e.title === 'Идёт');
  assert.match(today.status.text, /ждёт подтверждения/);

  // Опоздание считается от момента открытия: пара шла с 08:30, открыл в 09:05.
  const logic = await import('../src/renderer/logic.mjs');
  const row = logic.rollCall(running, docs.get(running.id), '2026-11-10', '09:06').find((r) => r.name === 'Иванова Анна');
  assert.equal(row.auto, true);
  assert.equal(row.late, 35);

  // Фиксация отчёта подтверждает отметку.
  await store.lockReport(running.id, 'Преподаватель');
  const after = (await store.attendance()).find((doc) => doc.eventId === running.id);
  assert.equal(after.marks['Иванова Анна'].auto, undefined);
  assert.equal(after.marks['Иванова Анна'].status, 'present');
});

test('пара вне колледжа: с телефона и с панели не отмечается, неотмеченные не прогульщики', async (t) => {
  const { store, call } = await setup(t); // сейчас 10.11.2026 09:05
  const logic = await import('../src/renderer/logic.mjs');
  const group = await store.saveRef({ kind: 'group', name: 'ФВТ-24' });
  const me = await store.saveRef({ kind: 'student', name: 'Иванова Анна', groupId: group.id });
  const pe = await store.save({ type: 'lesson', title: 'Физическая культура', date: '2026-11-10', start: '09:00', end: '10:30', offsite: true, participants: ['Иванова Анна'] });
  assert.equal(pe.offsite, true);
  const code = await store.studentCode(me.id);
  const { data: { token } } = await call('/api/bind', { code, nick: 'Anna' });
  const { data } = await call('/api/open', {}, token);
  assert.equal((await store.attendance()).length, 0, 'с телефона не отмечено');
  assert.equal(data.today[0].offsite, true);
  await assert.rejects(store.saveMark(pe.id, 'Иванова Анна', 'present', { student: true }), { code: 'offsite' });
  // После окончания неотмеченный остаётся «нет отметки», пока преподаватель не зафиксирует отчёт.
  assert.equal(logic.rollCall(pe, null, '2026-11-10', '12:00')[0].status, 'pending');
  await store.saveMark(pe.id, 'Иванова Анна', 'present', { teacher: 'Преподаватель', at: new Date(2026, 10, 10, 9, 0).toISOString() });
  assert.equal((await store.attendance())[0].marks['Иванова Анна'].status, 'present', 'преподаватель отмечает');
  const lone = await store.save({ type: 'lesson', title: 'Физкультура 2', date: '2026-11-10', start: '09:00', end: '10:30', offsite: true, participants: ['Петров'] });
  await store.lockReport(lone.id, 'Преподаватель');
  const doc = (await store.attendance()).find((d) => d.eventId === lone.id);
  assert.equal(logic.rollCall(lone, doc, '2026-11-10', '12:00')[0].status, 'absent', 'после фиксации — без причины');
});
