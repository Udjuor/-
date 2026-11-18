import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DAILY_LOSS, POOR_FLOOR, PRIZES, PRIZE_DAYS, PRIZE_HEALTH, dressedPixels, healthChange, moodOf, petChange, petLook, petPixels, petPrizes, petStatus } from '../src/renderer/pet.mjs';

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

test('изменение здоровья: плохая пара от половины пропусков или трёх четвертей опозданий', () => {
  assert.equal(healthChange({ absent: 0, late: 0 }), 4, 'все и вовремя');
  assert.equal(healthChange({ absent: 0.1, late: 0.25 }), 4);
  assert.equal(healthChange({ absent: 0.2, late: 0 }), 2, 'хорошо');
  assert.equal(healthChange({ absent: 0, late: 0.4 }), 2);
  assert.equal(healthChange({ absent: 0.25, late: 0 }), -3, 'посредственно');
  assert.equal(healthChange({ absent: 0, late: 0.5 }), -3);
  assert.equal(healthChange({ absent: 0.49, late: 0.74 }), -3);
  assert.equal(healthChange({ absent: 0.5, late: 0 }), -8, 'половина прогуляла');
  assert.equal(healthChange({ absent: 0, late: 0.75 }), -8, 'три четверти опоздали');
});

test('посредственная посещаемость не убивает: питомец грустит, но живёт', () => {
  const events = Array.from({ length: 30 }, (_, i) => pair(i + 1));
  const docs = events.map((_, i) => marks(i + 1, { Аня: 'present', Боря: 'present', Вера: 'present' })); // каждый четвёртый прогулял
  const s = status(events, docs);
  assert.equal(s.health, POOR_FLOOR);
  assert.equal(s.mood, 'sad');
  assert.equal(s.diedOn, null);
});

test('три четверти опозданий доводят до смерти', () => {
  const lateAll = (n) => ({ eventId: `e${n}`, marks: Object.fromEntries(['Аня', 'Боря', 'Вера'].map((name) => [name, { status: 'present', at: stampAt(n, '09:20') }]).concat([['Гена', { status: 'present', at: stampAt(n) }]])) });
  const events = Array.from({ length: 12 }, (_, i) => pair(i + 1));
  const s = status(events, events.map((_, i) => lateAll(i + 1)));
  assert.equal(s.mood, 'dead');
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
  assert.equal(reasons.health, 74, 'из учитываемых пришли все');
  const absent = status([pair(1)], [marks(1, { Аня: 'present' })]);
  assert.equal(absent.health, 70 + healthChange({ absent: 0.75, late: 0 }));
  assert.equal(absent.last.absent, 3);
});

test('опоздание стоит половину посещения', () => {
  const doc = { eventId: 'e1', marks: { ...lateMark(1, 'Аня'), Боря: { status: 'present', at: stampAt(1) } } };
  const s = status([pair(1, ['Аня', 'Боря'])], [doc]);
  assert.equal(s.health, 70 + healthChange({ absent: 0, late: 0.5 }));
  assert.equal(s.last.late, 1);
});

test('постоянные прогулы доводят до смерти, и она окончательна', () => {
  const events = Array.from({ length: 12 }, (_, i) => pair(i + 1));
  const docs = events.map((_, i) => marks(i + 1, { Аня: 'present' }));
  docs.push(all(13));
  events.push(pair(13));
  const s = status(events, docs);
  assert.equal(s.mood, 'dead');
  assert.equal(s.health, 0);
  assert.equal(s.diedOn, day(9), 'по 8 за день: девять дней прогулов');
  assert.ok(s.diedOn < day(13), 'дальше пары не считаются');
});

test('за один день питомец теряет не больше 10', () => {
  const sameDay = (k) => ({ ...pair(5), id: `d${k}`, start: `${String(8 + k * 2).padStart(2, '0')}:00`, end: `${String(9 + k * 2).padStart(2, '0')}:30` });
  const events = [0, 1, 2, 3].map(sameDay);
  const docs = events.map((event) => ({ eventId: event.id, marks: { Аня: { status: 'absent', at: stampAt(5) }, Боря: { status: 'absent', at: stampAt(5) }, Вера: { status: 'absent', at: stampAt(5) }, Гена: { status: 'absent', at: stampAt(5) } } }));
  const s = status(events, docs);
  assert.equal(s.health, 70 - MAX_DAILY_LOSS, 'четыре пары полного прогула за день — минус 10, а не 48');
  assert.equal(s.counted, 4);
  const next = status([...events, pair(6)], [...docs, all(6)]);
  assert.equal(next.health, 70 - MAX_DAILY_LOSS + 4, 'на следующий день лечится как обычно');
});

