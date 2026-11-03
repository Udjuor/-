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
const teacherStore = new EventStore(teacherDir, teacherId);
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
seed(0, '09:00', '10:30', 'Подготовка к олимпиаде', { place: 'Ауд. 204', responsible: 'Лебедева О. В.', participants: group, equipment: ['Проектор'] });
seed(0, '11:00', '12:30', 'Волонтёры дня открытых дверей', { place: 'Актовый зал', responsible: 'Павлов С. Н.', participants: group.slice(0, 4), equipment: ['Микрофон', 'Ноутбук', 'Колонки'] });
seed(0, '11:30', '13:00', 'Репетиция хора', { place: 'Ауд. 101', responsible: 'Иванова Е. А.', participants: group.slice(4) });
seed(1, '14:00', '16:00', 'Студенческий совет', { place: 'Ауд. 305', responsible: 'Павлов С. Н.', participants: group.slice(1, 3) });
seed(2, '10:00', '12:00', 'Шахматный турнир', { place: 'Холл', participants: group });
seed(-1, '13:00', '14:30', 'Встреча с работодателем', { place: 'Ауд. 210' });
seed(3, '09:30', '11:00', 'Экскурсия в музей');
for (let i = 0; i < 6; i += 1) seed(9, `${pad(9 + i)}:00`, `${pad(10 + i)}:00`, `Секция ${i + 1}`);

(async () => {
  await teacher.start();
  const app = await _electron.launch({
    executablePath: process.env.CAL_EXE,
    args: (process.env.CAL_ARGS || '').split(' ').filter(Boolean),
    env: { ...process.env, STUDENT_CALENDAR_HOME: home },
  });
  const errors = [];
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.clock.setFixedTime(new Date(2026, 10, 3, 11, 42));
  await page.reload();
  await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
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
  assert.equal(fs.readdirSync(eventsDir).length, 14, 'мероприятие записано в папку');

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
  assert.equal(fs.readdirSync(eventsDir).length, 14, 'удаление записано отметкой для других устройств');

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

  // Преподаватель видит всё.
  await page.click('#settings');
  await page.click('label:has-text("Показывать мероприятия всех устройств")');
  await page.click('#preferences button[type=submit]');
  await page.waitForSelector('dialog#preferences', { state: 'hidden' });
  await page.waitForSelector('.block:has-text("На компьютер преподавателя")');

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
  await page.click('#preferences [aria-label=Закрыть]');

  assert.deepEqual(errors, [], 'ошибок на странице нет');
  await app.close();
  await teacher.stop();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(teacherDir, { recursive: true, force: true });
  console.log('Все сценарии пройдены');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
