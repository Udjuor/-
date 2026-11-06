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

const lesson = (id, date, start, end, participants, extra = {}) => ({
  id, type: 'lesson', title: 'Математика', date, start, end, responsible: 'Лебедева', participants, equipment: [], ...extra,
});
const at = (date, time) => new Date(`${date}T${time}:00`).toISOString();
const report = (events, attendance, extra = {}) => L.buildReport({
  events, attendance,
  students: [{ name: 'Иванов', groupId: 'g1' }, { name: 'Петров', groupId: 'g1' }, { name: 'Сидоров', groupId: 'g2' }],
  groups: [{ id: 'g1', name: 'ИС-21' }, { id: 'g2', name: 'ПИ-22' }],
  filters: { from: '2026-11-01', to: '2026-11-30', types: ['lesson', 'practice', 'task'], ...extra },
  nowISO: '2026-11-10', nowTime: '12:00',
});

test('опоздание считается от начала пары', () => {
  const e = lesson('a', '2026-11-03', '09:00', '10:30', []);
  assert.equal(L.lateMinutes(e, at('2026-11-03', '08:55')), 0);
  assert.equal(L.lateMinutes(e, at('2026-11-03', '09:00')), 0);
  assert.equal(L.lateMinutes(e, at('2026-11-03', '09:07')), 7);
});

test('без отметки: пока пара идёт — нет отметки, после окончания — пропуск', () => {
  const e = lesson('a', '2026-11-03', '09:00', '10:30', ['Иванов']);
  assert.equal(L.rollCall(e, null, '2026-11-03', '10:00')[0].status, 'pending');
  assert.equal(L.rollCall(e, null, '2026-11-03', '10:30')[0].status, 'absent');
});

test('снятая отметка считается отсутствующей', () => {
  const e = lesson('a', '2026-11-03', '09:00', '10:30', ['Иванов']);
  const doc = { marks: { Иванов: { status: null, at: null } } };
  assert.equal(L.rollCall(e, doc, '2026-11-04', '10:00')[0].status, 'absent');
});

test('отчёт считает проведённые пары, причины, опоздания и проценты', () => {
  const events = [
    lesson('a', '2026-11-03', '09:00', '10:30', ['Иванов', 'Петров', 'Сидоров', 'Гость']),
    lesson('b', '2026-11-10', '09:00', '10:30', ['Иванов'], { type: 'practice' }),
    lesson('future', '2026-11-11', '09:00', '10:30', ['Иванов']),
    lesson('today-later', '2026-11-10', '13:00', '14:00', ['Иванов']),
    lesson('old', '2026-10-30', '09:00', '10:30', ['Иванов']),
    lesson('other', '2026-11-05', '09:00', '10:30', ['Иванов'], { type: 'event' }),
  ];
  const attendance = [
    { eventId: 'a', marks: {
      Иванов: { status: 'present', at: at('2026-11-03', '09:10') },
      Петров: { status: 'sick', at: at('2026-11-03', '09:00') },
      Сидоров: { status: 'order', at: at('2026-11-03', '09:00') },
    } },
    { eventId: 'b', marks: { Иванов: { status: 'present', at: at('2026-11-10', '08:59') } } },
  ];
  const { pairs, students, groups } = report(events, attendance);
  assert.deepEqual(pairs.map((p) => p.event.id), ['a', 'b']);
  const first = pairs[0];
  assert.deepEqual([first.total, first.present, first.late, first.sick, first.order, first.absent, first.percent], [4, 1, 1, 1, 1, 1, 25]);
  assert.deepEqual(first.groups, ['ИС-21', 'ПИ-22']);
  const ivanov = students.find((s) => s.name === 'Иванов');
  assert.deepEqual([ivanov.group, ivanov.total, ivanov.present, ivanov.late, ivanov.percent], ['ИС-21', 2, 2, 1, 100]);
  assert.deepEqual(groups.map((g) => [g.name, g.total, g.present]), [['Без группы', 1, 0], ['ИС-21', 3, 2], ['ПИ-22', 1, 0]]);
});