test('новый питомец не отвечает за старые пары', () => {
  const events = Array.from({ length: 12 }, (_, i) => pair(i + 1));
  const docs = events.map((_, i) => marks(i + 1, { Аня: 'present' }));
  assert.equal(status(events, docs).mood, 'dead');
  const fresh = status(events, docs, { id: 'g', petSince: `${day(12)}T12:00` });
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

test('смена состояния питомца заметна три дня, а потом забывается', () => {
  const point = (date, health) => ({ date, title: 'Пара', health });
  const pet = { timeline: [point('2026-11-01', 72), point('2026-11-02', 50), point('2026-11-03', 45)] };
  assert.deepEqual(petChange(pet, '2026-11-03'), { from: 'fine', to: 'sad', date: '2026-11-02' });
  assert.ok(petChange(pet, '2026-11-05'));
  assert.equal(petChange(pet, '2026-11-06'), null);
  assert.equal(petChange({ timeline: [point('2026-11-01', 72)] }, '2026-11-02'), null, 'состояние то же, что на старте');
  assert.equal(petChange({ timeline: [] }, '2026-11-02'), null);
  assert.deepEqual(petChange({ timeline: [point('2026-11-02', 20), point('2026-11-03', 40)] }, '2026-11-03').to, 'sad', 'выздоровление тоже считается');
  assert.equal(petChange({ timeline: [point('2026-11-03', 0)] }, '2026-11-03').to, 'dead');
});

test('питомец группы живёт посещаемостью подгрупп, а МГЗ не считает другую половину', () => {
  const groups = [{ id: 'g', name: 'ФВТ-24' }, { id: 'a', name: 'ФВТ-24-1' }, { id: 'b', name: 'ФВТ-24-2' }];
  const students = [{ name: 'Аня', groupId: 'a' }, { name: 'Вера', groupId: 'b' }];
  const event = { id: 'm', type: 'lesson', title: 'МГЗ', date: '2026-11-03', start: '09:00', end: '10:00', participants: ['Аня'] };
  const attendance = [{ eventId: 'm', marks: { Аня: { status: 'present', at: new Date(2026, 10, 3, 9, 0).toISOString(), late: false } } }];
  const pet = petStatus({ group: groups[0], groups, students, events: [event], attendance, nowISO: '2026-11-05', nowTime: '10:00' });
  assert.equal(pet.counted, 1);
  assert.equal(pet.last.total, 1, 'вторая подгруппа на этой паре не считается');
  assert.equal(pet.last.present, 1);
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

const petWith = (days, mood = 'play') => ({
  mood,
  timeline: days.flatMap(([date, ...healths]) => healths.map((health) => ({ date, title: 'Пара', health }))),
});

test('приз за каждые три учебных дня подряд со здоровьем от 90', () => {
  assert.equal(PRIZE_DAYS, 3);
  assert.equal(PRIZE_HEALTH, 90);
  const pet = petWith([
    ['2026-11-02', 89, 100], // день не засчитан: после первой пары было 89
    ['2026-11-03', 90, 100], // 90 уже засчитывается
    ['2026-11-04', 97],
    ['2026-11-06', 100], // выходные и дни без пар серию не прерывают
    ['2026-11-09', 100],
    ['2026-11-10', 100, 85], // серия обнулилась
    ['2026-11-11', 100],
  ]);
  const prizes = petPrizes(pet);
  assert.deepEqual(prizes.earned.map((p) => [p.id, p.date]), [['camera', '2026-11-06']]);
  assert.equal(prizes.streak, 1);
  assert.equal(prizes.next.id, 'tripod');
});

test('после всех призов идут звёзды, у умершего питомца призов нет', () => {
  const days = Array.from({ length: PRIZE_DAYS * (PRIZES.length + 2) }, (_, i) => [`2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, 100]);
  const prizes = petPrizes(petWith(days));
  assert.equal(prizes.earned.length, PRIZES.length);
  assert.equal(prizes.stars, 2);
  assert.equal(prizes.next, null);
  assert.equal(petPrizes(petWith(days, 'dead')).earned.length, 0);
});

test('наряд: выбор учителя из полученного, иначе последнее полученное', () => {
  const prizes = petPrizes(petWith(Array.from({ length: 15 }, (_, i) => [`2026-11-${String(i + 1).padStart(2, '0')}`, 100])));
  // Получены: камера, штатив, наушники, микрофон, берет.
  assert.deepEqual(petLook(undefined, prizes), { head: 'beret', right: 'microphone', left: 'tripod' });
  assert.deepEqual(petLook({ head: 'headphones', left: 'camera', right: 'camera' }, prizes), { head: 'headphones', left: 'camera', right: '' });
  assert.deepEqual(petLook({ head: 'crown', left: 'spotlight', right: 'tripod' }, prizes), { head: '', left: '', right: 'tripod' }, 'неполученное не надевается');
  assert.deepEqual(petLook({ head: '', left: '', right: '' }, prizes), { head: '', left: '', right: '' }, 'можно снять всё');
  const pixels = dressedPixels('play', { head: 'crown', left: 'tripod', right: 'camera' });
  assert.ok(pixels.every((p) => p.x >= 0 && p.x < 32 && p.y >= 0 && p.y < 20));
});
