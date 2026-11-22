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

test('без отметки: пока пара идёт — нет отметки, после окончания — пропуск, если перекличка была', () => {
  const e = lesson('a', '2026-11-03', '09:00', '10:30', ['Иванов', 'Петров']);
  assert.equal(L.rollCall(e, null, '2026-11-03', '10:00')[0].status, 'pending');
  const marked = { marks: { Петров: { status: 'present', at: at('2026-11-03', '09:00') } } };
  assert.equal(L.rollCall(e, marked, '2026-11-03', '10:30')[0].status, 'absent', 'остальных отметили — не отмеченный не пришёл');
  assert.deepEqual(L.rollCall(e, null, '2026-11-03', '10:30').map((r) => r.status), ['unmarked', 'unmarked'], 'не отмечен никто — перекличку не проводили');
  const locked = { marks: {}, lock: { at: 'x', teacher: 'Т', participants: ['Иванов', 'Петров'], excused: {} } };
  assert.deepEqual(L.rollCall(e, locked, '2026-11-03', '10:30').map((r) => r.status), ['absent', 'absent'], 'отчёт зафиксирован без отметок — прогул');
});

test('отметка задним числом после конца пары — пришёл вовремя, опоздание только явное', () => {
  const e = lesson('a', '2026-09-03', '09:00', '10:30', ['Иванов', 'Петров', 'Сидоров']);
  const doc = { marks: {
    Иванов: { status: 'present', at: at('2026-11-21', '15:40') },
    Петров: { status: 'present', at: at('2026-09-03', '09:15'), late: true },
    Сидоров: { status: 'present', at: at('2026-09-03', '09:50') },
  } };
  const rows = L.rollCall(e, doc, '2026-11-21', '16:00');
  assert.deepEqual(rows.map((r) => [r.status, r.late]), [['present', 0], ['present', 15], ['absent', 0]]);
  assert.equal(rows[0].lateMark, false);
});

test('снятая отметка считается отсутствующей', () => {
  const e = lesson('a', '2026-11-03', '09:00', '10:30', ['Иванов', 'Петров']);
  const doc = { marks: { Иванов: { status: null, at: null }, Петров: { status: 'present', at: at('2026-11-03', '09:00') } } };
  assert.equal(L.rollCall(e, doc, '2026-11-04', '10:00')[0].status, 'absent');
});

