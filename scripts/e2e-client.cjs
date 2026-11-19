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
  put({ title: 'Пара на панели', type: 'lesson', date: today, start: '00:05', end: '19:55', participants: ['Иванов', 'Петров', 'Сидоров', 'Козлов'], devices: [] });
  put({ title: 'Пара с перекличкой', type: 'lesson', date: today, start: '00:10', end: '01:30', participants: ['Алексеев', 'Борисов', 'Волков'], devices: [] });
  put({ title: 'Концерт на панели', type: 'event', date: today, start: '19:00', end: '19:30', participants: ['Сидоров'], devices: [] });
  put({ title: 'Физкультура выездная', type: 'lesson', date: today, start: '04:00', end: '05:00', offsite: true, participants: ['Иванов', 'Петров'], devices: [] });
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
  // На медленной машине окно заставки иногда закрывается позже: берём главное окно заново, если прежнее закрылось.
  await new Promise((resolve) => { setTimeout(resolve, 1500); });
  if (page.isClosed()) {
    page = app.windows().find((w) => !w.isClosed() && w.url().endsWith('index.html'));
    await page.waitForSelector('.block:has-text("Пара на панели")');
  }
  assert.equal((await page.evaluate(() => window.calendar.getSettings())).edition, 'client');
  // Часы окна совпадают с часами программы: 00:20, занятие идёт с 00:05.
  await page.clock.setFixedTime(new Date(`${today}T00:20`));

  const shot = (name) => (process.env.SHOTS ? page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) : null);
  const refused = async (work, arg) => assert.equal((await page.evaluate(work, arg)).code, 'teacher-only');

  // Разделов преподавателя нет ни на экране, ни при прямом обращении к программе.
  for (const button of ['#open-catalog', '#open-reports', '#notices-open', '#open-journal', '#open-signals']) {
    assert.equal(await page.$eval(button, (el) => el.hidden), true, button);
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
  // С панели — только практика и мероприятие, занятия и задания добавляют преподаватели.
  const panelTypes = await page.$$eval('#form .targets button[class^="t-"]', (buttons) => buttons.map((b) => b.className.split(' ')[0]));
  assert.deepEqual(panelTypes.filter((c) => ['t-lesson', 't-task', 't-practice', 't-event'].includes(c)), ['t-practice', 't-event']);
  assert.equal(await page.getAttribute('#form .targets .t-event', 'aria-pressed'), 'true');
  const forged = await page.evaluate(() => window.calendar.save({ title: 'Подделка', type: 'lesson', date: '2026-11-03', start: '10:00', end: '11:00', participants: [], equipment: [], devices: [] }, null));
  assert.equal(forged.code, 'teacher-only', 'занятие с панели не сохраняется');
  // Добавленное с панели ждёт согласования преподавателем.
  assert.equal((await page.textContent('dialog#form button[type=submit]')).trim(), 'Отправить на согласование');
  await page.click('dialog#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  await page.waitForSelector('.block.pending:has-text("Событие студента")');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('на согласование'));
  const studentEvent = (await page.evaluate(() => window.calendar.list())).value.find((e) => e.title === 'Событие студента');
  assert.deepEqual([studentEvent.pending, studentEvent.pendingFrom], [true, 'Ауд. 101']);
  await page.click('.block:has-text("Событие студента")');
  await page.waitForSelector('#details .pendingnote:has-text("Ждёт согласования")');
  assert.equal(await page.locator('#details #approve-event, #details #propose-event, #details .sheetfoot .primary').count(), 0, 'на панели не согласуют и не отмечают');
  await shot('client-pending');
  await page.click('#details [aria-label=Закрыть]');
  await refused((id) => window.calendar.approveEvent(id, null), studentEvent.id);
  await refused((id) => window.calendar.declineEvent(id, null), studentEvent.id);

  // Имя питомца студенты меняют и с панели, а остальное в группе панель не трогает.
  await page.waitForSelector('#pet-open:not([hidden])');
  await page.click('#pet-open');
  await page.waitForSelector('#pet[open]');
  await page.fill('#pet-name', 'Бублик');
  await page.click('#pet >> text=Назвать');
  await page.waitForSelector('#pet-open:has-text("Бублик")');
  const petGroup = (await page.evaluate(() => window.calendar.directory())).value.find((ref) => ref.kind === 'group');
  assert.equal(petGroup.petName, 'Бублик');
  assert.equal(petGroup.name, 'ИС-21');
  await shot('client-pet');
  await page.click('#pet [aria-label=Закрыть]');

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

  // Мероприятие с панели не меняется сразу: изменения уходят преподавателю на утверждение.
  await page.click('.block:has-text("Концерт на панели")');
  await page.click('#details #propose-event');
  await page.waitForSelector('#form[open] button[type=submit]:has-text("Отправить на утверждение")');
  await page.fill('#f-place', 'Актовый зал');
  await page.click('#form button[type=submit]');
  await page.waitForSelector('dialog#form', { state: 'hidden' });
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('на утверждение'));
  const proposals = (await page.evaluate(() => window.calendar.proposals())).value;
  assert.deepEqual(proposals.map((p) => p.changes), [{ place: 'Актовый зал' }]);
  const concert = (await page.evaluate(() => window.calendar.list())).value.find((e) => e.title === 'Концерт на панели');
  assert.equal(concert.place ?? '', '', 'до утверждения не меняется');
  await page.click('.block:has-text("Концерт на панели")');
  await page.waitForSelector('#details .proposalnote:has-text("Ауд. 101")');
  assert.equal(await page.locator('#details #review-proposal').count(), 0, 'утверждает только преподаватель');
  assert.equal((await page.evaluate((id) => window.calendar.resolveProposal(id, true), proposals[0].id)).code, 'teacher-only');
  await shot('client-proposal');
  await page.click('#details [aria-label=Закрыть]');

  // Занятие, которое идёт сейчас, открывается сразу кнопкой «Начать занятие».
  await page.click('.block:has-text("Пара на панели")');
  await page.waitForSelector('#roll[open][data-stage="start"] #start-lesson');
  await shot('client-start-stage');
  // Карточка — только просмотр.
  await page.click('#roll .sheetfoot >> text=Карточка занятия');
  await page.waitForSelector('#details[open]');
  for (const text of ['Изменить', 'Удалить', 'Служебная записка']) {
    assert.equal(await page.locator(`#details .plain:has-text("${text}")`).count(), 0, text);
  }
  await page.click('#details .primary');
  // Пока преподавателя нет, студенты отмечаются сами по обычному списку.
  await page.click('#skip-start');
  await page.waitForSelector('#roll[open][data-stage="list"] .rollrow');
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
  // Преподаватель пришёл позже: после «Начать занятие» идёт перекличка, пришедший до него уже не опоздал.
  await page.click('#start-lesson');
  await page.waitForSelector('#roll[data-stage="call"] .calltile[aria-pressed=true]:has-text("Иванов")');
  await page.waitForSelector('#roll .calltile[disabled]:has-text("Сидоров")');
  // Все отмечены или освобождены: можно сразу фиксировать, но мы ждём опоздавших.
  await page.waitForSelector('#roll .sheetfoot #lock-report');
  await page.click('#call-done');
  await page.waitForSelector('#roll[data-stage="live"] .livebar');
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
  // Не начатое занятие панель не фиксирует.
  await refused(async () => {
    const event = (await window.calendar.list()).value.find((item) => item.title === 'Физкультура выездная');
    return window.calendar.lockReport(event.id);
  });

  // Полный сценарий на панели: начать, «Отметить всех», снять отсутствующего, он пришёл позже, зафиксировать.
  await page.click('.block:has-text("Пара с перекличкой")');
  await page.waitForSelector('#roll[open][data-stage="start"]');
  await page.click('#start-lesson');
  await page.waitForSelector('#roll[data-stage="call"] #mark-all:has-text("Отметить всех (3)")');
  await page.click('#mark-all');
  await page.waitForSelector('#roll .calltile[aria-pressed=true]:has-text("Волков")');
  await page.click('#roll .calltile:has-text("Волков")');
  await page.waitForSelector('#roll .calltile[aria-pressed=false]:has-text("Волков")');
  await shot('client-call');
  assert.equal(await page.locator('#roll .sheetfoot #lock-report').count(), 0, 'не все отмечены — сначала перекличка');
  await page.click('#call-done');
  await page.waitForSelector('#roll[data-stage="live"] .livebar:has-text("Ещё не пришли: 1")');
  // Кого нет — сверху списка.
  assert.match(await page.textContent('#roll .rolllist li:first-child'), /Волков/);
  await shot('client-live');
  await page.click('.rollrow:has-text("Волков") .rollname');
  await page.waitForSelector('.rollrow:has-text("Волков") .rollname[aria-pressed=true]');
  await page.click('#lock-report');
  await page.waitForSelector('#lock-confirm');
  assert.match(await page.textContent('#roll .sheetfoot'), /Все отмечены/);
  await page.click('#lock-confirm');
  await page.waitForSelector('#roll .lockbanner:has-text("Ауд. 101")');
  assert.equal(await page.locator('#roll .rollname:not([disabled])').count(), 0, 'после фиксации панель не правит');
  await page.click('#roll [aria-label=Закрыть]');
  assert.equal((await page.evaluate((id) => window.calendar.mark(id, 'Иванов', 'present', {}), lockedId)).code, 'locked');

  for (const call of [() => window.calendar.removeRange('2000-01-01', '2100-01-01', ['lesson']), () => window.calendar.backupNow(), () => window.calendar.restoreBackup('C:\\'), () => window.calendar.resetTemplate()]) {
    assert.equal((await page.evaluate(call)).code, 'teacher-only');
  }

  // Пара вне колледжа: на панели только просмотр.
  await page.click('.block:has-text("Физкультура выездная")');
  await page.waitForSelector('#details:has-text("Проходит вне колледжа")');
  await page.click('#details >> text=/Отметка:/');
  await page.waitForSelector('#roll[open] .lockbanner:has-text("вне колледжа")');
  assert.equal(await page.locator('#roll .rollname:not([disabled])').count(), 0, 'имена не нажимаются');
  assert.equal(await page.locator('#roll #start-lesson, #roll .sheetfoot button').count(), 0, 'нет начала и фиксации');
  assert.match(await page.textContent('#roll .rollrow:has-text("Иванов")'), /Нет отметки|Нажмите/);
  await page.click('#roll [aria-label=Закрыть]');

  // Грейд виден и на панели.
  await page.click('#open-sections');
  await page.click('#open-grade');
  await page.waitForSelector('#grade[open] h2:has-text("Грейд студентов")');
  assert.equal(await page.locator('#grade .gradetable .linkbutton').count(), 0, 'личное дело на панели не открывается');
  assert.equal(await page.locator('#grade .gradetable button:has-text("±")').count(), 0, 'баллы вручную на панели не добавляют');
  await page.click('#grade [aria-label=Закрыть]');

  // Табло перемены: через минуту без касаний панель показывает следующее в аудитории, касание убирает.
  await page.clock.setFixedTime(new Date(`${today}T20:30`));
  await page.waitForSelector('#breakboard:not([hidden]) .boardroom:has-text("Ауд. 101")', { timeout: 15000 });
  await shot('client-breakboard');
  await page.mouse.click(400, 400);
  await page.waitForSelector('#breakboard', { state: 'hidden' });

  // В настройках только язык, размер и версия.
  await page.click('#settings');
  await page.waitForSelector('#preferences[open]');
  assert.equal(await page.locator('#s-name, #s-key, #s-peers, #s-all').count(), 0);
  assert.match(await page.textContent('#preferences'), /клиент для панелей/);
  await page.click('#preferences [aria-label=Закрыть]');

  // Индикатор связи есть и на панели: без ключа — «Обмен выключен», проверка объясняет почему.
  await page.waitForSelector('#net[data-level="off"]:has-text("Обмен выключен")');
  await page.click('#net');
  await page.waitForSelector('#netcheck .netchecks li.bad:has-text("Ключ сети не введён")');
  await shot('client-netcheck');
  await page.click('#netcheck [aria-label=Закрыть]');

  await app.close();
  console.log('Клиент проверен');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
