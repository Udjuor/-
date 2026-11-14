'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore } = require('../src/main/store');
const { SyncNode, generateKey, seal, open, deriveKey } = require('../src/main/sync');

const KEY = 'TEST1-TEST2-TEST3-TEST4';
const sample = { title: 'Олимпиада', date: '2026-11-10', start: '10:00', end: '12:00', participants: ['Иванов И.'] };

async function device(t, name, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-sync-'));
  const store = new EventStore(dir, name);
  const node = new SyncNode({
    store, device: { id: name, name }, networkKey: KEY, port: 0, discoveryPort: 0, discoveryTargets: [], timers: false, ...options,
  });
  await node.start();
  node.at = `127.0.0.1:${node.port}`;
  t.after(async () => {
    await node.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { node, store };
}

test('новое мероприятие передаётся в обе стороны', async (t) => {
  const teacher = await device(t, 'teacher');
  const room = await device(t, 'room');
  await teacher.store.save(sample);
  await room.store.save({ ...sample, title: 'Совет' });
  assert.equal(await teacher.node.syncWith(room.node.at), true);
  const titles = async (d) => (await d.store.list()).map((e) => e.title).sort();
  assert.deepEqual(await titles(teacher), ['Олимпиада', 'Совет']);
  assert.deepEqual(await titles(room), ['Олимпиада', 'Совет']);
});

test('правка и удаление доходят до другого устройства', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  const saved = await a.store.save(sample);
  await a.node.syncWith(b.node.at);
  const edited = await b.store.save({ ...saved, title: 'Финал' }, saved.updatedAt);
  await a.node.syncWith(b.node.at);
  assert.equal((await a.store.list())[0].title, 'Финал');
  await a.store.remove(edited.id, edited.updatedAt);
  await b.node.syncWith(a.node.at);
  assert.equal((await b.store.list()).length, 0);
});

test('удаление не отменяется устройством, которое было выключено', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  const saved = await a.store.save(sample);
  await a.node.syncWith(b.node.at);
  await a.store.remove(saved.id, saved.updatedAt);
  await b.node.syncWith(a.node.at); // у b ещё старая копия
  await a.node.syncWith(b.node.at);
  assert.equal((await a.store.list()).length, 0);
  assert.equal((await b.store.list()).length, 0);
});

test('запись доходит через третье устройство, когда автор уже выключен', async (t) => {
  const teacher = await device(t, 'teacher');
  const hub = await device(t, 'hub');
  const room = await device(t, 'room');
  await teacher.store.save(sample);
  await teacher.node.syncWith(hub.node.at);
  await teacher.node.stop();
  await room.node.syncWith(hub.node.at);
  assert.equal((await room.store.list())[0].title, 'Олимпиада');
});

test('при одновременной правке все устройства приходят к одной версии', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  const saved = await a.store.save(sample);
  await a.node.syncWith(b.node.at);
  await new Promise((r) => setTimeout(r, 5));
  await a.store.save({ ...saved, title: 'С первого' }, saved.updatedAt);
  await new Promise((r) => setTimeout(r, 5));
  await b.store.save({ ...saved, title: 'Со второго' }, saved.updatedAt);
  await a.node.syncWith(b.node.at);
  assert.equal((await a.store.list())[0].title, 'Со второго');
  assert.equal((await b.store.list())[0].title, 'Со второго');
});

test('справочники и их удаление расходятся как мероприятия', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  const group = await a.store.saveRef({ kind: 'group', name: 'ИС-21' });
  const student = await a.store.saveRef({ kind: 'student', name: 'Иванов Иван', groupId: group.id });
  await a.node.syncWith(b.node.at);
  assert.equal((await b.store.directory()).length, 2);
  await b.store.remove(student.id, student.updatedAt);
  await a.node.syncWith(b.node.at);
  assert.deepEqual((await a.store.directory()).map((r) => r.name), ['ИС-21']);
});

test('отметка с панели без связи не меняет зафиксированный отчёт', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  const event = await a.store.save({ ...sample, participants: ['Иванов', 'Петров'] });
  await a.node.syncWith(b.node.at);
  await a.store.saveMark(event.id, 'Иванов', 'present');
  await a.store.lockReport(event.id, 'Лебедева');
  await new Promise((r) => setTimeout(r, 5));
  await b.store.saveMark(event.id, 'Петров', 'present'); // панель b ещё не знает о фиксации
  await a.node.syncWith(b.node.at);
  await b.node.syncWith(a.node.at);
  await a.node.syncWith(b.node.at);
  for (const d of [a, b]) {
    const [doc] = await d.store.attendance();
    assert.equal(doc.lock.teacher, 'Лебедева');
    assert.deepEqual(Object.keys(doc.marks), ['Иванов']);
  }
});

