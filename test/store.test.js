'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore, normalizeEvent, petKindLocked } = require('../src/main/store');
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
  assert.equal((await store.records()).find((r) => r.kind !== 'change').deleted, true);
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

test('количество техники и своя камера сохраняются и проверяются', async (t) => {
  const store = new EventStore(tempDir(t));
  const limited = await store.saveRef({ kind: 'equipment', name: 'Камера', quantity: 5 });
  assert.equal(limited.quantity, 5);
  assert.equal((await store.saveRef({ kind: 'equipment', name: 'Штатив', quantity: '' })).quantity, null);
  assert.equal((await store.saveRef({ kind: 'equipment', name: 'Свет', quantity: -1 })).quantity, null);
  const group = await store.saveRef({ kind: 'group', name: 'ИС-21' });
  assert.equal((await store.saveRef({ kind: 'student', name: 'А', groupId: group.id, ownCamera: true })).ownCamera, true);
  assert.equal((await store.saveRef({ kind: 'student', name: 'Б', groupId: group.id })).ownCamera, false);
  const event = await store.save({ ...sample, equipment: ['Камера'], equipmentQty: { Камера: 3, Плохое: -2 }, ownCameras: ['А'] });
  assert.deepEqual(event.equipmentQty, { Камера: 3 });
  assert.deepEqual(event.ownCameras, ['А']);
});

test('время подготовки сохраняется и проверяется', async (t) => {
  const store = new EventStore(tempDir(t));
  assert.equal((await store.save({ ...sample, prepMinutes: 45 })).prepMinutes, 45);
  assert.equal((await store.save(sample)).prepMinutes, 0);
  assert.equal((await store.save({ ...sample, prepMinutes: -5 })).prepMinutes, 0);
  assert.equal((await store.save({ ...sample, prepMinutes: 9999 })).prepMinutes, 720);
});

test('тип события сохраняется, у старых записей это мероприятие', async (t) => {
  const store = new EventStore(tempDir(t));
  assert.equal((await store.save({ ...sample, type: 'practice' })).type, 'practice');
  assert.equal((await store.save(sample)).type, 'event');
  assert.equal((await store.save({ ...sample, type: 'мусор' })).type, 'event');
});

test('поля будущих версий не теряются', () => {
  const raw = { ...sample, id: '00000000-0000-4000-8000-000000000001', futureField: 7 };
  assert.equal(normalizeEvent(raw).futureField, 7);
});

test('отметка хранит время и статус, снимается и не смешивается с другими записями', async (t) => {
  const store = new EventStore(tempDir(t), 'a');
  const event = await store.save(sample);
  await store.saveMark(event.id, 'Иванов', 'present');
  await store.saveMark(event.id, 'Петров', 'sick');
  await store.saveMark(event.id, 'Иванов', null);
  const [doc] = await store.attendance();
  assert.equal(doc.marks['Иванов'].status, null);
  assert.equal(doc.marks['Петров'].status, 'sick');
  assert.ok(Date.now() - Date.parse(doc.marks['Петров'].at) < 5000);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.directory()).length, 0);
  assert.equal((await store.records()).filter((r) => r.kind !== 'change').length, 2, 'одна запись на пару');
});

test('быстрые отметки подряд не теряются', async (t) => {
  const store = new EventStore(tempDir(t), 'a');
  const event = await store.save(sample);
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.saveMark(event.id, `Студент ${i}`, 'present')));
  assert.equal(Object.keys((await store.attendance())[0].marks).length, 30);
});

test('неверная отметка не принимается', async (t) => {
  const store = new EventStore(tempDir(t));
  const event = await store.save(sample);
  await assert.rejects(store.saveMark(event.id, 'Иванов', 'спит'), { code: 'invalid' });
  await assert.rejects(store.saveMark('../x', 'Иванов', 'present'), { code: 'invalid' });
});

test('имя питомца хранится в группе и проверяется', async (t) => {
  const store = new EventStore(tempDir(t));
  const group = await store.saveRef({ kind: 'group', name: 'ИС-21', petName: ' Пиксель ', petSince: '2026-11-03T12:00' });
  assert.equal(group.petName, 'Пиксель');
  assert.equal(group.petSince, '2026-11-03T12:00');
  const bad = await store.saveRef({ kind: 'group', name: 'ПИ-22', petName: 'x'.repeat(50), petSince: 'вчера' });
  assert.equal(bad.petName.length, 24);
  assert.equal(bad.petSince, '');
});

test('журнал смертей питомца хранится в группе', async (t) => {
  const store = new EventStore(tempDir(t));
  const group = await store.saveRef({ kind: 'group', name: 'ИС-21', petDeaths: [{ name: 'Пиксель', bornOn: '2026-10-01', diedOn: '2026-10-20', pairs: 9, лишнее: 1 }, null] });
  assert.deepEqual(group.petDeaths[0], { name: 'Пиксель', bornOn: '2026-10-01', diedOn: '2026-10-20', pairs: 9 });
  assert.equal(group.petDeaths.length, 2);
});

