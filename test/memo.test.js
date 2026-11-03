'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildMemo, readZip, writeZip } = require('../src/main/memo');

const template = fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'memo-template.docx'));
const memo = {
  day: '03', month: 'ноября', year: '2026', title: 'Концерт <к Дню матери> & репетиция', when: '5 ноября 2026, 11:00',
  release: '11:00–14:30', place: 'Актовый зал', responsible: 'Павлов С. Н.',
  students: [{ name: 'Иванова Анна', group: 'ИС-21' }, { name: 'Петров Пётр', group: 'ПИ-22' }, { name: 'Гость', group: '' }],
};
const xmlOf = (buffer) => readZip(buffer).find((e) => e.name === 'word/document.xml').data.toString('utf8');
const textOf = (xml) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');

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
