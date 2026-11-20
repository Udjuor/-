// Тамагочи группы. Здоровье не хранится, а пересчитывается по отметкам,
// поэтому на всех устройствах питомец в одном и том же состоянии.
import { addDays, byTime, groupMembers, nameKey, rollCall } from './logic.mjs';

const START_HEALTH = 70;
const ALERT_DAYS = 3;
/** Больше этого за один учебный день питомец не теряет: даже после худшего дня у группы есть неделя, чтобы его спасти. */
export const MAX_DAILY_LOSS = 10;
const COUNTED_TYPES = new Set(['lesson', 'practice', 'task']);

const clamp = (value) => Math.max(0, Math.min(100, value));

/** Пропуски от половины группы или опоздания от трёх четвертей — пара губит питомца. */
export const DEADLY_ABSENT = 0.5;
export const DEADLY_LATE = 0.75;
/** Пропуски от четверти или опоздания от половины — питомец грустит, но от этого не умирает. */
export const POOR_ABSENT = 0.25;
export const POOR_LATE = 0.5;
/** Ниже этого посредственные пары не опускают: болеет и умирает питомец только от плохих. */
export const POOR_FLOOR = 40;

/**
 * Как пара меняет здоровье. absent и late — доли группы без причины и с опозданием.
 * Плохая пара: −8. Посредственная: −3. Хорошая: +2, отличная (почти все и вовремя): +4.
 */
export function healthChange({ absent, late }) {
  if (absent >= DEADLY_ABSENT || late >= DEADLY_LATE) return -8;
  if (absent >= POOR_ABSENT || late >= POOR_LATE) return -3;
  if (absent <= 0.1 && late <= 0.25) return 4;
  return 2;
}

/** Плохая ли пара: такие и только такие ведут к смерти. */
export const deadlyPair = (shares) => shares.absent >= DEADLY_ABSENT || shares.late >= DEADLY_LATE;

export function moodOf(health) {
  if (health <= 0) return 'dead';
  if (health < 35) return 'sick';
  if (health < 60) return 'sad';
  if (health < 85) return 'fine';
  return 'play';
}

/**
 * Состояние питомца группы.
 * Смерть окончательна: дальше пары не считаются, нужен новый питомец.
 * Опоздание стоит половину посещения. Причины отсутствия из счёта исключаются.
 * Пара без единой отметки пропускается: посещаемость на ней просто не вели.
 */
export function petStatus({ group, groups = [group], students, events, attendance, nowISO, nowTime }) {
  const members = new Set(groupMembers(group, groups, students).map((s) => nameKey(s.name)));
  const docs = new Map(attendance.map((doc) => [doc.eventId, doc]));
  const since = group.petSince ?? '';
  const pairs = events
    .filter((event) => COUNTED_TYPES.has(event.type) && event.cancelled !== true && event.pending !== true && `${event.date}T${event.end}` > since)
    .sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));

  let health = START_HEALTH;
  let counted = 0;
  let last = null;
  let diedOn = null;
  const timeline = [];
  // Сколько здоровья уже потеряно за день: потери за день ограничены.
  let lossDay = '';
  let lost = 0;

  for (const event of pairs) {
    const marks = Object.values(docs.get(event.id)?.marks ?? {});
    if (!marks.some((mark) => mark.status)) continue;
    const rows = rollCall(event, docs.get(event.id), nowISO, nowTime, events)
      .filter((row) => members.has(nameKey(row.name)) && ['present', 'absent'].includes(row.status));
    if (!rows.length) continue;
    const onTime = rows.filter((row) => row.status === 'present' && !row.late).length;
    const late = rows.filter((row) => row.late > 0).length;
    const absent = rows.filter((row) => row.status === 'absent').length;
    const shares = { absent: absent / rows.length, late: late / rows.length };
    let change = healthChange(shares);
    // Посредственная пара не доводит до болезни: ниже POOR_FLOOR опускают только плохие.
    if (change < 0 && !deadlyPair(shares)) change = Math.max(change, Math.min(0, POOR_FLOOR - health));
    if (lossDay !== event.date) {
      lossDay = event.date;
      lost = 0;
    }
    if (change < 0) {
      change = -Math.min(-change, MAX_DAILY_LOSS - lost);
      lost -= change;
    }
    health = clamp(health + change);
    counted += 1;
    last = { title: event.title, date: event.date, total: rows.length, present: onTime + late, late, absent };
    timeline.push({ date: event.date, title: event.title, health });
    if (health === 0) {
      diedOn = event.date;
      break;
    }
  }

  const bornOn = since.slice(0, 10) || timeline[0]?.date || nowISO;
  return { health, mood: moodOf(health), counted, last, diedOn, timeline, bornOn };
}