test('напоминание хранит цвет и срок, без срока не принимается', async (t) => {
  const store = new EventStore(tempDir(t));
  const notice = await store.saveRef({ kind: 'notice', name: 'Собрание', color: 'red', until: '2026-11-05T18:00' });
  assert.equal(notice.color, 'red');
  assert.equal((await store.saveRef({ kind: 'notice', name: 'Б', color: 'розовый', until: '2026-11-05T18:00' })).color, 'blue');
  await assert.rejects(store.saveRef({ kind: 'notice', name: 'Без срока' }), { code: 'invalid' });
  assert.equal((await store.directory()).length, 2);
});

test('срок сдачи есть только у заданий и мероприятий', async (t) => {
  const store = new EventStore(tempDir(t));
  const base = { ...sample, deadline: '2026-11-10T18:00', deadlineDone: '2026-11-09T12:00' };
  const event = await store.save({ ...base, type: 'event' });
  assert.equal(event.deadline, '2026-11-10T18:00');
  assert.equal(event.deadlineDone, '2026-11-09T12:00');
  assert.equal((await store.save({ ...base, type: 'task' })).deadline, '2026-11-10T18:00');
  const lesson = await store.save({ ...base, type: 'lesson' });
  assert.deepEqual([lesson.deadline, lesson.deadlineDone], ['', '']);
  const broken = await store.save({ ...base, type: 'task', deadline: 'завтра' });
  assert.deepEqual([broken.deadline, broken.deadlineDone], ['', ''], 'без срока отметка о сдаче не держится');
});

test('на панели отмечают присутствие и опоздание, а причины нет', async (t) => {
  const store = new EventStore(tempDir(t));
  const event = await store.save({ ...sample, participants: ['Иванов', 'Петров'] });
  const student = { student: true };
  await store.saveMark(event.id, 'Иванов', 'present', student);
  await store.saveMark(event.id, 'Иванов', null, student);
  await assert.rejects(store.saveMark(event.id, 'Иванов', 'order', student), { code: 'teacher-only' });
  await store.saveMark(event.id, 'Петров', 'present', { ...student, late: true, at: '2026-11-10T01:20:00.000Z' });
  const [doc] = await store.attendance();
  assert.deepEqual([doc.marks['Петров'].late, doc.marks['Петров'].at], [true, '2026-11-10T01:20:00.000Z']);
  await store.saveMark(event.id, 'Иванов', 'sick', { teacher: 'Кабинет' });
  await assert.rejects(store.saveMark(event.id, 'Иванов', 'present', student), { code: 'teacher-only' });
});

test('после фиксации отчёт правится только преподавателем и с историей', async (t) => {
  const store = new EventStore(tempDir(t));
  const event = await store.save({ ...sample, participants: ['Иванов', 'Петров'] });
  await store.saveMark(event.id, 'Иванов', 'present');
  const locked = await store.lockReport(event.id, 'Лебедева', { Петров: 'Концерт' });
  assert.deepEqual(locked.lock.excused, { Петров: 'Концерт' });
  await assert.rejects(store.lockReport(event.id, 'Павлов'), { code: 'locked' });
  await assert.rejects(store.saveMark(event.id, 'Петров', 'present', { student: true }), { code: 'locked' });
  await assert.rejects(store.saveMark(event.id, 'Петров', 'present'), { code: 'locked' });
  const doc = await store.saveMark(event.id, 'Петров', 'sick', { teacher: 'Павлов' });
  assert.deepEqual(doc.lock.participants, ['Иванов', 'Петров']);
  assert.equal(doc.lock.teacher, 'Лебедева', 'исправление не меняет того, кто зафиксировал');
  assert.equal(doc.history.length, 1);
  assert.equal(doc.history[0].teacher, 'Павлов');
  assert.equal(doc.history[0].before.status, null);
  assert.equal(doc.history[0].after.status, 'sick');
});

test('панель ставит предварительную болезнь, подтверждает только преподаватель', async (t) => {
  const store = new EventStore(tempDir(t));
  const event = await store.save({ ...sample, participants: ['Иванов'] });
  const student = { student: true };
  const first = await store.saveMark(event.id, 'Иванов', 'sick', student);
  assert.equal(first.marks['Иванов'].confirmed, false);
  await assert.rejects(store.saveMark(event.id, 'Иванов', 'sick', { ...student, confirmed: true }), { code: 'teacher-only' });
  await store.saveMark(event.id, 'Иванов', null, student);
  await store.saveMark(event.id, 'Иванов', 'sick', student);
  const done = await store.saveMark(event.id, 'Иванов', 'sick', { teacher: 'Кабинет', confirmed: true });
  assert.equal(done.marks['Иванов'].confirmed, true);
  await assert.rejects(store.saveMark(event.id, 'Иванов', null, student), { code: 'teacher-only' });
});

test('справку можно принять и после фиксации, запись остаётся в истории', async (t) => {
  const store = new EventStore(tempDir(t));
  const event = await store.save({ ...sample, participants: ['Иванов'] });
  await store.saveMark(event.id, 'Иванов', 'sick', { teacher: 'Кабинет' });
  await store.lockReport(event.id, 'Кабинет');
  const doc = await store.saveMark(event.id, 'Иванов', 'sick', { teacher: 'Кабинет', confirmed: true });
  assert.equal(doc.history.length, 1);
  assert.deepEqual([doc.history[0].before.confirmed, doc.history[0].after.confirmed], [false, true]);
});