test('отчёт по группе считает только её студентов', () => {
  const events = [lesson('a', '2026-11-03', '09:00', '10:30', ['Иванов', 'Сидоров']), lesson('b', '2026-11-03', '11:00', '12:00', ['Сидоров'])];
  const { pairs, students } = report(events, [], { group: 'ИС-21' });
  assert.deepEqual(pairs.map((p) => [p.event.id, p.total]), [['a', 1]]);
  assert.deepEqual(students.map((s) => s.name), ['Иванов']);
});

test('отчёт по преподавателю', () => {
  const events = [lesson('a', '2026-11-03', '09:00', '10:30', []), lesson('b', '2026-11-03', '11:00', '12:00', [], { responsible: 'Павлов' })];
  assert.deepEqual(report(events, [], { teacher: 'Павлов' }).pairs.map((p) => p.event.id), ['b']);
  assert.equal(report(events, []).pairs[0].percent, null);
});

test('CSV открывается в Excel и экранирует значения', () => {
  const csv = L.toCsv(['Имя', 'Группа'], [['Иванов; Иван', 'ИС "21"'], ['Петров', 5]]);
  assert.equal(csv, '\uFEFFИмя;Группа\r\n"Иванов; Иван";"ИС ""21"' + '""\r\nПетров;5\r\n');
});

const gear = (id, start, end, equipment, equipmentQty = {}) => ({ ...ev(id, start, end), equipment, equipmentQty });

test('лимит техники учитывает пересекающиеся события и их количество', () => {
  const stock = [{ name: 'Камера', quantity: 5 }];
  const events = [gear('a', '10:00', '11:00', ['Камера'], { Камера: 3 }), gear('b', '10:30', '11:30', ['камера']), gear('c', '11:00', '12:00', ['Камера'], { Камера: 5 })];
  assert.equal(L.freeStock(ev('n', '10:30', '10:45'), events, stock[0]), 1);
  assert.equal(L.freeStock(ev('n', '12:00', '13:00'), events, stock[0]), 5);
  assert.equal(L.freeStock(gear('a', '10:00', '11:00', []), events, stock[0]), 4, 'своё событие не считается');
  assert.equal(L.freeStock(ev('n', '08:00', '09:00'), events, { name: 'Камера', quantity: null }), null);
});

test('нехватка техники определяется, в пределах лимита всё хорошо', () => {
  const stock = [{ name: 'Камера', quantity: 2 }, { name: 'Штатив', quantity: null }];
  const busy = [gear('a', '10:00', '11:00', ['Камера'])];
  assert.deepEqual(L.shortages(gear('n', '10:00', '11:00', ['Камера'], { Камера: 2 }), busy, stock), [{ name: 'Камера', need: 2, free: 1, total: 2 }]);
  assert.deepEqual(L.shortages(gear('n', '10:00', '11:00', ['Камера']), busy, stock), []);
  assert.deepEqual(L.shortages(gear('n', '10:00', '11:00', ['Штатив'], { Штатив: 99 }), busy, stock), []);
  assert.deepEqual(L.shortages(gear('n', '10:00', '11:00', ['Вне списка']), busy, stock), []);
});

test('техника со счётом и своя камера не дают ложной занятости', () => {
  const stock = [{ name: 'Камера', quantity: 5 }];
  const busy = [gear('a', '10:00', '11:00', ['Камера', L.OWN_CAMERA, 'Проектор'])];
  const found = L.findConflicts(gear('n', '10:00', '11:00', ['Камера', L.OWN_CAMERA, 'Проектор']), busy, stock);
  assert.deepEqual(found.map((c) => c.name), ['Проектор']);
});

test('подпись количества', () => {
  assert.equal(L.equipmentLabel({ equipmentQty: { Камера: 3 } }, 'Камера'), 'Камера × 3');
  assert.equal(L.equipmentLabel({}, 'Камера'), 'Камера');
});

