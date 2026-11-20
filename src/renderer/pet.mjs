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

/*
 * Питомцы 48×48, восемь кадров анимации. Пять видов, у каждого своя фигура и расцветка.
 * Всё рисуется фигурами с объёмом (свет сверху слева); настроение меняет лицо, позу и оттенок.
 */

export const PET_SIZE = 48;
export const PET_FRAMES = 8;

const INK = '#1b1f24';
const BLUSH = '#ff8fab';
const SHADOW = '#00000038';

/** Виды питомцев — звери Якутии: мамонт, кулунчук (жеребёнок), куобах (заяц), бэдэр (рысь), хаар эбэ (снежная сова). */
export const PET_KINDS = [
  { id: 'mammoth', name: 'Мамонт' },
  { id: 'foal', name: 'Кулунчук' },
  { id: 'hare', name: 'Куобах' },
  { id: 'lynx', name: 'Бэдэр' },
  { id: 'owl', name: 'Хаар эбэ' },
];
export const DEFAULT_PET_KIND = 'mammoth';
export const petKindOf = (kind) => (PET_KINDS.some((item) => item.id === kind) ? kind : DEFAULT_PET_KIND);

/** Ключ выбора вида: дата заведения питомца. Правило то же, что в src/main/store.js. */
export const petKindLockKey = (group) => group.petSince || 'pet';
/** Вид выбран на этого питомца: студенты его больше не меняют до смерти. Новый питомец меняет ключ. */
export const petKindLocked = (group) => Boolean(group.petKindFor) && group.petKindFor === petKindLockKey(group);

/* Рисование */

const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

/** Повёрнутый овал: angle в радианах, по часовой стрелке. */
const tilted = (cx, cy, rx, ry, angle) => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return ((dx * cos + dy * sin) / rx) ** 2 + ((-dx * sin + dy * cos) / ry) ** 2 <= 1;
  };
};

/** Многоугольник по точкам. */
const polygon = (points) => (x, y) => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const blank = () => Array.from({ length: PET_SIZE }, () => Array(PET_SIZE).fill(null));

/** Закрашивает фигуру: color — цвет или функция (x, y) → цвет. */
function paint(cells, shape, color) {
  for (let y = 0; y < PET_SIZE; y += 1) {
    for (let x = 0; x < PET_SIZE; x += 1) {
      if (shape(x + 0.5, y + 0.5)) cells[y][x] = typeof color === 'function' ? color(x + 0.5, y + 0.5) : color;
    }
  }
}

/** Цвет с объёмом: свет сверху слева, тень снизу справа. */
const shaded = (pal, cx, cy, rx, ry) => (x, y) => {
  const lit = ((x - cx) / rx) * 0.55 + ((y - cy) / ry) * 0.85;
  return lit < -0.64 ? pal.light : lit > 0.8 ? pal.deep : lit > 0.44 ? pal.shade : pal.base;
};

/** Мягкий объём для светлых пятен: животик, маска. */
const soft = (light, dark, cx, cy, rx, ry) => (x, y) => (((x - cx) / rx) * 0.5 + ((y - cy) / ry) * 0.8 > 0.62 ? dark : light);

const dot = (cells, x, y, color) => {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (cells[yi]?.[xi] !== undefined) cells[yi][xi] = color;
};

function line(cells, x0, y0, x1, y1, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 || 1;
  for (let i = 0; i <= steps; i += 1) dot(cells, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, color);
}

function curve(cells, x0, x1, f, color) {
  let px = x0;
  let py = f(x0);
  for (let x = x0 + 0.5; x <= x1 + 0.01; x += 0.5) {
    const y = f(x);
    line(cells, px, py, x, y, color);
    px = x;
    py = y;
  }
}

/** Цепочка кругов по точкам: хвост, хобот. Радиус плавно меняется от r0 до r1. */
function chain(cells, points, r0, r1, color) {
  const total = points.length - 1;
  for (let i = 0; i < total; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    for (let k = 0; k <= 4; k += 1) {
      const t = (i + k / 4) / total;
      const r = r0 + (r1 - r0) * t;
      const cx = x0 + ((x1 - x0) * k) / 4;
      const cy = y0 + ((y1 - y0) * k) / 4;
      paint(cells, ellipse(cx, cy, r, r), typeof color === 'function' ? (x, y) => color(x, y, t) : color);
    }
  }
}

function sparkle(cells, x, y, size, color = '#f2cc60', core = '#fff3b0') {
  if (size <= 0) return;
  for (let i = -size; i <= size; i += 1) {
    dot(cells, x + i, y, color);
    dot(cells, x, y + i, color);
  }
  dot(cells, x, y, core);
}

/** Смешивает два цвета #rrggbb. */
function mix(a, b, k) {
  const pa = parseInt(a.slice(1, 7), 16);
  const pb = parseInt(b.slice(1, 7), 16);
  const ch = (shift) => Math.round(((pa >> shift) & 255) * (1 - k) + ((pb >> shift) & 255) * k);
  return `#${[16, 8, 0].map((shift) => ch(shift).toString(16).padStart(2, '0')).join('')}`;
}

/** Грусть делает питомца голубее, болезнь — желтовато-зеленее. */
const MOOD_TINT = { sad: ['#6f9fd8', 0.28], sick: ['#a3a35a', 0.34] };

function paletteFor(species, mood) {
  const tint = MOOD_TINT[mood];
  if (!tint) return species.pal;
  return Object.fromEntries(Object.entries(species.pal).map(([key, color]) => [key, mix(color, tint[0], tint[1])]));
}

/** Поза кадра: дыхание, прыжок, движения ушей и лап. */
export function pose(mood, frame) {
  const phase = (frame / PET_FRAMES) * Math.PI * 2;
  const breath = (1 - Math.cos(phase)) / 2;
  const q = { phase, breath, lift: 0, top: 0, wave: 0, twitch: 0, droop: 0, sway: Math.sin(phase) };
  if (mood === 'play') {
    q.lift = Math.round(Math.abs(Math.sin(phase)) * 4);
    q.wave = (1 + Math.sin(phase * 2)) / 2; // 0…1: правая лапа машет
  }
  if (mood === 'fine' && frame === 4) q.twitch = 1;
  if (mood === 'sad') q.droop = 1;
  if (mood === 'sick') q.droop = 0.5;
  q.top = -q.lift;
  return q;
}

/** Обводка снаружи нарисованного тела. */
function outline(cells, color) {
  const out = cells.map((row) => [...row]);
  for (let y = 0; y < PET_SIZE; y += 1) {
    for (let x = 0; x < PET_SIZE; x += 1) {
      if (cells[y][x] && cells[y][x] !== SHADOW) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const c = cells[y + dy]?.[x + dx]; return c && c !== SHADOW; })) out[y][x] = color;
    }
  }
  return out;
}

/** Блик на макушке: только поверх основного цвета тела. */
function gloss(cells, pal, cx, cy) {
  for (let y = 0; y < PET_SIZE; y += 1) {
    for (let x = 0; x < PET_SIZE; x += 1) {
      const c = cells[y][x];
      if (c !== pal.base && c !== pal.light && c !== pal.shade) continue;
      if (ellipse(cx, cy, 2.8, 1.6)(x + 0.5, y + 0.5)) cells[y][x] = '#ffffff';
      else if (ellipse(cx, cy, 4.8, 3)(x + 0.5, y + 0.5)) cells[y][x] = pal.light;
    }
  }
}

/* Виды. body рисует фигуру до обводки, extra — детали поверх лица. */