test('начало занятия расходится по сети, последнее исправление побеждает', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  const event = await a.store.save({ ...sample, type: 'lesson', participants: ['Иванов'] });
  await a.node.syncWith(b.node.at);
  await a.store.startLesson(event.id, { admin: true, at: '2026-11-10T01:30:00.000Z' });
  await b.store.saveMark(event.id, 'Иванов', 'present', { student: true });
  await new Promise((r) => setTimeout(r, 5));
  await a.node.syncWith(b.node.at);
  await b.node.syncWith(a.node.at);
  await new Promise((r) => setTimeout(r, 5));
  await b.store.startLesson(event.id, { admin: true, at: '2026-11-10T01:35:00.000Z' });
  await b.node.syncWith(a.node.at);
  await a.node.syncWith(b.node.at);
  for (const d of [a, b]) {
    const [doc] = await d.store.attendance();
    assert.equal(doc.start.at, '2026-11-10T01:35:00.000Z');
    assert.equal(doc.marks['Иванов'].status, 'present');
  }
});

test('отчёт, зафиксированный с двух компьютеров без связи, остаётся один', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  const event = await a.store.save({ ...sample, participants: ['Иванов'] });
  await a.node.syncWith(b.node.at);
  await a.store.lockReport(event.id, 'Кабинет 1');
  await new Promise((r) => setTimeout(r, 5));
  await b.store.lockReport(event.id, 'Кабинет 2');
  await a.node.syncWith(b.node.at);
  await b.node.syncWith(a.node.at);
  await a.node.syncWith(b.node.at);
  for (const d of [a, b]) {
    const docs = await d.store.attendance();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].lock.teacher, 'Кабинет 1', 'первая фиксация и остаётся');
  }
});

test('исправления с разных устройств сохраняются в истории', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  const event = await a.store.save({ ...sample, participants: ['Иванов', 'Петров'] });
  await a.store.lockReport(event.id, 'Лебедева');
  await a.node.syncWith(b.node.at);
  await a.store.saveMark(event.id, 'Иванов', 'sick', { teacher: 'Лебедева' });
  await new Promise((r) => setTimeout(r, 5));
  await b.store.saveMark(event.id, 'Петров', 'order', { teacher: 'Павлов' });
  await a.node.syncWith(b.node.at);
  await b.node.syncWith(a.node.at);
  await a.node.syncWith(b.node.at);
  for (const d of [a, b]) {
    const [doc] = await d.store.attendance();
    assert.equal(doc.history.length, 2);
    assert.deepEqual([doc.marks['Иванов'].status, doc.marks['Петров'].status], ['sick', 'order']);
  }
});

test('отметки разных панелей по одной паре объединяются, а не затирают друг друга', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  const event = await a.store.save({ ...sample, participants: ['Иванов', 'Петров', 'Сидоров'] });
  await a.node.syncWith(b.node.at);
  await a.store.saveMark(event.id, 'Иванов', 'present');
  await a.store.saveMark(event.id, 'Сидоров', 'present');
  await new Promise((r) => setTimeout(r, 5));
  await b.store.saveMark(event.id, 'Петров', 'sick');
  await new Promise((r) => setTimeout(r, 5));
  await a.store.saveMark(event.id, 'Сидоров', 'order'); // новее у a, но у b есть своя отметка
  await a.node.syncWith(b.node.at);
  await b.node.syncWith(a.node.at);
  await a.node.syncWith(b.node.at);
  const view = async (d) => Object.fromEntries(Object.entries((await d.store.attendance())[0].marks).map(([n, m]) => [n, m.status]));
  const expected = { Иванов: 'present', Петров: 'sick', Сидоров: 'order' };
  assert.deepEqual(await view(a), expected);
  assert.deepEqual(await view(b), expected);
  assert.equal((await a.store.records()).filter((r) => r.kind !== 'change').length, 2);
});

test('устройства завершают обмен отметками, а не пересылают их бесконечно', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  const event = await a.store.save(sample);
  await a.store.saveMark(event.id, 'Иванов', 'present');
  await b.store.saveMark(event.id, 'Петров', 'present');
  await a.node.syncWith(b.node.at);
  await a.node.syncWith(b.node.at);
  await b.node.syncWith(a.node.at);
  const stamp = async (d) => (await d.store.attendance())[0].updatedAt;
  const before = [await stamp(a), await stamp(b)];
  assert.equal(before[0], before[1]);
  await a.node.syncWith(b.node.at);
  await b.node.syncWith(a.node.at);
  assert.deepEqual([await stamp(a), await stamp(b)], before);
});