test('отчёт считает проведённые пары, причины, опоздания и проценты', () => {
  const events = [
    lesson('a', '2026-11-03', '09:00', '10:30', ['Иванов', 'Петров', 'Сидоров', 'Гость']),
    lesson('b', '2026-11-10', '09:00', '10:30', ['Иванов']),
    // Практика идёт без отметки: в отчёт о посещаемости не попадает.
    lesson('p', '2026-11-07', '09:00', '10:30', ['Иванов'], { type: 'practice' }),
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
  assert.deepEqual(pairs.map((p) => [p.event.id, p.total, p.unmarked]), [['a', 0, 1]], 'без переклички — не в процентах, а отдельно');
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
  const event = { type: 'lesson', date: '2026-11-03', start: '09:00', end: '10:30', participants: ['Аня', 'Боря', 'Вера', 'Гена'] };
  const at = new Date(2026, 10, 3, 9, 20).toISOString();
  const doc = { marks: {
    Аня: { status: 'present', at, late: false },
    Боря: { status: 'present', at, late: true },
    Вера: { status: 'present', at },
  } };
  const rows = L.rollCall(event, doc, '2026-11-03', '09:30');
  assert.deepEqual(rows.map((r) => [r.name, r.late]), [['Аня', 20], ['Боря', 20], ['Вера', 20], ['Гена', 0]]);
});

test('случай из колледжа: преподаватель задержался, опоздание считается от фактического начала', () => {
  const names = ['С1', 'С2', 'С3', 'С4', 'С5', 'С6', 'С7', 'В1017', 'В1027', 'В1032', 'В1055', 'Нет'];
  const event = { type: 'lesson', date: '2026-11-03', start: '10:15', end: '11:45', participants: names };
  const at = (time) => new Date(2026, 10, 3, ...time.split(':').map(Number)).toISOString();
  const marks = Object.fromEntries([
    ...names.slice(0, 7).map((name) => [name, { status: 'present', at: at('10:10'), late: false }]),
    ['В1017', { status: 'present', at: at('10:17'), late: false }],
    ['В1027', { status: 'present', at: at('10:27'), late: false }],
    ['В1032', { status: 'present', at: at('10:32'), late: false }],
    ['В1055', { status: 'present', at: at('10:55'), late: true }],
  ]);
  const view = (doc) => L.rollCall(event, doc, '2026-11-03', '12:00').map((row) => `${row.status}${row.late ? row.late : ''}`);
  const started = { marks, start: { at: at('10:30') } };
  assert.deepEqual(view(started), [...Array(7).fill('present'), 'present', 'present', 'present', 'present25', 'absent']);
  assert.equal(L.startDelay(event, started), 15);
  assert.deepEqual(view({ marks }).slice(7), ['present', 'present12', 'present17', 'absent', 'absent'], 'без кнопки отсчёт от расписания');
  assert.deepEqual(view({ marks, start: { at: at('10:00') } }).slice(7, 8), ['present'], 'раньше расписания занятие не начинается');
  assert.equal(L.startDelay(event, { start: { at: at('10:00') } }), 0);
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
  assert.equal(L.rollCall(lesson, null, '2026-11-03', '12:00', events)[3].status, 'unmarked', 'никого не отмечали — перекличку не проводили');
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
  const event = { id: 'e', type: 'lesson', title: 'Пара', date: '2026-11-03', start: '09:00', end: '10:30', participants: ['Аня', 'Боря', 'Вера'] };
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

test('подгруппы МГЗ входят в общую группу, а половина группы не считается отсутствующей', () => {
  const groups = [{ id: 'g', name: 'ФВТ-24' }, { id: 'a', name: 'ФВТ-24-1' }, { id: 'b', name: 'ФВТ-24-2' }, { id: 'x', name: 'ДИ-3' }, { id: 'y', name: 'ДИ-3-1А' }];
  const students = [
    { name: 'Аня', groupId: 'a' }, { name: 'Боря', groupId: 'a' }, { name: 'Вера', groupId: 'b' }, { name: 'Гена', groupId: 'b' },
    { name: 'Аня', groupId: 'g' }, { name: 'Дина', groupId: 'x' },
  ];
  assert.equal(L.parentGroup(groups[1], groups).id, 'g');
  assert.equal(L.parentGroup(groups[0], groups), null);
  assert.equal(L.parentGroup(groups[4], groups), null, 'только номер подгруппы');
  assert.deepEqual(L.groupMembers(groups[0], groups, students).map((s) => s.name), ['Аня', 'Боря', 'Вера', 'Гена']);
  assert.deepEqual(L.groupMembers(groups[1], groups, students).map((s) => s.name), ['Аня', 'Боря']);
  const at = new Date(2026, 10, 3, 9, 0).toISOString();
  const mgz = { id: 'm', type: 'lesson', title: 'МГЗ', date: '2026-11-03', start: '09:00', end: '10:30', participants: ['Аня', 'Боря'] };
  const common = { ...mgz, id: 'c', title: 'Общая', start: '11:00', end: '12:00', participants: ['Аня', 'Боря', 'Вера', 'Гена'] };
  const doc = (eventId, names) => ({ eventId, marks: Object.fromEntries(names.map((n) => [n, { status: 'present', at, late: false }])) });
  const report = L.buildReport({
    events: [mgz, common], attendance: [doc('m', ['Аня', 'Боря']), doc('c', ['Аня', 'Боря', 'Вера', 'Гена'])], students, groups,
    filters: { from: '2026-11-01', to: '2026-11-30', group: 'ФВТ-24', teacher: '', types: ['lesson'] }, nowISO: '2026-11-05', nowTime: '10:00',
  });
  assert.deepEqual(report.pairs.map((p) => [p.event.title, p.total, p.percent]), [['МГЗ', 2, 100], ['Общая', 4, 100]]);
  assert.deepEqual(report.students.find((s) => s.name === 'Вера').total, 1, 'Вера не числится на чужом МГЗ');
  assert.deepEqual(report.groups.map((g) => [g.name, g.total, g.percent]), [['ФВТ-24', 6, 100], ['ФВТ-24-1', 4, 100], ['ФВТ-24-2', 2, 100]]);
  assert.equal(L.memoData({ ...mgz, responsible: '', place: '' }, students, groups, '2026-11-03').students?.[0]?.group ?? 'ФВТ-24', 'ФВТ-24');
});

test('на мероприятии только был или не был, без опозданий', () => {
  const event = { type: 'event', date: '2026-11-03', start: '10:00', end: '12:00', participants: ['Аня', 'Боря', 'Вера'] };
  const at = (time) => new Date(2026, 10, 3, ...time.split(':').map(Number)).toISOString();
  const doc = { marks: { Аня: { status: 'present', at: at('10:25'), late: true }, Боря: { status: 'present', at: at('11:30'), late: false } }, start: { at: at('10:20') } };
  const rows = L.rollCall(event, doc, '2026-11-03', '12:30');
  assert.deepEqual(rows.map((row) => [row.status, row.late]), [['present', 0], ['present', 0], ['absent', 0]]);
  assert.equal(L.countsLateness({ type: 'lesson' }), true);
  assert.equal(L.countsLateness({ type: 'task' }), false, 'задание: был или не был');
  assert.equal(L.countsLateness({ type: 'practice' }), false);
});

test('цепочка событий: даты по каждому виду повтора до последнего дня', () => {
  assert.deepEqual(L.repeatDates('2026-11-02', 'week', '2026-11-23'), ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']);
  assert.deepEqual(L.repeatDates('2026-11-02', '2weeks', '2026-11-29'), ['2026-11-02', '2026-11-16']);
  assert.deepEqual(L.repeatDates('2026-11-06', 'weekdays', '2026-11-10'), ['2026-11-06', '2026-11-09', '2026-11-10'], 'суббота и воскресенье пропущены');
  assert.deepEqual(L.repeatDates('2026-11-06', 'monsat', '2026-11-10'), ['2026-11-06', '2026-11-07', '2026-11-09', '2026-11-10'], 'воскресенье пропущено');
  assert.equal(L.repeatDates('2026-11-01', 'day', '2026-11-30').length, 30);
  assert.deepEqual(L.repeatDates('2026-10-31', 'month', '2027-01-31'), ['2026-10-31', '2026-12-31', '2027-01-31'], 'в ноябре нет 31-го');
  assert.deepEqual(L.repeatDates('2026-11-02', 'week', '2026-11-01'), ['2026-11-02']);
  assert.equal(L.repeatDates('2026-01-01', 'day', '2030-01-01').length, L.MAX_REPEATS, 'длина ограничена');
  const series = [{ id: 'a', seriesId: 's', date: '2026-11-02' }, { id: 'c', seriesId: 's', date: '2026-11-16' }, { id: 'b', seriesId: 's', date: '2026-11-09' }, { id: 'x', seriesId: 'другая', date: '2026-11-20' }];
  assert.deepEqual(L.seriesFrom(series[2], series).map((e) => e.id), ['b', 'c']);
  assert.deepEqual(L.seriesFrom({ id: 'одно', date: '2026-11-02' }, series).map((e) => e.id), ['одно']);
});

test('на практике тоже только был или не был', () => {
  const event = { type: 'practice', date: '2026-11-03', start: '10:00', end: '12:00', participants: ['Аня'] };
  const doc = { marks: { Аня: { status: 'present', at: new Date(2026, 10, 3, 11, 0).toISOString(), late: false } } };
  assert.deepEqual(L.rollCall(event, doc, '2026-11-03', '12:30').map((row) => [row.status, row.late]), [['present', 0]]);
});

test('весь день для студентов: учебный день с 8:30 до 20:00 целиком, с учётом подготовки', () => {
  assert.equal(L.isAllDay({ start: '09:00', end: '10:00', allDay: true }), true);
  assert.equal(L.isAllDay({ start: '08:30', end: '20:00' }), true);
  assert.equal(L.isAllDay({ start: '00:00', end: '23:59' }), true);
  assert.equal(L.isAllDay({ start: '10:00', end: '20:30', prepMinutes: 120 }), true, 'с подготовкой и завозом с 8:00');
  assert.equal(L.isAllDay({ start: '10:00', end: '20:30', prepMinutes: 60 }), false);
  assert.equal(L.isAllDay({ start: '08:30', end: '19:55' }), false);
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

test('опоздания: кто чаще и по каким дням недели', () => {
  const students = [{ name: 'Иванов', groupId: 'g' }, { name: 'Петрова', groupId: 'g' }, { name: 'Сидоров', groupId: 'g' }];
  const groups = [{ id: 'g', name: 'ФВТ-24' }];
  const who = students.map((s) => s.name);
  // 2026-11-02 понедельник, 2026-11-03 вторник, 2026-11-09 понедельник.
  const lessons = ['2026-11-02', '2026-11-03', '2026-11-09'].map((date, i) => ({ id: `e${i}`, type: 'lesson', title: 'Пара', date, start: '09:00', end: '10:30', participants: who }));
  const at = (date, time) => new Date(`${date}T${time}`).toISOString();
  const attendance = [
    { eventId: 'e0', marks: { 'Иванов': { status: 'present', at: at('2026-11-02', '09:15') }, 'Петрова': { status: 'present', at: at('2026-11-02', '09:12') }, 'Сидоров': { status: 'present', at: at('2026-11-02', '09:00') } } },
    { eventId: 'e1', marks: { 'Иванов': { status: 'present', at: at('2026-11-03', '09:05') }, 'Петрова': { status: 'present', at: at('2026-11-03', '09:45') }, 'Сидоров': { status: 'present', at: at('2026-11-03', '09:00') } } },
    { eventId: 'e2', marks: { 'Иванов': { status: 'present', at: at('2026-11-09', '09:25') }, 'Петрова': { status: 'present', at: at('2026-11-09', '09:00') }, 'Сидоров': { status: 'present', at: at('2026-11-09', '09:00') } } },
  ];
  const report = L.buildReport({ events: lessons, attendance, students, groups, filters: { from: '2026-11-01', to: '2026-11-30', types: ['lesson'], group: '', teacher: '' }, nowISO: '2026-11-30', nowTime: '20:00' });
  assert.deepEqual(report.lateness.map((r) => [r.name, r.late, r.minutes, r.tooLate]), [['Иванов', 2, 40, 0], ['Петрова', 1, 12, 1]]);
  assert.deepEqual(report.lateness[0].byWeekday, [2, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(report.lateness[0].worstDays, [1]);
  assert.equal(report.lateness[0].average, 20);
  assert.equal(report.lateness[0].last, '2026-11-09');
  assert.deepEqual(report.latenessByWeekday, [3, 0, 0, 0, 0, 0, 0]);
});

test('ранний сигнал: пропуски подряд, частые пропуски и опоздания, «Разобрались»', () => {
  const students = [{ id: 'a', name: 'Иванов', groupId: 'g' }, { id: 'b', name: 'Петрова', groupId: 'g' }, { id: 'c', name: 'Сидоров', groupId: 'g' }];
  const groups = [{ id: 'g', name: 'ФВТ-24' }];
  const who = students.map((s) => s.name);
  const days = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10'];
  const events = days.map((date, i) => ({ id: `e${i}`, type: 'lesson', title: 'Пара', date, start: '09:00', end: '10:30', participants: who }));
  const at = (date, time) => new Date(`${date}T${time}`).toISOString();
  const attendance = days.map((date, i) => ({ eventId: `e${i}`, marks: {
    // Иванов: 3 пропуска подряд в конце. Петрова: опаздывает 3 раза за неделю. Сидоров: был, один раз болел.
    'Иванов': i < 2 ? { status: 'present', at: at(date, '09:00') } : undefined,
    'Петрова': { status: 'present', at: at(date, i >= 2 ? '09:20' : '09:00') },
    'Сидоров': i === 1 ? { status: 'sick' } : { status: 'present', at: at(date, '09:00') },
  } })).map((doc) => ({ ...doc, marks: Object.fromEntries(Object.entries(doc.marks).filter(([, m]) => m)) }));
  const now = { nowISO: '2026-11-10', nowTime: '18:00' };
  const signals = L.earlySignals({ events, attendance, students, groups, ...now });
  assert.deepEqual(signals.map((s) => [s.name, s.reasons.map((r) => `${r.kind}:${r.count}`).join(',')]), [
    ['Иванов', 'streak:3'],
    ['Петрова', 'lateWeek:3'],
  ]);
  assert.equal(signals[0].group, 'ФВТ-24');
  // Куратор разобрался после пары 10 ноября: старое больше не считается.
  students[0].signalSince = new Date(2026, 10, 10, 11, 0).toISOString();
  assert.deepEqual(L.earlySignals({ events, attendance, students, groups, ...now }).map((s) => s.name), ['Петрова']);
});

test('портфолио: где был, где по приказу, и достижения', () => {
  const events = [
    { id: 'e1', type: 'event', title: 'Концерт хора', date: '2026-10-20', start: '17:00', end: '19:00', place: 'Актовый зал', participants: ['Иванов', 'Петрова'] },
    { id: 'e2', type: 'task', title: 'Фотосъёмка выставки', date: '2026-10-25', start: '12:00', end: '14:00', participants: ['Иванов'] },
    { id: 'e3', type: 'practice', title: 'Практика в музее', date: '2026-11-02', start: '09:00', end: '15:00', participants: ['Иванов'] },
    { id: 'e4', type: 'lesson', title: 'Пара', date: '2026-11-03', start: '09:00', end: '10:30', participants: ['Иванов'] },
    { id: 'e5', type: 'event', title: 'Будущий концерт', date: '2026-12-01', start: '17:00', end: '19:00', participants: ['Иванов'] },
  ];
  const attendance = [{ eventId: 'e3', marks: { 'Иванов': { status: 'absent' } } }, { eventId: 'e1', marks: { 'Иванов': { status: 'present' } } }];
  const achievements = [{ name: 'Конкурс «Объектив»', student: 'Иванов', date: '2026-10-30', result: 'Диплом I степени' }, { name: 'Чужое', student: 'Петрова', date: '2026-10-30', result: '' }];
  const p = L.portfolio({ name: 'иванов', events, attendance, achievements, nowISO: '2026-11-10', nowTime: '12:00' });
  assert.deepEqual(p.items.map((i) => i.title), ['Фотосъёмка выставки', 'Концерт хора'], 'практику пропустил, пары и будущее не входят');
  assert.deepEqual(p.awards.map((a) => a.result), ['Диплом I степени']);
  assert.deepEqual(p.counts, { event: 1, task: 1, practice: 0 });
});

test('многодневная практика: начало, конец и номер дня', () => {
  const days = ['2026-11-16', '2026-11-17', '2026-11-18'].map((date, i) => ({ id: `p${i}`, type: 'practice', seriesId: 'S', date }));
  assert.deepEqual(L.practiceSpan(days[1], days), { from: '2026-11-16', to: '2026-11-18', day: 2, days: 3 });
  assert.equal(L.practiceSpan({ type: 'practice', seriesId: '', date: '2026-11-16' }, days), null, 'один день');
  assert.equal(L.practiceSpan({ ...days[0], type: 'lesson' }, days), null, 'не практика');
});

test('занятие не состоялось: нет в отчёте, сигналах, конфликтах и освобождениях', () => {
  const who = ['Иванов'];
  const events = ['2026-11-04', '2026-11-05', '2026-11-06'].map((date, i) => ({ id: `e${i}`, type: 'lesson', title: 'Пара', date, start: '09:00', end: '10:30', participants: who, equipment: ['Проектор'] }));
  const attendance = events.map((e) => ({ eventId: e.id, marks: { 'Петров': { status: 'present', at: new Date(`${e.date}T09:00`).toISOString() } } }));
  events.forEach((e) => e.participants.push('Петров'));
  const now = { nowISO: '2026-11-10', nowTime: '18:00' };
  const students = [{ id: 'a', name: 'Иванов', groupId: 'g' }];
  const groups = [{ id: 'g', name: 'ФВТ-24' }];
  assert.equal(L.earlySignals({ events, attendance, students, groups, ...now }).length, 1, 'три пропуска подряд');
  events[1].cancelled = true;
  assert.equal(L.earlySignals({ events, attendance, students, groups, ...now }).length, 0, 'отменённая пара не пропуск');
  const report = L.buildReport({ events, attendance, students, groups, filters: { from: '2026-11-01', to: '2026-11-30', types: ['lesson'] }, ...now });
  assert.deepEqual(report.pairs.map((p) => p.event.id), ['e0', 'e2']);
  const draft = { id: 'x', date: '2026-11-05', start: '09:30', end: '10:00', participants: ['Иванов'], equipment: ['Проектор'] };
  assert.deepEqual(L.findConflicts(draft, events), [], 'люди и техника свободны');
  const task = { id: 't', type: 'task', title: 'Съёмка', date: '2026-11-05', start: '09:00', end: '10:30', participants: ['Иванов'], cancelled: true };
  assert.equal(L.excusedBy({ ...events[2], date: '2026-11-05' }, [task]).size, 0, 'отменённое задание не освобождает');
});

test('сценарий занятия: начать, перекличка, опоздавшие по факту, обычный список', async () => {
  const L = await import('../src/renderer/logic.mjs');
  const lesson = { id: 'x', type: 'lesson', date: '2026-11-16', start: '10:00', end: '11:30', participants: ['Иванов', 'Петров'] };
  const at = (time) => new Date(`2026-11-16T${time}`).getTime();
  assert.equal(L.rollStage(lesson, null, at('09:20')), 'list', 'рано');
  assert.equal(L.rollStage(lesson, null, at('09:35')), 'start');
  assert.equal(L.rollStage(lesson, null, at('10:39')), 'start');
  assert.equal(L.rollStage(lesson, null, at('10:41')), 'list', 'после 40-й минуты кнопки нет');
  const doc = { start: { at: new Date(at('10:05')).toISOString() } };
  assert.equal(L.rollStage(lesson, doc, at('10:06')), 'call');
  assert.equal(L.rollStage(lesson, doc, at('10:06'), true), 'live', 'перекличку закончили');
  assert.equal(L.rollStage(lesson, doc, at('10:46')), 'live', 'с 40-й минуты сама переходит к опоздавшим');
  assert.equal(L.rollStage(lesson, doc, at('11:31')), 'list');
  assert.equal(L.rollStage({ ...lesson, cancelled: true }, null, at('09:50')), 'list');
  assert.equal(L.rollStage({ ...lesson, type: 'event' }, null, at('09:50')), 'list');
  assert.equal(L.rollStage(lesson, { ...doc, lock: { at: 'x' } }, at('10:20')), 'list');
  assert.equal(L.lessonIsNow(lesson, null, at('09:40')), true);
  assert.equal(L.lessonIsNow(lesson, null, at('11:40')), false);
  assert.deepEqual(L.arrivalNow(lesson, doc, new Date(at('10:12')).toISOString()), { minutes: 7, verdict: 'ontime' });
  assert.deepEqual(L.arrivalNow(lesson, doc, new Date(at('10:20')).toISOString()), { minutes: 15, verdict: 'late' });
  assert.deepEqual(L.arrivalNow(lesson, doc, new Date(at('10:50')).toISOString()), { minutes: 45, verdict: 'absent' });
  // Перекличка пишет приход временем начала: долгая перекличка не делает опоздавших.
  const marked = L.rollCall(lesson, { ...doc, marks: { Иванов: { status: 'present', at: new Date(at('10:05')).toISOString() } } }, '2026-11-16', '10:25');
  assert.equal(marked[0].late, 0);
});

test('собрание: без отметок, тех. задания, записки и портфолио, с пары не освобождает', () => {
  const meeting = { id: 'm1', type: 'meeting', title: 'Брифинг перед днём открытых дверей', date: '2026-11-03', start: '09:00', end: '10:00', participants: ['Иванов', 'Сидорова А. П.'], equipment: [] };
  const lesson = { id: 'l1', type: 'lesson', title: 'Пара', date: '2026-11-03', start: '09:00', end: '10:30', participants: ['Иванов'], equipment: [] };
  assert.equal(L.typeName('meeting'), 'Собрание');
  assert.equal(L.takesAttendance(meeting), false);
  assert.equal(L.hasPaper(meeting), false);
  assert.equal(L.hasPaper(lesson), false);
  assert.equal(L.hasPaper({ ...meeting, type: 'event' }), true);
  assert.equal(L.memoApplies(meeting), false);
  const p = L.portfolio({ name: 'Иванов', events: [meeting], attendance: [], achievements: [], nowISO: '2026-11-10', nowTime: '12:00' });
  assert.deepEqual(p.items, []);
  assert.equal('meeting' in p.counts, false);
  const row = L.rollCall(lesson, null, '2026-11-03', '11:00', [meeting, lesson]).find((r) => r.name === 'Иванов');
  assert.equal(row.excusedFor, undefined, 'собрание проходит вне занятий');
  assert.equal(L.findConflicts(meeting, [lesson])[0]?.name, 'Иванов', 'пересечение с парой видно в форме');
});

test('роль студента видна в событии и в портфолио', () => {
  const event = { id: 'r1', type: 'event', title: 'День открытых дверей', date: '2026-11-03', start: '10:00', end: '12:00', participants: ['Иванов Пётр', 'Петрова'], roles: { 'Иванов Пётр': 'Оператор' }, equipment: [] };
  assert.equal(L.hasRoles(event), true);
  assert.equal(L.hasRoles({ type: 'lesson' }), false);
  assert.equal(L.hasRoles({ type: 'meeting' }), false);
  assert.equal(L.roleOf(event, 'иванов петр'), 'Оператор');
  assert.equal(L.roleOf(event, 'Петрова'), '');
  const p = L.portfolio({ name: 'Иванов Пётр', events: [event], attendance: [], achievements: [], nowISO: '2026-11-10', nowTime: '12:00' });
  assert.equal(p.items[0].role, 'Оператор');
});

test('сдача по студентам, должники, итоги по ролям и поручения', () => {
  const task = { id: 't1', type: 'task', title: 'Монтаж', date: '2026-11-02', start: '10:00', end: '11:00', participants: ['Иванов', 'Петрова', 'Сидоров'], deadline: '2026-11-05T18:00', handIn: { 'Иванов': 'done', 'Петрова': 'rework' }, roles: { 'Иванов': 'Оператор' } };
  const ev = { id: 'e1', type: 'event', title: 'Концерт', date: '2026-11-03', start: '15:00', end: '17:00', participants: ['Иванов', 'Петрова'], roles: { 'Иванов': 'Оператор', 'Петрова': 'Ведущий' } };
  const meeting = { id: 'm1', type: 'meeting', title: 'Совещание', date: '2026-11-04', start: '14:00', end: '15:00', participants: [], decisions: [
    { id: 'd1', text: 'Подготовить зал', who: 'Павлов', due: '2026-11-06', done: false },
    { id: 'd2', text: 'Отчёт', who: '', due: '', done: false },
    { id: 'd3', text: 'Готово', who: '', due: '2026-11-01', done: true }] };
  assert.deepEqual(L.handInSummary(task), { done: 1, rework: 1, missing: 1, total: 3 });
  assert.deepEqual(L.debtors([task], '2026-11-04T09:00'), [], 'до срока должников нет');
  assert.deepEqual(L.debtors([task], '2026-11-06T09:00').map((p) => [p.name, p.items[0].status]), [['Петрова', 'rework'], ['Сидоров', 'missing']]);
  assert.deepEqual(L.debtors([{ ...task, deadlineDone: '2026-11-06T08:00' }], '2026-11-06T09:00'), [], 'закрытый срок');
  assert.deepEqual(L.debtors([{ ...task, type: 'event' }], '2026-11-06T09:00'), [], 'материалы мероприятия сдаются целиком');
  const stats = L.roleStats([task, ev, { ...ev, id: 'e2', date: '2026-12-01' }], '2026-11-10');
  assert.deepEqual(stats.roles, ['Ведущий', 'Оператор']);
  assert.deepEqual(stats.people.map((p) => [p.name, p.total, p.roles['Оператор'] ?? 0]), [['Иванов', 2, 2], ['Петрова', 1, 0]]);
  assert.equal(L.roleStats([task, ev], '2026-11-10', '2026-11-03').people[0].total, 1, 'с начала периода');
  assert.deepEqual(L.decisionList([meeting], '2026-11-07').map((x) => [x.item.text, x.state]), [['Подготовить зал', 'overdue'], ['Отчёт', 'later']]);
  const csv = L.weeklySummaryCsv({ events: [task], attendance: [], students: [], groups: [], from: '2026-11-02', to: '2026-11-08', nowISO: '2026-11-09', nowTime: '09:00',
    labels: { title: 'Сводка', groups: 'Группы', groupHeader: ['Группа'], absent: 'Пропуски', absentHeader: ['Студент'], certificates: 'Справки', certificatesHeader: ['Студент'], debts: 'Долги', debtsHeader: ['Студент', 'Долгов', 'Что'] } });
  assert.match(csv, /^﻿Сводка/);
  assert.match(csv, /Сидоров;1;Монтаж/);
});

test('дни рождения: разбор дат, обращение, поздравление в выходные и 29 февраля', () => {
  assert.equal(L.parseBirthday('12.03.2007'), '2007-03-12');
  assert.equal(L.parseBirthday('2.3.07'), '2007-03-02');
  assert.equal(L.parseBirthday('2007-03-12'), '2007-03-12');
  assert.equal(L.parseBirthday('31.02.2007'), '');
  assert.equal(L.parseBirthday('завтра'), '');
  assert.deepEqual(L.splitPeople('Иванов Иван\t12.03.2007\nПетрова Анна 01.02.2006\nЛебедева О. В.'), [
    { name: 'Иванов Иван', birthday: '2007-03-12' },
    { name: 'Петрова Анна', birthday: '2006-02-01' },
    { name: 'Лебедева О. В.', birthday: '' },
  ]);
  assert.equal(L.greetingName('Иванов Иван'), 'Иван Иванов');
  assert.equal(L.greetingName('Иванов Иван Петрович'), 'Иван Иванов');
  assert.equal(L.greetingName('Петрова Анна Сергеевна', 'teacher'), 'Анна Сергеевна');
  assert.equal(L.greetingName('Лебедева О. В.', 'teacher'), 'Лебедева О. В.');
  const refs = [
    { kind: 'student', id: 's1', name: 'Иванов Иван', birthday: '2008-11-17' },
    { kind: 'student', id: 's2', name: 'Петрова Анна', birthday: '2007-11-15' }, // воскресенье
    { kind: 'teacher', id: 't1', name: 'Сидорова Ольга Павловна', birthday: '1980-02-29' },
    { kind: 'group', id: 'g1', name: 'ИС-21', birthday: '2008-11-17' },
    { kind: 'student', id: 's3', name: 'Без даты' },
  ];
  assert.deepEqual(L.birthdaysOn(refs, '2026-11-17'), [{ id: 's1', name: 'Иван Иванов', late: false }]);
  assert.deepEqual(L.birthdaysOn(refs, '2026-11-16').map((p) => [p.name, p.late]), [['Анна Петрова', true]], 'в понедельник — те, кто был в выходные');
  assert.deepEqual(L.birthdaysOn(refs, '2027-02-28').map((p) => p.name), ['Ольга Павловна'], '29 февраля в невисокосный год');
  assert.deepEqual(L.birthdaysOn(refs, '2028-02-28'), [], 'в високосный — в свой день');
  assert.equal(L.pickGreeting('Иван Иванов', '2026-11-17', 8), L.pickGreeting('Иван Иванов', '2026-11-17', 8));
});

test('расписание группы на неделю, табло перемены, лучшая группа и летопись', () => {
  const groups = [{ id: 'g1', kind: 'group', name: 'ИС-21' }, { id: 'g2', kind: 'group', name: 'ИС-22' }];
  const students = [
    ...['Аня', 'Боря', 'Вера', 'Гена'].map((name, i) => ({ id: `a${i}`, kind: 'student', name, groupId: 'g1' })),
    ...['Дина', 'Егор', 'Жора', 'Зоя'].map((name, i) => ({ id: `b${i}`, kind: 'student', name, groupId: 'g2' })),
  ];
  const lesson = (id, date, start, end, participants, extra = {}) => ({ id, type: 'lesson', title: `Пара ${id}`, date, start, end, participants, equipment: [], ...extra });
  const g1 = ['Аня', 'Боря', 'Вера', 'Гена'];
  const g2 = ['Дина', 'Егор', 'Жора', 'Зоя'];
  // Неделя 2 – 7 ноября 2026: понедельник 2 ноября.
  const week = L.groupWeek({ events: [lesson('w1', '2026-11-03', '10:00', '11:30', g1), lesson('w0', '2026-11-03', '08:30', '10:00', ['Аня']), lesson('w2', '2026-11-03', '12:00', '13:00', g2), lesson('w3', '2026-11-09', '10:00', '11:00', g1)],
    group: groups[0], groups, students, monday: '2026-11-02' });
  assert.equal(week.length, 6);
  assert.deepEqual(week[1].events.map((e) => e.id), ['w0', 'w1'], 'свои пары по времени, чужие и вне недели — нет');

  const room = [lesson('r1', '2026-11-03', '09:00', '10:30', g1), lesson('r2', '2026-11-03', '12:00', '13:30', g1), lesson('r3', '2026-11-05', '09:00', '10:00', g1)];
  assert.equal(L.breakBoard(room, '2026-11-03', '10:00'), null, 'во время пары табло нет');
  assert.deepEqual([L.breakBoard(room, '2026-11-03', '11:20').next.id, L.breakBoard(room, '2026-11-03', '11:20').minutes], ['r2', 40]);
  assert.deepEqual([L.breakBoard(room, '2026-11-03', '14:00').next.id, L.breakBoard(room, '2026-11-03', '14:00').today], ['r3', false]);
  assert.equal(L.breakBoard(room, '2026-11-06', '09:00').next, null);

  // Октябрь: ИС-21 ходит лучше ИС-22, у обеих по 20+ отметок.
  const events = [];
  const attendance = [];
  for (let d = 1; d <= 6; d += 1) {
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    for (const [id, names, absent] of [[`a${d}`, g1, []], [`b${d}`, g2, ['Зоя', 'Жора']]]) {
      events.push(lesson(id, date, '09:00', '10:00', names));
      attendance.push({ eventId: id, marks: Object.fromEntries(names.filter((n) => !absent.includes(n)).map((n) => [n, { status: 'present', at: `${date}T00:00:00.000Z` }])) });
    }
  }
  events.push({ id: 'ev', type: 'event', title: 'Концерт', date: '2026-10-10', start: '15:00', end: '17:00', participants: ['Аня', 'Дина'], roles: { 'Аня': 'Ведущий' }, equipment: [] });
  const best = L.bestGroupOfMonth({ events, attendance, students, groups, nowISO: '2026-11-03', nowTime: '12:00' });
  assert.deepEqual([best.name, best.percent, best.month], ['ИС-21', 100, '2026-10'], 'концерт без единой отметки — перекличку не проводили, не пропуск');
  assert.equal(L.bestGroupOfMonth({ events, attendance, students, groups, nowISO: '2026-11-10', nowTime: '12:00' }), null, 'объявляется первую неделю');
  assert.equal(L.schoolYearOf('2026-11-03'), 2026);
  assert.equal(L.schoolYearOf('2027-03-03'), 2026);
  const year = L.yearChronicle({ events, attendance, students, groups, achievements: [{ student: 'Аня', name: 'Олимпиада', result: '1 место', date: '2026-10-20' }, { student: 'Аня', name: 'Старое', date: '2025-05-01' }], year: 2026, nowISO: '2026-11-03', nowTime: '12:00' });
  assert.equal(year.counts.lesson, 12);
  assert.equal(year.counts.event, 1);
  assert.equal(year.attendance, 75, '(24 + 12) из 48: концерт без отметок не считается');
  assert.deepEqual(year.events.map((e) => [e.title, e.people]), [['Концерт', 2]]);
  assert.deepEqual(year.active.map((p) => [p.name, p.count, p.roles['Ведущий'] ?? 0]), [['Аня', 1, 1], ['Дина', 1, 0]]);
  assert.deepEqual(year.roleLeaders, [{ role: 'Ведущий', name: 'Аня', count: 1 }]);
  assert.deepEqual(year.months.map((m) => [m.month, m.name]), [['2026-10', 'ИС-21']]);
  assert.deepEqual(year.awards.map((a) => a.name), ['Олимпиада']);
});

test('лучшую группу с низкой посещаемостью не объявляем', () => {
  const groups = [{ id: 'g1', kind: 'group', name: 'ИС-21' }];
  const names = ['Аня', 'Боря', 'Вера', 'Гена'];
  const students = names.map((name, i) => ({ id: `s${i}`, kind: 'student', name, groupId: 'g1' }));
  const events = [];
  const attendance = [];
  for (let d = 1; d <= 6; d += 1) {
    const date = `2026-10-0${d}`;
    events.push({ id: `e${d}`, type: 'lesson', title: 'Пара', date, start: '09:00', end: '10:00', participants: names, equipment: [] });
    attendance.push({ eventId: `e${d}`, marks: { Аня: { status: 'present', at: `${date}T00:00:00.000Z` }, Боря: { status: 'present', at: `${date}T00:00:00.000Z` } } });
  }
  assert.equal(L.bestGroupOfMonth({ events, attendance, students, groups, nowISO: '2026-11-02', nowTime: '12:00' }), null, '50% — не повод для похвалы');
});

test('грейд: баллы по дням, задания, мероприятия с ролью, практика, справка и звания', () => {
  const groups = [{ id: 'g1', kind: 'group', name: 'ИС-21' }];
  const students = ['Аня', 'Боря', 'Вера'].map((name, i) => ({ id: `s${i}`, kind: 'student', name, groupId: 'g1' }));
  const names = students.map((s) => s.name);
  const pair = (id, date, start = '09:00') => ({ id, type: 'lesson', title: 'Пара', date, start, end: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, participants: names, equipment: [] });
  const at = (date, time) => new Date(`${date}T${time}`).toISOString();
  const events = [pair('p1', '2026-11-02'), pair('p2', '2026-11-02', '11:00'), pair('p3', '2026-11-03')];
  const attendance = [
    // День 2 ноября: Аня на обеих парах вовремя, Боря опоздал на вторую, Вера прогуляла первую.
    { eventId: 'p1', marks: { Аня: { status: 'present', at: at('2026-11-02', '09:00') }, Боря: { status: 'present', at: at('2026-11-02', '09:00') }, Вера: { status: 'absent', at: at('2026-11-02', '09:00') } } },
    { eventId: 'p2', marks: { Аня: { status: 'present', at: at('2026-11-02', '11:00') }, Боря: { status: 'present', at: at('2026-11-02', '11:20') }, Вера: { status: 'present', at: at('2026-11-02', '11:00') } } },
    // 3 ноября: Вера болеет без справки.
    { eventId: 'p3', marks: { Аня: { status: 'present', at: at('2026-11-03', '09:00') }, Боря: { status: 'excused', at: at('2026-11-03', '09:00') }, Вера: { status: 'sick', confirmed: false, at: at('2026-11-03', '09:00') } } },
  ];
  events.push({ id: 'e1', type: 'event', title: 'Концерт', date: '2026-11-04', start: '15:00', end: '16:00', participants: ['Аня', 'Боря'], roles: { 'Аня': 'Ведущий' }, equipment: [] });
  attendance.push({ eventId: 'e1', marks: { Аня: { status: 'present', at: at('2026-11-04', '15:00') }, Боря: { status: 'present', at: at('2026-11-04', '15:00') } } });
  events.push({ id: 'pr', type: 'practice', title: 'Практика', date: '2026-11-05', start: '09:00', end: '12:00', participants: ['Вера'], equipment: [] });
  events.push({ id: 't1', type: 'task', title: 'Монтаж', date: '2026-11-02', start: '10:00', end: '11:00', participants: names, deadline: '2026-11-06T18:00', handIn: { 'Аня': 'done', 'Боря': 'rework' }, equipment: [] });
  const report = (nowISO) => Object.fromEntries(L.gradeReport({ events, attendance, students, groups, from: '2026-09-01', to: '2027-01-31', nowISO, nowTime: '20:00' }).map((r) => [r.name, r]));

  const early = report('2026-11-07');
  assert.equal(early['Аня'].points, 1 + 1 + 5 + 2 + 3, 'два дня, мероприятие с ролью, сданное задание');
  assert.equal(early['Боря'].points, 3, 'день с опозданием −1 → 0 (ниже нуля нельзя), уважительная 0, мероприятие +5, задание на доработке после срока −2');
  assert.deepEqual([early['Боря'].breakdown.day, early['Боря'].breakdown.late, early['Боря'].breakdown.taskMissed], [1, 1, 1]);
  assert.equal(early['Вера'].points, 0, 'прогул в день −4, болезнь без справки пока 0, практика +2, задание −2');
  assert.equal(early['Вера'].breakdown.absent, 1);
  assert.equal(early['Вера'].breakdown.practice, 1);
  const late = report('2026-11-20');
  assert.equal(late['Вера'].breakdown.absent, 2, 'справку не принесли за неделю — пропуск');
  assert.equal(early['Аня'].level, 'Intern');
  assert.equal(early['Аня'].next.name, 'Junior');
  assert.equal(early['Аня'].next.need, 15 - 12);

  // Звание и день, когда оно получено.
  const many = Array.from({ length: 30 }, (_, i) => pair(`d${i}`, L.addDays('2026-09-01', i)));
  const marks = many.map((event) => ({ eventId: event.id, marks: { Аня: { status: 'present', at: at(event.date, '09:00') } } }));
  const rows = L.gradeReport({ events: many, attendance: marks, students, groups, from: '2026-09-01', to: '2027-01-31', nowISO: '2026-11-01', nowTime: '12:00' });
  const anya = rows.find((r) => r.name === 'Аня');
  assert.deepEqual([anya.points, anya.level, anya.levelUps], [30, 'Junior', [{ level: 'Junior', date: '2026-09-15' }]]);
  assert.equal(rows[0].name, 'Аня', 'по убыванию баллов');
  assert.deepEqual(L.semesterOf('2026-11-19'), { from: '2026-09-01', to: '2027-01-31' });
  assert.deepEqual(L.semesterOf('2027-01-15'), { from: '2026-09-01', to: '2027-01-31' });
  assert.deepEqual(L.semesterOf('2027-03-01'), { from: '2027-02-01', to: '2027-08-31' });
});

test('личное дело: посещаемость, опоздания, справки, задания, грейд и участие за период', () => {
  const groups = [{ id: 'g1', kind: 'group', name: 'ИС-21' }];
  const students = ['Аня', 'Боря'].map((name, i) => ({ id: `s${i}`, kind: 'student', name, groupId: 'g1' }));
  const at = (date, time) => new Date(`${date}T${time}`).toISOString();
  const lesson = (id, date) => ({ id, type: 'lesson', title: 'Пара', date, start: '09:00', end: '10:00', participants: ['Аня', 'Боря'], equipment: [] });
  const events = [lesson('l1', '2026-11-02'), lesson('l2', '2026-11-03'), lesson('l3', '2026-11-04'), lesson('old', '2026-03-02'),
    { id: 't1', type: 'task', title: 'Монтаж', date: '2026-11-02', start: '10:00', end: '11:00', participants: ['Аня'], deadline: '2026-11-05T18:00', handIn: { 'Аня': 'rework' }, equipment: [] },
    { id: 'e1', type: 'event', title: 'Концерт', date: '2026-11-04', start: '15:00', end: '16:00', participants: ['Аня'], roles: { 'Аня': 'Ведущий' }, equipment: [] }];
  const attendance = [
    { eventId: 'l1', marks: { Аня: { status: 'present', at: at('2026-11-02', '09:20') }, Боря: { status: 'present', at: at('2026-11-02', '09:00') } } },
    { eventId: 'l2', marks: { Аня: { status: 'absent', at: at('2026-11-03', '09:00') }, Боря: { status: 'present', at: at('2026-11-03', '09:00') } } },
    { eventId: 'l3', marks: { Аня: { status: 'sick', confirmed: false, at: at('2026-11-04', '09:00') }, Боря: { status: 'present', at: at('2026-11-04', '09:00') } } },
    { eventId: 'e1', marks: { Аня: { status: 'present', at: at('2026-11-04', '15:00') } } },
  ];
  const file = L.studentFile({ student: students[0], events, attendance, students, groups, achievements: [{ student: 'Аня', name: 'Олимпиада', result: '2 место', date: '2026-10-10' }],
    from: '2026-09-01', to: '2027-01-31', nowISO: '2026-11-10', nowTime: '12:00' });
  assert.deepEqual([file.attendance.total, file.attendance.present, file.attendance.late, file.attendance.absent, file.attendance.sick, file.attendance.share], [4, 2, 1, 1, 1, 67]);
  assert.equal(file.lateness.count, 1);
  assert.deepEqual(file.lateness.worstDays, [1], 'понедельник');
  assert.equal(file.certificates, 1);
  assert.deepEqual(file.tasks.map((task) => [task.title, task.state]), [['Монтаж', 'rework-late']]);
  assert.ok(file.grade && file.grade.level);
  assert.deepEqual(file.items.map((item) => [item.title, item.role]), [['Концерт', 'Ведущий'], ['Монтаж', '']]);
  assert.deepEqual(file.awards.map((item) => item.name), ['Олимпиада']);
  assert.equal(file.to, '2026-11-10', 'период — до сегодняшнего дня');
});

test('грейд: баллы вручную — плюс и минус, по дате, в звании и в личном деле', () => {
  const groups = [{ id: 'g1', kind: 'group', name: 'ИС-21' }];
  const students = ['Аня', 'Боря'].map((name, i) => ({ id: `s${i}`, kind: 'student', name, groupId: 'g1' }));
  const bonuses = [
    { student: 'Аня', name: 'Олимпиада', date: '2026-10-01', points: 20 },
    { student: 'аня', name: 'Помощь', date: '2026-10-05', points: 5 },
    { student: 'Боря', name: 'Нарушение', date: '2026-10-02', points: -10 },
    { student: 'Аня', name: 'Прошлый семестр', date: '2026-05-01', points: 50 },
    { student: 'Аня', name: 'Будущее', date: '2026-12-01', points: 50 },
  ];
  const rows = Object.fromEntries(L.gradeReport({ events: [], attendance: [], students, groups, bonuses, from: '2026-09-01', to: '2027-01-31', nowISO: '2026-11-01', nowTime: '12:00' }).map((r) => [r.name, r]));
  assert.equal(rows['Аня'].points, 25, 'только этот семестр и не позже сегодня, имя без учёта регистра');
  assert.equal(rows['Аня'].breakdown.manual, 25);
  assert.equal(rows['Аня'].level, 'Junior');
  assert.deepEqual(rows['Аня'].levelUps, [{ level: 'Junior', date: '2026-10-01' }]);
  assert.equal(rows['Боря'].points, 0, 'ниже нуля не опускается');
  assert.equal(rows['Боря'].breakdown.manual, -10);
  const file = L.studentFile({ student: students[0], events: [], attendance: [], students, groups, achievements: [], bonuses,
    from: '2026-09-01', to: '2027-01-31', nowISO: '2026-11-01', nowTime: '12:00' });
  assert.deepEqual(file.manual.map((item) => [item.name, item.points]), [['Олимпиада', 20], ['Помощь', 5]]);
  assert.equal(file.grade.points, 25);
});

test('прошлые работы: задание, практика и мероприятие задним числом дают баллы как обычные', () => {
  const groups = [{ id: 'g1', kind: 'group', name: 'ИС-21' }];
  const students = ['Аня', 'Боря', 'Вера'].map((name, i) => ({ id: `s${i}`, kind: 'student', name, groupId: 'g1' }));
  const pastWorks = [
    { id: 'w1', name: 'Курсовой проект', work: 'task', date: '2026-09-20', students: ['Аня', 'вера'], roles: [], missed: ['Боря'] },
    { id: 'w2', name: 'Практика на ТВ', work: 'practice', date: '2026-10-01', students: ['Аня', 'Боря'], roles: [], missed: [] },
    { id: 'w3', name: 'Неделя кино', work: 'event', date: '2026-10-10', students: ['Аня', 'Боря', 'Вера'], roles: ['Аня'], missed: [] },
    { id: 'w4', name: 'Прошлый семестр', work: 'event', date: '2026-05-10', students: ['Аня'], roles: [], missed: [] },
  ];
  const rows = Object.fromEntries(L.gradeReport({ events: [], attendance: [], students, groups, pastWorks, from: '2026-09-01', to: '2027-01-31', nowISO: '2026-11-01', nowTime: '12:00' }).map((r) => [r.name, r]));
  assert.equal(rows['Аня'].points, 3 + 2 + 5 + 2, 'задание, практика, мероприятие и роль');
  assert.deepEqual([rows['Аня'].breakdown.task, rows['Аня'].breakdown.practice, rows['Аня'].breakdown.event, rows['Аня'].breakdown.role], [1, 1, 1, 1]);
  assert.equal(rows['Боря'].points, 7, 'минус за несданное, но ниже нуля не опускается: 0 − 2 → 0, затем +2 и +5');
  assert.equal(rows['Боря'].breakdown.taskMissed, 1);
  assert.equal(rows['Вера'].points, 8, 'имя без учёта регистра');

  const file = L.studentFile({ student: students[0], events: [], attendance: [], students, groups, achievements: [], pastWorks,
    from: '2026-09-01', to: '2027-01-31', nowISO: '2026-11-01', nowTime: '12:00' });
  assert.deepEqual(file.tasks.map((task) => [task.title, task.state, task.past]), [['Курсовой проект', 'done', true]]);
  assert.deepEqual(file.items.map((item) => [item.title, item.type, item.role]), [['Неделя кино', 'event', 'role'], ['Практика на ТВ', 'practice', '']]);
  assert.equal(file.grade.points, 12);
  const missed = L.studentFile({ student: students[1], events: [], attendance: [], students, groups, achievements: [], pastWorks,
    from: '2026-09-01', to: '2027-01-31', nowISO: '2026-11-01', nowTime: '12:00' });
  assert.deepEqual(missed.tasks.map((task) => task.state), ['missed']);

  const year = L.yearChronicle({ events: [], attendance: [], students, groups, achievements: [], pastWorks, year: 2026, nowISO: '2026-11-01', nowTime: '12:00' });
  assert.equal(year.grades[0].name, 'Аня');
});

test('ждущее согласования не учитывается, но занимает место и технику', () => {
  const pending = { id: 'a', type: 'event', title: 'Концерт', date: '2026-11-10', start: '10:00', end: '12:00', place: 'Зал', participants: ['Аня'], equipment: ['Проектор'], pending: true };
  assert.equal(L.isHeld(pending), false);
  assert.equal(L.isHeld({ ...pending, pending: undefined }), true);
  const draft = { ...pending, id: 'b', pending: undefined };
  assert.ok(L.findConflicts(draft, [pending]).length > 0, 'конфликт с ждущим согласования виден');
});

test('CSV: текст, похожий на формулу, открывается в Excel как текст, числа — как числа', () => {
  const csv = L.toCsv(['a', 'b', 'c', 'd', 'e'], [['=HYPERLINK("http://x")', '-4', -4, '+1', '-Иван']]);
  const line = csv.split('\r\n')[1];
  assert.equal(line, `"'=HYPERLINK(""http://x"")";-4;-4;'+1;'-Иван`);
});

test('грейд: пара без переклички не даёт ни дня, ни прогула; после заполнения по журналу — как обычно', () => {
  const groups = [{ id: 'g1', kind: 'group', name: 'ИС-21' }];
  const students = ['Аня', 'Боря'].map((name, i) => ({ id: `s${i}`, kind: 'student', name, groupId: 'g1' }));
  const pair = { id: 'l', type: 'lesson', title: 'Пара', date: '2026-09-03', start: '09:00', end: '10:30', participants: ['Аня', 'Боря'], equipment: [] };
  const grade = (attendance) => Object.fromEntries(L.gradeReport({ events: [pair], attendance, students, groups, from: '2026-09-01', to: '2027-01-31', nowISO: '2026-11-21', nowTime: '16:00' })
    .map((r) => [r.name, [r.points, r.breakdown.day, r.breakdown.absent]]));
  assert.deepEqual(grade([]), { 'Аня': [0, 0, 0], 'Боря': [0, 0, 0] });
  // По журналу: «Все были» в ноябре, затем с Бори отметку сняли.
  const filled = [{ eventId: 'l', marks: { Аня: { status: 'present', at: '2026-11-21T06:00:00.000Z' }, Боря: { status: null, at: null } } }];
  assert.deepEqual(grade(filled), { 'Аня': [1, 1, 0], 'Боря': [0, 0, 1] });
});

test('расчёт баллов по дням: прогул за день, ноль снизу, поощрения и поведение', () => {
  const groups = [{ id: 'g1', kind: 'group', name: 'ИС-21' }];
  const students = [{ id: 's0', kind: 'student', name: 'Аня', groupId: 'g1' }, { id: 's1', kind: 'student', name: 'Боря', groupId: 'g1' }];
  const pair = (id, date, start, end) => ({ id, type: 'lesson', title: `Пара ${id}`, date, start, end, participants: ['Аня', 'Боря'], equipment: [] });
  const events = [pair('a', '2026-09-03', '09:00', '10:30'), pair('b', '2026-09-03', '10:40', '12:10'), pair('c', '2026-09-04', '09:00', '10:30')];
  const on = (date, time) => new Date(`${date}T${time}`).toISOString();
  const attendance = [
    // 3 сентября Аня на первой паре, вторую прогуляла; Боря на обеих.
    { eventId: 'a', marks: { Аня: { status: 'present', at: on('2026-09-03', '09:00') }, Боря: { status: 'present', at: on('2026-09-03', '09:00') } } },
    { eventId: 'b', marks: { Боря: { status: 'present', at: on('2026-09-03', '10:40') } } },
    { eventId: 'c', marks: { Аня: { status: 'present', at: on('2026-09-04', '09:00') }, Боря: { status: 'present', at: on('2026-09-04', '09:00') } } },
  ];
  const bonuses = [
    { kind: 'bonus', student: 'Боря', date: '2026-09-04', points: -10, name: 'Неуважительное обращение', by: 'Каб. 12' },
    { kind: 'bonus', student: 'Аня', date: '2026-09-04', points: 5, name: 'Олимпиада' },
  ];
  const rows = Object.fromEntries(L.gradeReport({ events, attendance, students, groups, bonuses, from: '2026-09-01', to: '2027-01-31', nowISO: '2026-11-22', nowTime: '13:00' }).map((r) => [r.name, r]));
  const anya = rows['Аня'];
  assert.deepEqual(anya.history.map((d) => [d.date, d.sum, d.after, d.lost]), [['2026-09-03', -4, 0, 4], ['2026-09-04', 6, 6, 0]]);
  const absentDay = anya.history[0].items[0];
  assert.equal(absentDay.kind, 'absent');
  assert.deepEqual(absentDay.lessons.map((l) => l.title), ['Пара b'], 'прогул — вторая пара');
  assert.deepEqual(absentDay.attended.map((l) => l.title), ['Пара a'], 'на первой был, но +1 за день нет');
  assert.equal(anya.earned, 2);
  assert.equal(anya.lost, 4);
  assert.equal(anya.points, anya.earned + anya.lost, 'итог = сумма начислений + не засчитанное из-за нуля');
  assert.equal(anya.breakdown.reward, 5);
  const borya = rows['Боря'];
  assert.equal(borya.points, 0, '+1, затем +1 и −10 → не ниже нуля');
  assert.deepEqual(borya.history.map((d) => [d.after, d.lost]), [[1, 0], [0, 8]]);
  assert.equal(borya.breakdown.conduct, -10);
  const manual = borya.history[1].items.find((i) => i.kind === 'manual');
  assert.deepEqual([manual.title, manual.by], ['Неуважительное обращение', 'Каб. 12']);
});
