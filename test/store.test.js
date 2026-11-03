'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore, normalizeEvent } = require('../src/main/store');
const { loadConfig, saveConfig, parseIni } = require('../src/main/config');

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const sample = {
  title: 'Олимпиада', date: '2026-11-10', start: '10:00', end: '12:00',
  place: 'Ауд. 204', responsible: 'Лебедева О. В.',
  participants: ['Иванов', 'иванов', ' Петров ', ''], equipment: ['Проектор'], notes: '',
};

test('новое мероприятие сохраняется и читается заново другим экземпляром', async (t) => {
  const dir = tempDir(t);
  const saved = await new EventStore(dir).save(sample);
  assert.deepEqual(saved.participants, ['Иванов', 'Петров']);
  const list = await new EventStore(dir).list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Олимпиада');
  assert.equal(list[0].id, saved.id);
});

test('вторая панель видит изменения первой', async (t) => {
  const dir = tempDir(t);
  const a = new EventStore(dir);
  const b = new EventStore(dir);
  assert.equal((await b.list()).length, 0);
  const saved = await a.save(sample);
  assert.equal((await b.list()).length, 1);
  await a.save({ ...saved, title: 'Олимпиада по физике, финал' }, saved.updatedAt);
  assert.equal((await b.list())[0].title, 'Олимпиада по физике, финал');
  const [current] = await b.list();
  await a.remove(current.id, current.updatedAt);
  assert.equal((await b.list()).length, 0);
});

test('устаревшее изменение отклоняется и данные не теряются', async (t) => {
  const store = new EventStore(tempDir(t));
  const original = await store.save(sample);
  await new Promise((r) => setTimeout(r, 5));
  const fromPanelA = await store.save({ ...original, title: 'С панели А' }, original.updatedAt);
  await assert.rejects(store.save({ ...original, title: 'С панели Б' }, original.updatedAt), { code: 'conflict' });
  await assert.rejects(store.remove(original.id, original.updatedAt), { code: 'conflict' });
  assert.equal((await store.list())[0].title, fromPanelA.title);
});

test('изменение мероприятия, удалённого на другой панели, отклоняется', async (t) => {
  const store = new EventStore(tempDir(t));
  const saved = await store.save(sample);
  await store.remove(saved.id, saved.updatedAt);
  await assert.rejects(store.save({ ...saved, title: 'x' }, saved.updatedAt), { code: 'conflict' });
  assert.equal((await store.list()).length, 0);
  assert.equal((await store.records())[0].deleted, true);
});

test('новая версия позже предыдущей, даже если часы отстают', async (t) => {
  const store = new EventStore(tempDir(t), 'dev-a');
  const future = new Date(Date.now() + 86400000).toISOString();
  const saved = await store.save(sample);
  await store.merge([{ ...saved, updatedAt: future, updatedBy: 'dev-b' }]);
  const edited = await store.save({ ...saved, title: 'Правка' }, future);
  assert.ok(edited.updatedAt > future);
  assert.equal(edited.updatedBy, 'dev-a');
});

test('слияние оставляет более новую версию', async (t) => {
  const store = new EventStore(tempDir(t));
  const saved = await store.save(sample);
  const older = { ...saved, title: 'Старое', updatedAt: '2020-01-01T00:00:00.000Z' };
  const newer = { ...saved, title: 'Новое', updatedAt: '2099-01-01T00:00:00.000Z' };
  assert.equal(await store.merge([older]), 0);
  assert.equal(await store.merge([newer]), 1);
  assert.equal(await store.merge([newer]), 0);
  assert.equal((await store.list())[0].title, 'Новое');
});

test('отметка об удалении побеждает старую версию и уступает новой', async (t) => {
  const store = new EventStore(tempDir(t));
  const saved = await store.save(sample);
  const gone = { id: saved.id, deleted: true, updatedAt: '2090-01-01T00:00:00.000Z', updatedBy: 'x' };
  await store.merge([gone]);
  assert.equal((await store.list()).length, 0);
  await store.merge([saved]);
  assert.equal((await store.list()).length, 0);
  await store.merge([{ ...saved, updatedAt: '2095-01-01T00:00:00.000Z' }]);
  assert.equal((await store.list()).length, 1);
});

test('слияние отбрасывает неверные записи', async (t) => {
  const dir = tempDir(t);
  const store = new EventStore(dir);
  const saved = await store.save(sample);
  const changed = await store.merge([
    { ...saved, id: '../../evil', updatedAt: '2099-01-01T00:00:00.000Z' },
    { ...saved, updatedAt: 'когда-нибудь' },
    { id: saved.id, deleted: true, updatedAt: 'x' },
    null,
  ]);
  assert.equal(changed, 0);
  assert.equal((await store.list()).length, 1);
});

