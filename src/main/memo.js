'use strict';
// Служебная записка из шаблона Word с полями вида {{Мероприятие}}. Оформление
// шаблона не меняется: подставляются только значения полей и строки студентов.
// Шаблон может быть любым: учебное заведение делает его в Word и загружает в программу.
const zlib = require('node:zlib');

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/** Читает ZIP (файл docx — это архив): [{ name, data }]. */
function readZip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== END_OF_CENTRAL_DIRECTORY) end -= 1;
  if (end < 0) throw new Error('Шаблон повреждён');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(at) !== CENTRAL_HEADER) throw new Error('Шаблон повреждён');
    const method = buffer.readUInt16LE(at + 10);
    const packed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const raw = buffer.subarray(start, start + packed);
    entries.push({ name, data: method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Собирает ZIP заново. */
function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const escapeXml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Поля пишутся по-русски или по-английски: шаблон могут делать в любом учебном заведении.
const ALIASES = {
  event: 'мероприятие', when: 'дата и время', release: 'освобождение', place: 'место', responsible: 'ответственный',
  from: 'от кого', signature: 'подпись', day: 'день', month: 'месяц', year: 'год', no: '№', name: 'фио', group: 'группа',
};
const keyOf = (text) => {
  const key = text.replace(/[{}]/g, '').trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');
  return ALIASES[key] ?? key;
};

/** Поля документа: название в шаблоне и откуда берётся значение. */
const FIELDS = {
  'мероприятие': (memo) => memo.title,
  'дата и время': (memo) => memo.when,
  'освобождение': (memo) => memo.release,
  'место': (memo) => memo.place,
  'ответственный': (memo) => memo.responsible,
  'от кого': (memo) => memo.from,
  'подпись': (memo) => memo.signer,
  'день': (memo) => memo.day,
  'месяц': (memo) => memo.month,
  'год': (memo) => memo.year,
};

/** Поля строки студента: строка таблицы с ними повторяется для каждого. */
const ROW_FIELDS = {
  '№': (student, i) => i + 1,
  'фио': (student) => student.name,
  'группа': (student) => student.group,
};

const PLACEHOLDER = /\{\{[^{}<>]*\}\}/g;
const TEXT_RUN = /(<w:t(?: [^>]*)?>)([^<]*)(<\/w:t>)/g;

/**
 * Word делит текст на фрагменты как угодно, и {{ФИО}} может оказаться в трёх кусках.
 * Собирает каждое поле в один фрагмент, оформление берётся у того, где поле начинается.
 */
function joinPlaceholders(xml) {
  return xml.replace(/<w:p(?: [^>]*)?>(?:(?!<\/w:p>).)*?<\/w:p>/gs, (paragraph) => {
    const runs = [...paragraph.matchAll(TEXT_RUN)].map((m) => ({ text: m[2] }));
    if (runs.length < 2 || !runs.map((r) => r.text).join('').includes('{{')) return paragraph;
    for (;;) {
      const all = runs.map((r) => r.text).join('');
      const starts = [];
      let at = 0;
      for (const run of runs) {
        starts.push(at);
        at += run.text.length;
      }
      const runAt = (pos) => starts.findLastIndex((start, i) => start <= pos && (pos < start + runs[i].text.length || i === runs.length - 1));
      const split = [...all.matchAll(PLACEHOLDER)].find((m) => runAt(m.index) !== runAt(m.index + m[0].length - 1));
      if (!split) break;
      const first = runAt(split.index);
      const last = runAt(split.index + split[0].length - 1);
      const end = split.index + split[0].length;
      const tail = runs[last].text.slice(end - starts[last]);
      runs[first].text = runs[first].text.slice(0, split.index - starts[first]) + split[0];
      for (let i = first + 1; i <= last; i += 1) runs[i].text = '';
      runs[last].text = tail;
    }
    let index = 0;
    return paragraph.replace(TEXT_RUN, () => {
      const run = runs[index];
      index += 1;
      return `<w:t xml:space="preserve">${run.text}</w:t>`;
    });
  });
}

const fill = (text, fields, ...args) => text.replace(PLACEHOLDER, (found) => {
  const value = fields[keyOf(found)];
  return value ? escapeXml(value(...args) ?? '') : found;
});

const TABLE_ROW = /<w:tr(?: [^>]*)?>(?:(?!<\/w:tr>).)*?<\/w:tr>/gs;
const hasRowField = (row) => (row.match(PLACEHOLDER) ?? []).some((found) => keyOf(found) in ROW_FIELDS);

function fillDocument(xml, memo) {
  const joined = joinPlaceholders(xml);
  const withStudents = joined.replace(TABLE_ROW, (row) => (hasRowField(row)
    ? memo.students.map((student, i) => fill(row, ROW_FIELDS, student, i)).join('')
    : row));
  return fill(withStudents, FIELDS, memo);
}

/** Какие поля нашлись в шаблоне. Для проверки загруженного файла. */
function templateFields(template) {
  const entry = readZip(template).find((item) => item.name === 'word/document.xml');
  if (!entry) throw new Error('Это не документ Word');
  const found = [...new Set(joinPlaceholders(entry.data.toString('utf8')).match(PLACEHOLDER) ?? [])];
  const known = (name) => keyOf(name) in FIELDS || keyOf(name) in ROW_FIELDS;
  return { known: found.filter(known), unknown: found.filter((name) => !known(name)) };
}

/** Возвращает готовый docx. */
function buildMemo(template, memo) {
  const entries = readZip(template).map((entry) => (entry.name === 'word/document.xml'
    ? { name: entry.name, data: Buffer.from(fillDocument(entry.data.toString('utf8'), memo), 'utf8') }
    : entry));
  return writeZip(entries);
}

module.exports = { buildMemo, readZip, templateFields, writeZip };