/** Последняя смена состояния питомца, если она случилась за последние три дня. */
export function petChange(pet, nowISO) {
  const healths = [START_HEALTH, ...pet.timeline.map((point) => point.health)];
  for (let i = healths.length - 1; i > 0; i -= 1) {
    if (moodOf(healths[i]) !== moodOf(healths[i - 1])) {
      const { date } = pet.timeline[i - 1];
      return date >= addDays(nowISO, -ALERT_DAYS) ? { from: moodOf(healths[i - 1]), to: moodOf(healths[i]), date } : null;
    }
  }
  return null;
}

/* Призы */

/** Сколько учебных дней подряд нужно продержаться с высоким здоровьем ради одного приза. */
export const PRIZE_DAYS = 3;

/** Здоровье, с которого день засчитывается в серию за приз. */
export const PRIZE_HEALTH = 90;

/**
 * Призы выдаются по порядку. head надевается на питомца, side стоит рядом.
 * Когда все получены, каждый следующий приз — звезда.
 */
export const PRIZES = [
  { id: 'camera', slot: 'side', name: 'Фотокамера' },
  { id: 'tripod', slot: 'side', name: 'Штатив' },
  { id: 'headphones', slot: 'head', name: 'Наушники' },
  { id: 'microphone', slot: 'side', name: 'Микрофон' },
  { id: 'beret', slot: 'head', name: 'Берет художника' },
  { id: 'spotlight', slot: 'side', name: 'Прожектор' },
  { id: 'clapper', slot: 'side', name: 'Кинохлопушка' },
  { id: 'crown', slot: 'head', name: 'Корона' },
];

const PRIZE_BY_ID = new Map(PRIZES.map((prize) => [prize.id, prize]));

/**
 * Призы питомца по его истории здоровья.
 * День засчитывается, если после каждой пары этого дня здоровье было не ниже
 * PRIZE_HEALTH. Дни без пар серию не прерывают, день ниже порога обнуляет её. Каждый третий
 * засчитанный день подряд приносит приз. Призы считаются заново на каждом
 * устройстве из отметок, поэтому везде одинаковы; у нового питомца их нет.
 */
export function petPrizes(pet) {
  const days = new Map();
  for (const point of pet.timeline) {
    days.set(point.date, (days.get(point.date) ?? true) && point.health >= PRIZE_HEALTH);
  }
  let streak = 0;
  const earned = [];
  let stars = 0;
  for (const [date, perfect] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    if (!perfect) {
      streak = 0;
      continue;
    }
    streak += 1;
    if (streak % PRIZE_DAYS !== 0) continue;
    if (earned.length < PRIZES.length) earned.push({ ...PRIZES[earned.length], date });
    else stars += 1;
  }
  const alive = pet.mood !== 'dead';
  return {
    earned: alive ? earned : [],
    stars: alive ? stars : 0,
    streak: alive ? streak % PRIZE_DAYS : 0,
    next: alive ? PRIZES[earned.length] ?? null : null,
  };
}

/**
 * Что надето и что стоит рядом. Выбор учителя хранится в группе (petLook);
 * пока его нет, питомец сам надевает последнее полученное.
 */