test('столбцы техники из таблицы', () => {
  assert.deepEqual(L.parseEquipment('Камера\t5\r\nШтатив большой\nСвет\tLED\t3\n'), [
    { name: 'Камера', quantity: 5 }, { name: 'Штатив большой', quantity: null }, { name: 'Свет LED', quantity: 3 },
  ]);
});

test('записка: только не для занятий и только если есть участники', () => {
  const e = { type: 'practice', title: 'Т', date: '2026-11-03', start: '10:00', end: '11:00', place: '', responsible: '', participants: ['Иванов'] };
  assert.equal(L.memoApplies(e), true);
  assert.equal(L.memoApplies({ ...e, type: 'lesson' }), false);
  assert.equal(L.memoApplies({ ...e, participants: [] }), false);
  assert.equal(L.needsMemo(e, {}), true);
  assert.equal(L.needsMemo(e, { ...e, id: '1' }), false, 'без изменений записка не пересоздаётся');
  assert.equal(L.needsMemo(e, { ...e, id: '1', participants: [] }), true);
  assert.equal(L.needsMemo(e, { ...e, id: '1', notes: 'другое' }), false);
  assert.equal(L.needsMemo({ ...e, type: 'lesson' }, {}), false);
});

test('значения записки', () => {
  const memo = L.memoData(
    { title: 'Концерт', date: '2026-11-05', start: '11:00', end: '14:30', place: 'Зал', responsible: 'Павлов С. Н.', participants: ['Иванова Анна', 'Гость'] },
    [{ name: 'Иванова Анна', groupId: 'g' }], [{ id: 'g', name: 'ИС-21' }], '2026-11-03',
  );
  assert.deepEqual([memo.day, memo.month, memo.year], ['03', 'ноября', '2026']);
  assert.equal(memo.when, '5 ноября 2026, 11:00');
  assert.equal(memo.release, '11:00–14:30');
  assert.deepEqual(memo.students, [{ name: 'Иванова Анна', group: 'ИС-21' }, { name: 'Гость', group: '' }]);
});

test('подготовка делает участников занятыми раньше начала', () => {
  const concert = ev('c', '11:00', '12:00', { prepMinutes: 60, participants: ['Иванов'] });
  assert.equal(L.busyFrom(concert), '10:00');
  assert.equal(L.busyFrom(ev('x', '00:30', '01:00', { prepMinutes: 90 })), '00:00');
  assert.equal(L.busyFrom(ev('x', '10:00', '11:00')), '10:00');
  const before = ev('b', '09:30', '10:30', { participants: ['Иванов'] });
  assert.equal(L.findConflicts(before, [concert]).length, 1, 'пересечение с подготовкой');
  assert.equal(L.findConflicts(ev('b', '09:00', '10:00', { participants: ['Иванов'] }), [concert]).length, 0);
});

test('подготовка занимает технику', () => {
  const stock = { name: 'Камера', quantity: 1 };
  const concert = { ...gear('c', '11:00', '12:00', ['Камера']), prepMinutes: 60 };
  assert.equal(L.freeStock(ev('b', '10:30', '10:45'), [concert], stock), 0);
  assert.equal(L.freeStock(ev('b', '09:00', '10:00'), [concert], stock), 1);
});

test('время освобождения в записке начинается с подготовки', () => {
  const e = { type: 'event', title: 'К', date: '2026-11-05', start: '11:00', end: '12:00', prepMinutes: 45, place: '', responsible: '', participants: ['А'] };
  const memo = L.memoData(e, [], [], '2026-11-03');
  assert.equal(memo.release, '10:15–12:00');
  assert.equal(memo.when, '5 ноября 2026, 11:00', 'начало события не меняется');
  assert.equal(L.needsMemo(e, { ...e, id: '1', prepMinutes: 0 }), true, 'изменение подготовки обновляет записку');
});