test('повреждённые и посторонние файлы не мешают чтению', async (t) => {
  const dir = tempDir(t);
  const store = new EventStore(dir);
  await store.save(sample);
  fs.writeFileSync(path.join(dir, 'events', 'broken.json'), '{ обрыв');
  fs.writeFileSync(path.join(dir, 'events', 'wrong.json'), '{"title":"без даты"}');
  fs.writeFileSync(path.join(dir, 'events', 'x.json.1.tmp'), 'запись идёт');
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  assert.equal((await store.list()).length, 1);
});

test('справочники хранятся отдельно от мероприятий и переживают перезапуск', async (t) => {
  const dir = tempDir(t);
  const store = new EventStore(dir);
  await store.save(sample);
  const group = await store.saveRef({ kind: 'group', name: ' ИС-21 ' });
  await store.saveRef({ kind: 'student', name: 'Иванов Иван', groupId: group.id });
  await store.saveRef({ kind: 'equipment', name: 'Проектор' });
  await store.saveRef({ kind: 'teacher', name: 'Лебедева О. В.' });
  const again = new EventStore(dir);
  assert.equal((await again.list()).length, 1);
  const refs = await again.directory();
  assert.deepEqual(refs.map((r) => r.kind).sort(), ['equipment', 'group', 'student', 'teacher']);
  assert.equal(refs.find((r) => r.kind === 'group').name, 'ИС-21');
});

test('запись справочника меняется и удаляется с проверкой версии', async (t) => {
  const store = new EventStore(tempDir(t));
  const item = await store.saveRef({ kind: 'teacher', name: 'Старое' });
  const renamed = await store.saveRef({ ...item, name: 'Новое' }, item.updatedAt);
  await assert.rejects(store.saveRef({ ...item, name: 'Другое' }, item.updatedAt), { code: 'conflict' });
  await store.remove(renamed.id, renamed.updatedAt);
  assert.equal((await store.directory()).length, 0);
});

test('неверные записи справочника не принимаются', async (t) => {
  const store = new EventStore(tempDir(t));
  await assert.rejects(store.saveRef({ kind: 'teacher', name: '  ' }), { code: 'invalid' });
  await assert.rejects(store.saveRef({ kind: 'student', name: 'Без группы' }), { code: 'invalid' });
  await assert.rejects(store.saveRef({ kind: 'admin', name: 'x' }), { code: 'invalid' });
});

test('неверные данные не записываются', async (t) => {
  const store = new EventStore(tempDir(t));
  await assert.rejects(store.save({ ...sample, title: '  ' }), { code: 'invalid' });
  await assert.rejects(store.save({ ...sample, end: '09:00' }), { code: 'invalid' });
  await assert.rejects(store.save({ ...sample, end: '12:00', start: '12:00' }), { code: 'invalid' });
  await assert.rejects(store.save({ ...sample, date: '10.11.2026' }), { code: 'invalid' });
});

test('идентификатор не может вывести запись за пределы папки', async (t) => {
  const dir = tempDir(t);
  const store = new EventStore(dir);
  await assert.rejects(store.save({ ...sample, id: '../../evil' }, 'x'), { code: 'invalid' });
  await assert.rejects(store.remove('../../evil', 'x'), { code: 'invalid' });
  assert.equal(normalizeEvent({ ...sample, id: '..\\evil', updatedAt: '' }), null);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.json')));
});

test('недоступная папка даёт ошибку, а не падение', async (t) => {
  const notAFolder = path.join(tempDir(t), 'file.txt');
  fs.writeFileSync(notAFolder, '');
  const store = new EventStore(notAFolder);
  await assert.rejects(store.list());
  await assert.rejects(store.save(sample));
});

test('настройки: значения по умолчанию, запись и файл от NSIS', (t) => {
  const home = tempDir(t);
  const first = loadConfig(home);
  assert.equal(first.dataDir, path.join(home, 'data'));
  assert.equal(first.fullscreen, true);
  assert.equal(first.deviceName, os.hostname());
  assert.match(first.deviceId, /^[0-9a-f-]{36}$/);
  assert.equal(loadConfig(home).deviceId, first.deviceId, 'номер устройства не меняется между запусками');
  saveConfig(home, { ...first, fullscreen: false, syncKey: 'ABCD-EFGH-IJKL', peers: ['10.0.2.5', '10.0.3.7:47800'], showAll: true, deviceName: 'Ауд. 204' });
  const again = loadConfig(home);
  assert.deepEqual(again.peers, ['10.0.2.5', '10.0.3.7:47800']);
  assert.equal(again.syncKey, 'ABCD-EFGH-IJKL');
  assert.equal(again.deviceName, 'Ауд. 204');
  assert.equal(again.showAll, true);
  assert.equal(again.fullscreen, false);
  assert.deepEqual(parseIni('\uFEFF[calendar]\r\ndataDir=\\\\srv\\a=b\r\n; комментарий\r\n'), { dataDir: '\\\\srv\\a=b' });
});
