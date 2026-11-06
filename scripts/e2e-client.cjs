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
  put({ title: 'Пара на панели', type: 'lesson', date: today, start: '00:05', end: '23:55', participants: ['Иванов'], devices: [] });
  const lockedId = put({ title: 'Закрытая пара', type: 'lesson', date: today, start: '06:00', end: '07:00', participants: ['Иванов'], devices: [] });
  const hex = crypto.createHash('sha256').update(`attendance:${lockedId}`).digest('hex');
  const docId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  fs.writeFileSync(path.join(events, `${docId}.json`), JSON.stringify({
    id: docId, kind: 'attendance', eventId: lockedId, marks: {}, lock: { at: '2026-11-01T00:00:00.000Z', teacher: 'Кабинет', participants: ['Иванов'] }, history: [], updatedAt: '2026-11-01T00:00:00.000Z',
  }));

  const app = await _electron.launch({
    executablePath: process.env.CAL_EXE,
    args: (process.env.CAL_ARGS ?? '').split(' ').filter(Boolean),
    env: { ...process.env, KERDIIS_HOME: home, KERDIIS_EDITION: 'client' },
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

  const refused = async (work) => assert.equal((await page.evaluate(work)).code, 'teacher-only');

  // Разделов преподавателя нет ни на экране, ни при прямом обращении к программе.
  for (const button of ['#open-catalog', '#open-reports', '#notices-open']) {
    assert.equal(await page.isVisible(button), false, button);
  }
  await refused(() => window.calendar.saveRefs([{ ref: { kind: 'group', name: 'Чужая' }, base: null }]));
  await refused(() => window.calendar.saveSettings({ deviceName: 'Взлом' }));
  await refused(async () => {
    const list = (await window.calendar.list()).value;
    return window.calendar.remove(list[0].id, list[0].updatedAt);
  });
  await refused(async () => {
    const [event] = (await window.calendar.list()).value;
    return window.calendar.save({ ...event, title: 'Подмена' }, event.updatedAt);
  });

  // Добавить событие можно и на клиенте.
  await page.click('#add');
  await page.waitForSelector('#form[open]');
  await page.fill('#f-title', 'Событие студента');
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  await page.waitForSelector('.block:has-text("Событие студента")');

  // В карточке только просмотр, в отметках только своё присутствие.
  await page.click('.block:has-text("Пара на панели")');
  await page.waitForSelector('#details[open]');
  for (const text of ['Изменить', 'Удалить', 'Служебная записка']) {
    assert.equal(await page.locator(`#details .plain:has-text("${text}")`).count(), 0, text);
  }
  await page.click('#details .primary');
  await page.waitForSelector('#roll[open]');
  assert.equal(await page.locator('.rollrow .reason').count(), 0);
  assert.equal(await page.locator('#lock-report').count(), 0);
  await page.click('.rollrow:has-text("Иванов") .rollname');
  await page.waitForSelector('.rollrow:has-text("Иванов") .rollname[aria-pressed=true]');
  await page.click('#roll [aria-label=Закрыть]');
  await refused(async () => {
    const [event] = (await window.calendar.list()).value;
    return window.calendar.mark(event.id, 'Иванов', 'sick', {});
  });
  await refused(async () => {
    const [event] = (await window.calendar.list()).value;
    return window.calendar.lockReport(event.id);
  });
  assert.equal((await page.evaluate((id) => window.calendar.mark(id, 'Иванов', 'present', {}), lockedId)).code, 'locked');

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