test('возврат из копии добавляет удалённое и не трогает текущее', async (t) => {
  const store = new EventStore(tempDir(t));
  const kept = await store.save({ ...sample, title: 'Осталось' });
  const gone = await store.save({ ...sample, title: 'Удалили' });
  const backup = tempDir(t);
  for (const file of fs.readdirSync(store.dir)) fs.copyFileSync(path.join(store.dir, file), path.join(backup, file));
  const renamed = await store.save({ ...kept, title: 'Переименовали' }, kept.updatedAt);
  await store.remove(gone.id, gone.updatedAt);
  fs.writeFileSync(path.join(backup, 'мусор.json'), '{');
  assert.equal(await store.restoreFrom(backup), 1);
  const list = await store.list();
  assert.deepEqual(list.map((e) => e.title).sort(), ['Переименовали', 'Удалили']);
  const back = list.find((e) => e.title === 'Удалили');
  assert.ok(back.updatedAt > gone.updatedAt, 'новое время, чтобы удаление не вернулось');
  assert.equal(renamed.title, 'Переименовали');
  assert.equal(await store.restoreFrom(backup), 0, 'второй раз нечего возвращать');
});

test('«Начать занятие»: с панели один раз и только около начала, преподаватель может поправить', async (t) => {
  const store = new EventStore(tempDir(t));
  const event = await store.save({ ...sample, type: 'lesson', participants: ['Иванов'] });
  const at = (time) => new Date(2026, 10, 10, ...time.split(':').map(Number)).getTime();
  await assert.rejects(store.startLesson(event.id, { now: at('09:20') }), { code: 'not-now' });
  await assert.rejects(store.startLesson(event.id, { now: at('10:41') }), { code: 'not-now' });
  await assert.rejects(store.startLesson(event.id, { now: at('10:15'), at: new Date(at('10:00')).toISOString() }), { code: 'teacher-only' });
  await store.saveMark(event.id, 'Иванов', 'present', { student: true });
  const doc = await store.startLesson(event.id, { now: at('10:15') });
  assert.equal(doc.start.at, new Date(at('10:15')).toISOString());
  assert.equal(doc.marks['Иванов'].status, 'present', 'отметки сохраняются');
  await assert.rejects(store.startLesson(event.id, { now: at('10:16') }), { code: 'started' });
  const fixed = await store.startLesson(event.id, { admin: true, at: new Date(at('10:20')).toISOString() });
  assert.equal(fixed.start.at, new Date(at('10:20')).toISOString());
  const task = await store.save({ ...sample, type: 'task', participants: ['Иванов'] });
  await assert.rejects(store.startLesson(task.id, { now: at('10:15') }), { code: 'invalid' }, 'у задания нет начала: был или не был');
  const marked = await store.saveMark(event.id, 'Иванов', 'present', { student: true });
  assert.ok(marked.start, 'отметка не стирает начало');
  const locked = await store.lockReport(event.id, 'Кабинет');
  assert.ok(locked.start, 'фиксация сохраняет начало');
  await assert.rejects(store.startLesson(event.id, { admin: true, at: new Date(at('10:25')).toISOString() }), { code: 'locked' });
});

test('событие помнит свою цепочку, неверная цепочка отбрасывается', async (t) => {
  const store = new EventStore(tempDir(t));
  const seriesId = '11111111-2222-4333-8444-555555555555';
  const event = await store.save({ ...sample, seriesId, repeat: { every: 'week', until: '2026-12-29' } });
  assert.deepEqual([event.seriesId, event.repeat], [seriesId, { every: 'week', until: '2026-12-29' }]);
  const odd = await store.save({ ...sample, seriesId: 'не номер', repeat: { every: 'year', until: 'потом' } });
  assert.deepEqual([odd.seriesId, odd.repeat], ['', null]);
});

test('удаление за период: только выбранные типы и даты, зафиксированные остаются', async (t) => {
  const store = new EventStore(tempDir(t));
  const make = (title, date, type) => store.save({ ...sample, title, date, type });
  await make('до', '2026-10-31', 'lesson');
  const locked = await make('зафиксирована', '2026-11-02', 'lesson');
  await make('пара', '2026-11-03', 'lesson');
  await make('концерт', '2026-11-04', 'event');
  await make('после', '2026-12-01', 'lesson');
  await store.lockReport(locked.id, 'Кабинет');
  assert.deepEqual(await store.removeRange('2026-11-01', '2026-11-30', ['lesson']), { removed: 1, kept: 1 });
  assert.deepEqual((await store.list()).map((e) => e.title).sort(), ['до', 'зафиксирована', 'концерт', 'после']);
  await assert.rejects(store.removeRange('2026-11-30', '2026-11-01', ['lesson']), { code: 'invalid' });
});

test('отметка «весь день» хранится', async (t) => {
  const store = new EventStore(tempDir(t));
  assert.equal((await store.save({ ...sample, start: '00:00', end: '23:59', allDay: true })).allDay, true);
  assert.equal((await store.save({ ...sample, allDay: 'да' })).allDay, false);
});