export function petLook(look, prizes) {
  const owned = new Set(prizes.earned.map((prize) => prize.id));
  const has = (id, slot) => owned.has(id) && PRIZE_BY_ID.get(id)?.slot === slot;
  const latest = (slot) => prizes.earned.filter((prize) => prize.slot === slot).map((prize) => prize.id).reverse();
  if (look && typeof look === 'object') {
    return {
      head: has(look.head, 'head') ? look.head : '',
      left: has(look.left, 'side') ? look.left : '',
      right: has(look.right, 'side') && look.right !== look.left ? look.right : '',
    };
  }
  const sides = latest('side');
  return { head: latest('head')[0] ?? '', right: sides[0] ?? '', left: sides[1] ?? '' };
}

/* Спрайт 32×32: тело рисуется по фигурам с объёмом (свет сверху слева), лицо — по точкам. */

export const PET_SIZE = 32;

const INK = '#1b1f24';

/** Цвета тела по настроению: основной, свет, тень, животик, контур. */
const PALETTES = {
  play: { base: '#6fdc8c', light: '#aef0bf', shade: '#3fae62', deep: '#2f8a4c', belly: '#dcfbe4', line: '#14532d' },
  fine: { base: '#6fdc8c', light: '#aef0bf', shade: '#3fae62', deep: '#2f8a4c', belly: '#dcfbe4', line: '#14532d' },
  sad: { base: '#8cc4ff', light: '#cde5ff', shade: '#5b93d8', deep: '#4475b8', belly: '#eaf4ff', line: '#1e3a6e' },
  sick: { base: '#c4c46a', light: '#e3e3a2', shade: '#999842', deep: '#7c7b30', belly: '#f2f1cc', line: '#4a4917' },
};

const EAR_PINK = '#ff9db4';
const BLUSH = '#ff8fab';
const SHADOW = '#00000038';

const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

/** Фигуры тела. squash — кадр «вдоха»: тело чуть ниже и шире. */
function shapes(squash) {
  const cy = 18 + squash * 0.6;
  const ry = 11.4 - squash * 0.6;
  return {
    cy,
    ry,
    body: ellipse(16, cy, 12.6 + squash * 0.4, ry),
    ears: [ellipse(7.6, 6.6 + squash, 3.4, 3.8), ellipse(24.4, 6.6 + squash, 3.4, 3.8)],
    inner: [ellipse(7.8, 6.6 + squash, 1.6, 2.2), ellipse(24.2, 6.6 + squash, 1.6, 2.2)],
    arms: [ellipse(3.4, 20.5 + squash * 0.5, 2.2, 3.2), ellipse(28.6, 20.5 + squash * 0.5, 2.2, 3.2)],
    feet: [ellipse(11, 29.2, 3.8, 1.9), ellipse(21, 29.2, 3.8, 1.9)],
    belly: ellipse(16, 22.4 + squash * 0.4, 7.2, 5.6 - squash * 0.3),
    shine: ellipse(11, 10.8 + squash * 0.6, 1.9, 1.1),
    gloss: ellipse(11, 10.8 + squash * 0.6, 3.2, 2),
    shadow: ellipse(16, 31, 11, 1.2),
  };
}

