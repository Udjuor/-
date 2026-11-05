'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore } = require('../src/main/store');
const { TeacherGate } = require('../src/main/teachers');

const KEY = 'SECRET-NETWORK-KEY';
const setup = async (t, key = KEY) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-pin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new EventStore(dir, 'device');
  const clock = { now: 1_000_000 };
  const gate = new TeacherGate(store, () => key, () => clock.now);
  const teacher = await store.saveRef({ kind: 'teacher', name: 'Лебедева О. В.' });
  return { store, gate, clock, teacher };
};

test('PIN задаётся по ключу сети, а без ключа и старого PIN нет', async (t) => {
  const { gate, teacher, store } = await setup(t);
  await assert.rejects(gate.setPin(teacher.id, '', '123456'), { code: 'wrong-proof' });
  await assert.rejects(gate.setPin(teacher.id, KEY, '12345'), { code: 'invalid-pin' });
  await gate.setPin(teacher.id, KEY, '123456');
  const saved = await store.readCurrent(teacher.id);
  assert.ok(saved.pin.hash);
  assert.ok(!JSON.stringify(saved).includes('123456'), 'PIN не хранится открыто');
  await gate.setPin(teacher.id, '123456', '654321');
  await gate.login(teacher.id, '654321');
});

test('вход выдаёт сессию, которая заканчивается после простоя', async (t) => {
  const { gate, teacher, clock } = await setup(t);
  await gate.setPin(teacher.id, KEY, '123456');
  await assert.rejects(gate.login(teacher.id, '000000'), { code: 'wrong-pin' });
  const { token, name } = await gate.login(teacher.id, '123456');
  assert.equal(name, 'Лебедева О. В.');
  assert.equal(gate.session(token), name);
  clock.now += 9 * 60_000;
  assert.equal(gate.session(token), name, 'действие продлевает сессию');
  clock.now += 9 * 60_000;
  assert.equal(gate.session(token), name);
  clock.now += 11 * 60_000;
  assert.equal(gate.session(token), null);
  assert.equal(gate.session('чужой'), null);
});

test('после пяти ошибок вход блокируется на пять минут, даже с верным PIN', async (t) => {
  const { gate, teacher, clock } = await setup(t);
  await gate.setPin(teacher.id, KEY, '123456');
  for (let i = 0; i < 5; i += 1) await assert.rejects(gate.login(teacher.id, '000000'), { code: 'wrong-pin' });
  await assert.rejects(gate.login(teacher.id, '123456'), { code: 'pin-wait' });
  clock.now += 5 * 60_000 + 1;
  await gate.login(teacher.id, '123456');
});

test('забытый PIN снимается только ключом сети', async (t) => {
  const { gate, teacher, store } = await setup(t);
  await gate.setPin(teacher.id, KEY, '123456');
  await assert.rejects(gate.resetPin(teacher.id, '123456'), { code: 'wrong-proof' });
  await gate.resetPin(teacher.id, KEY);
  assert.equal((await store.readCurrent(teacher.id)).pin, null);
});

test('обычное сохранение и подмена со страницы не меняют PIN', async (t) => {
  const { gate, teacher, store } = await setup(t);
  await gate.setPin(teacher.id, KEY, '123456');
  const before = await store.readCurrent(teacher.id);
  const renamed = await store.saveRef({ ...before, name: 'Лебедева Ольга', pin: { salt: 'a', hash: 'b' }, hasPin: true }, before.updatedAt);
  assert.deepEqual(renamed.pin, before.pin);
  assert.equal(renamed.hasPin, undefined);
  const fresh = await store.saveRef({ kind: 'teacher', name: 'Самозванец', pin: { salt: 'a', hash: 'b' } });
  assert.equal(fresh.pin, null);
  await assert.rejects(store.remove(teacher.id, renamed.updatedAt), { code: 'protected' });
});