test('мероприятие не начинают кнопкой', async (t) => {
  const store = new EventStore(tempDir(t));
  const event = await store.save({ ...sample, type: 'event' });
  await assert.rejects(store.startLesson(event.id, { admin: true, at: '2026-11-10T01:00:00.000Z' }), { code: 'invalid' });
});

test('PIN из прошлых версий исчезает из данных', async (t) => {
  const store = new EventStore(tempDir(t));
  const ref = await store.saveRef({ kind: 'teacher', name: 'Лебедева', pin: { salt: 'a', hash: 'b' }, hasPin: true });
  assert.equal('pin' in ref, false);
  assert.equal('hasPin' in ref, false);
});

test('отчёт нельзя отправить дважды, даже одновременно', async (t) => {
  const store = new EventStore(tempDir(t));
  const event = await store.save({ ...sample, participants: ['Иванов'] });
  const results = await Promise.allSettled([store.lockReport(event.id, 'Кабинет'), store.lockReport(event.id, 'Кабинет')]);
  assert.deepEqual(results.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((x) => x.status === 'rejected').reason.code, 'locked');
});

test('зафиксированную пару нельзя удалить или подменить, а срок сдачи можно', async (t) => {
  const store = new EventStore(tempDir(t));
  const event = await store.save({ ...sample, type: 'task' });
  await store.lockReport(event.id, 'Лебедева');
  await assert.rejects(store.remove(event.id, event.updatedAt), { code: 'locked' });
  await assert.rejects(store.save({ ...event, participants: ['Другой'] }, event.updatedAt), { code: 'locked' });
  await assert.rejects(store.save({ ...event, start: '09:00' }, event.updatedAt), { code: 'locked' });
  const saved = await store.save({ ...event, deadline: '2026-11-12T18:00' }, event.updatedAt);
  assert.equal(saved.deadline, '2026-11-12T18:00');
});

test('папка данных из старых настроек следует за переездом', (t) => {
  const root = tempDir(t);
  const home = path.join(root, 'Kerdiis');
  fs.mkdirSync(home, { recursive: true });
  const oldData = path.join(root, 'StudentCalendar', 'data');
  fs.writeFileSync(path.join(home, 'config.ini'), `[calendar]\r\ndataDir=${oldData}\r\ndeviceId=11111111-1111-4111-8111-111111111111\r\ndeviceName=А\r\n`);
  assert.equal(loadConfig(home).dataDir, path.join(home, 'data'));
  fs.mkdirSync(oldData, { recursive: true });
  assert.equal(loadConfig(home).dataDir, oldData, 'пока старая папка есть, данные читаются из неё');
  const custom = path.join(root, 'share', 'data');
  fs.writeFileSync(path.join(home, 'config.ini'), `[calendar]\r\ndataDir=${custom}\r\ndeviceId=11111111-1111-4111-8111-111111111111\r\ndeviceName=А\r\n`);
  assert.equal(loadConfig(home).dataDir, custom, 'своя папка не меняется');
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

test('уже работающее устройство остаётся на русском и без мастера', (t) => {
  const home = tempDir(t);
  fs.writeFileSync(path.join(home, 'config.ini'), '[calendar]\r\ndeviceId=abc\r\n');
  assert.equal(loadConfig(home).lang, 'ru');
  assert.equal(loadConfig(home).setupDone, true);
});

test('мастер первого запуска: новое устройство, ключ от установщика, повторный запуск', (t) => {
  const fresh = tempDir(t);
  assert.equal(loadConfig(fresh).setupDone, false);
  assert.equal(loadConfig(fresh).setupDone, false, 'пока мастер не пройден, он появляется снова');
  const installed = tempDir(t);
  fs.writeFileSync(path.join(installed, 'config.ini'), '[calendar]\r\nsyncKey=ABCDE-ABCDE-ABCDE\r\n');
  assert.equal(loadConfig(installed).setupDone, true);
});

test('настройки: значения по умолчанию, запись и файл от NSIS', (t) => {
  const home = tempDir(t);
  const first = loadConfig(home);
  assert.equal(first.dataDir, path.join(home, 'data'));
  assert.equal(first.uiSize, 'medium');
  assert.equal(first.lang, 'auto', 'новое устройство определяет язык само');
  assert.equal(loadConfig(home).lang, 'auto');
  assert.equal(first.deviceName, os.hostname());
  assert.match(first.deviceId, /^[0-9a-f-]{36}$/);
  assert.equal(loadConfig(home).deviceId, first.deviceId, 'номер устройства не меняется между запусками');
  saveConfig(home, { ...first, uiSize: 'small', syncKey: 'ABCD-EFGH-IJKL', peers: ['10.0.2.5', '10.0.3.7:47800'], showAll: true, deviceName: 'Ауд. 204' });
  const again = loadConfig(home);
  assert.deepEqual(again.peers, ['10.0.2.5', '10.0.3.7:47800']);
  assert.equal(again.syncKey, 'ABCD-EFGH-IJKL');
  assert.equal(again.deviceName, 'Ауд. 204');
  assert.equal(again.showAll, true);
  assert.equal(again.uiSize, 'small');
  assert.equal(first.memoSigner, 'Семенов И. А.');
  assert.deepEqual(parseIni('\uFEFF[calendar]\r\ndataDir=\\\\srv\\a=b\r\n; комментарий\r\n'), { dataDir: '\\\\srv\\a=b' });
});

test('журнал: создание, правка с полями, удаление, цепочка и период', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new EventStore(dir, 'dev-1', { deviceName: () => 'Панель 214' });
  const event = await store.save({ type: 'lesson', title: 'Физика', date: '2026-11-10', start: '10:00', end: '11:30', participants: ['Иванов'] });
  const edited = await store.save({ ...event, start: '10:15', participants: ['Иванов', 'Петров'] }, event.updatedAt);
  await store.save({ ...edited }, edited.updatedAt); // ничего не поменялось
  await store.remove(edited.id, (await store.list()).find((e) => e.id === edited.id).updatedAt);
  await store.save({ type: 'event', title: 'Концерт', date: '2026-11-12', start: '15:00', end: '16:00' });
  await store.removeRange('2026-11-01', '2026-11-30', ['event']);
  const log = await store.changes();
  assert.deepEqual(log.map((c) => c.action).sort(), ['create', 'create', 'delete', 'delete-range', 'edit']);
  const edit = log.find((c) => c.action === 'edit');
  assert.equal(edit.device, 'Панель 214');
  assert.equal(edit.title, 'Физика');
  assert.deepEqual(edit.fields.map((f) => f.field), ['start', 'participants']);
  assert.deepEqual(edit.fields[0], { field: 'start', before: '10:00', after: '10:15' });
  assert.equal(log.find((c) => c.action === 'delete-range').count, 1);
  assert.equal((await store.directory()).length, 0, 'журнал не попадает в справочники');
  assert.equal((await store.list()).length, 0);
});

test('журнал старше полугода удаляется и не принимается при обмене', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-01-01T10:00:00Z');
  const store = new EventStore(dir, 'dev-1', { clock: () => now });
  await store.save({ type: 'lesson', title: 'Химия', date: '2026-01-01', start: '10:00', end: '11:30' });
  const [old] = await store.changes();
  now = Date.parse('2026-08-01T10:00:00Z');
  assert.equal((await store.changes()).length, 0);
  assert.equal(await store.pruneChanges(), 1);
  assert.equal(await store.merge([{ ...old }]), 0);
});