/** Тело с объёмом: каждая точка — свет, основной цвет, тень или контур. */
function bodyCells(mood, squash) {
  const p = PALETTES[mood];
  const s = shapes(squash);
  const cells = Array.from({ length: PET_SIZE }, () => Array(PET_SIZE).fill(null));
  const filled = (x, y) => s.body(x, y) || s.ears.some((f) => f(x, y)) || s.arms.some((f) => f(x, y)) || s.feet.some((f) => f(x, y));
  for (let y = 0; y < PET_SIZE; y += 1) {
    for (let x = 0; x < PET_SIZE; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!filled(px, py)) {
        if (s.shadow(px, py)) cells[y][x] = SHADOW;
        continue;
      }
      let color = p.base;
      if (s.feet.some((f) => f(px, py)) && !s.body(px, py)) color = py > 29.6 ? p.deep : p.shade;
      else if (s.arms.some((f) => f(px, py)) && !s.body(px, py)) color = py > 21.5 ? p.shade : p.base;
      else if (s.ears.some((f) => f(px, py)) && !s.body(px, py)) color = s.inner.some((f) => f(px, py)) ? EAR_PINK : px < 16 ? p.light : p.base;
      else {
        // Свет падает сверху слева: чем дальше вниз и вправо, тем темнее.
        const nx = (px - 16) / 12.6;
        const ny = (py - s.cy) / s.ry;
        const lit = nx * 0.55 + ny * 0.85;
        color = lit < -0.62 ? p.light : lit > 0.78 ? p.deep : lit > 0.42 ? p.shade : p.base;
        if (s.belly(px, py)) color = lit > 0.78 ? p.shade : p.belly;
        if (s.gloss(px, py) && !s.belly(px, py)) color = p.light;
        if (s.shine(px, py)) color = '#ffffff';
      }
      cells[y][x] = color;
    }
  }
  // Контур снаружи фигуры: тёмный оттенок тела вместо чёрного.
  const outline = cells.map((row) => [...row]);
  for (let y = 0; y < PET_SIZE; y += 1) {
    for (let x = 0; x < PET_SIZE; x += 1) {
      if (cells[y][x] && cells[y][x] !== SHADOW) continue;
      const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const c = cells[y + dy]?.[x + dx];
        return c && c !== SHADOW;
      });
      if (near) outline[y][x] = p.line;
    }
  }
  return outline;
}

const put = (cells, color, points, dy = 0) => {
  for (const [x, y] of points) if (cells[y + dy]?.[x] !== undefined) cells[y + dy][x] = color;
};

/** Открытые глаза с бликами. */
const openEyes = (cells, dy, down = 0) => {
  for (const ex of [10, 19]) {
    put(cells, INK, [[ex, 13], [ex + 1, 13], [ex + 2, 13], [ex, 14], [ex + 1, 14], [ex + 2, 14], [ex, 15], [ex + 1, 15], [ex + 2, 15], [ex, 16], [ex + 1, 16], [ex + 2, 16]].map(([x, y]) => [x, y + down]), dy);
    put(cells, '#ffffff', [[ex, 13 + down], [ex + 1, 13 + down], [ex, 14 + down]], dy);
    put(cells, '#8b949e', [[ex + 2, 16 + down]], dy);
  }
};

const closedEyes = (cells, dy) => {
  put(cells, INK, [[10, 15], [11, 16], [12, 15], [19, 15], [20, 16], [21, 15]], dy);
};

const cheeks = (cells, dy) => {
  put(cells, BLUSH, [[6, 18], [7, 18], [8, 18], [23, 18], [24, 18], [25, 18]], dy);
  put(cells, '#ffc2d1', [[7, 17], [24, 17]], dy);
};