const SPECIES = {
  mammoth: {
    pal: { base: '#b57f52', light: '#dcab7e', shade: '#8d5d38', deep: '#6b4227', belly: '#ecd2b2', bellyShade: '#d8b48e', line: '#3d2412', inner: '#d99a8a' },
    eyes: [[17, 20.5], [31, 20.5]],
    cheeks: [[11, 26], [37, 26]],
    mouth: null, // рот под хоботом
    headDrop: 8,
    body(c, pal, q, mood) {
      const t = q.top;
      const flap = mood === 'play' || mood === 'fine' ? Math.sin(q.phase) * 0.9 : 0;
      for (const [cx, side] of [[7.4, -1], [40.6, 1]]) {
        const cy = 24 + t + q.droop * 2 + q.breath * 0.5;
        paint(c, ellipse(cx, cy, 6.6 + flap, 8.6), shaded(pal, cx, cy, 6.6, 8.6));
        paint(c, ellipse(cx + side * 0.6, cy + 0.6, 3.6 + flap * 0.6, 5.6), pal.inner);
      }
      const cy = 27.4 + q.breath * 0.8 + t;
      paint(c, ellipse(24, cy, 18 + q.breath * 0.5, 17 - q.breath * 0.8), shaded(pal, 24, cy, 18, 17));
      paint(c, ellipse(24, cy + 10, 10.5, 6), soft(pal.belly, pal.bellyShade, 24, cy + 10, 10.5, 6));
      // Шерсть: короткие пряди по бокам.
      for (const [x0, y0, x1, y1] of [[10, 28, 9, 31], [38, 28, 39, 31], [12, 35, 11, 38], [36, 35, 37, 38], [15, 16, 14, 18], [33, 16, 34, 18]]) line(c, x0, y0 + t, x1, y1 + t, pal.shade);
      for (const fx of [15.5, 32.5]) {
        paint(c, ellipse(fx, 43.6, 5.4, 3), shaded(pal, fx, 42, 5.4, 3));
        for (const nx of [-2.2, 0, 2.2]) dot(c, fx + nx, 45.4, '#fff4dc');
      }
      // Чубчик.
      for (const [x0, x1, y1] of [[22, 21, 6.5], [24, 24, 5.5], [26, 27, 6.5]]) line(c, x0, 11 + t, x1, y1 + t, pal.deep);
    },
    extra(c, pal, q, mood) {
      const t = q.top;
      // Хобот поверх мордочки, со своим контуром: поднят от радости, висит от грусти, покачивается.
      const end = mood === 'play'
        ? [[24, 25], [24.4, 29.5], [26.5, 32], [29.5, 31], [31, 27.5 - q.wave]]
        : mood === 'sad' || mood === 'sick'
          ? [[24, 25], [24, 30], [23.8, 34], [23.4 + q.sway * 0.5, 38.5]]
          : [[24, 25], [24, 30], [24.6, 33.5], [26.4, 35.6], [28.4 + q.sway * 0.6, 34.6]];
      let trunk = blank();
      chain(trunk, end.map(([x, y]) => [x, y + t]), 2.8, 1.8, (x, y, k) => (k > 0.2 && Math.round(y) % 3 === 0 ? pal.shade : x < 23.6 ? pal.light : pal.base));
      trunk = outline(trunk, pal.line);
      // Основание хобота сливается с мордочкой: верхнюю обводку не рисуем.
      trunk.forEach((row, y) => row.forEach((color, x) => { if (color && !(color === pal.line && y < 26 + t)) c[y][x] = color; }));
      // Бивни.
      for (const side of [-1, 1]) {
        curve(c, side < 0 ? 18.6 : 26.8, side < 0 ? 21.2 : 29.4, (x) => 30.4 + t + ((x - (24 + side * 4)) * side + 1.3) ** 2 * 0.45, '#fff4dc');
        dot(c, 24 + side * 5.6, 32 + t, '#d8c49c');
      }
    },
  },
  foal: {
    // Якутская лошадка: светлая соловая, тёмная грива и чёлка, белая проточина, мягкая морда.
    pal: { base: '#e6c48c', light: '#f6e2b8', shade: '#c9a265', deep: '#a8824a', belly: '#f8ead0', bellyShade: '#ead3ad', line: '#4a3418', inner: '#d9a98a', mane: '#6b4a2b', maneLight: '#8f6a43' },
    eyes: [[17.5, 20.5], [30.5, 20.5]],
    cheeks: [[11, 25.5], [37, 25.5]],
    mouth: { y: 33.2, style: 'muzzle' },
    headDrop: 8,
    body(c, pal, q, mood) {
      const t = q.top;
      // Хвост сзади: машет, от радости чаще.
      const swish = Math.sin(q.phase * (mood === 'play' ? 2 : 1)) * 2.5;
      chain(c, [[37, 38 + t], [42, 35 + t], [44 + swish, 39], [43 + swish, 44]], 2.6, 1.6, (x, y, k) => (Math.floor(k * 8) % 3 === 0 ? pal.maneLight : pal.mane));
      // Узкие торчащие уши.
      for (const [cx, side] of [[15, -1], [33, 1]]) {
        const angle = side * (0.32 + q.droop * 0.7) + (side > 0 ? q.twitch * 0.35 : 0);
        const cy = 8 + t + q.breath * 0.5 + q.droop * 3;
        paint(c, tilted(cx, cy, 2.8, 5.6, angle), shaded(pal, cx, cy, 2.8, 5.6));
        paint(c, tilted(cx, cy + 0.8, 1.2, 3.6, angle), pal.inner);
      }
      const cy = 27.6 + q.breath * 0.8 + t;
      paint(c, ellipse(24, cy, 18.2 + q.breath * 0.5, 16.8 - q.breath * 0.8), shaded(pal, 24, cy, 18.2, 16.8));
      paint(c, ellipse(24, cy + 9.6, 10, 5.8), soft(pal.belly, pal.bellyShade, 24, cy + 9.6, 10, 5.8));
      // Белая проточина от чёлки к морде.
      paint(c, polygon([[23, 16 + t], [25, 16 + t], [26.2, 26 + t], [21.8, 26 + t]]), '#fffaf0');
      // Вытянутая светлая морда с тёмным носом и ноздрями.
      const my = 30 + t + q.breath * 0.5;
      paint(c, ellipse(24, my, 8.6, 6), soft('#f8ecd4', '#e3c99d', 24, my, 8.6, 6));
      paint(c, (x, y) => ellipse(24, my, 8.6, 6)(x, y) && y > my + 2.4, '#d6b88a');
      for (const nx of [20.8, 27.2]) {
        paint(c, ellipse(nx, my - 0.4, 1.3, 1.1), pal.deep);
        dot(c, nx - 0.4, my - 1, '#fff3dc');
      }
      // Передние ножки с тёмными копытцами.
      for (const [ax, side] of [[6, 0], [42, 1]]) {
        const lift = side ? q.wave * 8 : 0;
        paint(c, ellipse(ax, 31.5 + t - lift, 3.2, 4.8), (x, y) => (y > 34.2 + t - lift ? pal.mane : pal.base));
      }
      for (const fx of [16.5, 31.5]) paint(c, ellipse(fx, 44, 5.2, 2.6), (x, y) => (y > 44.2 ? pal.line : pal.mane));
      // Густая грива на макушке и чёлка на лоб.
      chain(c, [[17, 10.5 + t], [21, 8 + t], [27, 8 + t], [31, 10.5 + t]], 3, 2.6, (x, y) => (Math.round(x) % 3 === 0 ? pal.maneLight : pal.mane));
      chain(c, [[21.5, 10 + t], [20, 13.5 + t], [19.6, 16.8 + t]], 2.6, 1.3, pal.mane);
      chain(c, [[26.5, 10 + t], [28, 13.5 + t], [28.4, 16.2 + t]], 2.4, 1.2, pal.mane);
      chain(c, [[24, 10 + t], [24.2, 13.6 + t]], 2, 1.2, pal.maneLight);
    },
    extra() {},
  },
  hare: {
    // Куобах: зимний заяц-беляк, белоснежный, с чёрными кончиками ушей.
    pal: { base: '#f2f5fa', light: '#ffffff', shade: '#d2dae7', deep: '#b0bcd0', belly: '#ffffff', bellyShade: '#e5eaf2', line: '#3f4a5e', inner: '#ffc2d1' },
    eyes: [[18, 22.5], [30, 22.5]],
    cheeks: [[11, 28], [37, 28]],
    mouth: { y: 28.4, style: 'bunny' },
    headDrop: 9,
    body(c, pal, q) {
      const t = q.top;
      paint(c, ellipse(41.5, 38, 3.8, 3.6), soft('#ffffff', pal.bellyShade, 41.5, 38, 3.8, 3.6));
      const tilt = q.droop * 0.75;
      const wig = q.lift > 2 ? 0.08 : 0;
      for (const [cx, side] of [[17.5, -1], [30.5, 1]]) {
        const angle = side * (0.12 + tilt + wig) + (side > 0 ? q.twitch * 0.3 : 0);
        const cy = 11 + t + q.breath * 0.5 + q.droop * 4;
        const ox = cx + side * q.droop * 4;
        const ear = tilted(ox, cy, 3.9, 9.6, angle);
        paint(c, ear, shaded(pal, ox, cy, 3.9, 9.6));
        paint(c, tilted(ox, cy + 1.4, 1.9, 6.6, angle), pal.inner);
        // Чёрный кончик уха.
        const tipX = ox + Math.sin(angle) * 8;
        const tipY = cy - Math.cos(angle) * 8;
        paint(c, (x, y) => ear(x, y) && ellipse(tipX, tipY, 4.6, 3.8)(x, y), (x) => (x < tipX ? '#454c56' : '#2d333b'));
      }
      const cy = 28.6 + q.breath * 0.8 + t;
      paint(c, ellipse(24, cy, 17.6 + q.breath * 0.5, 16 - q.breath * 0.8), shaded(pal, 24, cy, 17.6, 16));
      paint(c, ellipse(24, cy + 7.4, 10, 7), soft(pal.belly, pal.bellyShade, 24, cy + 7.4, 10, 7));
      for (const [ax, side] of [[7, 0], [41, 1]]) {
        const lift = side ? q.wave * 8 : 0;
        paint(c, ellipse(ax, 32 + t - lift, 3.2, 4.4), shaded(pal, ax, 32 + t - lift, 3.2, 4.4));
      }
      for (const fx of [16, 32]) paint(c, ellipse(fx, 43.8, 6.6, 2.7), soft(pal.belly, pal.bellyShade, fx, 43.8, 6.6, 2.7));
    },
    extra(c, pal, q) {
      const t = q.top;
      for (const [x, y] of [[23, 26.5], [24, 26.5], [25, 26.5], [24, 27.4]]) dot(c, x, y + t, '#ff7b93');
      for (const side of [-1, 1]) line(c, 24 + side * 9.5, 27.4 + t, 24 + side * 15, 26.8 + t, pal.deep);
    },
  },
  lynx: {
    // Бэдэр: рысь — кисточки на ушах, бакенбарды, пятнистая шерсть, короткий хвост с чёрным кончиком.
    pal: { base: '#c9a47b', light: '#e7cba6', shade: '#a27e57', deep: '#7f5d3c', belly: '#f8f1e6', bellyShade: '#e8dccb', line: '#3e2a17', inner: '#f1c9b9', spot: '#8a6844' },
    eyes: [[17.5, 21.5], [30.5, 21.5]],
    cheeks: [[12, 27.5], [36, 27.5]],
    mouth: { y: 28, style: 'cat' },
    headDrop: 8,
    body(c, pal, q) {
      const t = q.top;
      chain(c, [[37, 41], [40.5, 38.5], [42.6 + q.sway * 0.8, 35.4 + t]], 2.6, 2.3, (x, y, k) => (k > 0.66 ? '#1f1a17' : shaded(pal, 40, 38, 4, 4)(x, y)));
      const droop = q.droop * 3;
      const ears = [
        [[9, 17 + t + droop], [12.5 - droop, 2.5 + t + droop * 1.5], [20, 11 + t]],
        [[28, 11 + t], [35.5 + droop, 2.5 + t + droop * 1.5 - q.twitch * 1.5], [39, 17 + t + droop]],
      ];
      for (const tri of ears) {
        paint(c, polygon(tri), (x, y) => (y < tri[1][1] + 4 ? pal.deep : x < 24 ? pal.light : pal.base));
        const [a, b, d] = tri;
        const mid = [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3];
        paint(c, polygon(tri.map(([x, y]) => [mid[0] + (x - mid[0]) * 0.45, mid[1] + (y - mid[1]) * 0.45 + 1.2])), pal.inner);
      }
      const cy = 27.8 + q.breath * 0.8 + t;
      // Бакенбарды: пушистые клинья по бокам морды, в полоску.
      for (const side of [-1, 1]) {
        const wedge = polygon([[24 + side * 13, 22 + t], [24 + side * 21.5, 31 + t + q.breath * 0.5], [24 + side * 15, 30.5 + t], [24 + side * 18.6, 34.2 + t], [24 + side * 11, 31 + t]]);
        paint(c, wedge, (x, y) => (Math.round(y + x * 0.3 * side) % 3 === 0 ? pal.deep : pal.light));
      }
      paint(c, ellipse(24, cy, 17.6 + q.breath * 0.5, 16.6 - q.breath * 0.8), shaded(pal, 24, cy, 17.6, 16.6));
      paint(c, ellipse(24, cy + 7.8, 9.6, 7.4), soft(pal.belly, pal.bellyShade, 24, cy + 7.8, 9.6, 7.4));
      paint(c, ellipse(24, 28 + t + q.breath * 0.5, 6.4, 3.6), pal.belly);
      // Пятна.
      for (const [x, y, r] of [[11, 31, 1.2], [37, 31, 1.2], [13.5, 36, 1], [34.5, 36, 1], [9.6, 25, 0.9], [38.4, 25, 0.9], [19, 13.5, 0.8], [29, 13.5, 0.8], [24, 12, 0.8]]) {
        paint(c, ellipse(x, y + t, r + 0.3, r), pal.spot);
      }
      for (const [ax, side] of [[6, 0], [42, 1]]) {
        const lift = side ? q.wave * 8 : 0;
        paint(c, ellipse(ax, 32 + t - lift, 3.4, 4.6), (x, y) => (y > 34.2 + t - lift ? pal.belly : pal.base));
      }
      for (const fx of [16.5, 31.5]) paint(c, ellipse(fx, 43.8, 5.6, 2.8), soft(pal.belly, pal.bellyShade, fx, 43.8, 5.6, 2.8));
    },
    extra(c, pal, q) {
      const t = q.top;
      // Кисточки на ушах.
      for (const [x, lean] of [[12.5 - q.droop * 3, -1], [35.5 + q.droop * 3, 1]]) {
        const y = 2.5 + t + q.droop * 4.5 - (lean > 0 ? q.twitch * 1.5 : 0);
        line(c, x, y, x + lean * 0.6, y - 4, '#1f1a17');
        line(c, x + lean * 0.6, y, x + lean * 1.4, y - 3, '#3a2f28');
      }
      for (const [x, y] of [[23, 26], [24, 26], [25, 26], [24, 27]]) dot(c, x, y + t, '#e07a8f');
      // Тёмные «стрелки» от глаз.
      for (const side of [-1, 1]) line(c, 24 + side * 8.6, 24 + t, 24 + side * 10.4, 26.4 + t, pal.deep);
      for (const side of [-1, 1]) {
        line(c, 24 + side * 7.5, 27 + t, 24 + side * 15, 26.2 + t, '#ffffff');
        line(c, 24 + side * 7.5, 28.5 + t, 24 + side * 15, 29.3 + t, '#ffffff');
      }
    },
  },
  owl: {
    // Хаар эбэ: снежная сова — белая в тёмных крапинках, жёлтые глаза, крылья, пушистые лапы.
    pal: { base: '#f3f5f9', light: '#ffffff', shade: '#d4dbe6', deep: '#b4bfcf', belly: '#ffffff', bellyShade: '#e4e9f1', line: '#3b4254', inner: '#f2cc60', speck: '#6e7781' },
    eyes: [[17.2, 21], [30.8, 21]],
    eyeStyle: 'owl',
    cheeks: [[10.6, 27.6], [37.4, 27.6]],
    mouth: { y: 25.6, style: 'beak' },
    headDrop: 6,
    body(c, pal, q, mood) {
      const t = q.top;
      const cy = 27.6 + q.breath * 0.8 + t;
      // Крылья: от радости машут.
      for (const [ax, side] of [[7, -1], [41, 1]]) {
        const flap = mood === 'play' ? q.wave * 1.1 : 0;
        const angle = side * (0.28 + flap) - (mood === 'sad' ? side * 0.15 : 0);
        const ay = 31 + t - flap * 4;
        paint(c, tilted(ax, ay, 4.2, 9.4, angle), (x, y) => (Math.round(y * 0.8 + x * 0.3) % 4 === 0 ? pal.speck : shaded(pal, ax, ay, 4.2, 9.4)(x, y)));
      }
      // Чуть заметные пёрышки-ушки.
      for (const side of [-1, 1]) paint(c, polygon([[24 + side * 8, 12 + t], [24 + side * 13, 6.5 + t + q.droop * 2], [24 + side * 15, 12.5 + t]]), pal.light);
      paint(c, ellipse(24, cy, 18 + q.breath * 0.5, 17.8 - q.breath * 0.8), shaded(pal, 24, cy, 18, 17.8));
      // Лицевой диск вокруг глаз.
      for (const [ex, ey] of [[17.2, 21], [30.8, 21]]) paint(c, ellipse(ex, ey + t, 6, 5.8), (x, y) => (ellipse(ex, ey + t, 5, 4.8)(x, y) ? '#ffffff' : pal.shade));
      // Крапинки-«галочки» по груди и макушке.
      for (const [x, y] of [[13, 33], [20, 36], [28, 36], [35, 33], [16, 39], [32, 39], [24, 40], [19, 12], [29, 12], [24, 10]]) {
        line(c, x - 1.2, y + t - 0.6, x, y + t + 0.4, pal.speck);
        line(c, x, y + t + 0.4, x + 1.2, y + t - 0.6, pal.speck);
      }
      // Пушистые лапы с тёмными когтями.
      for (const fx of [17, 31]) {
        paint(c, ellipse(fx, 43.6, 5.2, 3), soft('#ffffff', pal.bellyShade, fx, 43.6, 5.2, 3));
        for (const nx of [-2.2, 0, 2.2]) line(c, fx + nx, 45.6, fx + nx, 46.4, '#3b4254');
      }
    },
    extra(c, pal, q, mood) {
      const t = q.top;
      const open = mood === 'play' && q.lift > 1;
      // Крючковатый клюв.
      line(c, 23, 25 + t, 25, 25 + t, '#5c6577');
      line(c, 23.3, 26 + t, 24.7, 26 + t, '#3b4254');
      dot(c, 24, 27 + t + (open ? 1 : 0), '#3b4254');
      if (open) line(c, 23.4, 27 + t, 24.6, 27 + t, '#cf222e');
    },
  },
};