test('занятость техники: сейчас, у кого, с учётом подготовки и количества', () => {
  const stock = [{ name: 'Камера', quantity: 5 }, { name: 'Штатив', quantity: null }, { name: 'Проектор', quantity: 1 }];
  const events = [
    { ...gear('a', '10:00', '11:00', ['камера'], { камера: 2 }), responsible: 'Лебедева' },
    { ...gear('b', '11:00', '12:00', ['Камера']), prepMinutes: 90 },
    gear('c', '10:30', '12:00', ['Вне списка']),
    gear('d', '13:00', '14:00', ['Штатив']),
    { ...gear('past', '08:00', '09:00', ['Проектор']) },
    { ...gear('tomorrow', '09:00', '10:00', ['Проектор']), date: '2026-11-04' },
  ];
  const rows = L.equipmentNow(stock, events, '2026-11-03', '10:45');
  const row = (name) => rows.find((r) => r.name === name);
  assert.equal(row('Камера').used, 3);
  assert.equal(row('Камера').total, 5);
  assert.deepEqual(row('Камера').holders.map((h) => h.event.id), ['a', 'b']);
  assert.equal(row('Камера').holders[0].event.responsible, 'Лебедева');
  assert.equal(row('Вне списка').used, 1, 'техника, вписанная вручную, тоже видна');
  assert.equal(row('Штатив').used, 0);
  assert.equal(row('Штатив').next.id, 'd');
  assert.equal(row('Проектор').next.id, 'tomorrow', 'ближайшая бронь на другой день');
  assert.ok(rows.findIndex((r) => r.name === 'Камера') < rows.findIndex((r) => r.name === 'Штатив'), 'занятое выше свободного');
  assert.equal(L.equipmentNow(stock, events, '2026-11-03', '12:30').find((r) => r.name === 'Камера').used, 0);
});

test('занятость техники считается по концу события и не показывает свою камеру как запас', () => {
  const rows = L.equipmentNow([{ name: L.OWN_CAMERA, quantity: null }, { name: 'Камера', quantity: 1 }], [gear('a', '10:00', '11:00', ['Камера'])], '2026-11-03', '11:00');
  assert.deepEqual(rows.map((r) => [r.name, r.used]), [['Камера', 0]]);
});

test('напоминания: истёкшие скрываются, ближайшие к сроку идут первыми', () => {
  const notices = [{ name: 'позже', until: '2026-11-05T10:00' }, { name: 'раньше', until: '2026-11-04T10:00' }, { name: 'истекло', until: '2026-11-03T10:00' }];
  assert.deepEqual(L.activeNotices(notices, '2026-11-03T10:00').map((n) => n.name), ['раньше', 'позже']);
  assert.deepEqual(L.activeNotices(notices, '2026-11-05T10:00'), []);
});

test('сроки сдачи: состояние меняется со временем и отметкой о сдаче', () => {
  const task = (deadline, deadlineDone = '') => ({ id: deadline, deadline, deadlineDone });
  const moment = '2026-11-03T11:42';
  assert.equal(L.deadlineState({ deadline: '' }, moment), null);
  assert.equal(L.deadlineState(task('2026-11-03T11:42'), moment), 'overdue', 'в сам момент срока уже поздно');
  assert.equal(L.deadlineState(task('2026-11-03T11:43'), moment), 'soon');
  assert.equal(L.deadlineState(task('2026-11-04T23:59'), moment), 'soon');
  assert.equal(L.deadlineState(task('2026-11-05T00:00'), moment), 'later');
  assert.equal(L.deadlineState(task('2026-11-01T10:00', '2026-11-02T10:00'), moment), 'done', 'сданное не просрочено');
});

test('сроки сдачи раскладываются по группам и по порядку', () => {
  const list = L.deadlineList([
    { id: 'нет', deadline: '' },
    { id: 'позже2', deadline: '2026-11-20T10:00' },
    { id: 'позже1', deadline: '2026-11-10T10:00' },
    { id: 'долг', deadline: '2026-11-01T10:00' },
    { id: 'завтра', deadline: '2026-11-04T10:00' },
    { id: 'сдано-давно', deadline: '2026-10-01T10:00', deadlineDone: '2026-10-01T09:00' },
    { id: 'сдано', deadline: '2026-11-02T10:00', deadlineDone: '2026-11-02T09:00' },
  ], '2026-11-03T11:42');
  assert.deepEqual(Object.fromEntries(Object.entries(list).map(([key, items]) => [key, items.map((e) => e.id)])), {
    overdue: ['долг'], soon: ['завтра'], later: ['позже1', 'позже2'], done: ['сдано', 'сдано-давно'],
  });
});

