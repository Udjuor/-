import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LANGUAGES, language, locale, setLanguage, t, tp } from '../src/renderer/i18n.mjs';
import { ABSENCE_REASONS, EVENT_TYPES, JOURNAL_ACTIONS, JOURNAL_FIELD_LABELS, OWN_CAMERA, statusName } from '../src/renderer/logic.mjs';

const read = (file) => fs.readFileSync(new URL(`../src/renderer/${file}`, import.meta.url), 'utf8');
const app = read('app.js');
const page = read('index.html') + read('splash.html');
const unescape = (text) => text.replace(/\\\\/g, '\\').replace(/\\'/g, "'");

const usedKeys = () => {
  const keys = new Set([...app.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1])));
  const body = page.replace(/<head>.*?<\/head>/gs, '');
  for (const m of body.matchAll(/>([^<>]*[А-Яа-яЁё][^<>]*)</g)) keys.add(m[1].trim());
  for (const m of body.matchAll(/aria-label="([^"]*[А-Яа-яЁё][^"]*)"/g)) keys.add(m[1]);
  for (const [, label] of [...EVENT_TYPES, ...ABSENCE_REASONS]) keys.add(label);
  for (const status of ['present', 'late', 'sick', 'order', 'excused', 'absent', 'pending']) keys.add(statusName(status));
  keys.add(OWN_CAMERA);
  for (const label of [...Object.values(JOURNAL_FIELD_LABELS), ...Object.values(JOURNAL_ACTIONS)]) keys.add(label);
  keys.add('Без группы');
  return [...keys];
};

const others = LANGUAGES.map(([code]) => code).filter((code) => code !== 'ru');

test('все фразы переведены на все языки', async () => {
  for (const code of others) {
    const { default: dictionary } = await import(`../src/renderer/locales/${code}.mjs`);
    const missing = usedKeys().filter((key) => !dictionary.strings[key]);
    assert.deepEqual(missing, [], code);
  }
});

test('подстановки в переводах совпадают с исходной фразой', async () => {
  const slots = (text) => [...text.matchAll(/\{\d\}/g)].map((m) => m[0]).sort();
  for (const code of others) {
    const { default: dictionary } = await import(`../src/renderer/locales/${code}.mjs`);
    for (const [key, value] of Object.entries(dictionary.strings)) assert.deepEqual(slots(value), slots(key), `${code}: ${key}`);
  }
});

test('в переводах не осталось кириллицы, кроме имени папки на диске', async () => {
  for (const code of others) {
    const { default: dictionary } = await import(`../src/renderer/locales/${code}.mjs`);
    for (const [key, value] of Object.entries(dictionary.strings)) {
      const text = value.replace('Служебные записки', '');
      assert.ok(!/[А-Яа-яЁё]/.test(text), `${code}: ${key}`);
    }
  }
});

test('в коде интерфейса нет русских строк мимо перевода', () => {
  const code = app.split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n')
    .replace(/\/\/ .*$/gm, '').replace(/\/\*.*?\*\//g, '').replace(/\bt\('(?:[^'\\]|\\.)*'/g, '').replace(/\/ г\\\.\$\//g, '');
  assert.deepEqual(code.match(/.*[А-Яа-яЁё].*/g) ?? [], []);
});

test('множественные числа и подстановки', () => {
  assert.equal(tp('people', 1), '1 участник');
  assert.equal(tp('people', 3), '3 участника');
  assert.equal(tp('people', 5), '5 участников');
  setLanguage('en');
  assert.equal(language(), 'en');
  assert.equal(locale(), 'en-GB');
  assert.equal(tp('people', 1), '1 participant');
  assert.equal(tp('people', 3), '3 participants');
  assert.equal(t('Здоровье {0} из 100', [70]), 'Health 70 of 100');
  setLanguage('ja');
  assert.equal(tp('students', 2), '学生 2 名');
  assert.equal(t('Несуществующая фраза'), 'Несуществующая фраза');
  setLanguage('ru');
  assert.equal(t('Здоровье {0} из 100', [70]), 'Здоровье 70 из 100');
});