const FACES = {
  play(cells, frame, dy) {
    // Глаза-дуги, открытый рот с языком, искорки вокруг.
    put(cells, INK, [[9, 15], [10, 14], [11, 13], [12, 14], [13, 15], [18, 15], [19, 14], [20, 13], [21, 14], [22, 15]], dy);
    put(cells, INK, [[13, 19], [14, 19], [15, 19], [16, 19], [17, 19], [18, 19], [13, 20], [18, 20], [14, 21], [17, 21], [14, 20], [17, 20]], dy);
    put(cells, '#7a1f2b', [[15, 20], [16, 20]], dy);
    put(cells, '#ff6b81', [[15, 21], [16, 21]], dy);
    put(cells, '#ffffff', [[14, 19], [17, 19]], dy);
    cheeks(cells, dy);
    const star = (x, y) => [[x, y - 1], [x - 1, y], [x, y], [x + 1, y], [x, y + 1]];
    put(cells, '#f2cc60', frame ? [...star(2, 4), ...star(29, 11)] : [...star(29, 3), ...star(2, 12)]);
    put(cells, '#fff3b0', frame ? [[2, 4], [29, 11]] : [[29, 3], [2, 12]]);
  },
  fine(cells, frame, dy) {
    if (frame) closedEyes(cells, dy);
    else openEyes(cells, dy);
    put(cells, INK, [[13, 19], [14, 20], [15, 20], [16, 20], [17, 20], [18, 19]], dy);
    cheeks(cells, dy);
  },
  sad(cells, frame, dy) {
    openEyes(cells, dy, 1);
    // Брови домиком, рот вниз, слеза стекает.
    put(cells, INK, [[9, 12], [10, 12], [11, 11], [12, 11], [19, 11], [20, 11], [21, 12], [22, 12]], dy);
    put(cells, INK, [[13, 22], [14, 21], [15, 21], [16, 21], [17, 21], [18, 22]], dy);
    put(cells, '#54aeff', frame ? [[10, 20], [10, 21], [9, 21]] : [[10, 18], [10, 19]], dy);
    put(cells, '#cde5ff', frame ? [[10, 20]] : [[10, 18]], dy);
  },
  sick(cells, frame, dy) {
    // Глаза-крестики, волнистый рот, градусник, капля пота, грелка-пакет со льдом.
    for (const ex of [10, 19]) put(cells, INK, [[ex, 13], [ex + 2, 13], [ex + 1, 14], [ex, 15], [ex + 2, 15]], dy);
    put(cells, INK, [[12, 20], [13, 19], [14, 20], [15, 19], [16, 20], [17, 19]], dy);
    put(cells, '#ffffff', [[18, 20], [19, 20], [20, 20], [21, 20], [22, 20]], dy);
    put(cells, '#adb5bd', [[18, 21], [19, 21], [20, 21], [21, 21], [22, 21]], dy);
    put(cells, '#e5534b', [[23, 20], [23, 21]], dy);
    put(cells, '#54aeff', frame ? [[26, 9], [26, 10], [25, 10]] : [[26, 7], [26, 8], [25, 8]], dy);
    put(cells, '#cde5ff', frame ? [[26, 9]] : [[26, 7]], dy);
    put(cells, '#e6edf3', [[13, 5], [14, 5], [15, 5], [16, 5], [17, 5], [18, 5], [13, 6], [18, 6], [13, 7], [14, 7], [15, 7], [16, 7], [17, 7], [18, 7]], dy);
    put(cells, '#79c0ff', [[14, 6], [15, 6], [16, 6], [17, 6]], dy);
  },
};

/** Надгробие с травой и цветком. */
const GRAVE = [
  '................................',
  '................................',
  '...........kkkkkkkkkk...........',
  '.........kkLLLLLLLLssks.........',
  '........kLLLLLLLLLssssk.........',
  '.......kLLLLLLLLsssssssk........',
  '......kLLLLLLsssssssssssk.......',
  '......kLLLLssssssssssssxk.......',
  '......kLLLsssssddsssssxxk.......',
  '......kLLssssssddssssssxk.......',
  '......kLssssddddddddsssxk.......',
  '......kLssssddddddddsssxk.......',
  '......kLssssssddssssssxxk.......',
  '......kLssssssddsssssssxk.......',
  '......kLssssssddssssdssxk.......',
  '......kLssssssddsssdsssxk.......',
  '......kLssssssssssdssssxk.......',
  '......kLsssssssssdsssssxk.......',
  '......kLssssssssssssssxxk.......',
  '......kLssssssssssssssxxk.......',
  '......kLsssssssssssssxxxk.......',
  '......kLsssssssssssssxxxk.......',
  '......kssssssssssssssxxxk.......',
  '.....kkkkkkkkkkkkkkkkkkkkk..r.r.',
  '....kssssssssssssssssssxxxk..y..',
  '....kxxxxxxxxxxxxxxxxxxxxxk..G..',
  '.G.GgGG.G.GG.gG.GG.G.GgG.G.G.GG.',
  'GgGgGGgGGgGGgGGgGGgGGgGgGGgGGgGG',
  'gggggggggggggggggggggggggggggggg',
  'gGggggGgggggGgggggGgggggGgggggGg',
  'gggggggggggggggggggggggggggggggg',
  '................................',
];

