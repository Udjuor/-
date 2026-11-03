'use strict';
// Служебная записка из шаблона Word. Оформление шаблона не меняется:
// в его XML подставляются только значения полей и строки студентов.
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

const RUN_PROPS = '<w:rPr><w:rStyle w:val="Нет"/><w:rtl w:val="0"/><w:lang w:val="ru-RU"/></w:rPr>';

const paragraph = (text, center = false) => `<w:p><w:pPr><w:pStyle w:val="Normal.0"/><w:spacing w:after="0"/>${center ? '<w:jc w:val="center"/>' : ''}</w:pPr><w:r>${RUN_PROPS}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;

/** Заполняет пустые ячейки строки по порядку. */
function fillRow(row, values) {
  let index = 0;
  return row.replace(/<w:p\/>/g, () => {
    const value = values[index];
    index += 1;
    return value === undefined ? '<w:p/>' : value;
  });
}

/** Заменяет текст абзаца, который проходит проверку. Оформление первого фрагмента остаётся. */
function setParagraph(xml, test, text) {
  return xml.replace(/<w:p(?: [^>]*)?>(?:(?!<\/w:p>).)*?<\/w:p>/gs, (paragraphXml) => {
    const current = [...paragraphXml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
    if (!test.test(current)) return paragraphXml;
    let first = true;
    return paragraphXml.replace(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g, () => {
      const run = first ? `<w:t xml:space="preserve">${escapeXml(text)}</w:t>` : '<w:t></w:t>';
      first = false;
      return run;
    });
  });
}

function fillDocument(xml, memo) {
  const firstTable = xml.indexOf('</w:tbl>');
  const start = xml.indexOf('<w:tbl>', firstTable);
  const end = xml.indexOf('</w:tbl>', start);
  if (firstTable < 0 || start < 0 || end < 0) throw new Error('В шаблоне нет таблицы записки');

  const table = xml.slice(start, end);
  const rows = table.match(/<w:tr>.*?<\/w:tr>/gs);
  if (!rows || rows.length !== 7) throw new Error('Таблица шаблона изменена');
  const fields = [memo.title, memo.when, memo.release, memo.place, memo.responsible];
  let filled = table;
  rows.slice(0, 5).forEach((row, i) => {
    filled = filled.replace(row, () => fillRow(row, [paragraph(fields[i])]));
  });
  // Колонка номера узкая: без уменьшенных полей двузначное число переносится.
  const studentRow = rows[6]
    .replace('<w:left w:type="dxa" w:w="80"/>', '<w:left w:type="dxa" w:w="20"/>')
    .replace('<w:right w:type="dxa" w:w="80"/>', '<w:right w:type="dxa" w:w="20"/>');
  const studentRows = memo.students.map((student, i) => fillRow(studentRow, [
    paragraph(i + 1, true),
    paragraph(student.name),
    paragraph(student.group),
  ])).join('');
  filled = filled.replace(rows[6], () => studentRows);

  const head = xml.slice(0, start)
    .replace(/(<w:t[^>]*>)__(<\/w:t>)/, `$1${escapeXml(memo.day)}$2`)
    .replace(/_____\s+\d{4}\s*/, `${escapeXml(memo.month)} ${escapeXml(memo.year)} `);
  let result = head + filled + xml.slice(end);
  if (memo.from) result = setParagraph(result, /^\s*От\s/, `От ${memo.from}`);
  if (memo.signer) result = setParagraph(result, /^\s*Подпись\s/, `Подпись ___________/ ${memo.signer}`);
  return result;
}

/** Возвращает готовый docx. */
function buildMemo(template, memo) {
  const entries = readZip(template).map((entry) => (entry.name === 'word/document.xml'
    ? { name: entry.name, data: Buffer.from(fillDocument(entry.data.toString('utf8'), memo), 'utf8') }
    : entry));
  return writeZip(entries);
}

module.exports = { buildMemo, readZip, writeZip };