/* Лица */

function eyesOf(c, sp, q, { dx = 0, dy = 0, blink = false } = {}) {
  for (const [ex, ey] of sp.eyes) {
    const x = ex + dx;
    const y = ey + q.top + dy + q.breath * 0.4;
    if (sp.eyeStyle === 'owl') {
      // Большие жёлтые глаза; моргает белым веком.
      if (blink) {
        paint(c, ellipse(x - dx, y - dy, 3.6, 3.6), '#ffffff');
        curve(c, x - dx - 3.4, x - dx + 3.4, (u) => y - dy + 0.4 + ((u - (x - dx)) / 3.4) ** 2 * 0.8, INK);
        continue;
      }
      paint(c, ellipse(x - dx, y - dy, 3.8, 3.8), (u, v) => (ellipse(x - dx, y - dy, 3, 3)(u, v) ? (v < y - dy ? '#f7d774' : '#e8b931') : '#9a6b00'));
      paint(c, ellipse(x, y, 1.9, 1.9), INK);
      paint(c, ellipse(x - 0.9, y - 1, 0.8, 0.8), '#ffffff');
      continue;
    }
    if (blink) {
      curve(c, x - 2.2, x + 2.2, (t) => y + 0.6 - ((t - x) / 2.2) ** 2 * 0.9, INK);
      continue;
    }
    paint(c, ellipse(x, y, 2.3, 3.1), INK);
    paint(c, ellipse(x - 0.8, y - 1.3, 1, 1), '#ffffff');
    dot(c, x + 1, y + 1.6, '#8b949e');
  }
}