const GRAVE_COLORS = { k: '#343a40', L: '#dee2e6', s: '#adb5bd', x: '#868e96', d: '#6e7781', g: '#2f8a4c', G: '#57c776', r: '#e5534b', y: '#f2cc60' };

function cellsFor(mood, frame) {
  if (mood === 'dead') return GRAVE.map((row) => [...row].map((c) => GRAVE_COLORS[c] ?? null));
  const squash = frame ? 1 : 0;
  const cells = bodyCells(mood, squash);
  FACES[mood](cells, frame, squash);
  return cells;
}

/** Пиксели спрайта 32×32: [{ x, y, fill }]. Кадр 0 или 1. */
export function petPixels(mood, frame = 0) {
  const pixels = [];
  cellsFor(mood, frame).forEach((row, y) => row.forEach((fill, x) => {
    if (fill) pixels.push({ x, y, fill });
  }));
  return pixels;
}

/* Призы рисуются поверх сцены 64×40: питомец в середине, предметы по бокам. Их рисунок вдвое крупнее, с объёмом. */

const PRIZE_COLORS = {
  k: '#1b1f24',
  g: '#6e7781',
  s: '#adb5bd',
  w: '#ffffff',
  l: '#54aeff',
  y: '#f2cc60',
  o: '#d4a72c',
  r: '#e5534b',
  p: '#8250df',
  q: '#c297ff',
  n: '#bc4c00',
};

// Головные уборы: сетка 16 в ширину, в сцене вдвое крупнее; HEAD_DROP опускает их на голову питомца.
const HEAD_DROP = 4;
const HEAD_ART = {
  headphones: { y: 2, rows: [
    '....ssssssss....',
    '..ss........ss..',
    '.s............s.',
    '.s............s.',
    '.s............s.',
    'srrs........srrs',
    'srrs........srrs',
    'srrs........srrs',
    '.ss..........ss.',
  ] },
  beret: { y: 1, rows: [
    '........kk......',
    '.....kkkppkkk...',
    '...kkppppppqpkk.',
    '..kpppppppppppk.',
    '...kkkkkkkkkkk..',
  ] },
  crown: { y: 0, rows: [
    '....y...y...y...',
    '....yy.yry.yy...',
    '....yyyyyyyyy...',
    '....yryyyyyry...',
    '....ooooooooo...',
  ] },
};

// Предметы рядом: сетка 8 в ширину, стоят на земле (нижняя строка сцены 18).
const SIDE_ART = {
  camera: [
    '..kkk...',
    'kkkkkkkk',
    'kgglllgk',
    'kgllwlgk',
    'kgglllgk',
    'kkkkkkkk',
  ],
  tripod: [
    '.ssssss.',
    '.sgggss.',
    '.ssssss.',
    '...ss...',
    '...ss...',
    '...ss...',
    '..s..s..',
    '..s..s..',
    '.s....s.',
    '.s....s.',
    's......s',
  ],
  microphone: [
    '..ssss..',
    '.ssssgs.',
    '.sssggs.',
    '..ssss..',
    '...ss...',
    '...ss...',
    '...ss...',
    '...ss...',
    '...ss...',
    '...ss...',
    '.ssssss.',
  ],
  spotlight: [
    'yy......',
    'yyyy....',
    'yyssss..',
    '.sggggs.',
    '.sgggggs',
    '..sssss.',
    '....ss..',
    '....ss..',
    '...s..s.',
    '..s....s',
  ],
  clapper: [
    'kwkwkwk.',
    '.kwkwkwk',
    'kkkkkkkk',
    'kwwwwwwk',
    'kwkkkkwk',
    'kwwwwwwk',
    'kkkkkkkk',
  ],
};