test('снятая отметка не возвращается при обмене', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  const event = await a.store.save(sample);
  await a.store.saveMark(event.id, 'Иванов', 'present');
  await a.node.syncWith(b.node.at);
  await new Promise((r) => setTimeout(r, 5));
  await a.store.saveMark(event.id, 'Иванов', null);
  await a.node.syncWith(b.node.at);
  assert.equal((await b.store.attendance())[0].marks['Иванов'].status, null);
});

test('устройство старой версии не участвует в обмене и помечается', async (t) => {
  const current = await device(t, 'current');
  const old = await device(t, 'old', { protocol: 1 });
  await current.store.save(sample);
  assert.equal(await current.node.syncWith(old.node.at), false);
  assert.equal(current.node.manualStatus.get(old.node.at), 'outdated');
  assert.equal(await old.node.syncWith(current.node.at), false);
  assert.equal((await old.store.list()).length, 0);
});

test('устройство с другим ключом не получает данные и не может их записать', async (t) => {
  const a = await device(t, 'a');
  const stranger = await device(t, 'stranger', { networkKey: 'XXXXX-XXXXX-XXXXX-XXXXX' });
  await a.store.save(sample);
  await stranger.store.save({ ...sample, title: 'Чужое' });
  assert.equal(await stranger.node.syncWith(a.node.at), false);
  assert.equal(await a.node.syncWith(stranger.node.at), false);
  assert.equal((await a.store.list()).length, 1);
  assert.equal((await stranger.store.list()).length, 1);
  assert.equal(a.node.manualStatus.get(stranger.node.at), 'wrong-key');
});

test('запрос без ключа и повреждённое сообщение отклоняются', async (t) => {
  const a = await device(t, 'a');
  const plain = await fetch(`http://${a.node.at}/v1`, { method: 'POST', body: '{"type":"sync"}' });
  assert.equal(plain.status, 401);
  const packet = seal(deriveKey(KEY), 'request', { type: 'push', records: [] });
  packet[40] ^= 1;
  assert.equal((await fetch(`http://${a.node.at}/v1`, { method: 'POST', body: packet })).status, 401);
  const wrongPurpose = seal(deriveKey(KEY), 'response', { type: 'push', records: [] });
  assert.equal((await fetch(`http://${a.node.at}/v1`, { method: 'POST', body: wrongPurpose })).status, 401);
  assert.equal((await fetch(`http://${a.node.at}/`)).status, 404);
});

test('данные в сети не читаются без ключа', () => {
  const key = deriveKey(KEY);
  const packet = seal(key, 'request', { name: 'Иванов Иван' });
  assert.ok(!packet.includes(Buffer.from('Иванов')));
  assert.deepEqual(open(key, 'request', packet), { name: 'Иванов Иван' });
});

test('недоступное устройство не мешает обмену с остальными', async (t) => {
  const a = await device(t, 'a', { peers: ['127.0.0.1:1'] });
  const b = await device(t, 'b');
  a.node.manual.push(b.node.at);
  await a.store.save(sample);
  await a.node.round();
  assert.equal((await b.store.list()).length, 1);
  assert.equal(a.node.status().unreachable[0].status, 'offline');
});

test('адреса устройств расходятся по цепочке', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  const c = await device(t, 'c');
  await b.node.syncWith(c.node.at);
  await a.node.syncWith(b.node.at);
  assert.deepEqual([...a.node.peers.keys()].sort(), ['b', 'c']);
  await a.store.save(sample);
  await a.node.round({ all: true });
  assert.equal((await c.store.list()).length, 1);
});

test('устройства находят друг друга рассылкой и сразу обмениваются', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  await a.store.save(sample);
  a.node.discoveryTargets = [{ address: '127.0.0.1', port: b.node.socket.address().port }];
  a.node.hello();
  for (let i = 0; i < 100 && !(await b.store.list()).length; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await b.store.list()).length, 1);
  assert.equal(b.node.peers.get('a').status, 'ok');
});

test('пакет рассылки с чужим ключом игнорируется', async (t) => {
  const a = await device(t, 'a');
  const socket = dgram.createSocket('udp4');
  t.after(() => socket.close());
  const packet = seal(deriveKey('ДРУГОЙ-КЛЮЧ'), 'hello', { id: 'x', name: 'x', port: 1 });
  await new Promise((r) => socket.send(packet, a.node.socket.address().port, '127.0.0.1', r));
  await new Promise((r) => socket.send(Buffer.from('мусор'), a.node.socket.address().port, '127.0.0.1', r));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(a.node.peers.size, 0);
});

