'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore } = require('../src/main/store');
const { TeacherRemote } = require('../src/main/remote');

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-'));
  const logic = await import('../src/renderer/logic.mjs');
  let now = new Date(2026, 10, 17, 8, 30).getTime();
  const clock = () => now;
  const store = new EventStore(dir, 'dev-1', { clock });
  const changes = [];
  const remote = new TeacherRemote({ store, logic, phonesFile: path.join(dir, 'phones.json'), clock, today: () => '2026-11-17', port: 0, host: '127.0.0.1', name: 'Кабинет 214', onChange: (what) => changes.push(what) });
  const port = await remote.start();
  t.after(async () => {
    await remote.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (route, body = {}, token = '', headers = {}) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...headers }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const group = await store.saveRef({ kind: 'group', name: 'ИС-21' });
  await store.saveRef({ kind: 'student', name: 'Иванов Иван', groupId: group.id });
  await store.saveRef({ kind: 'student', name: 'Петрова Анна', groupId: group.id });
  return { dir, store, remote, base, call, group, changes, setNow: (ms) => { now = ms; } };
}

const pairPhone = async ({ remote, call }) => {
  const { code } = remote.newPairing();
  const { status, data } = await call('/api/pair', { code, name: 'iPhone' });
  assert.equal(status, 200);
  return data.token;
};

test('без подключённого телефона страница ничего не отдаёт', async (t) => {
  const s = await setup(t);
  const res = await fetch(s.base + '/');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await s.call('/api/state')).status, 401);
  assert.equal((await s.call('/api/state', {}, 'x'.repeat(43))).status, 401);
  assert.equal((await s.call('/api/pair', { code: 'угадал' })).status, 401);
  assert.equal((await fetch(s.base + '/../main/main.js')).status, 404);
});

test('подключение по одноразовому коду: второй телефон по тому же QR не войдёт, код живёт 10 минут', async (t) => {
  const s = await setup(t);
  const { code } = s.remote.newPairing();
  const first = await s.call('/api/pair', { code, name: 'iPhone' });
  assert.equal(first.status, 200);
  assert.match(first.data.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.data.name, 'Кабинет 214');
  assert.equal((await s.call('/api/pair', { code, name: 'чужой' })).status, 401);
  // На диске только отпечаток ключа.
  assert.equal(fs.readFileSync(path.join(s.dir, 'phones.json'), 'utf8').includes(first.data.token), false);
  const late = s.remote.newPairing();
  s.setNow(new Date(2026, 10, 17, 8, 41).getTime());
  assert.equal((await s.call('/api/pair', { code: late.code })).status, 401);
  assert.deepEqual(s.remote.list().map((p) => p.name), ['iPhone']);
  // Отключённый телефон больше не пускают.
  await s.remote.forget(s.remote.list()[0].id);
  assert.equal((await s.call('/api/state', {}, first.data.token)).status, 401);
});

test('расписание с телефона: добавить по группе, перенести, отменить, вернуть, удалить', async (t) => {
  const s = await setup(t);
  const token = await pairPhone(s);
  const added = await s.call('/api/save', { event: { type: 'lesson', title: 'Сети', date: '2026-11-18', start: '10:00', end: '11:30', place: '214' }, groupIds: [s.group.id] }, token);
  assert.equal(added.status, 200, JSON.stringify(added.data));
  let event = (await s.store.list()).find((e) => e.id === added.data.id);
  assert.deepEqual(event.participants.sort(), ['Иванов Иван', 'Петрова Анна']);
  // В расписании для телефона — группы и число студентов, без фамилий.
  const state = await s.call('/api/state', {}, token);
  assert.deepEqual(state.data.events.map((e) => [e.title, e.groups, e.count]), [['Сети', ['ИС-21'], 2]]);
  assert.equal(JSON.stringify(state.data).includes('Иванов'), false);
  assert.deepEqual(state.data.groups.map((g) => g.name), ['ИС-21']);
  // Перенос: участники и остальное не трогаются, если группы не меняли.
  const moved = await s.call('/api/save', { event: { id: event.id, type: 'lesson', title: 'Сети', date: '2026-11-19', start: '12:00', end: '13:30', place: '214' }, base: event.updatedAt }, token);
  assert.equal(moved.status, 200);
  event = (await s.store.list()).find((e) => e.id === event.id);
  assert.deepEqual([event.date, event.start, event.participants.length], ['2026-11-19', '12:00', 2]);
  // Старая версия — конфликт, а не тихая перезапись.
  const stale = await s.call('/api/save', { event: { id: event.id, type: 'lesson', title: 'Старое', date: '2026-11-19', start: '12:00', end: '13:30' }, base: added.data.updatedAt }, token);
  assert.equal(stale.status, 409);
  const cancelled = await s.call('/api/cancel', { id: event.id, base: event.updatedAt, cancelled: true, reason: 'Болезнь преподавателя' }, token);
  assert.equal(cancelled.status, 200);
  event = (await s.store.list()).find((e) => e.id === event.id);
  assert.deepEqual([event.cancelled, event.cancelReason], [true, 'Болезнь преподавателя']);
  await s.call('/api/cancel', { id: event.id, base: event.updatedAt, cancelled: false }, token);
  event = (await s.store.list()).find((e) => e.id === event.id);
  assert.equal(event.cancelled, false);
  assert.equal((await s.call('/api/delete', { id: event.id, base: event.updatedAt }, token)).status, 200);
  assert.equal((await s.store.list()).length, 0);
  assert.ok(s.changes.filter((c) => c === 'events').length >= 4, 'окно программы обновляется');
});

test('запрос с чужого сайта отклоняется, неверный тип — тоже', async (t) => {
  const s = await setup(t);
  const token = await pairPhone(s);
  assert.equal((await s.call('/api/state', {}, token, { Origin: 'http://evil.example' })).status, 403);
  const bad = await s.call('/api/save', { event: { type: 'party', title: 'x', date: '2026-11-18', start: '10:00', end: '11:00' } }, token);
  assert.equal(bad.status, 409);
});