function cheeksOf(c, sp, q) {
  for (const [cx, cy] of sp.cheeks) {
    paint(c, ellipse(cx, cy + q.top, 2.6, 1.2), BLUSH);
    dot(c, cx - 0.8, cy - 0.8 + q.top, '#ffc2d1');
  }
}

/** Рот по виду и настроению: smile, open, frown, wavy. */
function mouthOf(c, sp, q, kind, frame) {
  if (!sp.mouth) return;
  const y = sp.mouth.y + q.top;
  const style = sp.mouth.style;
  if (style === 'beak') return; // клюв рисует сама сова
  const w = style === 'cat' || style === 'bunny' ? 3 : style === 'muzzle' ? 2.6 : 4;
  if (kind === 'open') {
    const rx = style === 'muzzle' ? 2.6 : 3.4;
    paint(c, (x, yy) => ellipse(24, y, rx, 2.6 + (q.lift > 2 ? 1 : 0))(x, yy) && yy > y - 0.4, INK);
    paint(c, ellipse(24, y + 1.6 + (q.lift > 2 ? 1 : 0), rx * 0.55, 1.1), '#ff6b81');
    return;
  }
  if (kind === 'frown') {
    curve(c, 24 - w, 24 + w, (x) => y + 2.6 - (1 - ((x - 24) / w) ** 2) * 1.6, INK);
    return;
  }
  if (kind === 'wavy') {
    curve(c, 24 - w - 1, 24 + w + 1, (x) => y + 1 + Math.sin((x - 24) * 1.4 + frame) * 0.8, INK);
    return;
  }
  if (style === 'cat') {
    for (const side of [-1, 1]) curve(c, side < 0 ? 21 : 24, side < 0 ? 24 : 27, (x) => y + (1 - ((x - (24 + side * 1.5)) / 1.5) ** 2) * 1.1, INK);
    return;
  }
  if (style === 'bunny') {
    curve(c, 21.5, 26.5, (x) => y + (1 - ((x - 24) / 2.5) ** 2) * 0.9, INK);
    paint(c, (x, yy) => x > 22.6 && x < 25.4 && yy > y + 0.6 && yy < y + 3, (x) => (Math.floor(x) === 24 ? '#dfe6f0' : '#ffffff'));
    return;
  }
  curve(c, 24 - w, 24 + w, (x) => y + (1 - ((x - 24) / w) ** 2) * (style === 'muzzle' ? 1.2 : 1.8), INK);
}

