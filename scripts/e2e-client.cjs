'use strict';
// Проверка клиента для панелей. Обычный сценарий идёт в версии для преподавателей.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { hashPin } = require('../src/main/teachers');

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
  put({ kind: 'teacher', name: 'Лебедева О. В.', pin: await hashPin('123456') });
  put({ kind: 'group', name: 'ИС-21' });
  put({ title: 'Пара на панели', type: 'lesson', date: today, start: '00:05', end: '23:55', participants: [], devices: [] });

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

  const enterPin = async (pin) => {
    for (const digit of pin) await page.click(`#pinpad .pinkey:text-is("${digit}")`);
  };
  const refused = async (work) => assert.equal((await page.evaluate(work)).code, 'teacher-only');

  // Без PIN закрыто и на экране, и при прямом обращении к программе.
  for (const button of ['#open-catalog', '#open-reports', '#settings', '#notices-open']) {
    await page.click(button);
    await page.waitForSelector('#pinpad[open]');
    await page.click('#pinpad [aria-label=Закрыть]');
    await page.waitForSelector('#pinpad', { state: 'hidden' });
  }
  assert.equal(await page.locator('#catalog[open], #reports[open], #preferences[open], #notices[open]').count(), 0);
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

  // Добавить событие можно без PIN.
  await page.click('#add');
  await page.waitForSelector('#form[open]');
  await page.fill('#f-title', 'Событие студента');
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  await page.waitForSelector('.block:has-text("Событие студента")');

  // Изменить чужое можно только после входа, и вход заканчивается с окном.
  await page.click('.block:has-text("Пара на панели")');
  await page.waitForSelector('#details[open]');
  assert.equal(await page.locator('#details >> text=Служебная записка').count(), 0);
  await page.click('#details >> text=Изменить');
  await page.waitForSelector('#pinpad[open]');
  await enterPin('123456');
  await page.waitForSelector('#form[open]');
  await page.fill('#f-title', 'Пара с правкой');
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('.block:has-text("Пара с правкой")');
  await page.waitForTimeout(600);
  await refused(() => window.calendar.saveRefs([{ ref: { kind: 'group', name: 'Чужая' }, base: null }]));

  await page.click('#open-catalog');
  await page.waitForSelector('#pinpad[open]');
  await enterPin('123456');
  await page.waitForSelector('#catalog[open]');
  await page.click('#catalog [aria-label=Закрыть]');
  await page.waitForTimeout(600);
  await refused(() => window.calendar.saveRefs([{ ref: { kind: 'group', name: 'Чужая' }, base: null }]));

  await app.close();
  console.log('Клиент проверен');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
