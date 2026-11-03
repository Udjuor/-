import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/renderer/logic.mjs';

const ev = (id, start, end, extra = {}) => ({
  id, title: id, date: '2026-11-03', start, end, responsible: '', participants: [], equipment: [], ...extra,
});

test('неделя начинается с понедельника', () => {
  assert.equal(L.weekStart('2026-11-03'), '2026-11-02');
  assert.equal(L.weekStart('2026-11-02'), '2026-11-02');
  assert.equal(L.weekStart('2026-11-08'), '2026-11-02'); // воскресенье
  assert.deepEqual([L.weekDays('2026-11-03')[0], L.weekDays('2026-11-03')[6]], ['2026-11-02', '2026-11-08']);
});

test('сетка месяца состоит из полных недель и покрывает весь месяц', () => {
  const weeks = L.monthWeeks('2026-11-15');
  assert.ok(weeks.every((w) => w.length === 7));
  assert.equal(weeks[0][0], '2026-10-26');
  assert.equal(weeks.at(-1)[6], '2026-12-06');
  assert.equal(L.monthWeeks('2026-02-10').length, 5);
  assert.equal(L.monthWeeks('2021-02-10').length, 4); // февраль ровно с понедельника
});

test('смена месяца не перескакивает через короткий месяц', () => {
  assert.equal(L.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(L.addMonths('2026-12-31', 2), '2027-02-28');
  assert.equal(L.addMonths('2026-03-31', -1), '2026-02-28');
});

test('дни считаются через перевод часов и границу года', () => {
  assert.equal(L.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(L.addDays('2028-02-28', 1), '2028-02-29');
});

test('непересекающиеся мероприятия занимают всю ширину', () => {
  const out = L.layoutDay([ev('a', '09:00', '10:00'), ev('b', '10:00', '11:00')]);
  assert.deepEqual(out.map((x) => [x.column, x.columns]), [[0, 1], [0, 1]]);
});

test('пересекающиеся мероприятия стоят рядом, свободная колонка используется снова', () => {
  const out = L.layoutDay([
    ev('a', '09:00', '12:00'), ev('b', '09:30', '10:00'), ev('c', '10:00', '11:00'), ev('d', '13:00', '14:00'),
  ]);
  const by = Object.fromEntries(out.map((x) => [x.event.id, x]));
  assert.equal(by.a.column, 0);
  assert.equal(by.b.column, 1);
  assert.equal(by.c.column, 1);
  assert.equal(by.a.columns, 2);
  assert.equal(by.d.columns, 1);
});

test('длинное мероприятие удерживает группу, пока не закончится', () => {
  const out = L.layoutDay([ev('a', '09:00', '15:00'), ev('b', '09:00', '10:00'), ev('c', '12:00', '13:00')]);
  assert.ok(out.every((x) => x.columns === 2));
});

test('сетка часов расширяется под ранние и поздние мероприятия', () => {
  assert.deepEqual(L.hourRange([]), { first: 8, last: 20 });
  assert.deepEqual(L.hourRange([ev('a', '06:30', '07:00'), ev('b', '21:10', '22:15')]), { first: 6, last: 23 });
});

test('занятый участник находится без учёта регистра и буквы ё', () => {
  const events = [ev('x', '10:00', '11:00', { participants: ['Семёнов Пётр'], equipment: ['Проектор'] })];
  const draft = ev('new', '10:30', '12:00', { participants: ['СЕМЕНОВ  ПЕТР', 'Иванова Анна'], equipment: ['проектор'] });
  const found = L.findConflicts(draft, events);
  assert.deepEqual(found.map((c) => [c.kind, c.name]), [['person', 'СЕМЕНОВ  ПЕТР'], ['equipment', 'проектор']]);
});

test('ответственный учитывается как занятый человек с обеих сторон', () => {
  const events = [ev('x', '10:00', '11:00', { responsible: 'Лебедева О. В.' })];
  assert.equal(L.findConflicts(ev('n', '10:00', '11:00', { participants: ['Лебедева О. В.'] }), events).length, 1);
  assert.equal(L.findConflicts(ev('n', '10:00', '11:00', { responsible: 'Лебедева О. В.' }), events).length, 1);
});

test('стыковка по времени, другой день и само мероприятие не считаются конфликтом', () => {
  const a = ev('a', '10:00', '11:00', { participants: ['Иванов'] });
  assert.equal(L.findConflicts(ev('b', '11:00', '12:00', { participants: ['Иванов'] }), [a]).length, 0);
  assert.equal(L.findConflicts(ev('b', '10:00', '11:00', { participants: ['Иванов'], date: '2026-11-04' }), [a]).length, 0);
  assert.equal(L.findConflicts(a, [a]).length, 0);
});

test('незаполненное время не даёт ложных конфликтов', () => {
  const a = ev('a', '10:00', '11:00', { participants: ['Иванов'] });
  assert.deepEqual(L.findConflicts(ev('b', '12:00', '11:00', { participants: ['Иванов'] }), [a]), []);
  assert.deepEqual(L.findConflicts(ev('b', '', '', { participants: ['Иванов'] }), [a]), []);
});

test('вставленный список разбирается по строкам и точке с запятой', () => {
  assert.deepEqual(L.splitList('Иванов И.\r\nПетров П.\n\n Сидоров С. ;Козлов К.\tОрлов О.'),
    ['Иванов И.', 'Петров П.', 'Сидоров С.', 'Козлов К.', 'Орлов О.']);
});

test('список имён из таблицы: строки разделяются, столбцы склеиваются', () => {
  assert.deepEqual(L.splitNames('Иванов\tИван\tПетрович\r\nСидорова  Анна\n\n;Козлов К.'),
    ['Иванов Иван Петрович', 'Сидорова Анна', 'Козлов К.']);
});

test('подсказки не дублируются', () => {
  assert.deepEqual(L.uniqueValues(['Проектор', 'проектор', '', 'Ноутбук']), ['Ноутбук', 'Проектор']);
});

test('состояние мероприятия', () => {
  const e = ev('a', '10:00', '11:00');
  assert.equal(L.eventState(e, '2026-11-03', '09:59'), 'future');
  assert.equal(L.eventState(e, '2026-11-03', '10:00'), 'now');
  assert.equal(L.eventState(e, '2026-11-03', '11:00'), 'past');
  assert.equal(L.eventState(e, '2026-11-04', '00:00'), 'past');
  assert.equal(L.eventState(e, '2026-11-02', '23:00'), 'future');
});

test('мероприятие показывается только на выбранных устройствах', () => {
  assert.equal(L.visibleOn({ devices: [] }, 'room', false), true);
  assert.equal(L.visibleOn({}, 'room', false), true);
  assert.equal(L.visibleOn({ devices: ['room'] }, 'room', false), true);
  assert.equal(L.visibleOn({ devices: ['other'] }, 'room', false), false);
  assert.equal(L.visibleOn({ devices: ['other'] }, 'room', true), true);
});

test('склонение', () => {
  const f = (n) => L.plural(n, 'участник', 'участника', 'участников');
  assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25, 101, 111].map(f), [
    'участник', 'участника', 'участников', 'участников', 'участников', 'участник', 'участника', 'участников', 'участник', 'участников',
  ]);
});

test('предложенное время начала', () => {
  assert.equal(L.suggestedStart('09:20'), '10:00');
  assert.equal(L.suggestedStart('23:50'), '22:00');
});