const MOOD_FACE = {
  play(c, sp, q, frame) {
    for (const [ex, ey] of sp.eyes) curve(c, ex - 2.6, ex + 2.6, (x) => ey + 0.7 + q.top - (1 - ((x - ex) / 2.6) ** 2) * 2.2, INK);
    mouthOf(c, sp, q, 'open', frame);
    cheeksOf(c, sp, q);
    [[4, 6], [44, 4], [44, 17], [3, 20]].forEach(([x, y], i) => sparkle(c, x, y, [0, 1, 2, 1][(frame + i * 2) % 4]));
  },
  fine(c, sp, q, frame) {
    eyesOf(c, sp, q, { dx: frame === 2 || frame === 3 ? -1 : frame === 5 ? 1 : 0, blink: frame === 6 });
    mouthOf(c, sp, q, 'smile', frame);
    cheeksOf(c, sp, q);
  },
  sad(c, sp, q, frame) {
    eyesOf(c, sp, q, { dy: 1.2, blink: frame === 7 });
    const [[lx, ly], [rx, ry]] = sp.eyes;
    line(c, lx - 3.5, ly - 3.2 + q.top, lx + 2.5, ly - 5 + q.top, INK);
    line(c, rx - 2.5, ry - 5 + q.top, rx + 3.5, ry - 3.2 + q.top, INK);
    mouthOf(c, sp, q, 'frown', frame);
    // Слеза собирается и стекает по щеке.
    const fall = frame / PET_FRAMES;
    const tx = lx - 1.8;
    const ty = ly + 4.5 + q.top + fall * 10;
    if (frame > 0) line(c, tx, ly + 4 + q.top, tx, ty - 1, '#a5d6ff');
    paint(c, ellipse(tx, ty, 1 + fall * 0.4, 1.3 + fall * 0.4), '#54aeff');
    dot(c, tx - 0.4, ty - 0.6, '#cde5ff');
    for (const [x, y0] of [[6, 2], [20, 0], [34, 3], [42, 1]]) {
      const y = (y0 + frame * 1.5) % 9;
      line(c, x, y, x, y + 1, '#79c0ff');
    }
  },
  sick(c, sp, q, frame) {
    for (const [ex, ey] of sp.eyes) {
      const y = ey + q.top;
      line(c, ex - 2, y - 2, ex + 2, y + 2, INK);
      line(c, ex + 2, y - 2, ex - 2, y + 2, INK);
    }
    mouthOf(c, sp, q, 'wavy', frame);
    // Градусник: красный столбик подрастает.
    const my = (sp.mouth?.y ?? 30) + q.top + 1.5;
    line(c, 27, my, 34, my + 1.4, '#ffffff');
    line(c, 27, my + 1, 34, my + 2.4, '#adb5bd');
    const mercury = 1 + (frame % 4);
    line(c, 34 - mercury, my + 0.9 - mercury * 0.2, 34, my + 1.6, '#e5534b');
    paint(c, ellipse(35, my + 1.6, 1.4, 1.4), '#e5534b');
    const sweat = 12 + (frame % 4) * 2;
    paint(c, ellipse(40.5, sweat, 1, 1.4), '#54aeff');
    dot(c, 40.2, sweat - 0.6, '#cde5ff');
    for (let k = 0; k < 3; k += 1) {
      const a = (frame / PET_FRAMES) * Math.PI * 2 + (k * Math.PI * 2) / 3;
      sparkle(c, 24 + Math.cos(a) * 11, 3.5 + Math.sin(a) * 2.2, 1, '#e3b341', '#fff3b0');
    }
  },
};

/** Надгробие: камень с объёмом, трава колышется, над цветком порхает бабочка. */
function grave(frame) {
  let c = blank();
  const stone = (x, y) => (x >= 11 && x <= 37 && y >= 14 && y <= 38) || (ellipse(24, 14, 13, 10)(x, y) && y < 14.5);
  paint(c, stone, (x, y) => {
    const lit = ((x - 24) / 13) * 0.6 + ((y - 22) / 18) * 0.4;
    return lit < -0.45 ? '#e9ecef' : lit > 0.42 ? '#868e96' : '#adb5bd';
  });
  for (let y = 12; y <= 27; y += 1) { c[y][23] = '#6e7781'; c[y][24] = '#6e7781'; c[y][25] = '#ced4da'; }
  for (let x = 18; x <= 29; x += 1) { c[16][x] = '#6e7781'; c[17][x] = '#6e7781'; }
  line(c, 31, 24, 29, 28, '#6e7781');
  line(c, 29, 28, 31, 31, '#6e7781');
  line(c, 31, 31, 30, 34, '#6e7781');
  c = outline(c, '#343a40');
  for (let x = 7; x <= 40; x += 1) { c[38][x] = '#343a40'; c[39][x] = '#adb5bd'; c[40][x] = '#868e96'; }
  for (let y = 41; y < 47; y += 1) for (let x = 0; x < PET_SIZE; x += 1) c[y][x] = (x + y) % 7 === 0 ? '#57c776' : '#2f8a4c';
  const sway = Math.round(Math.sin((frame / PET_FRAMES) * Math.PI * 2));
  for (let x = 1; x < PET_SIZE; x += 3) line(c, x, 41, x + sway, 41 - (2 + ((x * 7) % 3)), x % 2 ? '#57c776' : '#3fb950');
  const fx = 42 + sway;
  line(c, 42, 41, fx, 35, '#3fb950');
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) dot(c, fx + dx, 34 + dy, '#e5534b');
  dot(c, fx, 34, '#f2cc60');
  const a = (frame / PET_FRAMES) * Math.PI * 2;
  const bx = 41 + Math.cos(a) * 4;
  const by = 26 + Math.sin(a * 2) * 2.5;
  const wing = frame % 2 ? 1 : 2;
  paint(c, ellipse(bx - 1.2, by - 0.4, wing * 0.7, 1.3), '#c297ff');
  paint(c, ellipse(bx + 1.2, by - 0.4, wing * 0.7, 1.3), '#c297ff');
  dot(c, bx, by, INK);
  return c;
}

function cellsFor(mood, frame, kind) {
  const f = ((frame % PET_FRAMES) + PET_FRAMES) % PET_FRAMES;
  if (mood === 'dead') return grave(f);
  const sp = SPECIES[petKindOf(kind)];
  const pal = paletteFor(sp, mood);
  const q = pose(mood, f);
  let c = blank();
  paint(c, ellipse(24, 46.6, 16.5 - q.lift * 1.2, 1.6), SHADOW);
  sp.body(c, pal, q, mood);
  c = outline(c, pal.line);
  gloss(c, pal, 16.5, 15.6 + q.top + q.breath);
  MOOD_FACE[mood](c, { ...sp, palNow: pal }, q, f);
  sp.extra(c, pal, q, mood);
  return c;
}

/** Пиксели питомца 48×48: [{ x, y, fill }]. Кадр 0–7, вид — из PET_KINDS. */
export function petPixels(mood, frame = 0, kind = DEFAULT_PET_KIND) {
  const pixels = [];
  cellsFor(mood, frame, kind).forEach((row, y) => row.forEach((color, x) => {
    if (color) pixels.push({ x, y, fill: color });
  }));
  return pixels;
}

/** Насколько опустить головной убор для этого вида. */
export const headDropOf = (kind) => SPECIES[petKindOf(kind)].headDrop;

/*
 * Призы рисуются в масштабе питомца: точка рисунка — точка сцены 96×60.
 * Каждый приз — на своём холсте 48×48: предметы рядом занимают левые 24 столбца
 * и стоят на нижней строке, головные уборы совпадают с холстом питомца.
 * Объём — свет сверху слева, тень снизу справа, снаружи тёмная обводка.
 */