test('записи страницы студента из прежних версий принимаются, но не мешают', async (t) => {
  const dir = tempDir(t);
  const old = { id: '11111111-2222-3333-4444-555555555555', kind: 'presence', student: 'Иванова Анна', date: '2026-11-10', at: '2026-11-10T00:52:00.000Z', updatedAt: '2026-11-10T00:52:00.000Z', updatedBy: 'x' };
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  const store = new EventStore(path.join(dir, 'events'), 'dev-1');
  fs.writeFileSync(path.join(dir, 'events', `${old.id}.json`), JSON.stringify(old));
  assert.equal((await store.directory()).length, 0, 'служебные записи не в справочниках');
  assert.equal((await store.list()).length, 0, 'и не в событиях');
  const group = await store.saveRef({ kind: 'group', name: 'ИС-21' });
  const anna = await store.saveRef({ kind: 'student', name: 'Иванова Анна', groupId: group.id, nick: 'Ануся', nickOk: true, phoneKey: 'a'.repeat(64) });
  assert.equal('nick' in anna || 'phoneKey' in anna, false, 'ник и ключ телефона больше не хранятся');
});

test('занятие не состоялось: причина хранится, отметки не ставятся, снять можно', async (t) => {
  const store = new EventStore(tempDir(t), 'a');
  const event = await store.save(sample);
  await store.saveMark(event.id, 'Иванов', 'present');
  const cancelled = await store.save({ ...event, cancelled: true, cancelReason: '  Преподаватель на больничном ' }, event.updatedAt);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.cancelReason, 'Преподаватель на больничном');
  await assert.rejects(store.saveMark(event.id, 'Петров', 'present', { teacher: 'Кабинет' }), { code: 'cancelled' });
  await store.saveMark(event.id, 'Иванов', null); // снять старую отметку можно
  const back = await store.save({ ...cancelled, cancelled: false, cancelReason: 'забыто' }, cancelled.updatedAt);
  assert.equal(back.cancelled, false);
  assert.equal(back.cancelReason, '', 'без отмены причины нет');
});

test('роли студентов: только у участников заданий, практики и мероприятий', async (t) => {
  const dir = tempDir(t);
  const store = new EventStore(dir);
  const saved = await store.save({
    ...sample, type: 'task', participants: ['Иванов', 'Петров'],
    roles: { 'Иванов': ' Оператор ', 'Петров': '', 'Сидоров': 'Ведущий', 'Чужой': 5 },
  });
  assert.deepEqual(saved.roles, { 'Иванов': 'Оператор' });
  const lesson = await store.save({ ...sample, type: 'lesson', participants: ['Иванов'], roles: { 'Иванов': 'Оператор' } });
  assert.deepEqual(lesson.roles, {}, 'у занятий ролей нет');
  const meeting = await store.save({ ...sample, type: 'meeting', participants: ['Иванов'], roles: { 'Иванов': 'Ведущий' } });
  assert.deepEqual(meeting.roles, {}, 'у собраний ролей нет');
  const again = await store.save({ ...saved, participants: ['Петров'] }, saved.updatedAt);
  assert.deepEqual(again.roles, {}, 'роль уходит вместе с участником');
});