test('в строку попадают поджимающие сроки и свежие просрочки', () => {
  const alerts = L.deadlineAlerts([
    { id: 'старая', deadline: '2026-10-30T23:59' },
    { id: 'просрочка', deadline: '2026-10-31T00:00' },
    { id: 'недавняя', deadline: '2026-11-03T08:00' },
    { id: 'завтра', deadline: '2026-11-04T18:00' },
    { id: 'нескоро', deadline: '2026-11-05T18:00' },
    { id: 'сдана', deadline: '2026-11-03T08:00', deadlineDone: '2026-11-03T07:00' },
  ], '2026-11-03T11:42');
  assert.deepEqual(alerts.map(({ event, late }) => [event.id, late]), [['недавняя', true], ['просрочка', true], ['завтра', false]]);
});

test('опоздание ставит преподаватель, присутствие его не вызывает', () => {
  const event = { date: '2026-11-03', start: '09:00', end: '10:30', participants: ['Аня', 'Боря', 'Вера', 'Гена'] };
  const at = new Date(2026, 10, 3, 9, 20).toISOString();
  const doc = { marks: {
    Аня: { status: 'present', at, late: false },
    Боря: { status: 'present', at, late: true },
    Вера: { status: 'present', at },
  } };
  const rows = L.rollCall(event, doc, '2026-11-03', '09:30');
  assert.deepEqual(rows.map((r) => [r.name, r.late]), [['Аня', 0], ['Боря', 0], ['Вера', 20], ['Гена', 0]]);
});

test('опоздание засчитывается до конца 10-й минуты, позже нет, с 40-й это пропуск', () => {
  const event = { date: '2026-11-03', start: '09:00', end: '10:30', participants: ['Боря'] };
  const row = (minute) => L.rollCall(event, { marks: { Боря: { status: 'present', at: new Date(2026, 10, 3, 9, minute).toISOString(), late: true } } }, '2026-11-03', '09:50')[0];
  assert.deepEqual([row(0).status, row(0).late], ['present', 1]);
  assert.deepEqual([row(10).status, row(10).late], ['present', 10]);
  assert.deepEqual([row(11).status, row(11).late, row(11).lateMark], ['present', 0, true]);
  assert.deepEqual([row(39).status, row(39).late], ['present', 0]);
  assert.deepEqual([row(40).status, row(40).late, row(40).lateMark], ['absent', 0, true]);
});

test('зафиксированный отчёт держит свой состав и закрывает неотмеченных', () => {
  const event = { date: '2026-11-03', start: '09:00', end: '10:30', participants: ['Аня', 'Новенький'] };
  const doc = { marks: { Аня: { status: 'present', at: new Date(2026, 10, 3, 9, 0).toISOString(), late: false } }, lock: { at: 'x', teacher: 'Т', participants: ['Аня', 'Боря'] } };
  const rows = L.rollCall(event, doc, '2026-11-03', '09:30');
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [['Аня', 'present'], ['Боря', 'absent']]);
});