const METAL = { light: '#eef1f4', base: '#b4bcc5', shade: '#7d8790', deep: '#4f5861' };
const DARK = { light: '#7d8791', base: '#4b535c', shade: '#30363d', deep: '#1f242a' };
const GOLD = { light: '#fff5c2', base: '#f2cc60', shade: '#d4a72c', deep: '#9a6700' };
const RED = { light: '#ffa198', base: '#e5534b', shade: '#c43a33', deep: '#8e1519' };
const PURPLE = { light: '#d8bcff', base: '#8a5ae6', shade: '#6639ba', deep: '#472c82' };
const GLASS = { light: '#c8ebff', base: '#54aeff', shade: '#1f6feb', deep: '#0a3069' };
const CHALK = '#d8dee4';

/** Вертикальная труба: свет слева, тень справа. */
const pipe = (pal, x0, x1) => (x) => {
  const k = (x - x0) / (x1 - x0);
  return k < 0.3 ? pal.light : k < 0.68 ? pal.base : pal.shade;
};

/** Прямоугольник со скруглёнными углами. */
const rounded = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

/** Кольцо между двумя овалами. */
const ring = (cx, cy, rx, ry, width) => (x, y) => ellipse(cx, cy, rx, ry)(x, y) && !ellipse(cx, cy, rx - width, ry - width)(x, y);

/** Толстая прямая: ножки штатива, ручки. */
function rod(cells, x0, y0, x1, y1, r, color) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) || 1;
  for (let i = 0; i <= steps; i += 1) paint(cells, ellipse(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, r, r), color);
}

/** Жемчужина или камень с бликом. */
function gem(cells, x, y, r, pal) {
  paint(cells, ellipse(x, y, r, r), shaded(pal, x, y, r, r));
  dot(cells, x - r * 0.45, y - r * 0.45, '#ffffff');
}

function drawCamera(c, frame) {
  paint(c, rounded(2.5, 28.5, 9, 34, 1.2), DARK.base);
  paint(c, rounded(3.5, 29.5, 8, 31.5, 0.6), frame === 7 ? '#ffffff' : '#fff1b8');
  paint(c, rounded(9.5, 26.5, 16.5, 34, 1.6), (x, y) => (y < 28 ? DARK.light : DARK.base));
  paint(c, rounded(11.5, 27.5, 14.5, 29, 0.5), GLASS.deep);
  paint(c, rounded(18, 29.5, 21.5, 33, 1), shaded(RED, 19.7, 31, 2, 1.6));
  paint(c, rounded(0.5, 32, 23.5, 47, 2.6), shaded(DARK, 12, 38, 12, 9));
  // Кожаная вставка с мелкой фактурой.
  paint(c, (x, y) => y > 35.5 && y < 44.5 && x > 1 && x < 23, (x, y) => ((Math.floor(x) + Math.floor(y) * 2) % 3 === 0 ? DARK.deep : DARK.shade));
  paint(c, (x, y) => y > 33 && y < 34 && x > 1.5 && x < 22.5, DARK.light);
  // Объектив: серебряное кольцо, чёрная оправа, синее стекло с отражениями.
  paint(c, ellipse(12, 40, 7.4, 7.4), shaded(METAL, 12, 40, 7.4, 7.4));
  paint(c, ellipse(12, 40, 5.8, 5.8), DARK.deep);
  paint(c, ellipse(12, 40, 4.6, 4.6), shaded(GLASS, 12, 40, 4.6, 4.6));
  paint(c, ellipse(12, 40, 2.2, 2.2), GLASS.deep);
  dot(c, 10, 38, '#ffffff');
  dot(c, 11, 38, '#ffffff');
  dot(c, 10, 39, GLASS.light);
  dot(c, 14, 42, GLASS.light);
  dot(c, 20.5, 35, '#2ea043');
}

function drawTripod(c) {
  rod(c, 12.2, 27, 13.2, 46, 0.9, DARK.light);
  rod(c, 11.5, 27, 2.6, 46, 1.1, METAL.base);
  rod(c, 12.5, 27, 21.4, 46, 1.1, METAL.shade);
  for (const [x, y] of [[7, 36.5], [16.9, 36.5]]) paint(c, rounded(x - 1.8, y - 1.3, x + 1.8, y + 1.3, 0.7), DARK.shade);
  for (const x of [2.6, 13.2, 21.4]) paint(c, ellipse(x, 46.6, 1.8, 1), DARK.deep);
  paint(c, rounded(7.5, 24.5, 16.5, 28.5, 1.5), shaded(DARK, 12, 26.5, 4.5, 2));
  paint(c, (x, y) => x > 10.5 && x < 13.5 && y > 16.5 && y < 25, pipe(METAL, 10.5, 13.5));
  paint(c, rounded(9.5, 19.5, 14.5, 21.5, 0.6), DARK.shade);
  paint(c, rounded(4.5, 12.5, 19.5, 17, 1.6), shaded(DARK, 12, 14.5, 7.5, 2.3));
  paint(c, rounded(6.5, 10.5, 17.5, 12.8, 0.6), (x, y) => (y < 11.6 ? METAL.light : METAL.base));
  rod(c, 18.5, 16, 21.5, 20.5, 0.8, DARK.base);
  rod(c, 21, 19.8, 22.6, 22.4, 1.3, RED.base);
  dot(c, 21.4, 20.2, RED.light);
}

function drawMicrophone(c) {
  paint(c, ellipse(12, 46, 8.5, 2.2), shaded(DARK, 12, 45.5, 8.5, 2.2));
  paint(c, (x, y) => x > 10.8 && x < 13.2 && y > 29 && y < 45.5, pipe(METAL, 10.8, 13.2));
  paint(c, rounded(9.2, 27, 14.8, 30.5, 1), DARK.shade);
  paint(c, rounded(9, 19, 15, 28.5, 2.2), pipe(DARK, 9, 15));
  dot(c, 12, 24, RED.base);
  paint(c, (x, y) => x > 8.6 && x < 15.4 && y > 17.6 && y < 20, pipe(GOLD, 8.6, 15.4));
  // Сетка: косые нити по серебру, шов посередине и блик.
  paint(c, ellipse(12, 12, 6.4, 6.6), (x, y) => {
    const base = shaded(METAL, 12, 12, 6.4, 6.6)(x, y);
    return (Math.floor(x) + Math.floor(y)) % 3 === 0 || (Math.floor(x) - Math.floor(y) + 30) % 3 === 0 ? (base === METAL.light ? METAL.base : METAL.shade) : base;
  });
  paint(c, (x, y) => y > 11.8 && y < 13 && ellipse(12, 12, 6.4, 6.6)(x, y), METAL.deep);
  paint(c, ellipse(9.8, 9, 1.6, 1.2), '#ffffff');
}

const SPOT_BACK = [17.5, 26];
const SPOT_FRONT = [7.5, 18.5];
const SPOT_DIR = (() => {
  const dx = SPOT_FRONT[0] - SPOT_BACK[0];
  const dy = SPOT_FRONT[1] - SPOT_BACK[1];
  const len = Math.hypot(dx, dy);
  return { dx: dx / len, dy: dy / len, nx: dy / len, ny: -dx / len, len };
})();