test('сдача, поручения, запись и заявки нормализуются', async (t) => {
  const store = new EventStore(tempDir(t));
  const task = await store.save({ ...sample, type: 'task', participants: ['Иванов', 'Петров'], deadline: '2026-11-12T18:00', handIn: { 'Иванов': 'done', 'Петров': 'bad', 'Чужой': 'done' } });
  assert.deepEqual(task.handIn, { 'Иванов': 'done' });
  assert.ok(task.createdAt);
  const noDeadline = await store.save({ ...sample, type: 'task', participants: ['Иванов'], handIn: { 'Иванов': 'done' } });
  assert.deepEqual(noDeadline.handIn, {}, 'без срока нечего сдавать');
  const materials = await store.save({ ...sample, type: 'event', participants: ['Иванов'], deadline: '2026-11-12T18:00', handIn: { 'Иванов': 'done' } });
  assert.deepEqual(materials.handIn, {}, 'материалы мероприятия сдаются целиком');
  const meeting = await store.save({ ...sample, type: 'meeting', decisions: [{ text: ' Зал ', who: 'Павлов', due: '2026-11-20', done: true }, { text: '' }, { text: 'Без срока', due: 'потом' }] });
  assert.deepEqual(meeting.decisions.map((d) => [d.text, d.who, d.due, d.done]), [['Зал', 'Павлов', '2026-11-20', true], ['Без срока', '', '', false]]);
  assert.ok(meeting.decisions[0].id);
  const ev = await store.save({ ...sample, type: 'event', participants: ['Иванов'], signup: { open: true }, requests: [{ name: 'Сидоров' }] });
  assert.equal('signup' in ev || 'requests' in ev, false, 'запись со страницы студента убрана');
  const again = await store.save({ ...task, title: 'Новое имя' }, task.updatedAt);
  assert.equal(again.createdAt, task.createdAt, 'время создания не меняется');
});

test('день рождения хранится у студентов и преподавателей', async (t) => {
  const store = new EventStore(tempDir(t));
  const group = await store.saveRef({ kind: 'group', name: 'ИС-21', birthday: '2000-01-01' });
  assert.equal('birthday' in group, false);
  const student = await store.saveRef({ kind: 'student', name: 'Иванов Иван', groupId: group.id, birthday: '2008-11-17' });
  assert.equal(student.birthday, '2008-11-17');
  const teacher = await store.saveRef({ kind: 'teacher', name: 'Лебедева О. В.', birthday: '17.11.1980' });
  assert.equal(teacher.birthday, '', 'только в виде ГГГГ-ММ-ДД');
});

test('баллы грейда вручную: студент, дата, целое число от −100 до 100', async (t) => {
  const store = new EventStore(tempDir(t));
  const bonus = await store.saveRef({ kind: 'bonus', name: 'Олимпиада', student: 'Иванов Иван', date: '2026-11-03', points: -7 });
  assert.deepEqual([bonus.kind, bonus.name, bonus.student, bonus.date, bonus.points], ['bonus', 'Олимпиада', 'Иванов Иван', '2026-11-03', -7]);
  for (const bad of [{ points: 0 }, { points: 101 }, { points: 2.5 }, { points: '5' }, { date: '' }, { student: '' }]) {
    await assert.rejects(store.saveRef({ kind: 'bonus', name: 'X', student: 'Иванов Иван', date: '2026-11-03', points: 5, ...bad }));
  }
});

test('изменения с панели: предложение, замена, утверждение и отклонение', async (t) => {
  const dir = tempDir(t);
  const teacher = new EventStore(dir, 'teacher-1');
  const panel = new EventStore(dir, 'panel-1');
  const task = await teacher.save({ ...sample, type: 'task', title: 'Монтаж', place: 'Ауд. 1', participants: ['Иванов'] });
  const lesson = await teacher.save({ ...sample, type: 'lesson' });
  await assert.rejects(panel.propose(lesson.id, { title: 'Другое' }), { code: 'invalid' }, 'занятия не предлагают');
  await assert.rejects(panel.propose(task.id, { title: 'Монтаж', place: 'Ауд. 1' }), { code: 'unchanged' }, 'ничего не изменено');
  await assert.rejects(panel.propose(task.id, { start: '23:00', end: '01:00' }), { code: 'invalid' }, 'неверное время');
  const first = await panel.propose(task.id, { title: 'Монтаж', place: 'Ауд. 2', type: 'lesson', handIn: { 'Иванов': 'done' } });
  assert.deepEqual(first.changes, { place: 'Ауд. 2' }, 'только разрешённые и изменённые поля');
  const second = await panel.propose(task.id, { place: 'Ауд. 3', notes: 'Взять штатив' });
  assert.equal(second.id, first.id, 'повтор с той же панели заменяет прежнее');
  assert.equal((await teacher.proposals()).length, 1);
  assert.equal((await teacher.list()).find((e) => e.id === task.id).place, 'Ауд. 1', 'до утверждения событие не меняется');
  const saved = await teacher.resolveProposal(second.id, true);
  assert.deepEqual([saved.place, saved.notes, saved.type], ['Ауд. 3', 'Взять штатив', 'task']);
  assert.deepEqual(await teacher.proposals(), []);
  await panel.propose(task.id, { title: 'Не то' });
  const [declined] = await teacher.proposals();
  assert.equal(await teacher.resolveProposal(declined.id, false), null);
  assert.equal((await teacher.list()).find((e) => e.id === task.id).title, 'Монтаж');
  await assert.rejects(teacher.resolveProposal(declined.id, true), { code: 'not-found' });
});

