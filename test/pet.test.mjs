import test from 'node:test';
import assert from 'node:assert/strict';
import { healthChange, moodOf, petPixels, petStatus } from '../src/renderer/pet.mjs';

const G = { id: 'g' };
const students = ['Аня', 'Боря', 'Вера', 'Гена'].map((name) => ({ name, groupId: 'g' }));
const names = students.map((s) => s.name);
const day = (n) => `2026-10-${String(n).padStart(2, '0')}`;
const pair = (n, participants = names, type = 'lesson') => ({ id: `e${n}`, type, title: `Пара ${n}`, date: day(n), start: '09:00', end: '10:30', participants });
const stampAt = (n, time = '08:55') => new Date(`${day(n)}T${time}:00`).toISOString();
const marks = (n, map) => ({ eventId: `e${n}`, marks: Object.fromEntries(Object.entries(map).map(([k, status]) => [k, { status, at: stampAt(n, status === 'late' ? '09:20' : '08:55') }])) });
const lateMark = (n, name) => ({ [name]: { status: 'present', at: stampAt(n, '09:20') } });
const status = (events, attendance, group = G) => petStatus({ group, students, events, attendance, nowISO: '2026-11-03', nowTime: '12:00' });
const all = (n) => marks(n, Object.fromEntries(names.map((name) => [name, 'present'])));

test('изменение здоровья: хорошая посещаемость лечит, плохая вредит сильнее', () => {
  assert.equal(healthChange(1), 6);
  assert.equal(healthChange(0.75), 0);
  assert.equal(healthChange(0.5), -8);
  assert.equal(healthChange(0), -24);
});

test('настроение по здоровью', () => {
  assert.deepEqual([0, 1, 34, 35, 59, 60, 84, 85, 100].map(moodOf), ['dead', 'sick', 'sick', 'sad', 'sad', 'fine', 'fine', 'play', 'play']);
});

test('новый питомец здоров, пока нет отмеченных пар', () => {
  const s = status([], []);
  assert.deepEqual([s.health, s.mood, s.counted], [70, 'fine', 0]);
});

test('полная посещаемость лечит до игры, здоровье не выше 100', () => {
  const events = Array.from({ length: 12 }, (_, i) => pair(i + 1));
  const s = status(events, events.map((_, i) => all(i + 1)));
  assert.equal(s.health, 100);
  assert.equal(s.mood, 'play');
  assert.equal(s.counted, 12);
});

test('пара без единой отметки не вредит', () => {
  const s = status([pair(1), pair(2)], []);
  assert.deepEqual([s.health, s.counted], [70, 0]);
});

test('причины отсутствия не вредят, пропуски без причины вредят', () => {
  const reasons = status([pair(1)], [marks(1, { Аня: 'present', Боря: 'sick', Вера: 'order', Гена: 'excused' })]);
  assert.equal(reasons.health, 76, 'из учитываемых пришли все');
  const absent = status([pair(1)], [marks(1, { Аня: 'present' })]);
  assert.equal(absent.health, 70 + healthChange(0.25));
  assert.equal(absent.last.absent, 3);
});

test('опоздание стоит половину посещения', () => {
  const doc = { eventId: 'e1', marks: { ...lateMark(1, 'Аня'), Боря: { status: 'present', at: stampAt(1) } } };
  const s = status([pair(1, ['Аня', 'Боря'])], [doc]);
  assert.equal(s.health, 70 + healthChange(0.75));
  assert.equal(s.last.late, 1);
});

test('постоянные прогулы доводят до смерти, и она окончательна', () => {
  const events = Array.from({ length: 8 }, (_, i) => pair(i + 1));
  const docs = events.map((_, i) => marks(i + 1, { Аня: 'present' }));
  docs.push(all(9));
  events.push(pair(9));
  const s = status(events, docs);
  assert.equal(s.mood, 'dead');
  assert.equal(s.health, 0);
  assert.ok(s.diedOn < day(9), 'дальше пары не считаются');
});

test('новый питомец не отвечает за старые пары', () => {
  const events = Array.from({ length: 8 }, (_, i) => pair(i + 1));
  const docs = events.map((_, i) => marks(i + 1, { Аня: 'present' }));
  assert.equal(status(events, docs).mood, 'dead');
  const fresh = status(events, docs, { id: 'g', petSince: `${day(8)}T12:00` });
  assert.deepEqual([fresh.health, fresh.counted], [70, 0]);
});

test('мероприятия и чужие студенты не влияют', () => {
  const s = status([pair(1, names, 'event'), pair(2, ['Чужой'])], [marks(1, { Аня: 'present' }), marks(2, { Чужой: 'present' })]);
  assert.equal(s.counted, 0);
});

test('история здоровья идёт по парам и обрывается смертью', () => {
  const events = Array.from({ length: 12 }, (_, i) => pair(i + 1));
  const docs = events.map((_, i) => marks(i + 1, { Аня: 'present' }));
  const s = status(events, docs);
  assert.equal(s.timeline.length, s.counted);
  assert.equal(s.timeline.at(-1).health, 0);
  assert.ok(s.timeline.every((point, i, all) => i === 0 || point.health < all[i - 1].health));
  assert.equal(s.bornOn, day(1));
  assert.equal(s.timeline.at(-1).date, s.diedOn);
});

test('спрайты целые: 16 на 16, все пиксели окрашены', () => {
  for (const mood of ['play', 'fine', 'sad', 'sick', 'dead']) {
    for (const frame of [0, 1]) {
      const pixels = petPixels(mood, frame);
      assert.ok(pixels.length > 100, mood);
      assert.ok(pixels.every((p) => p.fill && p.x >= 0 && p.x < 16 && p.y >= 0 && p.y < 16), mood);
    }
  }
});