function drawSpotlight(c) {
  const { dx, dy, nx, ny, len } = SPOT_DIR;
  rod(c, 12, 41.5, 5, 46.5, 0.9, DARK.base);
  rod(c, 12, 41.5, 19, 46.5, 0.9, DARK.shade);
  rod(c, 12, 41.5, 12.5, 47, 0.9, DARK.light);
  paint(c, (x, y) => x > 10.9 && x < 13.1 && y > 30 && y < 42, pipe(METAL, 10.9, 13.1));
  rod(c, 5.5, 22, 5.5, 30.5, 0.9, DARK.light);
  rod(c, 19, 26, 19, 30.5, 0.9, DARK.light);
  rod(c, 5.5, 30.5, 19, 30.5, 0.9, DARK.light);
  // Корпус — повёрнутый цилиндр: верхняя сторона светлее.
  const [bx, by] = SPOT_BACK;
  const at = (t, side, r) => [bx + dx * len * t + nx * side * r, by + dy * len * t + ny * side * r];
  const body = polygon([at(0, 1, 4.6), at(1, 1, 5.6), at(1, -1, 5.6), at(0, -1, 4.6)]);
  const mx = (bx + SPOT_FRONT[0]) / 2;
  const my = (by + SPOT_FRONT[1]) / 2;
  paint(c, body, (x, y) => {
    const s = ((x - mx) * nx + (y - my) * ny) / 5;
    return s < -0.5 ? DARK.light : s < 0.1 ? DARK.base : s < 0.6 ? DARK.shade : DARK.deep;
  });
  // Рёбра охлаждения сзади.
  for (const t of [0.12, 0.26, 0.4]) {
    const [x0, y0] = at(t, 1, 4.4);
    const [x1, y1] = at(t, -1, 4.4);
    line(c, x0, y0, x1, y1, DARK.deep);
  }
  // Створки у линзы.
  for (const side of [1, -1]) {
    const [x0, y0] = at(1, side, 5.8);
    rod(c, x0, y0, x0 + dx * 2.6 + nx * side * 1.6, y0 + dy * 2.6 + ny * side * 1.6, 0.6, DARK.shade);
  }
  const angle = Math.atan2(dy, dx);
  const [fx, fy] = SPOT_FRONT;
  paint(c, tilted(fx, fy, 2.4, 5.8, angle), METAL.shade);
  paint(c, tilted(fx + dx * 0.4, fy + dy * 0.4, 1.8, 4.8, angle), (x, y) => (ellipse(fx - 0.6, fy - 1.2, 1.6, 2.4)(x, y) ? '#fffbe6' : GOLD.base));
}

/** Хлопушка: верхняя планка поднята, в кадрах 4–5 захлопнута, рядом с ними — на полпути. */
const CLAP_ANGLE = [-0.32, -0.32, -0.32, -0.16, 0, 0, -0.16, -0.32];

function drawClapper(c, frame) {
  const stripes = (u, v) => (Math.floor((u - v + 40) / 4) % 2 ? '#f6f8fa' : DARK.deep);
  paint(c, rounded(0.5, 30.5, 23.5, 47, 1.6), shaded(DARK, 12, 38, 12, 9));
  for (const y of [36, 41]) paint(c, (x, yy) => yy > y && yy < y + 1 && x > 1.5 && x < 22.5, CHALK);
  paint(c, (x, y) => x > 12 && x < 13 && y > 31 && y < 36, CHALK);
  paint(c, (x, y) => x > 8 && x < 9 && y > 41 && y < 46, CHALK);
  for (const [x0, x1, y] of [[3, 7, 33], [14, 18, 33], [3, 6, 38], [8, 10, 38], [14, 20, 38], [3, 6, 43], [11, 16, 43], [17, 20, 44]]) {
    paint(c, (x, yy) => yy > y && yy < y + 1 && x > x0 && x < x1, '#8c959f');
  }
  // Нижняя планка и верхняя на петле: полосы идут вдоль планки, по краю тёмная кромка.
  paint(c, (x, y) => x > 0.5 && x < 23.5 && y > 25.5 && y < 30.5, (x, y) => (y > 29.5 || y < 26.5 || x > 22.5 ? DARK.deep : stripes(x, 30.5 - y)));
  const a = CLAP_ANGLE[frame] ?? 0;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const hx = 1.5;
  const hy = 25.6;
  const local = (x, y) => [(x - hx) * cos + (y - hy) * sin, -(x - hx) * sin + (y - hy) * cos];
  paint(c, (x, y) => {
    const [u, v] = local(x, y);
    return u > -1 && u < 22 && v > -5 && v < 0;
  }, (x, y) => {
    const [u, v] = local(x, y);
    return v > -1 || v < -4 || u > 21 ? DARK.deep : stripes(u, -v);
  });
  paint(c, ellipse(1.8, 25.8, 1.4, 1.4), shaded(METAL, 1.8, 25.8, 1.4, 1.4));
}

function drawHeadphones(c) {
  // Дужка: светлая снаружи, темнее внутри; сверху красная мягкая накладка.
  paint(c, (x, y) => y < 25 && ring(24, 30, 21.5, 24.5, 3)(x, y), (x, y) => (((x - 24) / 21.5) ** 2 + ((y - 30) / 24.5) ** 2 > 0.9 ? DARK.light : DARK.shade));
  paint(c, (x, y) => Math.abs(x - 24) < 9 && ring(24, 30, 22.2, 25.4, 4.6)(x, y), (x, y) => (y < 6.4 ? RED.light : y < 8 ? RED.base : RED.shade));
  for (const xx of [15, 33]) paint(c, (x, y) => x > xx - 0.5 && x < xx + 0.5 && ring(24, 30, 22.2, 25.4, 4.6)(x, y), RED.deep);
  for (const [x0, x1] of [[2.6, 5.4], [42.6, 45.4]]) paint(c, (x, y) => x > x0 && x < x1 && y > 15 && y < 21, pipe(METAL, x0, x1));
  for (const [cx, cap] of [[5, 2.4], [43, 45.6]]) {
    paint(c, ellipse(cx, 26.5, 4.6, 6.8), shaded(RED, cx, 26.5, 4.6, 6.8));
    paint(c, ellipse(cap, 26.5, 2, 4.6), shaded(METAL, cap, 26.5, 2, 4.6));
    dot(c, cap - 0.4, 24.4, '#ffffff');
  }
}

function drawBeret(c) {
  paint(c, ellipse(24, 15, 14.6, 2.6), (x, y) => (y < 14.5 ? PURPLE.shade : PURPLE.deep));
  paint(c, tilted(25, 10, 17.2, 6, -0.09), shaded(PURPLE, 22, 8, 17, 6));
  // Мягкие складки ткани.
  curve(c, 13, 22, (x) => 11.8 + Math.sin((x - 13) / 3) * 0.6, PURPLE.shade);
  curve(c, 29, 37, (x) => 9.6 + Math.sin((x - 29) / 3) * 0.6, PURPLE.shade);
  paint(c, ellipse(18, 6.6, 4.4, 1.4), PURPLE.light);
  dot(c, 16.5, 6.2, '#ffffff');
  rod(c, 27.2, 3.6, 28.6, 5.4, 0.8, PURPLE.deep);
  // Значок художника: золотая палитра.
  paint(c, ellipse(35.5, 11.3, 1.9, 1.5), shaded(GOLD, 35.5, 11.3, 1.9, 1.5));
  dot(c, 35, 11, RED.base);
  dot(c, 36, 12, GLASS.base);
}

function drawCrown(c) {
  // Пять зубцов: крайние и средний выше, на них жемчуг.
  const shape = [[11.6, 15.6], [11.6, 4.4], [15.4, 9.4], [18.4, 5.6], [21.4, 9.4], [24, 2.6], [26.6, 9.4], [29.6, 5.6], [32.6, 9.4], [36.4, 4.4], [36.4, 15.6]];
  paint(c, polygon(shape), shaded(GOLD, 20, 6, 14, 9));
  paint(c, (x, y) => x > 11.6 && x < 36.4 && y > 10 && y < 15.6, (x, y) => (y < 11 ? GOLD.light : y > 14.6 ? GOLD.deep : x > 31 ? GOLD.shade : GOLD.base));
  for (let x = 13; x < 36; x += 2) dot(c, x, 14.6, GOLD.shade);
  for (const [x, y] of [[12.8, 5], [24, 3.4], [35.2, 5]]) gem(c, x, y, 1.6, METAL);
  gem(c, 24, 12.8, 1.9, RED);
  // Боковые камни — зелёные ромбы, без бликов: иначе похожи на глаза.
  for (const x of [17.5, 30.5]) {
    paint(c, polygon([[x, 10.9], [x + 1.6, 12.8], [x, 14.7], [x - 1.6, 12.8]]), (xx) => (xx < x ? '#56d364' : '#1a7f37'));
  }
}

