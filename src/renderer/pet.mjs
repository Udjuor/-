// Тамагочи группы. Здоровье не хранится, а пересчитывается по отметкам,
// поэтому на всех устройствах питомец в одном и том же состоянии.
import { byTime, nameKey, rollCall } from './logic.mjs';

const START_HEALTH = 70;
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
export function petStatus({ group, students, events, attendance, nowISO, nowTime }) {
  const members = new Set(students.filter((s) => s.groupId === group.id).map((s) => nameKey(s.name)));
  const docs = new Map(attendance.map((doc) => [doc.eventId, doc]));
  const since = group.petSince ?? '';
  const pairs = events
    .filter((event) => COUNTED_TYPES.has(event.type) && `${event.date}T${event.end}` > since)
    .sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));

  let health = START_HEALTH;
  let counted = 0;
  let last = null;
  let diedOn = null;

  for (const event of pairs) {
    const marks = Object.values(docs.get(event.id)?.marks ?? {});
    if (!marks.some((mark) => mark.status)) continue;
    const rows = rollCall(event, docs.get(event.id), nowISO, nowTime)
      .filter((row) => members.has(nameKey(row.name)) && ['present', 'absent'].includes(row.status));
    if (!rows.length) continue;
    const onTime = rows.filter((row) => row.status === 'present' && !row.late).length;
    const late = rows.filter((row) => row.late > 0).length;
    const absent = rows.filter((row) => row.status === 'absent').length;
    health = clamp(health + healthChange((onTime + late / 2) / rows.length));
    counted += 1;
    last = { title: event.title, date: event.date, total: rows.length, present: onTime + late, late, absent };
    if (health === 0) {
      diedOn = event.date;
      break;
    }
  }

  return { health, mood: moodOf(health), counted, last, diedOn };
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

/** Рисует существо: два кадра сменяют друг друга средствами CSS. */
export function petSprite(mood) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('petsprite', `mood-${mood}`);
  for (const frame of [0, 1]) {
    const layer = document.createElementNS(ns, 'g');
    layer.classList.add(`frame${frame}`);
    for (const { x, y, fill } of petPixels(mood, frame)) {
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
