'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildMemo, readZip, templateFields, writeZip } = require('../src/main/memo');

const template = fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'memo-template.docx'));
const memo = {
  day: '03', month: 'ноября', year: '2026', title: 'Концерт <к Дню матери> & репетиция', when: '5 ноября 2026, 11:00',
  release: '11:00–14:30', place: 'Актовый зал', responsible: 'Павлов С. Н.',
  students: [{ name: 'Иванова Анна', group: 'ИС-21' }, { name: 'Петров Пётр', group: 'ПИ-22' }, { name: 'Гость', group: '' }],
};
const xmlOf = (buffer) => readZip(buffer).find((e) => e.name === 'word/document.xml').data.toString('utf8');
const textOf = (xml) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');

const docx = (body) => writeZip([{ name: 'word/document.xml', data: Buffer.from(`<w:document><w:body>${body}</w:body></w:document>`) }]);
const p = (...runs) => `<w:p>${runs.map((text) => `<w:r><w:t>${text}</w:t></w:r>`).join('')}</w:p>`;

test('свой шаблон: поля в разорванных фрагментах и строка студента', () => {
  const custom = docx(`${p('Мероприятие: {{Меропр', 'иятие', '}}')}${p('{{ДЕНЬ}} {{месяц}} {{Год}}')}`
    + `<w:tbl><w:tr><w:tc>${p('№')}</w:tc></w:tr><w:tr><w:tc>${p('{{', '№}}')}</w:tc><w:tc>${p('{{ФИО}}')}</w:tc><w:tc>${p('{{Группа}}')}</w:tc></w:tr></w:tbl>`
    + p('{{Неизвестно}} {{Подпись}}'));
  const xml = xmlOf(buildMemo(custom, { ...memo, signer: 'Павлов С. Н.' }));
  const text = textOf(xml);
  assert.ok(text.includes('Мероприятие: Концерт &lt;к Дню матери&gt; &amp; репетиция'));
  assert.ok(text.includes('03 ноября 2026'));
  assert.ok(text.includes('1Иванова АннаИС-21') && text.includes('2Петров ПётрПИ-22'));
  assert.equal((xml.match(/<w:tr>/g) ?? []).length, 1 + memo.students.length);
  assert.ok(text.includes('{{Неизвестно}} Павлов С. Н.'), 'незнакомое поле остаётся как есть');
});

test('проверка шаблона перед загрузкой', () => {
  assert.deepEqual(templateFields(docx(p('{{ФИО}} {{Что-то}}'))), { known: ['{{ФИО}}'], unknown: ['{{Что-то}}'] });
  assert.deepEqual(templateFields(docx(p('без полей'))).known, []);
  assert.throws(() => templateFields(writeZip([{ name: 'a.txt', data: Buffer.from('x') }])));
  assert.equal(templateFields(template).known.length, 13, 'встроенный шаблон размечен полностью');
});

test('архив читается и собирается без потерь', () => {
  const entries = readZip(template);
  const again = readZip(writeZip(entries));
  assert.deepEqual(again.map((e) => e.name), entries.map((e) => e.name));
  again.forEach((entry, i) => assert.ok(entry.data.equals(entries[i].data), entry.name));
});

test('поля заполнены, шапка и согласования на месте', () => {
  const text = textOf(xmlOf(buildMemo(template, memo)));
  for (const value of ['5 ноября 2026, 11:00', '11:00–14:30', 'Актовый зал', 'Павлов С. Н.', 'Иванова Анна', 'ИС-21', 'Петров Пётр', 'ПИ-22', 'СЛУЖЕБНАЯ ЗАПИСКА', 'Никитину З.Н.', 'Габышев Р.А.', 'kkii.ykt@mail.ru']) {
    assert.ok(text.includes(value), value);
  }
});

test('специальные символы экранированы, документ остаётся корректным', () => {
  const xml = xmlOf(buildMemo(template, memo));
  assert.ok(xml.includes('Концерт &lt;к Дню матери&gt; &amp; репетиция'));
  assert.ok(!xml.includes('<к Дню'));
});

test('дата записки подставлена, номер оставлен для регистрации', () => {
  const text = textOf(xmlOf(buildMemo(template, memo)));
  assert.match(text, /«03»\s*ноября 2026/);
  assert.match(text, /№__/);
  assert.ok(!text.includes('_____  2026'));
});

test('отправитель подставляется в строку «От» и в подпись', () => {
  const text = textOf(xmlOf(buildMemo(template, { ...memo, from: 'Павлова С. Н.', signer: 'Павлов С. Н.' })));
  assert.ok(text.includes('От Павлова С. Н.'));
  assert.ok(text.includes('Подпись ___________/ Павлов С. Н.'));
  assert.ok(!text.includes('От Семенова'));
  assert.ok(text.includes('Семенов И. А'), 'председатель ПЦК остаётся');
});

test('строка на каждого студента', () => {
  const xml = xmlOf(buildMemo(template, memo));
  const rows = xml.slice(xml.lastIndexOf('<w:tbl>')).match(/<w:tr>/g);
  assert.equal(rows.length, 6 + memo.students.length);
});

test('длинный список не ломает документ', () => {
  const many = { ...memo, students: Array.from({ length: 60 }, (_, i) => ({ name: `Студент $& ${i}`, group: '$1' })) };
  const text = textOf(xmlOf(buildMemo(template, many)));
  assert.ok(text.includes('Студент $&amp; 59'));
});