const PRIZE_ART = { camera: drawCamera, tripod: drawTripod, microphone: drawMicrophone, spotlight: drawSpotlight, clapper: drawClapper, headphones: drawHeadphones, beret: drawBeret, crown: drawCrown };
const HEAD_PRIZES = new Set(['headphones', 'beret', 'crown']);
const prizeCache = new Map();

/** Точки приза на его холсте 48×48 для кадра. */
function prizePixels(id, frame) {
  const draw = PRIZE_ART[id];
  if (!draw) return [];
  const animated = id === 'camera' || id === 'clapper';
  const key = `${id}:${animated ? frame : 0}`;
  if (!prizeCache.has(key)) {
    const cells = blank();
    draw(cells, frame);
    const pixels = [];
    outline(cells, INK).forEach((row, y) => row.forEach((fill, x) => fill && pixels.push({ x, y, fill })));
    prizeCache.set(key, pixels);
  }
  return prizeCache.get(key);
}

/** Искорка из точек сцены. */
const glint = (x, y, size, color = '#ffffff') => {
  const out = [{ x, y, fill: color }];
  for (let i = 1; i <= size; i += 1) out.push({ x: x + i, y, fill: color }, { x: x - i, y, fill: color }, { x, y: y + i, fill: color }, { x, y: y - i, fill: color });
  return out;
};

/** Оживление призов по кадрам: вспышка камеры, луч прожектора, звук микрофона, ноты, блеск короны. ox, oy — угол холста приза в сцене. */
function prizeMotion(id, ox, oy, frame) {
  if (id === 'camera' && frame === 7) return glint(ox + 6, oy + 30, 3);
  if (id === 'camera' && frame === 0) return glint(ox + 6, oy + 30, 1);
  if (id === 'spotlight' && frame % 4 < 2) {
    const { dx, dy, nx, ny } = SPOT_DIR;
    const seen = new Set();
    const out = [];
    for (let k = 1; k <= 26; k += 0.5) {
      const half = 3.5 + k * 0.55;
      for (let w = -half; w <= half; w += 0.5) {
        const x = Math.round(ox + SPOT_FRONT[0] + dx * k + nx * w);
        const y = Math.round(oy + SPOT_FRONT[1] + dy * k + ny * w);
        if (seen.has(`${x},${y}`)) continue;
        seen.add(`${x},${y}`);
        out.push({ x, y, fill: '#f2cc602e' });
      }
    }
    return out;
  }
  if (id === 'microphone' && frame % 4 !== 3) {
    const r = 3 + (frame % 4) * 2;
    const out = [];
    for (let a = -0.7; a <= 0.7; a += 0.2) out.push({ x: Math.round(ox + 18 + r * 0.5 + Math.cos(a) * r * 0.4), y: Math.round(oy + 12 + Math.sin(a) * r), fill: '#8c959f' });
    return out;
  }
  if (id === 'headphones') {
    const y = oy + 20 - (frame % 4) * 3;
    const note = (x, yy) => [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [2, -1], [2, -2], [2, -3], [3, -3], [4, -2]].map(([a, b]) => ({ x: x + a, y: yy + b, fill: '#a371f7' }));
    return frame % 4 === 3 ? [] : [...note(ox - 6, y), ...note(ox + 50, y - 4)];
  }
  if (id === 'crown' && (frame === 2 || frame === 3)) return glint(ox + 27, oy + 6, frame === 2 ? 1 : 2, '#fff8d6');
  return [];
}

/** Пиксели сцены 96×60 с питомцем и призами. Кадр 0–7. */
export function dressedPixels(mood, look, frame = 0, kind = DEFAULT_PET_KIND) {
  const pixels = [];
  const f = ((frame % PET_FRAMES) + PET_FRAMES) % PET_FRAMES;
  const place = (id, ox, oy) => pixels.push(...prizePixels(id, f).map((p) => ({ ...p, x: p.x + ox, y: p.y + oy })), ...prizeMotion(id, ox, oy, f));
  // Предметы рядом стоят на земле: нижняя строка холста приза — нижняя строка сцены.
  if (PRIZE_ART[look.left] && !HEAD_PRIZES.has(look.left)) place(look.left, 0, 12);
  if (PRIZE_ART[look.right] && !HEAD_PRIZES.has(look.right)) place(look.right, 72, 12);
  // Питомец 48×48 стоит на земле посередине.
  pixels.push(...petPixels(mood, f, kind).map((p) => ({ ...p, x: p.x + 24, y: p.y + 12 })));
  if (HEAD_PRIZES.has(look.head) && mood !== 'dead') {
    // Головной убор двигается вместе с головой: дыхание и прыжки.
    const q = pose(mood, f);
    place(look.head, 24, headDropOf(kind) + Math.round(q.breath) - q.lift);
  }
  return pixels.filter((p) => p.x >= 0 && p.x < 96 && p.y >= 0 && p.y < 60);
}

const NS = 'http://www.w3.org/2000/svg';

/** Слой кадра: точки одного цвета сливаются в один путь из горизонтальных полосок. */
function layer(pixels, className) {
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', className);
  const byColor = new Map();
  for (const { x, y, fill } of pixels) {
    if (!byColor.has(fill)) byColor.set(fill, new Map());
    const rows = byColor.get(fill);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(x);
  }
  for (const [fill, rows] of byColor) {
    let d = '';
    for (const [y, xs] of rows) {
      xs.sort((a, b) => a - b);
      for (let i = 0; i < xs.length;) {
        let j = i;
        while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j += 1;
        d += `M${xs[i]} ${y}h${xs[j] - xs[i] + 1}v1h${-(xs[j] - xs[i] + 1)}z`;
        i = j + 1;
      }
    }
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    g.append(path);
  }
  return g;
}

/** Значок приза для списка: только сам предмет, по центру квадрата. */
export function prizeIcon(id) {
  const svg = document.createElementNS(NS, 'svg');
  const pixels = prizePixels(id, 0);
  const xs = pixels.map((p) => p.x);
  const ys = pixels.map((p) => p.y);
  const left = pixels.length ? Math.min(...xs) : 0;
  const top = pixels.length ? Math.min(...ys) : 0;
  const width = pixels.length ? Math.max(...xs) - left + 1 : 1;
  const height = pixels.length ? Math.max(...ys) - top + 1 : 1;
  // Квадрат по большей стороне: высокие и широкие предметы выглядят одного размера.
  const side = Math.max(width, height);
  svg.setAttribute('viewBox', `${left - (side - width) / 2} ${top - (side - height) / 2} ${side} ${side}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('prizeicon');
  svg.append(layer(pixels, 'still'));
  return svg;
}

/** Рисует существо: восемь кадров сменяют друг друга средствами CSS. */
export function petSprite(mood, look = null, kind = DEFAULT_PET_KIND) {
  const svg = document.createElementNS(NS, 'svg');
  const dressed = Boolean(look && (look.head || look.left || look.right));
  svg.setAttribute('viewBox', dressed ? '0 0 96 60' : `0 0 ${PET_SIZE} ${PET_SIZE}`);
  if (dressed) svg.classList.add('dressed');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('petsprite', `mood-${mood}`, `kind-${petKindOf(kind)}`);
  for (let frame = 0; frame < PET_FRAMES; frame += 1) {
    svg.append(layer(dressed ? dressedPixels(mood, look, frame, kind) : petPixels(mood, frame, kind), `frame f${frame}`));
  }
  return svg;
}
