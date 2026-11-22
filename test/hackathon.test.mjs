import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceHints, buildTeams, hackathonBusy, hackathonRecords, missingScores, nextStage, stageState, standings, minutesUntil } from '../src/renderer/hackathon.mjs';
import { gradeReport, findConflicts, shortages } from '../src/renderer/logic.mjs';

const people = [
  ['Аня', 300], ['Боря', 250], ['Вера', 200], ['Гоша', 150], ['Даша', 100], ['Егор', 60], ['Женя', 20], ['Зоя', 0],
].map(([name, experience]) => ({ name, experience, roles: {} }));

test('команды поровну по опыту и по числу людей', () => {
  const teams = buildTeams(people, 2);
  assert.deepEqual(teams.map((team) => team.members.length), [4, 4]);
  const sums = teams.map((team) => team.experience);
  assert.equal(sums[0] + sums[1], 1080);
  assert.ok(Math.abs(sums[0] - sums[1]) <= 20, `разница ${sums}`);
  // Сильнейшие не в одной команде.
  assert.notDeepEqual(teams[0].members.slice(0, 2).sort(), ['Аня', 'Боря']);
});

test('ключевая роль — тому, кто пробовал её меньше всех', () => {
  const crew = [
    { name: 'Аня', experience: 100, roles: { Режиссёр: 3, Оператор: 1 } },
    { name: 'Боря', experience: 90, roles: { Оператор: 2 } },
    { name: 'Вера', experience: 10, roles: {} },
  ];
  const [team] = buildTeams(crew, 1, ['Режиссёр', 'Оператор']);
  assert.equal(team.roles['Вера'], 'Режиссёр', 'никогда не пробовала роли — первая');
  assert.equal(team.roles['Аня'], 'Оператор', 'оператором была меньше Бори');
  assert.equal(team.roles['Боря'], undefined);
});

test('другой вариант сохраняет баланс и меняет состав', () => {
  const many = Array.from({ length: 16 }, (_, i) => ({ name: `Студент ${i}`, experience: 50 + (i % 4), roles: {} }));
  const a = buildTeams(many, 4, [], 0);
  const b = buildTeams(many, 4, [], 3);
  const spread = (teams) => Math.max(...teams.map((t) => t.experience)) - Math.min(...teams.map((t) => t.experience));
  assert.ok(spread(b) <= 3);
  assert.notDeepEqual(a.map((t) => t.members), b.map((t) => t.members));
  assert.deepEqual(buildTeams(many, 4, [], 3), b, 'тот же номер — те же команды');
});

const hack = {
  id: 'h1', name: 'Осень', from: '2026-11-02', to: '2026-11-03', start: '09:00', end: '18:00', approved: true, finished: false,
  teams: [
    { id: 'a', name: 'Альфа', members: ['Аня', 'Боря'], roles: { Аня: 'Режиссёр' }, equipment: { Камера: 2 }, film: '' },
    { id: 'b', name: 'Бета', members: ['Вера', 'Гоша'], roles: {}, equipment: { Камера: 1 }, film: '' },
    { id: 'c', name: 'Гамма', members: ['Даша'], roles: {}, equipment: {}, film: '' },
  ],
  stages: [{ id: 's1', name: 'Сценарий', due: '2026-11-02T13:00' }, { id: 's2', name: 'Монтаж', due: '2026-11-03T15:00' }],
  handIn: { a: { s1: 'done' }, b: { s2: 'rework' } },
  criteria: [{ id: 'k1', name: 'Идея', max: 10 }, { id: 'k2', name: 'Монтаж', max: 10 }],
  jury: ['Иванова', 'Петров'],
  scores: {
    a: { k1: { Иванова: 8, Петров: 9 }, k2: { Иванова: 7, Петров: 7 } },
    b: { k1: { Иванова: 9, Петров: 9 }, k2: { Иванова: 6 } },
    c: {},
  },
};

test('этапы: сдано, на доработке, срок прошёл; ближайший срок', () => {
  const at = '2026-11-02T14:00';
  assert.equal(stageState(hack, 'a', hack.stages[0], at), 'done');
  assert.equal(stageState(hack, 'b', hack.stages[0], at), 'late');
  assert.equal(stageState(hack, 'b', hack.stages[1], at), 'rework');
  assert.equal(stageState(hack, 'c', hack.stages[1], at), 'open');
  assert.equal(nextStage(hack, at).id, 's2');
  assert.equal(nextStage(hack, '2026-11-03T16:00'), null);
  assert.equal(minutesUntil('2026-11-03T15:00', '2026-11-02T14:00'), 25 * 60);
});

