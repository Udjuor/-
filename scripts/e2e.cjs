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
seed(0, '09:00', '10:30', 'Подготовка к олимпиаде', { type: 'lesson', place: 'Ауд. 204', responsible: 'Лебедева О. В.', participants: group, equipment: ['Проектор'] });
seed(0, '11:00', '12:30', 'Волонтёры дня открытых дверей', { place: 'Актовый зал', responsible: 'Павлов С. Н.', participants: group.slice(0, 4), equipment: ['Микрофон', 'Ноутбук', 'Колонки'] });
seed(0, '11:30', '13:00', 'Репетиция хора', { type: 'practice', place: 'Ауд. 101', responsible: 'Иванова Е. А.', participants: group.slice(4) });
seed(1, '14:00', '16:00', 'Студенческий совет', { place: 'Ауд. 305', responsible: 'Павлов С. Н.', participants: group.slice(1, 3) });
seed(2, '10:00', '12:00', 'Шахматный турнир', { type: 'task', place: 'Холл', participants: group });
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

  // Справочники: заполнение, вставка столбца, выбор в мероприятии, обмен.
  const paste = (selector, text) => page.evaluate(([sel, value]) => {
    const data = new DataTransfer();
    data.setData('text', value);
    document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [selector, text]);
  await page.click('#open-catalog');
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
  await page.click('#picker .pickrow:has-text("Проектор")');
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
  await page.click('#open-catalog');
  await page.click('#catalog .tabs >> text=Группы и студенты');
  await page.click('#catalog .refname:has-text("ПИ-22")');
  await page.waitForSelector('#catalog li:has-text("Новиков Роман")', { timeout: 15000 });
  await page.click('#catalog .catalogcols section:first-child li:has-text("ПИ-22") >> text=Удалить');
  await page.waitForSelector('#catalog .refrow:has-text("Удалить группу и студентов: 1?")');
  await page.click('#catalog .refrow .danger');
  await page.waitForSelector('#catalog .refname:has-text("ПИ-22")', { state: 'detached' });
  await page.click('#catalog [aria-label=Закрыть]');
  await until(async () => !(await teacherStore.directory()).some((r) => r.name === 'ПИ-22' || r.name === 'Новиков Роман'), 'удаление группы на другом устройстве');

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

  // Отчёт за период.
  await page.click('#open-reports');
  await page.waitForSelector('#reports[open]');
  const row = page.locator('#reports tbody tr:has-text("Подготовка к олимпиаде")');
  assert.deepEqual((await row.locator('td').allTextContents()).slice(7), ['6', '2', await row.locator('td').nth(9).textContent(), '1', '1', '1', '1', '33%']);
  assert.equal(await page.locator('#reports tbody tr:has-text("Волонтёры")').count(), 0, 'мероприятия не считаются парами');
  await shot('report-pairs');
  await page.click('#reports .tabs >> text=Посещаемость студентов');
  await page.waitForSelector('#reports tbody tr:has-text("Алексеева Мария")');
  await shot('report-students');
  await page.selectOption('#rp-group', 'ИС-21');
  await page.waitForFunction(() => document.querySelectorAll('#reports tbody tr').length === 3);
  await page.click('#reports .tabs >> text=По группам');
  await page.waitForSelector('#reports tbody tr:has-text("ИС-21")');

  const saved = path.join(home, 'report.csv');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, saved);
  await page.selectOption('#rp-group', '');
  await page.click('#reports .tabs >> text=Проведённые пары');
  await page.click('#reports >> text=Сохранить для Excel');
  await until(() => fs.existsSync(saved), 'файл отчёта');
  const csv = fs.readFileSync(saved, 'utf8');
  assert.ok(csv.startsWith('\uFEFFДата;Время;Тип;Название'), 'заголовок отчёта');
  assert.ok(csv.includes('Подготовка к олимпиаде'), 'строки отчёта');
  await page.click('#reports [aria-label=Закрыть]');

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
