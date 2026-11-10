// QR-код для ссылки на студенческую страницу. Без сторонних библиотек:
// байтовый режим, уровень коррекции M, версии 1–10 (до 213 байт), лучшая из восьми масок.

// Для уровня M: [всего кодовых слов, слов коррекции на блок, [[блоков, слов данных в блоке], …]].
const VERSIONS = [
  null,
  [26, 10, [[1, 16]]],
  [44, 16, [[1, 28]]],
  [70, 26, [[1, 44]]],
  [100, 18, [[2, 32]]],
  [134, 24, [[2, 43]]],
  [172, 16, [[4, 27]]],
  [196, 18, [[4, 31]]],
  [242, 22, [[2, 38], [2, 39]]],
  [292, 22, [[3, 36], [2, 37]]],
  [346, 26, [[4, 43], [1, 44]]],
];

const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/* Поле Галуа GF(256) с порождающим многочленом 0x11D */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Слова коррекции Рида — Соломона для блока данных. */
function correction(data, degree) {
  const gen = generator(degree);
  const rest = [...data, ...new Array(degree).fill(0)];
  for (let i = 0; i < data.length; i += 1) {
    const factor = rest[i];
    if (!factor) continue;
    for (let j = 0; j < gen.length; j += 1) rest[i + j] ^= mul(gen[j], factor);
  }
  return rest.slice(data.length);
}

function capacity(version) {
  const [, , groups] = VERSIONS[version];
  return groups.reduce((sum, [blocks, size]) => sum + blocks * size, 0);
}

/** Кодовые слова: режим, длина, данные, добивка; затем блоки с коррекцией вперемешку. */
function codewords(bytes, version) {
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  const total = capacity(version) * 8;
  put(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < total; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));

  const [, degree, groups] = VERSIONS[version];
  const blocks = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let b = 0; b < count; b += 1) {
      const chunk = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: chunk, ec: correction(chunk, degree) });
    }
  }
  const result = [];
  const longest = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < longest; i += 1) for (const block of blocks) if (i < block.data.length) result.push(block.data[i]);
  for (let i = 0; i < degree; i += 1) for (const block of blocks) result.push(block.ec[i]);
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function build(bytes, version, mask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    fixed[y][x] = true;
  };

  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = ALIGNMENT[version];
  for (let i = 0; i < align.length; i += 1) {
    for (let j = 0; j < align.length; j += 1) {
      const last = align.length - 1;
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  // Служебная информация: уровень M (00) и номер маски, код БЧХ(15,5).
  const formatData = (0b00 << 3) | mask;
  let rem = formatData;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const format = ((formatData << 10) | rem) ^ 0x5412;
  const bit = (value, i) => ((value >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(format, i));
  set(8, 7, bit(format, 6));
  set(8, 8, bit(format, 7));
  set(7, 8, bit(format, 8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(format, i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(format, i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(format, i));
  set(8, size - 8, true);

  if (version >= 7) {
    let r = version;
    for (let i = 0; i < 12; i += 1) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const info = (version << 12) | r;
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(info, i));
      set(b, a, bit(info, i));
    }
  }

  const words = codewords(bytes, version);
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fixed[y][x]) continue;
        let dark = false;
        if (index < words.length * 8) {
          dark = ((words[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
          index += 1;
        }
        modules[y][x] = dark !== MASKS[mask](x, y);
      }
    }
  }
  return modules;
}

/** Штраф маски: длинные ряды, квадраты 2×2 и перекос тёмного и светлого. */
function penalty(modules) {
  const size = modules.length;
  let score = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    for (let a = 0; a < size; a += 1) {
      let run = 1;
      for (let b = 1; b < size; b += 1) {
        const prev = pass ? modules[b - 1][a] : modules[a][b - 1];
        const cur = pass ? modules[b][a] : modules[a][b];
        if (cur === prev) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) dark += 1;
      if (x < size - 1 && y < size - 1) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
    }
  }
  score += Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10;
  return score;
}

/** Матрица QR-кода: true — тёмный модуль. */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let version = 1;
  while (version <= 10 && capacity(version) * 8 < 4 + (version < 10 ? 8 : 16) + bytes.length * 8) version += 1;
  if (version > 10) throw new Error('Слишком длинный текст для QR-кода');
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = build(bytes, version, mask);
    const score = penalty(modules);
    if (!best || score < best.score) best = { modules, score };
  }
  return best.modules;
}

/** Контур тёмных модулей для SVG и размер с белым полем в 4 модуля. */
export function qrPath(text) {
  const modules = qrMatrix(text);
  let path = '';
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`;
  }));
  return { size: modules.length + 8, path };
}

/** QR-код как SVG с белым полем в 4 модуля: читается и в тёмной теме. */
export function qrSvg(text) {
  const modules = qrMatrix(text);
  const size = modules.length + 8;
  let path = '';
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`;
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
