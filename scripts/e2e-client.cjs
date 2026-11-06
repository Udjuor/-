'use strict';
// Проверка клиента для панелей. Обычный сценарий идёт в версии для преподавателей.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const pad = (n) => String(n).padStart(2, '0');
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kerdiis-client-'));
  const events = path.join(home, 'data', 'events');
  fs.mkdirSync(events, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.ini'), `[calendar]\r\ndeviceId=${crypto.randomUUID()}\r\ndeviceName=Ауд. 101\r\nlang=ru\r\nsetupDone=1\r\ndataDir=${path.join(home, 'data')}\r\n`);
  const put = (record) => {
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(events, `${id}.json`), JSON.stringify({ id, updatedAt: '2026-11-01T00:00:00.000Z', ...record }));
    return id;
  };
  put({ kind: 'group', name: 'ИС-21' });
  put({ title: 'Пара на панели', type: 'lesson', date: today, start: '00:05', end: '23:20', participants: ['Иванов', 'Петров', 'Сидоров', 'Козлов'], devices: [] });
  put({ title: 'Концерт на панели', type: 'event', date: today, start: '23:00', end: '23:30', participants: ['Сидоров'], devices: [] });
  const lockedId = put({ title: 'Закрытая пара', type: 'lesson', date: today, start: '06:00', end: '07:00', participants: ['Иванов'], devices: [] });
  const hex = crypto.createHash('sha256').update(`attendance:${lockedId}`).digest('hex');
  const docId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  fs.writeFileSync(path.join(events, `${docId}.json`), JSON.stringify({
    id: docId, kind: 'attendance', eventId: lockedId, marks: {}, lock: { at: '2026-11-01T00:00:00.000Z', teacher: 'Кабинет', participants: ['Иванов'] }, history: [], updatedAt: '2026-11-01T00:00:00.000Z',
  }));

  const app = await _electron.launch({
    executablePath: process.env.CAL_EXE,
    args: (process.env.CAL_ARGS ?? '').split(' ').filter(Boolean),
    env: { ...process.env, KERDIIS_HOME: home, KERDIIS_EDITION: 'client', KERDIIS_CLOCK: new Date(`${today}T00:20`).toISOString() },
  });
  await app.firstWindow();
  let page = null;
  for (let i = 0; i < 100 && !page; i += 1) {
    page = app.windows().find((w) => w.url().endsWith('index.html')) ?? null;
    if (!page) await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  app.windows().find((w) => w.url().endsWith('splash.html'))?.click('body').catch(() => {});
  await page.waitForSelector('.block:has-text("Пара на панели")');
  assert.equal((await page.evaluate(() => window.calendar.getSettings())).edition, 'client');

  const shot = (name) => (process.env.SHOTS ? page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) : null);
  const refused = async (work) => assert.equal((await page.evaluate(work)).code, 'teacher-only');

  // Разделов преподавателя нет ни на экране, ни при прямом обращении к программе.
  for (const button of ['#open-catalog', '#open-reports', '#notices-open']) {
    assert.equal(await page.isVisible(button), false, button);
  }
  await refused(() => window.calendar.saveRefs([{ ref: { kind: 'group', name: 'Чужая' }, base: null }]));
  await refused(() => window.calendar.saveSettings({ deviceName: 'Взлом' }));
  await refused(async () => {
    const event = (await window.calendar.list()).value.find((item) => item.title === 'Пара на панели');
    return window.calendar.remove(event.id, event.updatedAt);
  });
  await refused(async () => {
    const event = (await window.calendar.list()).value.find((item) => item.title === 'Пара на панели');
    return window.calendar.save({ ...event, title: 'Подмена' }, event.updatedAt);
  });

  // Добавить событие можно и на клиенте.
  await page.click('#add');
  await page.waitForSelector('#form[open]');
  await page.fill('#f-title', 'Событие студента');
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  await page.waitForSelector('.block:has-text("Событие студента")');

  // На мероприятии только «был» или «не был».
  await page.click('.block:has-text("Концерт на панели")');
  await page.waitForSelector('#details[open]');
  await page.click('#details .primary');
  await page.waitForSelector('#roll[open]');
  assert.equal(await page.locator('#start-lesson, .rollrow >> text=Опоздал').count(), 0);
  await page.click('.rollrow:has-text("Сидоров") .rollname');
  await page.waitForSelector('.rollrow:has-text("Сидоров") .rollname[aria-pressed=true]');
  assert.doesNotMatch(await page.textContent('#roll'), /опоздан/i);
  await page.click('#roll [aria-label=Закрыть]');

  // В карточке только просмотр, в отметках только своё присутствие.
  await page.click('.block:has-text("Пара на панели")');
  await page.waitForSelector('#details[open]');
  for (const text of ['Изменить', 'Удалить', 'Служебная записка']) {
    assert.equal(await page.locator(`#details .plain:has-text("${text}")`).count(), 0, text);
  }
  await page.click('#details .primary');
  await page.waitForSelector('#roll[open]');
  assert.equal(await page.locator('.rollrow .reason:has-text("По приказу"), .rollrow .reason:has-text("Уважительная"), .certificate').count(), 0);
  assert.equal(await page.locator('#lock-report').count(), 0);
  await page.click('.rollrow:has-text("Иванов") .rollname');
  await page.waitForSelector('.rollrow:has-text("Иванов") .rollname[aria-pressed=true]');
  // Опоздание ставится на панели, а внесённый в мероприятие сразу освобождён.
  await page.click('.rollrow:has-text("Петров") >> text=Опоздал');
  await page.fill('.rollrow:has-text("Петров") .latetime', '00:25');
  await page.locator('.rollrow:has-text("Петров") .latetime').blur();
  await page.waitForSelector('.rollrow:has-text("Петров"):has-text("опоздание 20 мин")');
  // Предварительная болезнь с панели сразу идёт напоминанием в строку.
  await page.click('.rollrow:has-text("Козлов") .reason:has-text("Болезнь")');
  await page.waitForSelector('.rollrow:has-text("Козлов"):has-text("Болезнь, ждём справку")');
  await page.waitForSelector('#ticker .notice-yellow:has-text("Козлов: предъявите справку")', { state: 'attached', timeout: 15000 });
  // Преподаватель пришёл позже: после «Начать занятие» пришедший до него уже не опоздал.
  await page.click('#start-lesson');
  await page.waitForSelector('.startinfo:has-text("Занятие началось")');
  await page.waitForSelector('.rollrow:has-text("Петров"):has-text("не считается опозданием")');
  assert.equal(await page.locator('#start-lesson').count(), 0, 'начать можно один раз');
  assert.doesNotMatch(await page.textContent('.startline'), /false/);
  await shot('client-started');
  await page.waitForSelector('.rollrow.excused:has-text("Сидоров"):has-text("По приказу: Концерт на панели")');
  assert.match(await page.textContent('.rollsummary'), /по приказу: 1/);
  await page.click('#roll [aria-label=Закрыть]');
  await page.waitForSelector('.block:has-text("Пара на панели"):has-text("По приказу: 1")');
  await refused(async () => {
    const event = (await window.calendar.list()).value.find((item) => item.title === 'Пара на панели');
    return window.calendar.mark(event.id, 'Иванов', 'order', {});
  });
  await refused(async () => {
    const event = (await window.calendar.list()).value.find((item) => item.title === 'Пара на панели');
    return window.calendar.lockReport(event.id);
  });
  assert.equal((await page.evaluate((id) => window.calendar.mark(id, 'Иванов', 'present', {}), lockedId)).code, 'locked');

  for (const call of [() => window.calendar.removeRange('2000-01-01', '2100-01-01', ['lesson']), () => window.calendar.backupNow(), () => window.calendar.restoreBackup('C:\\'), () => window.calendar.resetTemplate()]) {
    assert.equal((await page.evaluate(call)).code, 'teacher-only');
  }

  // В настройках только язык, размер и версия.
  await page.click('#settings');
  await page.waitForSelector('#preferences[open]');
  assert.equal(await page.locator('#s-name, #s-key, #s-peers, #s-all').count(), 0);
  assert.match(await page.textContent('#preferences'), /клиент для панелей/);
  await page.click('#preferences [aria-label=Закрыть]');

  await app.close();
  console.log('Клиент проверен');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
