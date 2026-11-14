// Сквозная проверка настоящего приложения: запускает его, проходит основные
// сценарии и сохраняет снимки экрана в папку SHOTS (по умолчанию ./shots).
// Запуск: CAL_EXE=<путь к electron или установленной программе> node scripts/e2e.cjs
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore } = require('../src/main/store');
const { SyncNode } = require('../src/main/sync');

const shots = path.resolve(process.env.SHOTS || 'shots');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-e2e-'));
const eventsDir = path.join(home, 'data', 'events');
// Записи без журнала изменений: он лежит в той же папке.
const dataFiles = () => fs.readdirSync(eventsDir).filter((name) => !JSON.parse(fs.readFileSync(path.join(eventsDir, name), 'utf8')).kind?.startsWith('change')).length;
fs.mkdirSync(eventsDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });

// Настройки «аудиторного» устройства и второе устройство сети, «компьютер преподавателя».
const NETWORK_KEY = 'E2E00-E2E00-E2E00-E2E00';
const deviceId = crypto.randomUUID();
fs.writeFileSync(path.join(home, 'config.ini'), [
  '[calendar]', `deviceId=${deviceId}`, 'deviceName=Ауд. 204', `syncKey=${NETWORK_KEY}`, 'peers=127.0.0.1:47811', '',
].join('\r\n'));
const teacherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-e2e-teacher-'));
const teacherId = crypto.randomUUID();
const teacherStore = new EventStore(teacherDir, teacherId, { clock: () => new Date(2026, 10, 3, 9, 5).getTime() });
const teacher = new SyncNode({
  store: teacherStore,
  device: { id: teacherId, name: 'Кабинет преподавателя' },
  networkKey: NETWORK_KEY,
  peers: ['127.0.0.1:47800'],
  port: 47811,
  discoveryPort: 47812,
  discoveryTargets: [],
  timers: false,
});
const until = async (check, what) => {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Не дождались: ${what}`);
};

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const base = new Date(2026, 10, 3); // вторник
const day = (offset) => iso(new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset));

function seed(offset, start, end, title, extra = {}) {
  const event = {
    id: crypto.randomUUID(), title, date: day(offset), start, end, place: '', responsible: '',
    participants: [], equipment: [], notes: '', updatedAt: '2026-11-01T00:00:00.000Z', ...extra,
  };
  fs.writeFileSync(path.join(eventsDir, `${event.id}.json`), JSON.stringify(event));
  return event;
}

const group = ['Алексеева Мария', 'Борисов Илья', 'Васильева Дарья', 'Григорьев Павел', 'Данилова София', 'Егоров Тимур'];
seed(0, '09:00', '10:30', 'Подготовка к олимпиаде', { type: 'lesson', place: 'Ауд. 204', responsible: 'Лебедева О. В.', participants: group, equipment: ['Проектор'] });
seed(0, '11:00', '12:30', 'Волонтёры дня открытых дверей', { place: 'Актовый зал', responsible: 'Павлов С. Н.', participants: group.slice(0, 4), equipment: ['Микрофон', 'Ноутбук', 'Колонки'] });
seed(0, '11:30', '13:00', 'Репетиция хора', { type: 'practice', place: 'Ауд. 101', responsible: 'Иванова Е. А.', participants: group.slice(4) });
seed(1, '14:00', '16:00', 'Студенческий совет', { place: 'Ауд. 305', responsible: 'Павлов С. Н.', participants: group.slice(1, 3) });
seed(2, '10:00', '12:00', 'Шахматный турнир', { type: 'task', place: 'Холл', participants: group });
seed(-1, '13:00', '14:30', 'Встреча с работодателем', { place: 'Ауд. 210' });
seed(3, '09:30', '11:00', 'Экскурсия в музей');
for (let i = 0; i < 6; i += 1) seed(9, `${pad(9 + i)}:00`, `${pad(10 + i)}:00`, `Секция ${i + 1}`);

const page_shot = (target, name) => target.screenshot({ path: path.join(shots, `${name}.png`) });

(async () => {
  await teacher.start();
  const app = await _electron.launch({
    executablePath: process.env.CAL_EXE,
    args: (process.env.CAL_ARGS || '').split(' ').filter(Boolean),
    env: { ...process.env, KERDIIS_HOME: home, KERDIIS_CLOCK: new Date(2026, 10, 3, 9, 2).toISOString(), KERDIIS_PORTAL_PORT: '47890' },
  });
  const errors = [];
  // Панель-визитка: отдельное небольшое окно, потом главное.
  const startedAt = Date.now();
  const opened = (name) => app.windows().find((w) => w.url().endsWith(name));
  await app.firstWindow();
  await until(() => opened('splash.html') && opened('index.html'), 'окна программы');
  const splash = opened('splash.html');
  await splash.waitForSelector('#splash-logo .petsprite');
  await splash.waitForFunction(() => document.getElementById('splash-version').textContent);
  assert.match(await splash.textContent('body'), /Kerdi:s[\s\S]*Время для того, что важно![\s\S]*Автор: Udjuor[\s\S]*Версия \d+\.\d+\.\d+/);
  const sizes = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ size: w.getSize(), visible: w.isVisible(), top: w.isAlwaysOnTop() })));
  const card = sizes.find((w) => w.top);
  assert.ok(card.visible && card.size[0] === 640 && card.size[1] === 360, 'небольшое окно');
  assert.equal(sizes.filter((w) => w.visible).length, 1, 'главное окно ждёт панель');
  await page_shot(splash, 'splash');
  await until(async () => (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1, 'закрытие панели');
  assert.ok(Date.now() - startedAt >= 3500, 'панель держится несколько секунд');
  await until(async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), 'показ главного окна');
  const page = opened('index.html');
  assert.equal(await page.title(), 'Kerdiis');
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Playwright по умолчанию подменяет тему страницы, а нужна настоящая тема программы.
  await page.emulateMedia({ colorScheme: null });
  await page.clock.setFixedTime(new Date(2026, 10, 3, 11, 42));
  await page.reload();
  await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
  // Редкие разделы спрятаны в меню «Разделы».
  const openSection = async (selector) => {
    await page.click('#open-sections');
    await page.click(selector);
    await page.waitForSelector('#sections:not(:popover-open)', { state: 'attached' });
  };
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

  await page.locator('.block').first().waitFor();
  assert.equal(await page.locator('.block').count(), 7, 'неделя показывает свои мероприятия');
  assert.match(await page.textContent('#title'), /2–8 ноября 2026/);
  await shot('week');

  await page.click('[data-view=day]');
  assert.match(await page.textContent('#title'), /Вторник, 3 ноября/);
  assert.equal(await page.locator('.block').count(), 3);
  assert.equal(await page.locator('.block.now').count(), 2);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.block')].every((b) => b.scrollHeight <= b.clientHeight + 1)), 'текст блоков не обрезается');
  await shot('day');

  await page.click('[data-view=month]');
  assert.match(await page.textContent('#title'), /^Ноябрь 2026$/);
  assert.equal(await page.locator('.more').count() >= 1, true, 'лишние мероприятия свёрнуты');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.cell')].every((c) => c.scrollHeight <= c.clientHeight + 1)), 'содержимое ячеек месяца помещается');
  await shot('month');

  await page.click('[data-view=week]');
  await page.click('#add');
  await page.click('dialog#form button[type=submit]');
  assert.equal(await page.locator('dialog#form .error').first().textContent(), 'Укажите название');

  await page.fill('#f-title', 'Субботник');
  await page.fill('#f-date', day(0));
  await page.fill('#f-start', '10:00');
  await page.fill('#f-end', '09:00');
  await page.click('dialog#form button[type=submit]');
  assert.ok(await page.locator('text=Окончание должно быть позже начала').isVisible());
  await page.fill('#f-end', '11:30');
  assert.equal(await page.locator('text=Окончание должно быть позже начала').count(), 0, 'ошибка исчезает после исправления');
  await page.fill('#f-place', 'Двор');
  await page.fill('#f-responsible', 'Семёнова А. Р.');
  await page.focus('#f-participants');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text', 'Алексеева Мария\r\nНовиков Роман\nОрлова Вера\n');
    document.getElementById('f-participants').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  assert.equal(await page.locator('#form .tag').count(), 3, 'список из таблицы разобран по строкам');
  await page.locator('.conflicts').waitFor();
  assert.match(await page.textContent('.conflicts'), /Алексеева Мария: Подготовка к олимпиаде, 09:00–10:30/);
  await page.fill('#f-equipment', 'Проектор');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#form .tag').count(), 4);
  assert.match(await page.textContent('.conflicts'), /Проектор/);
  await shot('form');

  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  assert.equal(dataFiles(), 14, 'мероприятие записано в папку');

  await page.click('.block:has-text("Субботник")');
  assert.ok(await page.locator('#details >> text=Семёнова А. Р.').isVisible());
  assert.ok(await page.locator('#details li:has-text("Новиков Роман")').isVisible());
  await shot('details');

  await page.click('#details >> text=Изменить');
  await page.fill('#f-title', 'Субботник у корпуса');
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  assert.ok(await page.locator('.block:has-text("Субботник у корпуса")').isVisible());

  await page.click('.block:has-text("Субботник у корпуса")');
  await page.click('#details .plain:has-text("Удалить")');
  await page.click('#details .danger');
  await page.waitForSelector('dialog#details', { state: 'hidden' });
  assert.equal(await page.locator('.block:has-text("Субботник")').count(), 0);
  assert.equal(dataFiles(), 14, 'удаление записано отметкой для других устройств');

  // Обмен: компьютер преподавателя получил всё и появился в списке устройств.
  await until(async () => (await teacherStore.list()).length === 13, 'обмен с компьютером преподавателя');
  assert.equal((await teacherStore.list()).some((e) => e.title.includes('Субботник')), false, 'удаление дошло');

  // С компьютера преподавателя мероприятие адресовано этой аудитории.
  const forRoom = await teacherStore.save({ title: 'Для аудитории 204', date: day(0), start: '16:00', end: '17:00', devices: [deviceId] });
  await teacherStore.save({ title: 'Для другой аудитории', date: day(0), start: '17:00', end: '18:00', devices: ['00000000-0000-4000-8000-000000000000'] });
  await teacher.syncWith('127.0.0.1:47800');
  await page.waitForSelector('.block:has-text("Для аудитории 204")', { timeout: 15000 });
  assert.equal(await page.locator('.block:has-text("Для другой аудитории")').count(), 0, 'чужое мероприятие не показывается');

  // Правка и удаление с другого устройства.
  const renamed = await teacherStore.save({ ...forRoom, title: 'Перенесено в 204' }, forRoom.updatedAt);
  await teacher.syncWith('127.0.0.1:47800');
  await page.waitForSelector('.block:has-text("Перенесено в 204")', { timeout: 15000 });
  await teacherStore.remove(renamed.id, renamed.updatedAt);
  await teacher.syncWith('127.0.0.1:47800');
  await page.waitForSelector('.block:has-text("Перенесено в 204")', { state: 'detached', timeout: 15000 });

  // Отсюда мероприятие адресовано компьютеру преподавателя.
  await page.click('#add');
  await page.fill('#f-title', 'На компьютер преподавателя');
  await page.fill('#f-date', day(0));
  await page.fill('#f-start', '18:00');
  await page.fill('#f-end', '19:00');
  await page.click('.targets button:has-text("Кабинет преподавателя")');
  assert.equal(await page.getAttribute('.targets button:has-text("Все устройства")', 'aria-pressed'), 'false');
  await shot('form-targets');
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  assert.match(await page.textContent('#toast'), /отправлено: Кабинет преподавателя/);
  assert.equal(await page.locator('.block:has-text("На компьютер преподавателя")').count(), 0, 'здесь не показывается');
  await until(async () => (await teacherStore.list()).some((e) => e.title === 'На компьютер преподавателя'), 'отправка на другое устройство');

  // Справочники: заполнение, вставка столбца, выбор в мероприятии, обмен.
  const paste = (selector, text) => page.evaluate(([sel, value]) => {
    const data = new DataTransfer();
    data.setData('text', value);
    document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [selector, text]);
  await openSection('#open-catalog');
  await page.fill('#c-add-group', 'ИС-21');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#catalog .refname:has-text("ИС-21")');
  await page.fill('#c-add-group', 'ПИ-22');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#catalog .refname:has-text("ПИ-22")');
  await page.click('#catalog .refname:has-text("ИС-21")');
  await paste('#c-add-student', 'Алексеева\tМария\r\nБорисов Илья\nВасильева Дарья\n');
  await page.waitForSelector('#catalog li:has-text("Васильева Дарья")');
  assert.equal(await page.locator('#catalog .catalogcols section:nth-child(2) .refrow').count(), 3, 'столбец из таблицы разобран');
  await page.fill('#c-add-student', 'Борисов Илья');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#catalog .notice:has-text("Уже есть в списке: Борисов Илья")');
  assert.equal(await page.locator('#catalog .catalogcols section:nth-child(2) .refrow').count(), 3, 'повтор не добавлен');
  await shot('catalog');

  await page.click('#catalog .tabs >> text=Техника');
  await paste('#c-add-equipment', 'Проектор\nМикрофон\n');
  await page.waitForSelector('#catalog li:has-text("Микрофон")');
  await page.click('#catalog .tabs >> text=Преподаватели');
  await page.fill('#c-add-teacher', 'Лебедева О. В.');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#catalog li:has-text("Лебедева О. В.")');
  await page.click('#catalog li:has-text("Лебедева О. В.") >> text=Изменить');
  await page.fill('#c-edit', 'Лебедева Ольга Викторовна');
  await page.click('#catalog .refrow.editing >> text=Сохранить');
  await page.waitForSelector('#catalog li:has-text("Лебедева Ольга Викторовна")');
  await page.click('#catalog [aria-label=Закрыть]');

  await page.click('#add');
  await page.waitForSelector('#form[open]');
  await page.fill('#f-title', 'Из справочников');
  await page.fill('#f-date', day(0));
  await page.fill('#f-start', '09:30');
  await page.fill('#f-end', '10:00');
  await page.click('#form .field:has(#f-responsible) >> text=Из списка');
  await page.click('#picker .pickrow:has-text("Лебедева Ольга Викторовна")');
  await page.waitForSelector('#picker', { state: 'hidden' });
  assert.equal(await page.inputValue('#f-responsible'), 'Лебедева Ольга Викторовна');

  await page.fill('#f-participants', 'Гость Вручную');
  await page.keyboard.press('Enter');
  await page.click('#form .field:has(#f-participants) >> text=Из списка');
  await page.click('#picker .pickgroup:has-text("ИС-21") >> text=Всю группу');
  assert.match(await page.textContent('#picker .sheetfoot .primary'), /выбрано 3/);
  await page.click('#picker .grouptoggle:has-text("ИС-21")');
  assert.match(await page.textContent('#picker .pickrow:has-text("Алексеева Мария")'), /Занято: Подготовка к олимпиаде/, 'занятые отмечены');
  await page.fill('#p-search', 'борис');
  assert.equal(await page.locator('#picker .pickrow').count(), 1, 'поиск');
  await page.click('#picker .pickrow:has-text("Борисов Илья")');
  await shot('picker');
  await page.click('#picker .sheetfoot .primary');
  await page.waitForSelector('#picker', { state: 'hidden' });
  const tags = await page.locator('.field:has(#f-participants) .tag').allTextContents();
  assert.equal(tags.length, 3, 'группа без снятого студента и участник, введённый вручную');
  assert.ok(tags.some((t) => t.includes('Гость Вручную')), 'ручной участник сохранён');
  assert.ok(!tags.some((t) => t.includes('Борисов Илья')), 'снятый студент убран');

  await page.click('#form .field:has(#f-equipment) >> text=Из списка');
  await page.click('#picker [aria-label="Больше: Проектор"]');
  await page.click('#picker .sheetfoot .primary');
  await page.waitForSelector('#picker', { state: 'hidden' });
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  await until(async () => (await teacherStore.list()).some((e) => e.title === 'Из справочников' && e.equipment[0] === 'Проектор'), 'мероприятие из справочников на другом устройстве');
  await until(async () => (await teacherStore.directory()).length === 8, 'справочники на другом устройстве');

  // Студент, добавленный на другом устройстве, и удаление группы.
  const group = (await teacherStore.directory()).find((r) => r.name === 'ПИ-22');
  await teacherStore.saveRef({ kind: 'student', name: 'Новиков Роман', groupId: group.id });
  await teacher.syncWith('127.0.0.1:47800');
  await openSection('#open-catalog');
  await page.click('#catalog .tabs >> text=Группы и студенты');
  await page.click('#catalog .refname:has-text("ПИ-22")');
  await page.waitForSelector('#catalog li:has-text("Новиков Роман")', { timeout: 15000 });
  await page.click('#catalog .catalogcols section:first-child li:has-text("ПИ-22") >> text=Удалить');
  await page.waitForSelector('#catalog .refrow:has-text("Удалить группу и студентов: 1?")');
  await page.click('#catalog .refrow .danger');
  await page.waitForSelector('#catalog .refname:has-text("ПИ-22")', { state: 'detached' });
  await page.click('#catalog [aria-label=Закрыть]');
  await until(async () => !(await teacherStore.directory()).some((r) => r.name === 'ПИ-22' || r.name === 'Новиков Роман'), 'удаление группы на другом устройстве');

  // Свои подсказки при вводе: длинный список прокручивается.
  await openSection('#open-catalog');
  await page.click('#catalog .tabs >> text=Группы и студенты');
  await page.click('#catalog .refname:has-text("ИС-21")');
  await paste('#c-add-student', Array.from({ length: 40 }, (_, i) => `Тестов Ученик${i}`).join('\n') + '\n');
  await page.waitForSelector('#catalog li:has-text("Тестов Ученик39")');

  // Действия в длинном списке не сбрасывают его на начало.
  const catalogBody = '#catalog .sheetbody';
  await page.evaluate((box) => { document.querySelector(box).scrollTop = 500; }, catalogBody);
  await page.click('#catalog li:has-text("Тестов Ученик20") .owntoggle');
  await page.waitForSelector('#catalog li:has-text("Тестов Ученик20") .owntoggle[aria-pressed=true]');
  const kept = await page.evaluate((box) => document.querySelector(box).scrollTop, catalogBody);
  assert.ok(kept > 300, `список остался на месте: ${kept}`);
  await page.click('#catalog li:has-text("Тестов Ученик20") >> text=Изменить');
  assert.ok(await page.evaluate((box) => document.querySelector(box).scrollTop, catalogBody) > 300, 'изменение не сбрасывает список');
  await page.click('#catalog .refrow.editing >> text=Отмена');
  await page.click('#catalog li:has-text("Тестов Ученик20") .owntoggle');
  await page.waitForSelector('#catalog li:has-text("Тестов Ученик20") .owntoggle[aria-pressed=false]');
  await page.evaluate((box) => { document.querySelector(box).scrollTop = 0; }, catalogBody);

  // Своя камера студента и лимит техники.
  await page.click('#catalog li:has-text("Алексеева Мария") .owntoggle');
  await page.waitForSelector('#catalog li:has-text("Алексеева Мария") .owntoggle[aria-pressed=true]');
  await page.click('#catalog .tabs >> text=Техника');
  await page.fill('#c-add-equipment', 'Камера');
  await page.fill('#c-add-qty', '2');
  await page.keyboard.press('Tab');
  await page.click('#catalog .adder button:has-text("Добавить")');
  await page.waitForSelector('#catalog li:has-text("Камера"):has-text("2 шт.")');
  await shot('catalog-equipment');
  await page.click('#catalog [aria-label=Закрыть]');

  const fillEvent = async (title) => {
    await page.click('#add');
    await page.waitForSelector('#form[open]');
    await page.fill('#f-title', title);
    await page.fill('#f-date', day(7));
    await page.fill('#f-start', '10:00');
    await page.fill('#f-end', '11:00');
  };
  await fillEvent('Съёмка');
  await page.fill('#f-participants', 'Тестов');
  await page.waitForSelector('#form .suggest button:has-text("Тестов Ученик9")');
  const hints = await page.locator('#form .suggest:not([hidden])').evaluate((box) => {
    const before = box.scrollTop;
    box.scrollTop = 500;
    return { client: box.clientHeight, scroll: box.scrollHeight, moved: box.scrollTop - before };
  });
  assert.ok(hints.scroll > hints.client && hints.moved > 0, 'подсказки прокручиваются');
  await page.click('#form .suggest button:has-text("Тестов Ученик9")');
  assert.equal(await page.inputValue('#f-participants'), '');
  await page.click('#form .field:has(#f-participants) >> text=Из списка');
  assert.match(await page.textContent('#picker .pickall'), /Всех студентов: 43/);
  await page.click('#picker .pickall');
  assert.match(await page.textContent('#picker .sheetfoot .primary'), /выбрано 43/);
  await page.click('#picker .pickall');
  assert.match(await page.textContent('#picker .sheetfoot .primary'), /выбрано 0/);
  await page.click('#picker .pickgroup:has-text("ИС-21") >> text=Всю группу');
  await page.click('#picker .sheetfoot .primary');
  await page.waitForSelector('#form .ownbox:has-text("Алексеева Мария")');
  await page.click('#form .field:has(#f-equipment) >> text=Из списка');
  assert.match(await page.textContent('#picker .qtyrow:has-text("Камера")'), /Свободно 2 из 2/);
  await page.evaluate(() => { document.querySelector('#picker .qtyrow').dataset.same = '1'; });
  await page.click('#picker [aria-label="Больше: Камера"]');
  await page.click('#picker [aria-label="Больше: Камера"]');
  assert.equal(await page.getAttribute('#picker .qtyrow', 'data-same'), '1', 'строки не пересоздаются');
  assert.equal(await page.isDisabled('#picker [aria-label="Больше: Камера"]'), true, 'больше лимита не выбрать');
  await page.fill('#p-search', 'микро');
  assert.equal(await page.locator('#picker .qtyrow:visible').count(), 1, 'поиск по названию техники');
  assert.ok(await page.locator('#picker .qtyrow:has-text("Микрофон")').isVisible());
  await page.fill('#p-search', 'нет такого');
  assert.ok(await page.locator('#picker >> text=Ничего не найдено.').isVisible());
  await page.fill('#p-search', '');
  assert.equal(await page.textContent('#picker [aria-label="Выбрано: Камера"]'), '2', 'поиск не сбрасывает количество');
  await shot('stock-picker');
  await page.click('#picker .sheetfoot .primary');
  await page.waitForSelector('#form .tag:has-text("Камера × 2")');
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  const filmed = async () => (await teacherStore.list()).find((e) => e.title === 'Съёмка');
  await until(async () => (await filmed())?.equipmentQty?.['Камера'] === 2, 'количество техники на другом устройстве');
  assert.ok((await filmed()).equipment.includes('Своя камера'), 'своя камера в списке техники');
  assert.deepEqual((await filmed()).ownCameras, ['Алексеева Мария']);

  await fillEvent('Вторая съёмка');
  await page.click('#form .field:has(#f-equipment) >> text=Из списка');
  assert.match(await page.textContent('#picker .qtyrow:has-text("Камера")'), /Свободно 0 из 2/);
  assert.equal(await page.isDisabled('#picker [aria-label="Больше: Камера"]'), true, 'все камеры заняты');
  await page.click('#picker .sheetfoot .primary');
  await page.fill('#f-equipment', 'Камера');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#form .conflicts:has-text("нужно 1, свободно 0 из 2")');
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('#form .message:has-text("Не хватает: Камера")');
  await page.fill('#f-start', '12:00');
  await page.fill('#f-end', '13:00');
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });

  // Темы: переключение сразу, настройка не теряется.
  const canvas = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(await canvas(), 'rgb(13, 17, 23)');
  await page.click('#theme');
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)');
  assert.match(fs.readFileSync(path.join(home, 'config.ini'), 'utf8'), /theme=light/);
  await page.click('#today');
  await page.click('[data-view=week]');
  await shot('light-week');
  await page.click('.block:has-text("Подготовка к олимпиаде")');
  await shot('light-details');
  await page.click('#details [aria-label=Закрыть]');
  await page.click('#add');
  await page.waitForSelector('#form[open]');
  await shot('light-form');
  await page.click('#form [aria-label=Закрыть]');
  await page.click('[data-view=month]');
  await shot('light-month');
  await page.click('[data-view=day]');
  await page.click('#settings');
  await page.waitForSelector('#preferences[open]');
  await page.click('#preferences .targets button:has-text("Тёмная")');
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(13, 17, 23)');
  // Поддержать проект: QR-код СБП в настройках.
  await page.click('#open-donate');
  await page.waitForSelector('#donate[open] svg.qr');
  await shot('donate');
  await page.click('#donate [aria-label=Закрыть]');
  await page.click('#preferences [aria-label=Закрыть]');

  // Выбор языка сохраняется и перезапускает программу.
  await app.evaluate(({ app: electronApp }) => {
    electronApp.relaunch = () => { globalThis.relaunched = true; };
    electronApp.exit = () => {};
  });
  await page.click('#settings');
  await page.waitForSelector('#preferences[open]');
  assert.equal(await page.locator('#preferences .langs button').count(), 7);
  const langWidths = await page.locator('#preferences .langs button').evaluateAll((all) => all.map((b) => Math.round(b.getBoundingClientRect().width)));
  assert.equal(new Set(langWidths).size, 1, 'кнопки языка одного размера');
  await shot('settings-langs');
  await page.click('#preferences .langs button[aria-label="日本語"]');
  await until(async () => app.evaluate(() => globalThis.relaunched === true), 'перезапуск при смене языка');
  assert.match(fs.readFileSync(path.join(home, 'config.ini'), 'utf8'), /lang=ja/);
  await page.click('#preferences .langs button[aria-label="Русский"]');
  await until(() => /lang=ru/.test(fs.readFileSync(path.join(home, 'config.ini'), 'utf8')), 'возврат языка');
  await page.click('#preferences [aria-label=Закрыть]');

  // Размер интерфейса.
  await page.click('#settings');
  await page.waitForSelector('#preferences[open]');
  const rootSize = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const medium = await rootSize();
  await page.click('#preferences .targets button:has-text("Крупный")');
  await page.waitForFunction((m) => parseFloat(getComputedStyle(document.documentElement).fontSize) > m, medium);
  assert.match(fs.readFileSync(path.join(home, 'config.ini'), 'utf8'), /uiSize=large/);
  await page.click('#preferences .targets button:has-text("Мелкий")');
  await page.waitForFunction((m) => parseFloat(getComputedStyle(document.documentElement).fontSize) <= m, medium);
  await page.click('#preferences .targets button:has-text("Обычный")');
  await page.click('#preferences [aria-label=Закрыть]');

  // Техническое задание по событию: чек-лист и PDF.
  await page.click('#today');
  await page.click('[data-view=day]');
  await page.click('.block:has-text("Волонтёры дня открытых дверей")');
  await page.click('#details >> text=Тех. задание');
  await page.waitForSelector('#paper[open]');
  const sheet = page.locator('#paper .paper');
  assert.match(await sheet.textContent(), /Техническое задание на 3 ноября 2026/);
  assert.equal(await sheet.locator('tbody tr').count(), 3, 'строка на каждую единицу техники');
  assert.equal(await sheet.locator('tbody .box').count(), 9, 'отметки подготовки, выдачи и возврата');
  assert.equal(await sheet.locator('.people li').count(), 4, 'участники списком');
  await shot('paper');
  const pdf = path.join(home, 'task.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdf);
  await page.click('#paper >> text=Сохранить PDF');
  await until(() => fs.existsSync(pdf) && fs.statSync(pdf).size > 1000, 'файл PDF');
  await page.waitForSelector('#toast:has-text("PDF сохранён")');
  assert.equal(fs.readFileSync(pdf).subarray(0, 4).toString(), '%PDF');
  if (process.env.PDF_COPY) fs.copyFileSync(pdf, process.env.PDF_COPY);
  // Кнопка «Печать» передаёт в Windows именно этот лист.
  await app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    window.webContents.print = (options, done) => { globalThis.printCalls = (globalThis.printCalls ?? 0) + 1; done(true, ''); };
  });
  await page.click('#paper .sheetfoot >> text=Печать');
  await until(async () => (await app.evaluate(() => globalThis.printCalls ?? 0)) === 1, 'печать технического задания');
  assert.match(await page.textContent('#printarea'), /Волонтёры дня открытых дверей/);
  await page.click('#paper [aria-label=Закрыть]');

  // Типы событий различаются цветом, новое занятие выбирается в форме.
  await page.click('[data-view=week]');
  assert.equal(await page.locator('.block.t-lesson').count(), 2, 'занятия');
  assert.equal(await page.locator('.block.t-practice').count(), 1, 'практика');
  assert.equal(await page.locator('.block.t-task').count(), 1, 'задание');
  await shot('week');
  await page.click('[data-view=month]');
  await shot('month');
  await page.click('[data-view=day]');
  await shot('day');
  const lessonColor = await page.locator('.block.t-lesson').first().evaluate((el) => getComputedStyle(el).borderLeftColor);
  const practiceColor = await page.locator('.block.t-practice').first().evaluate((el) => getComputedStyle(el).borderLeftColor);
  assert.notEqual(lessonColor, practiceColor, 'цвета типов различаются');

  await page.click('#add');
  await page.waitForSelector('#form[open]');
  await page.fill('#f-title', 'Практика по сетям');
  await page.fill('#f-date', day(0));
  await page.fill('#f-start', '13:00');
  await page.fill('#f-end', '13:30');
  await page.click('#form .targets button:has-text("Практика")');
  await shot('form-type');
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  await page.waitForSelector('.block.t-practice:has-text("Практика по сетям")');
  await until(async () => (await teacherStore.list()).some((e) => e.title === 'Практика по сетям' && e.type === 'practice'), 'тип события на другом устройстве');

  // Отметка: студент отмечается, преподаватель указывает причины.
  await page.click('.block:has-text("Подготовка к олимпиаде")');
  await page.click('#details >> text=Отметка: 0 из 6');
  await page.waitForSelector('#roll[open]');
  await page.click('.rollrow:has-text("Алексеева Мария") .rollname');
  await page.waitForSelector('.rollrow:has-text("Алексеева Мария") .rollname[aria-pressed=true]');
  assert.match(await page.textContent('.rollrow:has-text("Алексеева Мария")'), /Отмечен в \d\d:\d\d/);
  await page.click('.rollrow:has-text("Борисов Илья") .rollname');
  await page.waitForSelector('.rollrow:has-text("Борисов Илья") .rollname[aria-pressed=true]');
  await page.click('.rollrow:has-text("Васильева Дарья") .reason:has-text("Болезнь")');
  await page.waitForSelector('.rollrow:has-text("Васильева Дарья") .reason[aria-pressed=true]');
  await page.click('.rollrow:has-text("Григорьев Павел") .reason:has-text("По приказу")');
  await page.waitForSelector('.rollrow:has-text("Григорьев Павел") .reason[aria-pressed=true]');
  await page.click('.rollrow:has-text("Данилова София") .reason:has-text("Уважительная")');
  await page.waitForSelector('.rollrow:has-text("Данилова София") .reason[aria-pressed=true]');
  await page.click('.rollrow:has-text("Борисов Илья") .rollname');
  await page.waitForSelector('.rollrow:has-text("Борисов Илья") .rollname[aria-pressed=false]');
  await page.waitForSelector('.rollsummary:has-text("Отмечены: 1 из 6")');
  await shot('roll');
  await until(async () => {
    const [doc] = await teacherStore.attendance();
    return doc?.marks['Данилова София']?.status === 'excused' && doc.marks['Алексеева Мария'].status === 'present';
  }, 'отметки на другом устройстве');

  // Отметка с другого устройства появляется на открытом экране.
  const seeded = (await teacherStore.list()).find((e) => e.title === 'Подготовка к олимпиаде');
  await teacherStore.saveMark(seeded.id, 'Егоров Тимур', 'present');
  await teacher.syncWith('127.0.0.1:47800');
  await page.waitForSelector('.rollrow:has-text("Егоров Тимур") .rollname[aria-pressed=true]', { timeout: 15000 });
  await page.click('#roll [aria-label=Закрыть]');

  // Вчерашние опоздания для раздела «Опоздания».
  for (const [start, end, arrived] of [['09:00', '10:30', '09:20'], ['11:00', '12:30', '11:15']]) {
    const past = await teacherStore.save({ title: `Вчерашняя пара ${start}`, type: 'lesson', date: day(-1), start, end, participants: ['Алексеева Мария', 'Борисов Илья'], devices: ['00000000-0000-4000-8000-000000000000'] });
    await teacherStore.saveMark(past.id, 'Алексеева Мария', 'present', { at: new Date(`${day(-1)}T${arrived}`).toISOString() });
    await teacherStore.saveMark(past.id, 'Борисов Илья', 'present', { at: new Date(`${day(-1)}T${start}`).toISOString() });
  }
  await teacher.syncWith('127.0.0.1:47800');

  // Отчёт за период.
  await openSection('#open-reports');
  await page.waitForSelector('#reports[open]');
  const row = page.locator('#reports tbody tr:has-text("Подготовка к олимпиаде")');
  assert.deepEqual((await row.locator('td').allTextContents()).slice(9), ['6', '2', await row.locator('td').nth(11).textContent(), '1', '1', '1', '1', '33%', '1']);
  assert.equal(await page.locator('#reports tbody tr:has-text("Волонтёры")').count(), 0, 'мероприятия не считаются парами');
  await shot('report-pairs');
  await page.click('#reports .tabs >> text=Посещаемость студентов');
  await page.waitForSelector('#reports tbody tr:has-text("Алексеева Мария")');
  await shot('report-students');
  await page.selectOption('#rp-group', 'ИС-21');
  await page.waitForFunction(() => document.querySelectorAll('#reports tbody tr').length === 3);
  await page.click('#reports .tabs >> text=По группам');
  await page.waitForSelector('#reports tbody tr:has-text("ИС-21")');
  await page.click('#reports .tabs >> text=Кто опаздывает и в какие дни');
  const lateRow = page.locator('#reports tbody tr:has-text("Алексеева Мария")');
  await lateRow.waitFor();
  const lateCells = await lateRow.locator('td').allTextContents();
  assert.deepEqual(lateCells.slice(2, 6), ['2', '35', '18', '2'], lateCells.join('|'));
  assert.equal(await lateRow.locator('td.heat-2').count(), 1, 'понедельник подсвечен');
  assert.equal(await page.locator('#reports tbody tr:has-text("Борисов Илья")').count(), 0, 'без опозданий не попадает');
  await page.waitForSelector('#report-summary:has-text("Больше всего опозданий")');
  await shot('report-lateness');

  const saved = path.join(home, 'report.csv');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, saved);
  await page.selectOption('#rp-group', '');
  await page.click('#reports .tabs >> text=Проведённые пары');
  await page.click('#reports >> text=Сохранить для Excel');
  await until(() => fs.existsSync(saved) && fs.readFileSync(saved, 'utf8').includes('Подготовка к олимпиаде'), 'файл отчёта');
  const csv = fs.readFileSync(saved, 'utf8');
  assert.ok(csv.startsWith('\uFEFFДата;Время;Тип;Название'), 'заголовок отчёта');
  assert.ok(csv.includes('Подготовка к олимпиаде'), 'строки отчёта');
  await page.click('#reports .sheetfoot >> text=Печать');
  await until(async () => (await app.evaluate(() => globalThis.printCalls ?? 0)) === 2, 'печать отчёта');
  assert.match(await page.textContent('#printarea'), /Проведённые пары[\s\S]*Подготовка к олимпиаде/);
  const reportPdf = path.join(home, 'report.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, reportPdf);
  await page.click('#reports .sheetfoot >> text=Сохранить PDF');
  await until(() => fs.existsSync(reportPdf) && fs.statSync(reportPdf).size > 1000, 'PDF отчёта');
  await page.waitForFunction(() => document.getElementById('toast').textContent === 'PDF сохранён.');
  if (process.env.REPORT_COPY) fs.copyFileSync(reportPdf, process.env.REPORT_COPY);
  await shot('report-buttons');
  await page.click('#reports [aria-label=Закрыть]');

  // Тамагочи: имя, настроение, смерть от прогулов и новый питомец.
  await page.waitForSelector('#pet-open:not([hidden])');
  await page.click('#pet-open');
  await page.waitForSelector('#pet[open]');
  await page.click('#pet .petgroups button:has-text("ИС-21")').catch(() => {});
  await page.fill('#pet-name', 'Пиксель');
  await page.click('#pet >> text=Назвать');
  await page.waitForSelector('#pet-open:has-text("Пиксель")');
  await until(async () => (await teacherStore.directory()).some((r) => r.petName === 'Пиксель'), 'имя питомца на другом устройстве');
  assert.equal(await page.locator('#pet .mood-sick, #pet .mood-sad, #pet .mood-fine, #pet .mood-play').count(), 1, 'питомец жив');
  await page.click('#pet .petstage');
  await page.waitForSelector('#pet .petheart');
  await shot('pet-alive');
  await page.click('#pet [aria-label=Закрыть]');

  const tiny = ['Алексеева Мария', 'Борисов Илья', 'Васильева Дарья', 'Тестов Ученик1'];
  for (let i = 0; i < 4; i += 1) {
    const lost = await teacherStore.save({ title: `Прогул ${i}`, type: 'lesson', date: day(-6 + i), start: '09:00', end: '10:00', participants: tiny, devices: ['00000000-0000-4000-8000-000000000000'] });
    await teacherStore.saveMark(lost.id, tiny[0], 'present', { at: new Date(`${day(-6 + i)}T09:00`).toISOString() });
  }
  await teacher.syncWith('127.0.0.1:47800');
  await page.waitForSelector('#pet-open .mood-dead', { timeout: 20000 });
  await page.click('#pet-open');
  await page.waitForSelector('#pet .mood-dead');
  assert.match(await page.textContent('#pet .petmood'), /Пиксель: питомец умер/);
  assert.equal(await page.locator('#pet .healthchart').count(), 1, 'график здоровья');
  await page.waitForSelector('#ticker .notice-red:has-text("Пиксель: питомец умер")', { state: 'attached' });
  await shot('pet-dead');
  await page.click('#pet >> text=Завести нового питомца');
  await page.waitForSelector('#pet .mood-fine');
  assert.match(await page.textContent('#pet .petlevel'), /Здоровье 70 из 100/);
  await page.waitForSelector('#ticker .notice:has-text("Пиксель")', { state: 'detached' });
  assert.match(await page.textContent('#pet .petdeaths'), /Пиксель/);
  await shot('pet-stats');
  await until(async () => (await teacherStore.directory()).some((r) => r.petDeaths?.[0]?.name === 'Пиксель'), 'журнал смертей на другом устройстве');
  await page.click('#pet [aria-label=Закрыть]');

  // Призы: новый питомец набирает 100 за первый день, потом шесть дней подряд держит 100.
  const perfect = async (offset, n) => {
    for (let k = 0; k < n; k += 1) {
      const start = `${String(9 + k).padStart(2, '0')}:00`;
      const pair = await teacherStore.save({ title: `Все на месте ${offset}.${k}`, type: 'lesson', date: day(offset), start, end: `${String(9 + k).padStart(2, '0')}:45`, participants: tiny, devices: ['00000000-0000-4000-8000-000000000000'] });
      for (const name of tiny) await teacherStore.saveMark(pair.id, name, 'present', { at: new Date(`${day(offset)}T${start}`).toISOString() });
    }
  };
  await perfect(1, 5);
  for (let d = 2; d <= 7; d += 1) await perfect(d, 1);
  await teacher.syncWith('127.0.0.1:47800');
  await page.waitForSelector('#pet-open .mood-play', { timeout: 20000 });
  await page.click('#pet-open');
  await page.waitForSelector('#pet .prize[data-prize="camera"]:not(.locked)');
  await page.waitForSelector('#pet .prize[data-prize="tripod"]:not(.locked)');
  await page.waitForSelector('#pet .prize[data-prize="headphones"].locked');
  assert.equal(await page.locator('#pet .petstage .petsprite.dressed').count(), 1, 'призы рядом с питомцем');
  await page.click('#pet .prizeslot:has-text("Слева") button:has-text("Фотокамера")');
  await until(async () => (await teacherStore.directory()).some((r) => r.petLook?.left === 'camera' && r.petLook?.right === 'tripod'), 'наряд питомца на другом устройстве');
  await page.waitForSelector('#pet .prizeslot:has-text("Справа") button[aria-pressed="true"]:has-text("Штатив")');
  await shot('pet-prizes');
  await page.click('#pet [aria-label=Закрыть]');

  // Служебная записка: сама при назначении на практику, не для занятий.
  const documents = path.join(home, 'documents');
  await app.evaluate(({ app: electronApp }, folder) => electronApp.setPath('documents', folder), documents);
  const memoFolder = path.join(documents, 'Служебные записки');
  const addWithStudent = async (title, type, date) => {
    await page.click('#add');
    await page.waitForSelector('#form[open]');
    await page.fill('#f-title', title);
    await page.click(`#form .targets button:has-text("${type}")`);
    await page.fill('#f-date', date);
    await page.fill('#f-start', '15:00');
    await page.fill('#f-end', '16:30');
    await page.fill('#f-place', 'Актовый зал');
    if (type === 'Занятие') assert.equal(await page.isVisible('#f-prep'), false, 'у занятия подготовки нет');
    else await page.click('#form .prepchoices button:has-text("60")');
    await page.fill('#f-participants', 'Алексеева Мария');
    await page.keyboard.press('Enter');
    await page.click('dialog#form button[type=submit]');
    await page.waitForSelector('dialog#form', { state: 'hidden' });
  };
  await page.click('#settings');
  await page.waitForSelector('#preferences[open]');
  await page.fill('#s-memo-from', 'Павлова С. Н.');
  await page.fill('#s-memo-signer', 'Павлов С. Н.');
  await page.click('#preferences button[type=submit]');
  await page.waitForSelector('dialog#preferences', { state: 'hidden' });
  assert.match(fs.readFileSync(path.join(home, 'config.ini'), 'utf8'), /memoSigner=Павлов С\. Н\./);

  await addWithStudent('Обычная пара', 'Занятие', day(14));
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#memo[open]').count(), 0, 'для занятия записки нет');
  await addWithStudent('Концерт', 'Мероприятие', day(14));
  await page.waitForSelector('#memo[open]');
  assert.match(await page.textContent('#memo'), /Служебная записка готова/);
  await shot('memo');
  await page.click('#memo [aria-label=Закрыть]');
  const memoFiles = fs.readdirSync(memoFolder);
  assert.equal(memoFiles.length, 1, 'файл записки создан');
  const { readZip } = require('../src/main/memo');
  const memoXml = readZip(fs.readFileSync(path.join(memoFolder, memoFiles[0]))).find((e) => e.name === 'word/document.xml').data.toString('utf8');
  assert.ok(memoXml.includes('Концерт') && memoXml.includes('Алексеева Мария') && memoXml.includes('ИС-21'), 'записка заполнена');
  assert.ok(memoXml.includes('14:00–16:30'), 'освобождение с начала подготовки');
  assert.ok(memoXml.includes('От Павлова С. Н.') && memoXml.includes('/ Павлов С. Н.'), 'отправитель из настроек');
  if (process.env.MEMO_COPY) fs.copyFileSync(path.join(memoFolder, memoFiles[0]), process.env.MEMO_COPY);

  await page.click('.block:has-text("Концерт")');
  await page.click('#details >> text=Изменить');
  await page.waitForSelector('#form[open]');
  await page.fill('#f-notes', 'Только примечание');
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#memo[open]').count(), 0, 'примечание не меняет записку');
  await page.click('.block:has-text("Концерт")');
  await page.click('#details >> text=Служебная записка');
  await page.waitForSelector('#memo[open]');
  await page.click('#memo [aria-label=Закрыть]');
  await page.click('#today');

  // Преподаватель видит всё.
  await page.click('#settings');
  await page.click('label:has-text("Показывать мероприятия всех устройств")');
  await page.click('#preferences button[type=submit]');
  await page.waitForSelector('dialog#preferences', { state: 'hidden' });
  await page.waitForSelector('.block:has-text("На компьютер преподавателя")');

  // Бегущая строка.
  await page.click('#notices-open');
  await page.waitForSelector('#notices[open]');
  await page.click('#notices >> text=Добавить в строку');
  await page.waitForSelector('#notices .error:has-text("Введите текст")');
  await page.fill('#n-text', 'Собрание кураторов в 15:00');
  await page.click('#notices .targets button:has-text("Красный")');
  await page.click('#notices .prepchoices button:has-text("3 дня")');
  await page.click('#notices >> text=Добавить в строку');
  await page.waitForSelector('#notices li:has-text("Собрание кураторов")');
  await page.click('#notices [aria-label=Закрыть]');
  await page.waitForSelector('#ticker:not([hidden]) .notice-red:has-text("Собрание кураторов")');
  const running = await page.evaluate(() => {
    const track = document.querySelector('.tickertrack');
    const duration = parseFloat(track.style.animationDuration);
    return { speed: (track.scrollWidth + document.getElementById('ticker').clientWidth) / duration, name: getComputedStyle(track).animationName };
  });
  assert.equal(running.name, 'ticker-run');
  assert.ok(running.speed > 40 && running.speed < 130, `читаемая скорость: ${running.speed}`);
  await until(async () => (await teacherStore.directory()).some((r) => r.kind === 'notice' && r.color === 'red'), 'напоминание на другом устройстве');
  await shot('ticker');
  const expired = await teacherStore.saveRef({ kind: 'notice', name: 'Вчерашнее', color: 'green', until: `${day(-1)}T10:00` });
  await teacher.syncWith('127.0.0.1:47800');
  await page.click('#notices-open');
  await page.waitForSelector('#notices li:has-text("Вчерашнее"):has-text("Срок вышел")', { timeout: 15000 });
  assert.equal(await page.locator('#ticker .notice:has-text("Вчерашнее")').count(), 0, 'истёкшее не показывается');
  await shot('notices');
  await page.click('#notices li:has-text("Вчерашнее") >> text=Удалить');
  await page.waitForSelector('#notices li:has-text("Вчерашнее")', { state: 'detached' });
  assert.ok(expired.id);
  await page.click('#notices [aria-label=Закрыть]');

  // Занятость техники в реальном времени.
  await openSection('#open-gear');
  await page.waitForSelector('#gear[open]');
  const micRow = page.locator('#gear tbody tr:has-text("Микрофон")');
  assert.match(await micRow.textContent(), /Занято[\s\S]*Павлов С\. Н\.[\s\S]*Волонтёры дня открытых дверей[\s\S]*Актовый зал[\s\S]*12:30/);
  assert.match(await page.textContent('#gear tbody tr:has-text("Проектор")'), /Свободно/);
  await shot('gear');
  await page.fill('#g-search', 'камер');
  await page.waitForFunction(() => document.querySelectorAll('#gear tbody tr').length === 1);
  assert.match(await page.textContent('#gear tbody'), /Камера/);
  await page.click('#gear [aria-label=Закрыть]');

  // Кнопки окна видны только на весь экран, закрытие подтверждается.
  const full = (await page.evaluate(() => window.calendar.getSettings())).fullscreen;
  assert.equal(await page.isVisible('#quit'), full);
  if (full) {
    await page.click('#quit');
    await page.waitForSelector('#quitask[open]');
    await page.click('#quitask >> text=Отмена');
  }

  // Резервная копия и возврат удалённого.
  await page.click('#settings');
  await page.waitForSelector('#s-backup-now');
  const backupDir = (await page.evaluate(() => window.calendar.backupStatus())).dir;
  // Ежедневная копия могла уже появиться сама: считаем только новую.
  const listCopies = () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : []).filter((name) => name.startsWith('Kerdiis-'));
  const before = listCopies();
  const clicked = Date.now();
  await page.click('#s-backup-now');
  await page.waitForSelector('#s-backup:has-text("Копия сохранена")');
  await shot('backup');
  // Новая папка или та же секунда, что у ежедневной копии: тогда папка просто обновлена.
  const fresh = () => listCopies().filter((name) => !before.includes(name) || fs.statSync(path.join(backupDir, name)).mtimeMs >= clicked - 1000);
  await until(() => fresh().length >= 1, 'новая резервная копия');
  await page.click('#preferences [aria-label=Закрыть]');
  await page.click('#settings');
  await page.waitForSelector('#s-backup-now');
  const victim = (await page.evaluate((date) => window.calendar.save({ title: 'Удалённое и возвращённое', type: 'event', date, start: '17:00', end: '18:00', participants: [], devices: [] }, null), day(0))).value;
  await page.click('#s-backup-now');
  await page.waitForFunction(() => document.querySelector('#s-backup')?.textContent.includes('Копия сохранена'));
  await page.click('#preferences [aria-label=Закрыть]');
  await page.evaluate((e) => window.calendar.remove(e.id, e.updatedAt), victim);
  await page.waitForSelector('.block:has-text("Удалённое и возвращённое")', { state: 'detached' });
  const newest = fs.readdirSync(backupDir).filter((name) => name.startsWith('Kerdiis-')).sort().at(-1);
  assert.equal((await page.evaluate((dir) => window.calendar.restoreBackup(dir), path.join(backupDir, newest))).value, 1);
  await page.waitForSelector('.block:has-text("Удалённое и возвращённое")');

  // Свой шаблон служебной записки.
  const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kerdiis-tpl-'));
  const { writeZip } = require('../src/main/memo');
  const plain = path.join(templateDir, 'plain.docx');
  fs.writeFileSync(plain, writeZip([{ name: 'word/document.xml', data: Buffer.from('<w:document><w:body><w:p><w:r><w:t>Без полей</w:t></w:r></w:p></w:body></w:document>') }]));
  assert.equal((await page.evaluate((f) => window.calendar.uploadTemplate(f), plain)).code, 'no-fields');
  const mine = path.join(templateDir, 'mine.docx');
  fs.writeFileSync(mine, writeZip([{ name: 'word/document.xml', data: Buffer.from('<w:document><w:body><w:p><w:r><w:t>Записка: {{Мероприятие}}</w:t></w:r></w:p></w:body></w:document>') }]));
  assert.deepEqual((await page.evaluate((f) => window.calendar.uploadTemplate(f), mine)).value.known, ['{{Мероприятие}}']);
  assert.equal((await page.evaluate(() => window.calendar.memoTemplate())).custom, true);
  await page.evaluate(() => window.calendar.resetTemplate());
  assert.equal((await page.evaluate(() => window.calendar.memoTemplate())).custom, false);

  // Цепочка: занятие каждую неделю до конкретной даты.
  await page.click('#add');
  await page.waitForSelector('#form[open]');
  await page.fill('#f-title', 'Математика по вторникам');
  await page.fill('#f-start', '16:00');
  await page.fill('#f-end', '17:00');
  await page.selectOption('#f-repeat', 'week');
  await page.fill('#f-until', day(14));
  await page.dispatchEvent('#f-until', 'change');
  await page.waitForSelector('[data-for=f-repeat] .help:has-text("Будет создано событий: 3")');
  await shot('repeat-form');
  await page.click('#form .sheetfoot .primary');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  const chain = async () => (await page.evaluate(() => window.calendar.list())).value
    .filter((e) => e.seriesId).sort((x, y) => x.date.localeCompare(y.date));
  assert.deepEqual((await chain()).map((e) => e.date), [day(0), day(7), day(14)]);
  await page.click('.block:has-text("Математика по вторникам")');
  await page.waitForSelector('#details[open]');
  assert.match(await page.textContent('#details'), /Каждую неделю, до/);
  await page.click('#details >> text=Изменить');
  await page.waitForSelector('#form[open]');
  assert.equal(await page.isVisible('#f-repeat'), false, 'повтор задаётся только при создании');
  await page.fill('#f-title', 'Математика, ауд. 305');
  await page.click('#form .sheetfoot .primary');
  await page.waitForSelector('#scope-following');
  await page.click('#scope-following');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  assert.deepEqual((await chain()).map((e) => e.title), Array(3).fill('Математика, ауд. 305'));
  await page.click('.block:has-text("Математика, ауд. 305")');
  await page.click('#details >> text=Удалить');
  await page.waitForSelector('#remove-following');
  await page.click('#details .danger:has-text("Только это")');
  await page.waitForSelector('#details', { state: 'hidden' });
  assert.deepEqual((await chain()).map((e) => e.date), [day(7), day(14)]);

  // Удаление за период: цепочка через неделю и две.
  const [day7, day14] = [day(7), day(14)];
  await page.click('#settings');
  await page.waitForSelector('#s-clear');
  await page.fill('#s-clear-from', day(7));
  await page.fill('#s-clear-to', day(14));
  await page.dispatchEvent('#s-clear-to', 'change');
  for (const type of ['practice', 'task', 'event']) await page.click(`#s-clearbox .targets button.t-${type}`);
  await page.click('#s-clear');
  const toClear = (await page.evaluate(() => window.calendar.list())).value.filter((e) => e.type === 'lesson' && e.date >= day7 && e.date <= day14).length;
  await page.waitForSelector(`#s-clearbox .help:has-text("Будет удалено событий: ${toClear}")`);
  await shot('clear-range');
  const copiesBefore = fs.readdirSync(backupDir).length;
  await page.click('#s-clear-confirm');
  await page.waitForFunction((n) => document.querySelector('#s-clearbox [role=status]')?.textContent === `Удалено событий: ${n}`, toClear);
  assert.equal((await chain()).length, 0);
  assert.ok(fs.readdirSync(backupDir).length > copiesBefore, 'перед удалением сделана копия');
  await page.click('#preferences [aria-label=Закрыть]');

  // Событие на весь день идёт полосой над сеткой и не растягивает её.
  await page.click('#add');
  await page.waitForSelector('#form[open]');
  await page.fill('#f-title', 'День открытых дверей');
  await page.check('#f-allday');
  assert.equal(await page.isVisible('#f-start'), false);
  await page.click('#form .sheetfoot .primary');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  await page.waitForSelector('.deadlinestrip .alldaychip:has-text("День открытых дверей")');
  assert.equal(await page.locator('.block:has-text("День открытых дверей")').count(), 0);
  assert.equal(await page.locator('.hours span:text-is("0:00")').count(), 0, 'сетка не растянута до полуночи');
  await shot('allday');
  await page.click('.alldaychip:has-text("День открытых дверей")');
  await page.waitForSelector('#details:has-text("Весь день, 08:30–20:00")');
  await page.click('#details [aria-label=Закрыть]');

  // Сроки сдачи.
  await page.click('#today');
  await page.click('#add');
  await page.waitForSelector('#form[open]');
  assert.equal(await page.isVisible('#f-deadline'), false, 'у занятия срока нет');
  await page.click('#form .targets button.t-event');
  assert.match(await page.textContent('[data-for=f-deadline] label'), /Срок сдачи материалов/);
  await page.click('#form .targets button.t-task');
  assert.equal((await page.textContent('[data-for=f-deadline] label')).trim(), 'Срок сдачи');
  await page.fill('#f-title', 'Сдача макета афиши');
  await page.fill('#f-start', '15:00');
  await page.fill('#f-end', '16:00');
  await page.click('[data-for=f-deadline] button:has-text("3 дня")');
  assert.equal(await page.inputValue('#f-deadline'), `${day(3)}T18:00`);
  await page.fill('#f-deadline', `${day(0)}T08:00`);
  await page.click('#form .sheetfoot .primary');
  await page.waitForSelector('.deadlinestrip .deadlinechip.overdue:has-text("Сдача макета афиши")');
  assert.equal(await page.textContent('#deadline-count.late'), '1');
  await page.waitForSelector('#ticker .notice-red:has-text("Просрочено: Сдача макета афиши")');
  await shot('deadline-day');
  await page.click('[data-view=month]');
  await page.waitForSelector('.cell .deadlinechip.overdue');
  await shot('deadline-month');
  await page.click('[data-view=day]');
  await page.click('#open-deadlines');
  await page.waitForSelector('#deadlines[open]');
  assert.match(await page.textContent('#deadlines'), /Просрочено: 1[\s\S]*Сдача макета афиши[\s\S]*Задание/);
  await shot('deadlines');
  await page.click('#deadlines tr:has-text("Сдача макета афиши") >> text=Отметить сдачу');
  await page.waitForSelector('#deadlines h3:has-text("Сдано: 1")');
  assert.equal(await page.isVisible('#deadline-count'), false, 'сданное не считается');
  await page.waitForSelector('#ticker .notice:has-text("Сдача макета афиши")', { state: 'detached' });
  assert.equal(await page.locator('.deadlinechip').count(), 0, 'сданное уходит из календаря');
  await page.click('#deadlines tr:has-text("Сдача макета афиши") .linkbutton');
  await page.waitForSelector('#details[open]');
  assert.match(await page.textContent('#details'), /Срок сдачи[\s\S]*Сдано:/);
  await page.click('#details [aria-label=Закрыть]');
  await until(async () => (await teacherStore.list()).some((e) => e.title === 'Сдача макета афиши' && e.deadlineDone), 'отметка о сдаче на другом устройстве');

  // Опоздание вручную и фиксация отчёта.
  const fixedPair = (await page.evaluate((date) => window.calendar.save({
    title: 'Пара с фиксацией', type: 'lesson', date, start: '14:00', end: '15:00', participants: ['Алексеева Мария', 'Борисов Илья', 'Васильева Дарья'], devices: [],
  }, null), day(0))).value;
  await page.click('.block:has-text("Пара с фиксацией")', { timeout: 15000 });
  await page.click('#details >> text=Отметка: 0 из 3');
  await page.waitForSelector('#roll[open]');
  await page.click('.rollrow:has-text("Алексеева Мария") .rollname');
  await page.waitForSelector('.rollrow:has-text("Алексеева Мария") .rollname[aria-pressed=true]');
  assert.doesNotMatch(await page.textContent('.rollrow:has-text("Алексеева Мария")'), /опоздание/, 'присутствие не считается опозданием');
  await page.click('.rollrow:has-text("Борисов Илья") >> text=Опоздал');
  await page.fill('.rollrow:has-text("Борисов Илья") .latetime', '14:20');
  await page.locator('.rollrow:has-text("Борисов Илья") .latetime').blur();
  await page.waitForSelector('.rollrow:has-text("Борисов Илья"):has-text("опоздание 20 мин")');
  await shot('roll-teacher');
  await page.click('#lock-report');
  await page.waitForSelector('#lock-confirm');
  await page.click('#lock-confirm');
  await page.waitForSelector('.lockbanner:not([hidden])');
  assert.match(await page.textContent('.rollrow:has-text("Васильева Дарья")'), /Без причины/);
  assert.equal(await page.locator('#lock-report').count(), 0, 'отчёт отправляется один раз');
  assert.equal((await page.evaluate((id) => window.calendar.lockReport(id), fixedPair.id)).code, 'locked', 'повторная отправка отклоняется');
  await shot('roll-locked');
  await page.click('#roll [aria-label=Закрыть]');
  await page.click('.block:has-text("Пара с фиксацией")');
  await page.click('#details >> text=Удалить');
  await page.click('#details .danger');
  await page.waitForSelector('#details .message:has-text("зафиксирован")');
  await page.click('#details [aria-label=Закрыть]');
  await page.click('.block:has-text("Пара с фиксацией")');
  await page.click('#details .primary');
  await page.waitForSelector('#roll[open]');
  await page.click('.rollrow:has-text("Васильева Дарья") .reason:has-text("Болезнь")');
  await page.waitForSelector('.rollhistory:has-text("Исправления после фиксации: 1")');
  await page.waitForSelector('.rollrow:has-text("Васильева Дарья"):has-text("Болезнь, ждём справку")');
  await page.waitForSelector('#ticker .notice:has-text("Васильева Дарья: предъявите справку")', { state: 'attached', timeout: 15000 });
  await shot('roll-corrected');
  await page.click('#roll [aria-label=Закрыть]');
  await page.click('#open-deadlines');
  await page.waitForSelector('#deadlines tr:has-text("Васильева Дарья"):has-text("Пара с фиксацией")');
  await shot('certificates');
  await page.click('#deadlines tr:has-text("Васильева Дарья") >> text=Справка принята');
  await page.waitForSelector('#deadlines tr:has-text("Васильева Дарья")', { state: 'detached' });
  await page.waitForSelector('#ticker .notice:has-text("Васильева Дарья")', { state: 'detached' });
  await page.click('#deadlines [aria-label=Закрыть]');
  await until(async () => (await teacherStore.attendance()).some((d) => d.eventId === fixedPair.id && d.lock && d.history.length === 2), 'зафиксированный отчёт на другом устройстве');

  // Нажатие на пустое время открывает форму с этим временем.
  await page.click('[data-view=day]');
  const box = await page.locator('.day').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.96);
  await page.waitForFunction(() => document.getElementById('form').open && /^19:/.test(document.getElementById('f-start').value));
  assert.equal(await page.inputValue('#f-date'), day(0));
  await page.click('#form [aria-label=Закрыть]');

  // Запись, сделанная другой панелью, появляется сама.
  seed(0, '15:00', '16:00', 'Добавлено с другой панели');
  await page.waitForSelector('.block:has-text("Добавлено с другой панели")', { timeout: 15000 });

  // Пропала папка: данные остаются на экране, программа сообщает об этом и восстанавливается.
  const parked = `${eventsDir}.parked`;
  fs.renameSync(eventsDir, parked);
  fs.writeFileSync(eventsDir, '');
  await page.waitForSelector('#banner:not([hidden])', { timeout: 15000 });
  assert.ok((await page.locator('.block').count()) > 0, 'мероприятия остаются на экране');
  await shot('offline');
  fs.rmSync(eventsDir);
  fs.renameSync(parked, eventsDir);
  await page.waitForSelector('#banner', { state: 'hidden', timeout: 15000 });

  await page.click('#settings');
  assert.equal(await page.inputValue('#s-name'), 'Ауд. 204');
  await page.click('text=Обменяться сейчас');
  await page.waitForSelector('#s-devices li:has-text("Кабинет преподавателя"):has-text("На связи")');
  await shot('settings');
  await page.click('#check-update');
  await page.waitForFunction(() => !document.getElementById('check-update').disabled, null, { timeout: 100000 });
  assert.match(await page.textContent('#s-update'), process.platform === 'win32' ? /Последняя проверка обновлений|не удалось проверить/ : /Проверку запустить не удалось/);
  await page.click('#preferences [aria-label=Закрыть]');

  // Страница для студентов: включить, показать QR, выдать код, привязать телефон.
  await page.click('#settings');
  await page.click('#s-portal-on');
  await page.waitForSelector('#s-portal:has-text("47890")');
  await page.click('#preferences [aria-label=Закрыть]');
  await page.waitForSelector('#open-portal:not([hidden])', { state: 'attached', timeout: 15000 });
  await openSection('#open-portal');
  await page.waitForSelector('#portal[open] svg.qr');
  await shot('portal');
  await page.click('#portal [aria-label=Закрыть]');

  await teacherStore.save({ title: 'Пара для телефона', type: 'lesson', date: day(0), start: '19:15', end: '19:55', participants: ['Васильева Дарья', 'Борисов Илья'], devices: [deviceId] });
  await teacherStore.save({ title: 'Пара сейчас', type: 'lesson', date: day(0), start: '09:00', end: '10:00', participants: ['Васильева Дарья', 'Борисов Илья'], devices: [deviceId] });
  await teacher.syncWith('127.0.0.1:47800');
  await openSection('#open-catalog');
  await page.click('#catalog .tabs >> text=Группы и студенты');
  await page.click('#catalog .refname:has-text("ИС-21")');
  await page.click('#catalog .refrow:has-text("Васильева Дарья") .phonetoggle');
  await page.click('#c-phone-code');
  const phoneCode = (await page.textContent('.phonecode strong')).replace(/\s/g, '');
  assert.match(phoneCode, /^\d{8}$/);
  await shot('phone-code');
  await page.click('#catalog [aria-label=Закрыть]');

  // «Телефон» — отдельное окно того же Chromium, что в Electron: отдельный браузер на сервере сборки не скачивается.
  const phoneOpened = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }) => {
    const w = new BrowserWindow({ width: 390, height: 844, show: true });
    w.loadURL('http://127.0.0.1:47890/');
  });
  const phone = await phoneOpened;
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.waitForSelector('#code');
  await phone.fill('#code', phoneCode);
  await phone.fill('#nick', 'Дашуля');
  await phone.click('button[type=submit]');
  await phone.waitForSelector('text=Вы в колледже с');
  await phone.waitForSelector('.item:has-text("Пара для телефона")');
  assert.ok(!(await phone.textContent('body')).includes('null'), 'пустые разделы не печатаются');
  assert.ok(!(await phone.content()).includes('Васильева'), 'ФИО на телефоне нет');
  await phone.screenshot({ path: path.join(shots, 'phone.png'), fullPage: true });
  await phone.reload();
  await phone.waitForSelector('text=Привет, Дашуля!');
  await phone.close();

  await page.waitForSelector('.block:has-text("Пара для телефона")', { timeout: 15000 });
  await page.click('.block:has-text("Пара для телефона")');
  await page.click('#details >> text=/Отметка/');
  await page.waitForSelector('#roll[open] .rollrow:has-text("Васильева Дарья"):has-text("В колледже с")', { timeout: 15000 });
  assert.equal(await page.locator('#roll .rollrow:has-text("Борисов Илья"):has-text("В колледже с")').count(), 0);
  await shot('roll-presence');
  await page.click('#roll [aria-label=Закрыть]');

  // Открыв страницу, студент сам отметился на идущей паре; преподаватель подтверждает.
  await page.click('.block:has-text("Пара сейчас")');
  await page.click('#details >> text=/Отметка/');
  await page.waitForSelector('#roll[open] .rollrow:has-text("Васильева Дарья"):has-text("С телефона в")', { timeout: 15000 });
  await page.waitForSelector('#roll .autobox:has-text("ждут подтверждения: 1")');
  assert.equal(await page.locator('#roll .rollrow:has-text("Борисов Илья") .confirmauto').count(), 0);
  await shot('roll-auto');
  await page.click('#roll .rollrow:has-text("Васильева Дарья") .confirmauto');
  await page.waitForSelector('#roll .autobox', { state: 'hidden' });
  assert.match(await page.textContent('#roll .rollrow:has-text("Васильева Дарья")'), /Отмечен в/);
  await page.click('#roll [aria-label=Закрыть]');
  await openSection('#open-catalog');
  await page.click('#catalog .tabs >> text=Группы и студенты');
  await page.click('#catalog .refname:has-text("ИС-21")');
  await page.waitForSelector('#catalog .refrow:has-text("Васильева Дарья"):has-text("ник Дашуля ждёт подтверждения")');
  await page.click('#catalog .refrow:has-text("Васильева Дарья") .phonetoggle');
  await page.click('.phonepanel button:has-text("Подтвердить ник")');
  await page.waitForSelector('#catalog .refrow:has-text("Васильева Дарья"):has-text("ник Дашуля, телефон привязан")');
  await page.click('#catalog [aria-label=Закрыть]');

  // Занятие не состоялось: причина, зачёркнутый блок, отметок нет.
  const toCancel = await teacherStore.save({ title: 'Пара для отмены', type: 'lesson', date: day(0), start: '12:00', end: '13:00', participants: ['Тестов Ученик33', 'Тестов Ученик34'] });
  await teacher.syncWith('127.0.0.1:47800');
  await page.click('#today');
  await page.click('[data-view=day]');
  await page.click('.block:has-text("Пара для отмены")', { timeout: 15000 });
  await page.waitForSelector('#details[open]');
  await page.click('#cancel-event');
  await page.fill('#cancel-reason', 'Преподаватель на больничном');
  await shot('cancel-form');
  await page.click('#cancel-confirm');
  await page.waitForSelector('#details[open]:has-text("Причина") , #details[open] dd:has-text("Преподаватель на больничном")');
  assert.equal(await page.locator('#details .primary:has-text("Отметка")').count(), 0, 'отметки нет');
  await page.click('#details [aria-label=Закрыть]');
  await page.waitForSelector('.block.cancelled:has-text("Не состоялось: Преподаватель на больничном")');
  await shot('cancelled-block');
  await until(async () => (await teacherStore.list()).some((e) => e.id === toCancel.id && e.cancelled), 'отмена на другом устройстве');
  await assert.rejects(teacherStore.saveMark(toCancel.id, 'Тестов Ученик33', 'present', { teacher: 'Кабинет' }), { code: 'cancelled' });
  await page.click('.block:has-text("Пара для отмены")');
  await page.click('#uncancel');
  await page.waitForSelector('#details[open] .primary:has-text("Отметка")');
  await page.click('#details [aria-label=Закрыть]');
  await page.waitForSelector('.block:has-text("Пара для отмены"):not(.cancelled)');

  // Практика на несколько дней: начало и последний день, на каждый день своя отметка.
  await page.click('#add');
  await page.waitForSelector('#form[open]');
  await page.fill('#f-title', 'Практика в фотостудии');
  await page.click('#form .targets button:has-text("Практика")');
  assert.equal(await page.textContent('[data-for=f-date] label'), 'Начало практики');
  assert.equal(await page.textContent('[data-for=f-repeat] label'), 'Конец практики');
  await page.fill('#f-date', day(21));
  await page.dispatchEvent('#f-date', 'change');
  await page.fill('#f-start', '09:00');
  await page.fill('#f-end', '15:00');
  await page.selectOption('#f-repeat', 'day');
  await page.fill('#f-until', day(25));
  await page.dispatchEvent('#f-until', 'change');
  await page.waitForSelector('[data-for=f-repeat] .help:has-text("Практика: дней 5")');
  await shot('practice-form');
  await page.click('#form .sheetfoot .primary');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  const practiceDays = (await page.evaluate(() => window.calendar.list())).value.filter((e) => e.title === 'Практика в фотостудии').map((e) => e.date).sort();
  assert.deepEqual(practiceDays, [21, 22, 23, 24, 25].map(day));

  // Вкладки календаря: по типу и расписание группы.
  await page.click('#today');
  await page.click('[data-view=day]');
  await page.click('#tabs [data-tab="type:practice"]');
  const practiceBlocks = await page.$$eval('#board .block', (blocks) => blocks.map((b) => b.className));
  assert.ok(practiceBlocks.length > 0 && practiceBlocks.every((c) => c.includes('t-practice')), 'только практика');
  const groupTab = page.locator('#tabs button.grouptab', { hasText: 'ИС-21' });
  await groupTab.click();
  const expected = await page.evaluate(async () => {
    const dir = (await window.calendar.directory()).value;
    const group = dir.find((r) => r.kind === 'group' && r.name === 'ИС-21');
    const subs = new Set([group.id, ...dir.filter((r) => r.kind === 'group' && r.name.startsWith('ИС-21-')).map((r) => r.id)]);
    const names = new Set(dir.filter((r) => r.kind === 'student' && subs.has(r.groupId)).map((r) => r.name.toLowerCase()));
    return { names: [...names] };
  });
  const shownTitles = await page.$$eval('#board .block strong', (els) => els.map((e) => e.textContent));
  const all = (await page.evaluate(() => window.calendar.list())).value;
  for (const title of shownTitles) {
    const event = all.find((e) => e.title === title);
    assert.ok(event.participants.some((p) => expected.names.includes(p.toLowerCase())), `${title} — для ИС-21`);
  }
  assert.ok(shownTitles.includes('Пара для отмены'), 'пара группы на месте');
  await page.click('[data-view=week]');
  await shot('tabs-group');
  await page.click('#tabs [data-tab=all]');

  // Верхняя строка помещается и на ноутбуке: кнопки не наезжают друг на друга и на заголовок.
  for (const width of [1920, 1536, 1366, 1280]) {
    await page.setViewportSize({ width, height: Math.round(width * 9 / 16) });
    await page.waitForTimeout(150);
    const bar = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const tools = [...document.querySelectorAll('.tools > *')].filter((el) => !el.hidden && el.offsetWidth && !el.matches('[popover]')).map(box);
      return { title: box(document.getElementById('title')), period: box(document.querySelector('.period')), toolsLeft: Math.min(...tools.map((b) => b.left)), toolsRight: Math.max(...tools.map((b) => b.right)), width: innerWidth, overlap: tools.some((b, i) => i && b.left < tools[i - 1].right - 0.5) };
    });
    assert.ok(bar.toolsRight <= bar.width + 0.5, `${width}: кнопки не выходят за край`);
    assert.ok(bar.period.right <= bar.toolsLeft + 0.5, `${width}: заголовок не под кнопками`);
    assert.ok(!bar.overlap, `${width}: кнопки не наезжают`);
    assert.ok(bar.title.width >= 120, `${width}: заголовок виден (${bar.title.width})`);
    await shot(`topbar-${width}`);
  }
  await page.click('#open-sections');
  await page.waitForSelector('#sections:popover-open #open-portal');
  await shot('sections-menu');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1920, height: 1080 });

  // Ранний сигнал: три пропуска без причины подряд.
  for (const offset of [-3, -2, -1]) {
    const skipped = await teacherStore.save({ title: `Пара без Ученика30 ${offset}`, type: 'lesson', date: day(offset), start: '15:00', end: '16:30', participants: ['Тестов Ученик30', 'Тестов Ученик31'], devices: ['00000000-0000-4000-8000-000000000000'] });
    await teacherStore.saveMark(skipped.id, 'Тестов Ученик31', 'present', { at: new Date(`${day(offset)}T15:00`).toISOString() });
  }
  // Портфолио: прошедший концерт со студентом.
  await teacherStore.save({ title: 'Концерт хора', type: 'event', date: day(-1), start: '17:00', end: '19:00', place: 'Актовый зал', participants: ['Тестов Ученик30'], devices: ['00000000-0000-4000-8000-000000000000'] });
  await teacher.syncWith('127.0.0.1:47800');
  await page.waitForSelector('#open-signals:not([hidden]) #signal-count:not([hidden])', { timeout: 15000 });
  await page.click('#open-signals');
  const signal = page.locator('#signals .signal:has-text("Тестов Ученик30")');
  await signal.waitFor();
  assert.match(await signal.textContent(), /Пропусков без причины подряд: 3/);
  await shot('signals');
  await signal.locator('text=Портфолио').click();
  await page.waitForSelector('#portfolio[open]:has-text("Концерт хора")');
  await page.fill('#pf-title', 'Конкурс «Объектив»');
  await page.fill('#pf-result', 'Диплом I степени');
  await page.click('#portfolio .portfolioadd button[type=submit]');
  await page.waitForSelector('#portfolio .awards li:has-text("Диплом I степени")');
  await until(async () => (await teacherStore.directory()).some((r) => r.kind === 'achievement' && r.student === 'Тестов Ученик30'), 'достижение на другом устройстве');
  await shot('portfolio');
  await page.click('#portfolio [aria-label=Закрыть]');
  await page.click('#signals .signal:has-text("Тестов Ученик30") >> text=Разобрались');
  await page.waitForSelector('#signals .signal:has-text("Тестов Ученик30")', { state: 'detached' });
  await page.click('#signals [aria-label=Закрыть]');

  // Журнал изменений: правка названия видна с прежним и новым значением.
  await openSection('#open-journal');
  await page.waitForSelector('#journal .jentry.j-edit:has-text("Субботник у корпуса") .jbefore:text-is("Субботник")');
  await page.waitForSelector('#journal .jentry.j-delete:has-text("Субботник у корпуса")');
  await page.waitForSelector('#journal .jentry.j-create-series');
  await page.fill('#journal-search', 'Субботник');
  assert.equal(await page.locator('#journal .jentry.j-create-series').count(), 0, 'поиск по названию');
  await shot('journal');
  await page.click('#journal [aria-label=Закрыть]');

  // Индикатор связи и проверка связи: компьютер преподавателя на связи, лишний адрес — нет.
  await page.click('#net');
  await page.waitForSelector('#netcheck[open] .netverdict');
  await page.waitForSelector('#netcheck .netpeers li.good:has-text("Кабинет преподавателя")');
  await page.waitForSelector('#netcheck .netchecks li:has-text("Отпечаток ключа")');
  await page.fill('#net-address', 'не адрес');
  await page.click('#netcheck .netadd button');
  await page.waitForSelector('#netcheck .message:has-text("Адрес вида 10.0.2.15")');
  await shot('netcheck');
  await page.click('#netcheck [aria-label=Закрыть]');
  await until(async () => (await page.getAttribute('#net', 'data-level')) === 'good', 'зелёный индикатор связи');
  await page.locator('header.topbar').screenshot({ path: path.join(shots, 'net-indicator.png') });

  assert.deepEqual(errors, [], 'ошибок на странице нет');
  await app.close();
  await teacher.stop();

  // Первый запуск: мастер настройки, пропуск и прохождение до конца.
  const firstRun = async (folder) => {
    // Новое устройство: только язык, иначе программа возьмёт язык системы.
    if (!fs.existsSync(path.join(folder, 'config.ini'))) fs.writeFileSync(path.join(folder, 'config.ini'), '[calendar]\r\nlang=ru\r\n');
    const launched = await _electron.launch({
      executablePath: process.env.CAL_EXE,
      args: (process.env.CAL_ARGS || '').split(' ').filter(Boolean),
      env: { ...process.env, KERDIIS_HOME: folder },
    });
    await launched.firstWindow();
    const windowOf = (name) => launched.windows().find((w) => w.url().endsWith(name));
    await until(() => windowOf('splash.html') && windowOf('index.html'), 'окна первого запуска');
    await windowOf('splash.html').click('body');
    return { launched, wizard: windowOf('index.html') };
  };
  const skipHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-e2e-skip-'));
  const skipped = await firstRun(skipHome);
  await skipped.wizard.waitForSelector('#welcome[open]');
  assert.equal(await skipped.wizard.locator('#welcome .langs button').count(), 7, 'выбор языка в мастере');
  await skipped.wizard.click('#welcome >> text=Пропустить настройку');
  await skipped.wizard.waitForSelector('#welcome', { state: 'hidden' });
  await until(() => /setupDone=1/.test(fs.readFileSync(path.join(skipHome, 'config.ini'), 'utf8')), 'пропуск мастера');
  await skipped.launched.close();
  const again = await firstRun(skipHome);
  await again.wizard.waitForSelector('.day, .cell');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await again.wizard.locator('#welcome[open]').count(), 0, 'второй раз мастер не появляется');
  await again.launched.close();

  const setupHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-e2e-setup-'));
  const setup = await firstRun(setupHome);
  const w = setup.wizard;
  await w.waitForSelector('#welcome[open]');
  await w.click('#welcome .sheetfoot >> text=Далее');
  await w.fill('#w-name', 'Ауд. 305');
  await w.click('#welcome .targets button:has-text("Компьютер преподавателя")');
  await page_shot(w, 'welcome');
  await w.click('#welcome .sheetfoot >> text=Далее');
  await w.fill('#w-key', 'коротко');
  await w.click('#welcome .sheetfoot >> text=Далее');
  await w.fill('#w-from', 'Павлова С. Н.');
  await w.click('#welcome .sheetfoot >> text=Начать работу');
  await w.waitForSelector('#welcome .error:has-text("не короче 12")');
  await w.click('#welcome .sheetfoot >> text=Назад');
  await w.click('#welcome button:has-text("Создать")');
  await w.waitForFunction(() => document.getElementById('w-key').value.length > 12);
  await w.click('#welcome .sheetfoot >> text=Далее');
  await w.click('#welcome .sheetfoot >> text=Начать работу');
  await w.waitForSelector('#welcome', { state: 'hidden' });
  const saved_ = fs.readFileSync(path.join(setupHome, 'config.ini'), 'utf8');
  assert.match(saved_, /deviceName=Ауд\. 305/);
  assert.match(saved_, /showAll=1/);
  assert.match(saved_, /memoFrom=Павлова С\. Н\./);
  assert.match(saved_, /syncKey=[A-Z2-9-]{23}/);
  assert.match(saved_, /setupDone=1/);
  await setup.launched.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(teacherDir, { recursive: true, force: true });
  console.log('Все сценарии пройдены');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