test('праздничное оформление общее: одна запись на всю сеть', async (t) => {
  const dir = tempDir(t);
  const teacher = new EventStore(dir, 'teacher-1');
  assert.equal(await teacher.skin(), 'auto', 'по умолчанию — по праздникам');
  assert.equal(await teacher.setSkin('newyear'), 'newyear');
  assert.equal(await new EventStore(dir, 'panel-1').skin(), 'newyear');
  await assert.rejects(teacher.setSkin('<script>'), { code: 'invalid' });
  await teacher.setSkin('off');
  assert.equal(await teacher.skin(), 'off');
});

test('с панели практика и мероприятие ждут согласования: флаг ставит программа, снимает только утверждение', async (t) => {
  const dir = tempDir(t);
  const panel = new EventStore(dir, 'panel-1', { deviceName: () => 'Ауд. 204' });
  const teacher = new EventStore(dir, 'teacher-1');
  const added = await panel.save({ ...sample, type: 'event' }, null, { pending: true });
  assert.deepEqual([added.pending, added.pendingFrom], [true, 'Ауд. 204']);
  const own = await teacher.save({ ...sample, type: 'event', pending: true });
  assert.equal('pending' in own, false, 'присланный флаг не учитывается');
  const edited = await teacher.save({ ...added, title: 'Олимпиада по сетям', pending: false }, added.updatedAt);
  assert.equal(edited.pending, true, 'правка не снимает согласование');
  await assert.rejects(teacher.saveMark(edited.id, 'Иванов', 'present'), { code: 'pending' });
  const approved = await teacher.approve(edited.id, edited.updatedAt);
  assert.equal('pending' in approved, false);
  await assert.rejects(teacher.approve(approved.id, approved.updatedAt), { code: 'not-found' });
  const other = await panel.save({ ...sample, type: 'practice' }, null, { pending: true });
  await teacher.decline(other.id, other.updatedAt);
  assert.equal((await teacher.list()).some((event) => event.id === other.id), false);
  const actions = (await teacher.changes()).map((entry) => entry.action);
  assert.ok(actions.includes('approve') && actions.includes('decline'));
});

test('согласие на показ: отметка «не показывать на панелях» хранится только у людей', async (t) => {
  const store = new EventStore(tempDir(t));
  const group = await store.saveRef({ kind: 'group', name: 'ИС-21', hidePublic: true });
  assert.equal('hidePublic' in group, false);
  const student = await store.saveRef({ kind: 'student', name: 'Иванов Иван', groupId: group.id, hidePublic: true });
  assert.equal(student.hidePublic, true);
  const shown = await store.saveRef({ ...student, hidePublic: false }, student.updatedAt);
  assert.equal('hidePublic' in shown, false);
  const bonus = await store.saveRef({ kind: 'bonus', name: 'Олимпиада', student: 'Иванов Иван', date: '2026-11-03', points: 5, by: 'Кабинет 204' });
  assert.equal(bonus.by, 'Кабинет 204');
});

test('вид питомца хранится в группе, неизвестный отбрасывается', async (t) => {
  const store = new EventStore(tempDir(t));
  const group = await store.saveRef({ kind: 'group', name: 'ИС-21', petKind: 'owl' });
  assert.equal(group.petKind, 'owl');
  const legacy = await store.saveRef({ kind: 'group', name: 'ИС-22', petKind: 'bunny' });
  assert.equal(legacy.petKind, 'hare', 'зайчонок из 1.56 — куобах');
  const odd = await store.saveRef({ ...group, petKind: 'dragon' }, group.updatedAt);
  assert.equal('petKind' in odd, false);
  const student = await store.saveRef({ kind: 'student', name: 'Иванов Иван', groupId: group.id, petKind: 'lynx' });
  assert.equal('petKind' in student, false);
});

