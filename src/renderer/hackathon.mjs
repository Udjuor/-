// Кинохакатон: команды, роли, этапы со сроками, техника за командами, жюри и итоги.
// Здесь только расчёты без DOM, их проверяют тесты. Хакатон хранится записью справочника kind: 'hackathon'.
import { addDays, nameKey } from './logic.mjs';

/** Баллы рейтинга за места: всем участникам команды, как поощрение. */
export const HACKATHON_PLACE_POINTS = [15, 10, 5];

/** Сдача этапа командой. Нет записи — ещё не сдала. */
export const STAGE_STATES = ['done', 'rework', 'late', 'open'];

const byName = (a, b) => a.name.localeCompare(b.name, 'ru');

/** Все участники хакатона по командам, без повторов. */
export function hackathonMembers(hack) {
  const seen = new Set();
  const out = [];
  for (const team of hack.teams ?? []) {
    for (const name of team.members) {
      if (seen.has(nameKey(name))) continue;
      seen.add(nameKey(name));
      out.push(name);
    }
  }
  return out;
}

export function teamOf(hack, name) {
  return (hack.teams ?? []).find((team) => team.members.some((member) => nameKey(member) === nameKey(name))) ?? null;
}

export function teamRole(team, name) {
  for (const [who, role] of Object.entries(team?.roles ?? {})) if (nameKey(who) === nameKey(name)) return role;
  return '';
}