/** Смешивает цвет с белым (amount > 0) или чёрным (amount < 0). */
function tint(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const target = amount > 0 ? 255 : 0;
  const k = Math.abs(amount);
  const ch = (shift) => Math.round(((n >> shift) & 255) * (1 - k) + target * k);
  return `#${[16, 8, 0].map((shift) => ch(shift).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Рисунок приза в двойном размере: каждая точка — 2×2, у краёв свет сверху и слева,
 * тень снизу и справа. Так предметы не выглядят грубее питомца.
 */
const art = (rows, left, top) => rows.flatMap((row, y) => [...row].flatMap((char, x) => {
  if (char === '.') return [];
  const base = PRIZE_COLORS[char];
  const empty = (dx, dy) => (rows[y + dy]?.[x + dx] ?? '.') === '.';
  const out = [];
  for (const j of [0, 1]) {
    for (const i of [0, 1]) {
      let fill = base;
      if ((j === 0 && empty(0, -1)) || (i === 0 && empty(-1, 0))) fill = tint(base, 0.35);
      if ((j === 1 && empty(0, 1)) || (i === 1 && empty(1, 0))) fill = tint(base, -0.3);
      out.push({ x: left + x * 2 + i, y: top + y * 2 + j, fill });
    }
  }
  return out;
}));

/** Пиксели сцены 64×40 с питомцем и призами. Кадр 0 или 1. */
export function dressedPixels(mood, look, frame = 0) {
  const pixels = [];
  const side = (id, left) => {
    const rows = SIDE_ART[id];
    if (rows) pixels.push(...art(rows, left, 39 - rows.length * 2));
  };
  side(look.left, 0);
  side(look.right, 48);
  // Питомец 32×32 стоит на земле посередине.
  pixels.push(...petPixels(mood, frame).map((p) => ({ ...p, x: p.x + 16, y: p.y + 8 })));
  const head = HEAD_ART[look.head];
  // Головной убор опускается вместе с питомцем на «вдохе».
  if (head && mood !== 'dead') pixels.push(...art(head.rows, 16, head.y * 2 + HEAD_DROP + (frame ? 1 : 0)));
  return pixels;
}

/** Значок приза для списка: только сам предмет. */
export function prizeIcon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const head = HEAD_ART[id];
  const rows = head ? head.rows : SIDE_ART[id] ?? [];
  const width = head ? 32 : 16;
  svg.setAttribute('viewBox', `0 0 ${width} ${Math.max(rows.length * 2, 1)}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('prizeicon');
  for (const { x, y, fill } of art(rows, 0, 0)) {
    const pixel = document.createElementNS(ns, 'rect');
    for (const [name, value] of Object.entries({ x, y, width: 1, height: 1, fill })) pixel.setAttribute(name, value);
    svg.append(pixel);
  }
  return svg;
}

/** Рисует существо: два кадра сменяют друг друга средствами CSS. */
export function petSprite(mood, look = null) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const dressed = Boolean(look && (look.head || look.left || look.right));
  svg.setAttribute('viewBox', dressed ? '0 0 64 40' : '0 0 32 32');
  if (dressed) svg.classList.add('dressed');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('petsprite', `mood-${mood}`);
  for (const frame of [0, 1]) {
    const layer = document.createElementNS(ns, 'g');
    layer.classList.add(`frame${frame}`);
    for (const { x, y, fill } of dressed ? dressedPixels(mood, look, frame) : petPixels(mood, frame)) {
      const pixel = document.createElementNS(ns, 'rect');
      pixel.setAttribute('x', x);
      pixel.setAttribute('y', y);
      pixel.setAttribute('width', 1);
      pixel.setAttribute('height', 1);
      pixel.setAttribute('fill', fill);
      layer.append(pixel);
    }
    svg.append(layer);
  }
  return svg;
}
