// Праздничные скины: гирлянда под верхней строкой, лёгкое украшение и поздравление в бегущей строке.
// Только данные и расчёты: рисует их app.js.

/**
 * Скины. dates — дни в году «ММ-ДД», когда скин включается сам; greet — дни поздравления в бегущей строке.
 * shape — что висит на гирлянде, colors — цвета по очереди, wire — цвет провода или ленты.
 */
export const SKINS = [
  { id: 'newyear', name: 'Новый год', from: '12-20', to: '01-10', greet: ['12-31', '01-01'], shape: 'bulb', colors: ['#e5383b', '#2dc653', '#2f80ed'], wire: '#3a5a40', snow: true,
    greeting: '🎄 С Новым годом! Пусть новый год будет ярким, как эта гирлянда!' },
  { id: 'tatiana', name: 'Татьянин день', from: '01-24', to: '01-26', greet: ['01-25'], shape: 'cap', colors: ['#1d4ed8', '#f2c94c'], wire: '#6b7280',
    greeting: '🎓 С Днём российского студенчества и Татьяниным днём! Лёгкой сессии и ярких открытий!' },
  { id: 'valentine', name: 'День святого Валентина', from: '02-13', to: '02-14', greet: ['02-14'], shape: 'heart', colors: ['#e63946', '#ff7aa2', '#c9184a'], wire: '#b5838d',
    greeting: '💌 С Днём святого Валентина! Любите своё дело и друг друга!' },
  { id: 'defender', name: '23 февраля', from: '02-21', to: '02-23', greet: ['02-23'], shape: 'star', colors: ['#b91c1c', '#4d7c0f', '#d4a017'], wire: '#4b5320',
    greeting: '⭐ С Днём защитника Отечества! Мира, силы и уверенности в себе!' },
  { id: 'womensday', name: '8 Марта', from: '03-06', to: '03-08', greet: ['03-08'], shape: 'flower', colors: ['#ff6fae', '#ffd166', '#b388ff', '#ff8fab'], wire: '#6a994e',
    greeting: '🌷 С 8 Марта! Весны, улыбок и вдохновения всем нашим девушкам и женщинам!' },
  { id: 'cosmonautics', name: 'День космонавтики', from: '04-12', to: '04-12', greet: ['04-12'], shape: 'star', colors: ['#f2f2f2', '#7dd3fc', '#facc15'], wire: '#334155',
    greeting: '🚀 С Днём космонавтики! Поехали — к новым вершинам!' },
  { id: 'sakha', name: 'День Республики Саха (Якутия)', from: '04-25', to: '04-27', greet: ['04-27'], shape: 'sun', colors: ['#0072ce', '#ffffff', '#d52b1e', '#009a44'], wire: '#0072ce',
    greeting: '☀️ С Днём Республики Саха (Якутия)! Тепла, света и процветания родной земле!' },
  { id: 'victory', name: 'День Победы', from: '05-05', to: '05-09', greet: ['05-09'], shape: 'star', colors: ['#d62828', '#f77f00'], wire: 'ribbon',
    greeting: '🎖 С Днём Победы! Помним и гордимся.' },
  { id: 'russia', name: 'День России', from: '06-11', to: '06-12', greet: ['06-12'], shape: 'flag', colors: ['#ffffff', '#0039a6', '#d52b1e'], wire: '#8d99ae',
    greeting: '🇷🇺 С Днём России! Мира и добра нашей большой стране!' },
  { id: 'ysyakh', name: 'Ысыах', from: '06-20', to: '06-23', greet: ['06-21'], shape: 'sun', colors: ['#f4d03f', '#ffffff', '#2e8b57'], wire: '#2e8b57',
    greeting: '🌞 С праздником Ысыах! Встречаем солнце: здоровья, достатка и долгого светлого лета!' },
  { id: 'knowledge', name: 'День знаний', from: '08-30', to: '09-01', greet: ['09-01'], shape: 'leaf', colors: ['#f4a261', '#e76f51', '#e9c46a', '#2a9d8f'], wire: '#6c584c',
    greeting: '📚 С Днём знаний! Пусть учёба будет интересной, а новый год — успешным!' },
  { id: 'teacher', name: 'День учителя', from: '10-04', to: '10-05', greet: ['10-05'], shape: 'apple', colors: ['#d62828', '#f4a261', '#90be6d'], wire: '#6c584c',
    greeting: '🍎 С Днём учителя! Спасибо нашим преподавателям за знания, терпение и вдохновение!' },
];