/** Детерминированная перетасовка для кнопки «Ещё вариант»: тот же номер — те же команды. */
function seeded(seed) {
  let x = (seed * 2654435761) % 4294967296 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

const sumOf = (team) => team.reduce((sum, person) => sum + person.experience, 0);

/**
 * Делит студентов на команды поровну по опыту и раздаёт ключевые роли.
 * people — [{ name, experience, roles: { роль: сколько раз была } }].
 * Опытные расходятся по командам «змейкой», потом обменами выравниваются суммы.
 * Роль достаётся тому, кто пробовал её меньше всех, при равенстве — у кого меньше ролей вообще.
 * seed > 0 перемешивает студентов с близким опытом: другой вариант при том же балансе.
 */
export function buildTeams(people, teamCount, keyRoles = [], seed = 0) {
  const count = Math.max(1, Math.min(teamCount, people.length || 1));
  const random = seed ? seeded(seed) : null;
  const jitter = new Map(people.map((person) => [person.name, random ? random() * 6 - 3 : 0]));
  const sorted = [...people].sort((a, b) => (b.experience + jitter.get(b.name)) - (a.experience + jitter.get(a.name)) || byName(a, b));
  const teams = Array.from({ length: count }, () => []);
  sorted.forEach((person, index) => {
    const round = Math.floor(index / count);
    const slot = index % count;
    teams[round % 2 === 0 ? slot : count - 1 - slot].push(person);
  });
  // Обмены по одному студенту между самой сильной и самой слабой командой, пока разница уменьшается.
  for (let step = 0; step < 200; step += 1) {
    const sums = teams.map(sumOf);
    const hi = sums.indexOf(Math.max(...sums));
    const lo = sums.indexOf(Math.min(...sums));
    const gap = sums[hi] - sums[lo];
    if (hi === lo || gap === 0) break;
    let best = null;
    for (const a of teams[hi]) {
      for (const b of teams[lo]) {
        const diff = a.experience - b.experience;
        if (diff <= 0) continue;
        const after = Math.abs(gap - 2 * diff);
        if (after < gap && (!best || after < best.after)) best = { a, b, after };
      }
    }
    if (!best) break;
    teams[hi] = teams[hi].filter((p) => p !== best.a).concat(best.b);
    teams[lo] = teams[lo].filter((p) => p !== best.b).concat(best.a);
  }
  return teams.map((members) => {
    const roles = {};
    const free = [...members];
    for (const role of keyRoles) {
      if (!free.length) break;
      const tried = (person) => person.roles?.[role] ?? 0;
      const total = (person) => Object.values(person.roles ?? {}).reduce((sum, n) => sum + n, 0);
      free.sort((a, b) => tried(a) - tried(b) || total(a) - total(b) || byName(a, b));
      const chosen = free.shift();
      roles[chosen.name] = role;
    }
    return {
      members: [...members].sort((a, b) => b.experience - a.experience || byName(a, b)).map((person) => person.name),
      roles,
      experience: sumOf(members),
    };
  });
}

/** Опыт команды: сумма опыта участников. */
export function teamExperience(team, experienceOf) {
  return team.members.reduce((sum, name) => sum + (experienceOf(name) ?? 0), 0);
}

/* Этапы и сроки */

/** Состояние этапа у команды: сдала, на доработке, срок прошёл, ещё идёт. */
export function stageState(hack, teamId, stage, moment) {
  const status = hack.handIn?.[teamId]?.[stage.id];
  if (status === 'done') return 'done';
  if (status === 'rework') return stage.due <= moment ? 'late' : 'rework';
  return stage.due <= moment ? 'late' : 'open';
}

/** Ближайший срок: этап, до которого идёт отсчёт. null, если все сроки прошли. */
export function nextStage(hack, moment) {
  return [...(hack.stages ?? [])].sort((a, b) => a.due.localeCompare(b.due)).find((stage) => stage.due > moment) ?? null;
}

/** Минут до срока: «2026-11-03T18:00» от «2026-11-03T11:42». */
export function minutesUntil(due, moment) {
  const toMs = (value) => Date.UTC(+value.slice(0, 4), +value.slice(5, 7) - 1, +value.slice(8, 10), +value.slice(11, 13), +value.slice(14, 16));
  return Math.max(0, Math.round((toMs(due) - toMs(moment)) / 60000));
}

/** Хакатон идёт: от первого дня до конца последнего. На панелях показывается и за день до начала. */
export const hackathonActive = (hack, todayISO) => Boolean(hack.approved) && !hack.finished && hack.from && addDays(hack.from, -1) <= todayISO && todayISO <= hack.to;

/* Жюри и итоги */

/** Оценка одного члена жюри по критерию в пределах от 0 до максимума критерия. */
function scoreOf(hack, teamId, criterion, juror) {
  const value = hack.scores?.[teamId]?.[criterion.id]?.[juror];
  return Number.isFinite(value) ? Math.max(0, Math.min(criterion.max, value)) : null;
}

/**
 * Итоги: по каждому критерию — среднее оценок жюри, сумма — итог команды.
 * Места по итогу; при равном итоге место общее. Команда без единой оценки места не получает.
 */
export function standings(hack) {
  const criteria = hack.criteria ?? [];
  const jury = hack.jury ?? [];
  const rows = (hack.teams ?? []).map((team) => {
    let scored = 0;
    const byCriterion = criteria.map((criterion) => {
      const values = jury.map((juror) => scoreOf(hack, team.id, criterion, juror)).filter((v) => v !== null);
      scored += values.length;
      return values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : null;
    });
    const total = Math.round(byCriterion.reduce((s, v) => s + (v ?? 0), 0) * 10) / 10;
    return { team, byCriterion, total, scored, place: null, points: 0 };
  });
  const ranked = rows.filter((row) => row.scored > 0).sort((a, b) => b.total - a.total || a.team.name.localeCompare(b.team.name, 'ru'));
  ranked.forEach((row, index) => {
    row.place = index > 0 && ranked[index - 1].total === row.total ? ranked[index - 1].place : index + 1;
    row.points = HACKATHON_PLACE_POINTS[row.place - 1] ?? 0;
  });
  return [...ranked, ...rows.filter((row) => row.scored === 0)];
}

/** Сколько оценок не хватает: команда × критерий × член жюри. */
export function missingScores(hack) {
  let missing = 0;
  for (const team of hack.teams ?? []) {
    for (const criterion of hack.criteria ?? []) {
      for (const juror of hack.jury ?? []) if (scoreOf(hack, team.id, criterion, juror) === null) missing += 1;
    }
  }
  return missing;
}

/* Рейтинг и портфолио */

/**
 * Хакатон в рейтинге: после последнего дня участие засчитывается как мероприятие (+5)
 * и роль (+2), а после подведения итогов места дают поощрение всей команде.
 * Возвращает записи в виде прошлых работ и ручных баллов: их считает gradeReport как обычно.
 */
export function hackathonRecords(hacks, todayISO) {
  const pastWorks = [];
  const bonuses = [];
  for (const hack of hacks) {
    if (!hack.approved || !hack.to || hack.to > todayISO) continue;
    const students = hackathonMembers(hack);
    if (!students.length) continue;
    const roleNames = {};
    for (const team of hack.teams) for (const [name, role] of Object.entries(team.roles ?? {})) if (role) roleNames[name] = role;
    pastWorks.push({
      id: `hk-${hack.id}`, kind: 'pastwork', name: hack.name, work: 'event', date: hack.to, students,
      roles: Object.keys(roleNames), roleNames, missed: [], by: hack.by ?? '', hackathon: true,
    });
    if (!hack.finished) continue;
    for (const row of standings(hack)) {
      if (!row.points) continue;
      for (const student of row.team.members) {
        bonuses.push({ id: `hk-${hack.id}-${row.team.id}-${nameKey(student)}`, kind: 'bonus', student, date: hack.to, points: row.points, name: hack.name, by: '', place: row.place, team: row.team.name, hackathon: true });
      }
    }
  }
  return { pastWorks, bonuses };
}

/**
 * Техника хакатона как занятость: на каждый день — отдельная запись на команду.
 * Её видят проверка конфликтов и «Где техника», поэтому одну камеру не отдадут и паре, и команде.
 */
export function hackathonBusy(hacks) {
  const busy = [];
  for (const hack of hacks) {
    if (!hack.approved || hack.finished || !hack.from || !hack.to) continue;
    for (let date = hack.from, guard = 0; date <= hack.to && guard < 31; date = addDays(date, 1), guard += 1) {
      for (const team of hack.teams) {
        const names = Object.keys(team.equipment ?? {}).filter((name) => team.equipment[name] > 0);
        if (!names.length) continue;
        busy.push({
          id: `hk-${hack.id}-${team.id}-${date}`, type: 'event', title: `${hack.name}: ${team.name}`, date,
          start: hack.start || '09:00', end: hack.end || '18:00', participants: [], responsible: '', equipment: names,
          equipmentQty: { ...team.equipment }, cancelled: false, hackathon: hack.id,
        });
      }
    }
  }
  return busy;
}

/* Кому дать: подсказки для студентов без инициативы */

/**
 * Кому дать задание, мероприятие или роль: студенты, у которых меньше всех участий,
 * давно не было заданий и мероприятий, мало баллов или роли, которых они ещё не пробовали.
 * works — [{ date, students: [...] }] — задания, мероприятия, практики и хакатоны за учёт.
 * Решает преподаватель: здесь только список с причинами.
 */
export function balanceHints({ candidates, works, points, roleCounts = new Map(), roles = [], todayISO, exclude = [], limit = 6 }) {
  const skip = new Set(exclude.map(nameKey));
  const rows = candidates.filter((name) => !skip.has(nameKey(name))).map((name) => {
    const key = nameKey(name);
    const mine = works.filter((work) => work.students.some((student) => nameKey(student) === key));
    const last = mine.reduce((max, work) => (work.date > max ? work.date : max), '');
    const days = last ? Math.round((Date.parse(todayISO) - Date.parse(last)) / 86400000) : null;
    const tried = roleCounts.get(key) ?? {};
    return { name, count: mine.length, last, days, points: points.get(key) ?? 0, untried: roles.filter((role) => !tried[role]) };
  });
  if (!rows.length) return [];
  const counts = rows.map((row) => row.count).sort((a, b) => a - b);
  const median = counts[Math.floor((counts.length - 1) / 2)];
  const pointList = rows.map((row) => row.points).sort((a, b) => a - b);
  const pointMedian = pointList[Math.floor((pointList.length - 1) / 2)];
  return rows
    .map((row) => ({
      ...row,
      reasons: [
        row.count === 0 ? 'none' : row.count < median ? 'few' : null,
        row.days !== null && row.days >= 21 ? 'long' : null,
        row.points < pointMedian ? 'points' : null,
      ].filter(Boolean),
    }))
    .filter((row) => row.reasons.length)
    .sort((a, b) => a.count - b.count || (b.days ?? 9999) - (a.days ?? 9999) || a.points - b.points || a.name.localeCompare(b.name, 'ru'))
    .slice(0, limit);
}