test('изменение рассылается само и сообщает странице', async (t) => {
  let notified = 0;
  const b = await device(t, 'b', { onChange: () => { notified += 1; } });
  const a = await device(t, 'a', { peers: [b.node.at] });
  await a.store.save(sample);
  a.node.nudge();
  for (let i = 0; i < 150 && !notified; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(notified, 1);
});

test('список устройств переживает перезапуск', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cal-peers-')), 'peers.json');
  const a = await device(t, 'a', { peersFile: file });
  const b = await device(t, 'b');
  a.node.manual.push(b.node.at);
  await a.node.round();
  await new Promise((r) => setTimeout(r, 50));
  const reopened = new SyncNode({ store: a.store, device: { id: 'a', name: 'a' }, networkKey: KEY, peersFile: file });
  assert.equal(reopened.peers.get('b').name, 'b');
});

test('сгенерированный ключ длинный и случайный', () => {
  assert.match(generateKey(), /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  assert.notEqual(generateKey(), generateKey());
});

/** Порт, на котором точно никто не слушает: «программа на том компьютере не запущена». */
async function closedPort() {
  const server = require('node:net').createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `127.0.0.1:${port}`;
}

test('проверка связи: кто на связи, кто выключен, кто с другим ключом', async (t) => {
  const closed = await closedPort();
  const panel = await device(t, 'panel', { version: '1.38.0', edition: 'client' });
  const teacher = await device(t, 'teacher', { version: '1.38.0', edition: 'admin' });
  const stranger = await device(t, 'stranger', { networkKey: 'OTHER-OTHER-OTHER-OTHER' });
  await teacher.store.save(sample);
  await panel.node.addManual(teacher.node.at);
  await panel.node.addManual(stranger.node.at);
  await panel.node.addManual(closed);
  const report = await panel.node.diagnose({ listenMs: 10 });
  const by = (address) => report.peers.find((p) => p.address === address);
  assert.equal(by(teacher.node.at).status, 'ok');
  assert.equal(by(teacher.node.at).name, 'teacher');
  assert.equal(by(teacher.node.at).version, '1.38.0');
  assert.equal(by(teacher.node.at).edition, 'admin');
  assert.equal(by(teacher.node.at).count, (await teacher.store.records()).length);
  assert.equal(by(stranger.node.at).status, 'wrong-key');
  assert.equal(by(closed).status, 'refused');
  assert.equal(report.listening, true);
  assert.match(report.device.keyPrint, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal(report.device.keyPrint, teacher.node.print, 'одинаковый ключ — одинаковый отпечаток');
  assert.notEqual(stranger.node.print, teacher.node.print);
});

test('встречная проверка показывает, доходят ли другие до этого устройства', async (t) => {
  const teacher = await device(t, 'teacher', { version: '1.38.0' });
  const panel = await device(t, 'panel', { version: '1.38.0' });
  await panel.node.addManual(teacher.node.at);
  const closed = await closedPort();
  const ok = await teacher.node.request(panel.node.at, { type: 'probe', targets: [teacher.node.at, 'not-an-address', closed] });
  assert.deepEqual(ok.results.map((r) => r.status), ['ok', 'refused'], 'чужие строки вместо адреса отбрасываются');
});

test('проверка связи не шлёт старым версиям незнакомый запрос, а обменивается как обычно', async (t) => {
  const panel = await device(t, 'panel', { version: '1.38.0' });
  const old = await device(t, 'old');
  await old.store.save(sample);
  await panel.node.syncWith(old.node.at);
  const report = await panel.node.diagnose({ listenMs: 10 });
  assert.equal(report.peers.find((p) => p.name === 'old').status, 'ok');
  assert.equal((await panel.store.list()).length, 1);
});

test('долго нет связи — поиск устройств перезапускается сам, раз в 15 минут', async (t) => {
  let now = Date.parse('2026-11-14T10:00:00Z');
  const { HEAL_MS } = require('../src/main/sync');
  const panel = await device(t, 'panel', { clock: () => now, peers: [await closedPort()] });
  await panel.node.round();
  assert.equal(panel.node.heals, 0);
  now += HEAL_MS + 1000;
  await panel.node.round();
  assert.equal(panel.node.heals, 1);
  assert.equal(panel.node.discoveryReady, true, 'поиск снова открыт');
  await panel.node.round();
  assert.equal(panel.node.heals, 1, 'не чаще раза в 15 минут');
});

test('забыть старые адреса: остаются только те, с кем есть связь', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  await a.node.syncWith(b.node.at);
  a.node.remember('gone', 'Старая панель', '10.9.9.9:47800');
  assert.equal(a.node.forgetStale(), 1);
  assert.deepEqual([...a.node.peers.keys()], ['b']);
});

test('адрес вручную проверяется и сразу даёт обмен', async (t) => {
  const a = await device(t, 'a');
  const b = await device(t, 'b');
  await b.store.save(sample);
  await assert.rejects(a.node.addManual('панель 214'), { code: 'bad-address' });
  assert.deepEqual(await a.node.addManual(b.node.at), { address: b.node.at, status: 'ok' });
  assert.equal((await a.store.list()).length, 1);
});