test('итоги: среднее жюри по критериям, места и баллы', () => {
  const rows = standings(hack);
  assert.deepEqual(rows.map((row) => [row.team.id, row.total, row.place, row.points]), [['a', 15.5, 1, 15], ['b', 15, 2, 10], ['c', 0, null, 0]]);
  assert.equal(missingScores(hack), 5, 'у Беты нет одной оценки, у Гаммы — всех четырёх');
  const tie = { ...hack, scores: { a: { k1: { Иванова: 5 } }, b: { k1: { Иванова: 5 } } } };
  assert.deepEqual(standings(tie).slice(0, 2).map((row) => row.place), [1, 1]);
});

test('хакатон в рейтинге: участие и роль после последнего дня, места — после итогов', () => {
  assert.deepEqual(hackathonRecords([hack], '2026-11-02').pastWorks, [], 'ещё идёт');
  const during = hackathonRecords([hack], '2026-11-03');
  assert.equal(during.pastWorks.length, 1);
  assert.deepEqual(during.pastWorks[0].roles, ['Аня']);
  assert.deepEqual(during.bonuses, [], 'итоги не подведены');
  const done = hackathonRecords([{ ...hack, finished: true }], '2026-11-05');
  assert.deepEqual(done.bonuses.map((b) => [b.student, b.points, b.place]), [['Аня', 15, 1], ['Боря', 15, 1], ['Вера', 10, 2], ['Гоша', 10, 2]]);
  assert.deepEqual(hackathonRecords([{ ...hack, approved: false }], '2026-11-05').pastWorks, [], 'не утверждён — не считается');

  const students = ['Аня', 'Боря', 'Вера', 'Гоша', 'Даша'].map((name) => ({ name, groupId: 'g' }));
  const rows = gradeReport({ events: [], attendance: [], students, groups: [], from: '2026-09-01', to: '2026-12-31', nowISO: '2026-11-05', nowTime: '12:00', ...done });
  const of = (name) => rows.find((row) => row.name === name);
  assert.equal(of('Аня').points, 5 + 2 + 15);
  assert.equal(of('Вера').points, 5 + 10);
  assert.equal(of('Даша').points, 5);
  const role = of('Аня').history[0].items.find((item) => item.kind === 'role');
  assert.equal(role.role, 'Режиссёр');
  assert.equal(role.hackathon, true);
  assert.equal(of('Аня').history[0].items.find((item) => item.kind === 'manual').place, 1);
});

test('техника команд занята на все дни хакатона', () => {
  const busy = hackathonBusy([hack]);
  assert.equal(busy.length, 4, 'две команды с техникой × два дня');
  const stock = [{ name: 'Камера', quantity: 4 }];
  const lesson = { id: 'x', type: 'lesson', date: '2026-11-03', start: '10:00', end: '11:30', participants: [], equipment: ['Камера'], equipmentQty: { Камера: 2 } };
  assert.deepEqual(shortages(lesson, busy, stock), [{ name: 'Камера', need: 2, free: 1, total: 4 }]);
  assert.equal(findConflicts({ ...lesson, equipment: ['Проектор'] }, busy, stock).length, 0);
  assert.deepEqual(hackathonBusy([{ ...hack, finished: true }]), [], 'после итогов техника свободна');
});

test('кому дать: меньше всех участий, давно без заданий, мало баллов', () => {
  const works = [
    { date: '2026-11-01', students: ['Аня', 'Боря'] },
    { date: '2026-10-25', students: ['Аня', 'Вера'] },
    { date: '2026-09-20', students: ['Гоша'] },
  ];
  const points = new Map([['аня', 80], ['боря', 40], ['вера', 30], ['гоша', 10], ['даша', 0]]);
  const rows = balanceHints({ candidates: ['Аня', 'Боря', 'Вера', 'Гоша', 'Даша'], works, points, roles: ['Оператор'], todayISO: '2026-11-03', exclude: ['Боря'] });
  assert.deepEqual(rows.map((row) => row.name), ['Даша', 'Гоша'], 'Вера на уровне остальных');
  assert.deepEqual(rows[0].reasons, ['none', 'points']);
  assert.equal(rows[1].days, 44);
  assert.ok(rows[1].reasons.includes('long'));
  assert.deepEqual(rows[0].untried, ['Оператор']);
});
