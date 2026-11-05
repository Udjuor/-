// Переводы. Ключ — русская фраза: русский язык не нуждается в словаре, а код
// остаётся читаемым. Значения подставляются в {0}, {1}, поэтому перевод может
// менять порядок слов.
import en from './locales/en.mjs';
import es from './locales/es.mjs';
import ja from './locales/ja.mjs';
import ko from './locales/ko.mjs';
import zh from './locales/zh.mjs';

export const LANGUAGES = [
  ['ru', 'Русский'],
  ['en', 'English'],
  ['es', 'Español'],
  ['zh', '中文'],
  ['ja', '日本語'],
  ['ko', '한국어'],
];

const LOCALES = { ru: 'ru-RU', en: 'en-GB', es: 'es-ES', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' };
const DICTIONARIES = { en, es, zh, ja, ko };

const RU_PLURALS = {
  people: { one: '{n} участник', few: '{n} участника', many: '{n} участников', other: '{n} участника' },
  students: { one: '{n} студент', few: '{n} студента', many: '{n} студентов', other: '{n} студента' },
  days: { one: '{n} день', few: '{n} дня', many: '{n} дней', other: '{n} дня' },
  pairsHeld: { one: 'Проведена: {n} пара', few: 'Проведено: {n} пары', many: 'Проведено: {n} пар', other: 'Проведено: {n} пары' },
};

let current = globalThis.window?.calendar?.language ?? 'ru';

export const language = () => current;
export const locale = () => LOCALES[current];

/** Нужно тестам: в программе язык меняется перезагрузкой страницы. */
export function setLanguage(next) {
  current = next;
}

export function t(key, values = []) {
  const text = DICTIONARIES[current]?.strings?.[key] ?? key;
  return text.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
}

/** Фраза с числом: формы слова зависят от языка. */
export function tp(key, n) {
  const forms = current === 'ru' ? RU_PLURALS[key] : DICTIONARIES[current].plurals[key];
  const category = new Intl.PluralRules(locale()).select(n);
  return (forms[category] ?? forms.other).replace('{n}', String(n));
}

/** Переводит постоянные надписи из index.html. */
export function translatePage(root = document.body) {
  document.documentElement.lang = current;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (/[А-Яа-яЁё]/.test(text)) node.nodeValue = t(text);
  }
  for (const element of root.querySelectorAll('[aria-label]')) {
    element.setAttribute('aria-label', t(element.getAttribute('aria-label')));
  }
}