test('внесённые в задание, практику или мероприятие сразу освобождены от занятия', () => {
  const lesson = { id: 'l', type: 'lesson', date: '2026-11-03', start: '10:00', end: '11:30', participants: ['Аня', 'Боря', 'Вера', 'Гена', 'Дина'] };
  const events = [
    lesson,
    { id: 'm', type: 'event', title: 'Концерт', date: '2026-11-03', start: '11:00', end: '12:00', participants: ['аня'] },
    { id: 't', type: 'task', title: 'Съёмка', date: '2026-11-03', start: '09:00', end: '10:30', participants: ['Боря'] },
    { id: 'p', type: 'practice', title: 'Практика', date: '2026-11-03', start: '12:00', end: '13:00', prepMinutes: 60, participants: ['Вера'] },
    { id: 'другая пара', type: 'lesson', title: 'Пара', date: '2026-11-03', start: '10:00', end: '11:30', participants: ['Гена'] },
    { id: 'позже', type: 'event', title: 'Вечер', date: '2026-11-03', start: '11:30', end: '12:00', participants: ['Дина'] },
    { id: 'завтра', type: 'event', title: 'Завтра', date: '2026-11-04', start: '10:00', end: '11:00', participants: ['Дина'] },
  ];
  assert.deepEqual([...L.excusedBy(lesson, events)], [['Аня', 'Концерт'], ['Боря', 'Съёмка'], ['Вера', 'Практика']]);
  const rows = L.rollCall(lesson, null, '2026-11-03', '10:05', events);
  assert.deepEqual(rows.map((row) => row.status), ['order', 'order', 'order', 'pending', 'pending']);
  assert.equal(rows[0].excusedFor, 'Концерт');
  assert.equal(L.rollCall(lesson, null, '2026-11-03', '12:00', events)[3].status, 'absent');
  const came = { marks: { Аня: { status: 'present', at: new Date(2026, 10, 3, 10, 0).toISOString(), late: false } } };
  assert.equal(L.rollCall(lesson, came, '2026-11-03', '10:05', events)[0].status, 'present', 'пришедший отмечается как пришедший');
  assert.equal(L.excusedBy({ ...events[1] }, events).size, 0, 'мероприятие само не освобождается');
});

test('после фиксации освобождения не зависят от расписания', () => {
  const lesson = { id: 'l', type: 'lesson', date: '2026-11-03', start: '10:00', end: '11:30', participants: ['Аня', 'Боря'] };
  const later = [{ id: 'm', type: 'event', title: 'Новое', date: '2026-11-03', start: '10:00', end: '11:00', participants: ['Боря'] }];
  const doc = { marks: {}, lock: { at: 'x', teacher: 'Т', participants: ['Аня', 'Боря'], excused: { Аня: 'Концерт' } } };
  const rows = L.rollCall(lesson, doc, '2026-11-03', '10:05', later);
  assert.deepEqual(rows.map((row) => row.status), ['order', 'absent']);
});

test('больничный без справки предварительный, старые отметки считаются подтверждёнными', () => {
  const event = { id: 'e', title: 'Пара', date: '2026-11-03', start: '09:00', end: '10:30', participants: ['Аня', 'Боря', 'Вера'] };
  const doc = { eventId: 'e', marks: {
    Аня: { status: 'sick', at: 'x', confirmed: false },
    Боря: { status: 'sick', at: 'x', confirmed: true },
    Вера: { status: 'sick', at: 'x' },
  } };
  assert.deepEqual(L.rollCall(event, doc, '2026-11-03', '09:30').map((row) => Boolean(row.unconfirmed)), [true, false, false]);
  const later = { ...event, id: 'f', title: 'Вторая', date: '2026-11-04' };
  const list = L.pendingCertificates([{ eventId: 'f', marks: { Аня: { status: 'sick', at: 'y', confirmed: false } } }, doc, { eventId: 'нет', marks: { Гена: { status: 'sick', confirmed: false } } }], [event, later]);
  assert.deepEqual(list.map((p) => [p.name, p.classes.map((c) => c.event.title)]), [['Аня', ['Пара', 'Вторая']]]);
  const report = L.buildReport({ events: [event], attendance: [doc], students: [], groups: [], filters: { from: '2026-11-01', to: '2026-11-30', group: '', teacher: '', types: ['lesson', undefined] }, nowISO: '2026-11-05', nowTime: '10:00' });
  assert.equal(report.pairs[0].noCertificate, 1);
  assert.equal(report.pairs[0].sick, 3);
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