export const SKIN_MODES = ['off', 'auto', ...SKINS.map((skin) => skin.id)];

/** Попадает ли день «ММ-ДД» в промежуток, который может переходить через Новый год. */
const within = (md, from, to) => (from <= to ? md >= from && md <= to : md >= from || md <= to);

/** Какой скин действует: выключено, выбранный вручную или праздник по дате. */
export function activeSkin(mode, iso) {
  if (!mode || mode === 'off') return null;
  if (mode !== 'auto') return SKINS.find((skin) => skin.id === mode) ?? null;
  const md = iso.slice(5, 10);
  return SKINS.find((skin) => within(md, skin.from, skin.to)) ?? null;
}

/** Поздравление в бегущей строке в сам праздник, если скин включён. */
export function holidayGreeting(mode, iso) {
  if (!mode || mode === 'off') return null;
  const md = iso.slice(5, 10);
  const skin = SKINS.find((item) => item.greet.includes(md));
  if (!skin) return null;
  // Выбран другой скин вручную — поздравление всё равно уместно.
  return { id: `holiday-${skin.id}`, text: skin.greeting };
}

/** Фигуры на гирлянде в рамке 24×28: верх фигуры — точка подвеса (12, 0). */
export const SHAPES = {
  bulb: 'M9 0h6v4H9z M12 4c-5 0-7 6-7 11 0 6 3 10 7 10s7-4 7-10c0-5-2-11-7-11z',
  heart: 'M12 26C4 19 1 15 1 10a5.5 5.5 0 0 1 11-2 5.5 5.5 0 0 1 11 2c0 5-3 9-11 16z',
  star: 'M12 2l3 7.5 8 .6-6.1 5.2 1.9 7.8L12 19l-6.8 4.1 1.9-7.8L1 10.1l8-.6z',
  flower: 'M12 26V15 M12 15c-4 0-7-3-7-7 2 1 4 1 5-1 1 2 1 2 2 2s1 0 2-2c1 2 3 2 5 1 0 4-3 7-7 7z',
  flag: 'M2 0h20L12 24z',
  sun: 'M12 6a7 7 0 1 0 0.01 0z M12 0v3 M12 25v3 M2 13H-1 M25 13h-3 M4.5 5.5l2 2 M19.5 5.5l-2 2 M4.5 20.5l2-2 M19.5 20.5l-2-2',
  cap: 'M0 9l12-6 12 6-12 6z M5 12v6c0 2 3 4 7 4s7-2 7-4v-6l-7 3.5z M22 10v8',
  leaf: 'M12 2C5 8 4 16 12 26c8-10 7-18 0-24z M12 4v21',
  apple: 'M12 7c-3-2-9-1-9 6 0 6 4 13 9 11 5 2 9-5 9-11 0-7-6-8-9-6z M12 7c0-3 1-5 3-6',
};

/**
 * Точки подвеса гирлянды по ширине экрана: провод провисает между ними.
 * Возвращает путь провода и центры фигур.
 */
export function garlandLayout(width, spacing = 64, sag = 14) {
  const count = Math.max(2, Math.round(width / spacing));
  const step = width / count;
  const points = [];
  let path = `M0 2`;
  for (let i = 0; i < count; i += 1) {
    const x0 = i * step;
    const x1 = (i + 1) * step;
    path += ` Q${(x0 + x1) / 2} ${2 + sag * 2} ${x1} 2`;
    points.push({ x: (x0 + x1) / 2, y: 2 + sag });
  }
  return { path, points };
}
