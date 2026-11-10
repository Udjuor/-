// Тамагочи группы. Здоровье не хранится, а пересчитывается по отметкам,
// поэтому на всех устройствах питомец в одном и том же состоянии.
import { addDays, byTime, groupMembers, nameKey, rollCall } from './logic.mjs';

const START_HEALTH = 70;
const ALERT_DAYS = 3;
const COUNTED_TYPES = new Set(['lesson', 'practice', 'task']);

const clamp = (value) => Math.max(0, Math.min(100, value));

/** Посещаемость 75% ничего не меняет, выше лечит, ниже вредит заметно сильнее. */
export function healthChange(rate) {
  return Math.round(rate >= 0.75 ? (rate - 0.75) * 24 : (rate - 0.75) * 32);
}

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
    .filter((event) => COUNTED_TYPES.has(event.type) && `${event.date}T${event.end}` > since)
    .sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));

  let health = START_HEALTH;
  let counted = 0;
  let last = null;
  let diedOn = null;
  const timeline = [];

  for (const event of pairs) {
    const marks = Object.values(docs.get(event.id)?.marks ?? {});
    if (!marks.some((mark) => mark.status)) continue;
    const rows = rollCall(event, docs.get(event.id), nowISO, nowTime, events)
      .filter((row) => members.has(nameKey(row.name)) && ['present', 'absent'].includes(row.status));
    if (!rows.length) continue;
    const onTime = rows.filter((row) => row.status === 'present' && !row.late).length;
    const late = rows.filter((row) => row.late > 0).length;
    const absent = rows.filter((row) => row.status === 'absent').length;
    health = clamp(health + healthChange((onTime + late / 2) / rows.length));
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

/** Сколько учебных дней подряд нужно продержаться со здоровьем 100 ради одного приза. */
export const PRIZE_DAYS = 3;

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
 * День засчитывается, если после каждой пары этого дня здоровье было 100.
 * Дни без пар серию не прерывают, день ниже 100 обнуляет её. Каждый третий
 * засчитанный день подряд приносит приз. Призы считаются заново на каждом
 * устройстве из отметок, поэтому везде одинаковы; у нового питомца их нет.
 */
export function petPrizes(pet) {
  const days = new Map();
  for (const point of pet.timeline) {
    days.set(point.date, (days.get(point.date) ?? true) && point.health === 100);
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

/* Спрайты 16×16 */

const BODY = [
  '................',
  '.....oooooo.....',
  '...oobbbbbboo...',
  '..obbbbbbbbbbo..',
  '.obbbbbbbbbbbbo.',
  '.obbbbbbbbbbbbo.',
  'obbbbbbbbbbbbbbo',
  'obbbbbbbbbbbbbbo',
  'obbbbbbbbbbbbbbo',
  'obbbbbbbbbbbbbbo',
  'obbbbbbbbbbbbbbo',
  '.obbbbbbbbbbbbo.',
  '.obbbbbbbbbbbbo.',
  '..oobbboobbboo..',
  '....ooo..ooo....',
  '................',
];

const GRAVE = [
  '................',
  '.....oooooo.....',
  '....osssssso....',
  '...osssxxssso...',
  '...osssxxssso...',
  '...osxxxxxxso...',
  '...osxxxxxxso...',
  '...osssxxssso...',
  '...osssxxssso...',
  '...osssxxssso...',
  '...osssssssso...',
  '...osssssssso...',
  '..oooooooooooo..',
  '.g.gg.g.gg.gg.g.',
  'gggggggggggggggg',
  '................',
];

const COLORS = {
  o: '#1b1f24',
  e: '#1b1f24',
  w: '#ffffff',
  c: '#ff9bb0',
  m: '#1b1f24',
  r: '#e5534b',
  t: '#54aeff',
  y: '#f2cc60',
  s: '#adb5bd',
  x: '#6e7781',
  g: '#3fb950',
};

const BODY_COLOR = { play: '#7ee787', fine: '#7ee787', sad: '#a5d6ff', sick: '#c9c76b' };

const stamp = (grid, char, points) => {
  for (const [x, y] of points) grid[y][x] = char;
};

const eyesOpen = (grid) => {
  stamp(grid, 'e', [[4, 6], [5, 6], [4, 7], [5, 7], [10, 6], [11, 6], [10, 7], [11, 7]]);
  stamp(grid, 'w', [[4, 6], [10, 6]]);
};

const FACES = {
  play(grid, frame) {
    stamp(grid, 'e', [[4, 7], [5, 6], [6, 7], [9, 7], [10, 6], [11, 7]]);
    stamp(grid, 'r', [[7, 9], [8, 9], [7, 10], [8, 10]]);
    stamp(grid, 'e', [[6, 9], [9, 9]]);
    stamp(grid, 'c', [[2, 8], [3, 8], [12, 8], [13, 8]]);
    stamp(grid, 'y', frame ? [[1, 1], [0, 2], [1, 2], [2, 2], [1, 3]] : [[14, 1], [13, 2], [14, 2], [15, 2], [14, 3]]);
  },
  fine(grid, frame) {
    if (frame) stamp(grid, 'e', [[4, 7], [5, 7], [10, 7], [11, 7]]);
    else eyesOpen(grid);
    stamp(grid, 'm', [[6, 9], [7, 10], [8, 10], [9, 9]]);
    stamp(grid, 'c', [[2, 8], [3, 8], [12, 8], [13, 8]]);
  },
  sad(grid, frame) {
    stamp(grid, 'e', [[4, 7], [5, 7], [4, 8], [5, 8], [10, 7], [11, 7], [10, 8], [11, 8]]);
    stamp(grid, 'w', [[4, 7], [10, 7]]);
    stamp(grid, 'o', [[3, 5], [4, 5], [11, 5], [12, 5]]);
    stamp(grid, 'm', [[6, 11], [7, 10], [8, 10], [9, 11]]);
    stamp(grid, 't', frame ? [[4, 10], [4, 11]] : [[4, 9]]);
  },
  sick(grid, frame) {
    stamp(grid, 'e', [[3, 6], [5, 6], [4, 7], [3, 8], [5, 8], [10, 6], [12, 6], [11, 7], [10, 8], [12, 8]]);
    stamp(grid, 'm', [[6, 10], [7, 9], [8, 10], [9, 9]]);
    stamp(grid, 'w', [[13, 2], [13, 3], [13, 4]]);
    stamp(grid, 'r', [[13, 5], [13, 6]]);
    stamp(grid, 't', frame ? [[2, 4]] : [[2, 3], [2, 4]]);
  },
};

function grid(mood, frame) {
  if (mood === 'dead') return GRAVE.map((row) => [...row]);
  const cells = BODY.map((row) => [...row]);
  FACES[mood](cells, frame);
  return cells;
}

/** Пиксели спрайта: [{ x, y, fill }]. Кадр 0 или 1. */
export function petPixels(mood, frame = 0) {
  const pixels = [];
  grid(mood, frame).forEach((row, y) => row.forEach((char, x) => {
    if (char === '.') return;
    pixels.push({ x, y, fill: char === 'b' ? BODY_COLOR[mood] : COLORS[char] });
  }));
  return pixels;
}

/* Призы рисуются поверх сцены 32×20: питомец в середине, предметы по бокам. */

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

// Головные уборы: сетка 16 в ширину, выравнивается по питомцу (его верх в строке 5 сцены).
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

const art = (rows, left, top) => rows.flatMap((row, y) => [...row].flatMap((char, x) => (
  char === '.' ? [] : [{ x: left + x, y: top + y, fill: PRIZE_COLORS[char] }]
)));

/** Пиксели сцены 32×20 с питомцем и призами. Кадр 0 или 1. */
export function dressedPixels(mood, look, frame = 0) {
  const pixels = [];
  const side = (id, left) => {
    const rows = SIDE_ART[id];
    if (rows) pixels.push(...art(rows, left, 19 - rows.length));
  };
  side(look.left, 0);
  side(look.right, 24);
  // Питомец стоит на земле: его последняя строка пустая, поэтому сдвиг на 4.
  pixels.push(...petPixels(mood, frame).map((p) => ({ ...p, x: p.x + 8, y: p.y + 4 })));
  const head = HEAD_ART[look.head];
  if (head && mood !== 'dead') pixels.push(...art(head.rows, 8, head.y));
  return pixels;
}

/** Значок приза для списка: только сам предмет. */
export function prizeIcon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const head = HEAD_ART[id];
  const rows = head ? head.rows : SIDE_ART[id] ?? [];
  const width = head ? 16 : 8;
  svg.setAttribute('viewBox', `0 0 ${width} ${Math.max(rows.length, 1)}`);
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
  svg.setAttribute('viewBox', dressed ? '0 0 32 20' : '0 0 16 16');
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