test('выбор вида закрыт до смерти питомца: ключ — дата заведения', async (t) => {
  const store = new EventStore(tempDir(t));
  const chosen = await store.saveRef({ kind: 'group', name: 'ИС-31', petSince: '2026-09-01T09:00', petKind: 'owl', petKindFor: '2026-09-01T09:00' });
  assert.equal(chosen.petKindFor, '2026-09-01T09:00');
  assert.equal(petKindLocked(chosen), true, 'вид на этого питомца выбран');
  const newPet = { ...chosen, petSince: '2026-11-02T10:00' };
  assert.equal(petKindLocked(newPet), false, 'новый питомец — выбор снова открыт');
  const oldGroup = await store.saveRef({ kind: 'group', name: 'ИС-32', petKindFor: 'pet' });
  assert.equal(petKindLocked(oldGroup), true, 'питомец без даты заведения');
  const free = await store.saveRef({ kind: 'group', name: 'ИС-33', petKind: 'foal' });
  assert.equal(petKindLocked(free), false, 'вид не выбирали');
  const junk = await store.saveRef({ kind: 'group', name: 'ИС-34', petKindFor: 'a b' });
  assert.equal('petKindFor' in junk, false);
});

test('запись переживает файл, на мгновение занятый антивирусом (EPERM при замене)', async (t) => {
  const fsp = require('node:fs/promises');
  const store = new EventStore(tempDir(t));
  const original = fsp.rename;
  let failures = 0;
  fsp.rename = async (...args) => {
    if (failures < 3) {
      failures += 1;
      throw Object.assign(new Error('busy'), { code: 'EPERM' });
    }
    return original(...args);
  };
  t.after(() => { fsp.rename = original; });
  const saved = await store.save({ ...sample });
  assert.equal(failures, 3);
  assert.equal((await store.list()).find((e) => e.id === saved.id)?.title, sample.title);
  // Если файл так и не освободился — ошибка, а черновик убран.
  failures = -100;
  await assert.rejects(store.save({ ...sample, title: 'Не сохранится' }), { code: 'EPERM' });
  fsp.rename = original;
  const leftovers = require('node:fs').readdirSync(store.dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('прошлая работа: проверка полей, роли только у бывших, не сдавшие только среди не сдавших', async (t) => {
  const store = new EventStore(tempDir(t));
  const work = await store.saveRef({
    kind: 'pastwork', name: '  Курсовой ', work: 'event', date: '2026-10-10',
    students: ['Аня', 'аня', 'Боря', ''], roles: ['Аня', 'Вера'], missed: ['Вера'],
  });
  assert.equal(work.name, 'Курсовой');
  assert.deepEqual(work.students, ['Аня', 'Боря'], 'повторы и пустые убраны');
  assert.deepEqual(work.roles, ['Аня'], 'роль — только у бывших');
  assert.deepEqual(work.missed, [], 'не сдавшие — только у заданий');
  const task = await store.saveRef({ kind: 'pastwork', name: 'Эссе', work: 'task', date: '2026-09-20', students: ['Аня'], missed: ['аня', 'Боря'] });
  assert.deepEqual(task.missed, ['Боря']);
  for (const bad of [
    { kind: 'pastwork', name: 'Без даты', work: 'task', students: ['Аня'] },
    { kind: 'pastwork', name: 'Неизвестно', work: 'lesson', date: '2026-09-20', students: ['Аня'] },
    { kind: 'pastwork', name: 'Пусто', work: 'practice', date: '2026-09-20', students: [] },
  ]) await assert.rejects(store.saveRef(bad));
});

test('флажки студентов и подписи цветов', async (t) => {
  const store = new EventStore(tempDir(t));
  const group = await store.saveRef({ kind: 'group', name: 'ИС-21' });
  const student = await store.saveRef({ kind: 'student', name: 'Иванов', groupId: group.id, flags: ['green', 'red', 'pink', 'red'] });
  assert.deepEqual(student.flags, ['red', 'green'], 'только четыре цвета, без повторов, в постоянном порядке');
  const label = await store.saveRef({ kind: 'flagname', name: ' Группа риска ', color: 'red' });
  assert.equal(label.name, 'Группа риска');
  await assert.rejects(store.saveRef({ kind: 'flagname', name: 'Розовый', color: 'pink' }));
});

test('окрас питомца: только известные окрасы и только у группы', async (t) => {
  const store = new EventStore(tempDir(t));
  const group = await store.saveRef({ kind: 'group', name: 'ИС-21', petCoat: 'gold' });
  assert.equal(group.petCoat, 'gold');
  assert.equal((await store.saveRef({ ...group, petCoat: 'pink' }, group.updatedAt)).petCoat, undefined);
});

test('дежурство группы: начало, освобождённые и замены', async (t) => {
  const store = new EventStore(tempDir(t));
  const group = await store.saveRef({ kind: 'group', name: 'ИС-21', dutyFrom: '2026-11-02', dutyExempt: ['Васин', 'Васин', ''], duty: { '2026-11-05': ' Белова ', 'вчера': 'Антонов', '2026-11-06': '' } });
  assert.equal(group.dutyFrom, '2026-11-02');
  assert.deepEqual(group.dutyExempt, ['Васин']);
  assert.deepEqual(group.duty, { '2026-11-05': 'Белова' });
  const plain = await store.saveRef({ ...group, dutyFrom: 'потом', dutyExempt: [], duty: {} }, group.updatedAt);
  assert.equal('dutyFrom' in plain || 'dutyExempt' in plain || 'duty' in plain, false);
});
