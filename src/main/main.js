'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { execFile } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { LANGUAGES, loadConfig, saveConfig, splitPeers } = require('./config');
const { EventStore, PET_COATS_IDS, PET_KINDS, petKindLockKey, petKindLocked } = require('./store');
const { buildMemo, templateFields } = require('./memo');
const { SyncNode, generateKey } = require('./sync');
const { Access, POLICY_ID, fullCode, grantCode, newSecret, parseCode, secretPrint } = require('./access');
const { firewallState, repairFirewall } = require('./netcheck');

// Папка общая для всех учётных записей компьютера: на панелях их бывает несколько.
function homeDir() {
  if (process.env.KERDIIS_HOME) return process.env.KERDIIS_HOME;
  if (process.platform === 'win32' && process.env.ProgramData) {
    const home = path.join(process.env.ProgramData, 'Kerdiis');
    const old = path.join(process.env.ProgramData, 'StudentCalendar');
    // Установщик переносит папку. Если она была занята, данные остаются на старом месте.
    return !existsSync(home) && existsSync(old) ? old : home;
  }
  return app.getPath('userData');
}

/** Язык интерфейса. Если языка Windows нет среди наших, берём английский. */
function interfaceLanguage() {
  if (config.lang !== 'auto') return config.lang;
  const system = app.getLocale().split('-')[0];
  if (system === 'sah') return 'ru';
  return LANGUAGES.includes(system) ? system : 'en';
}

let win = null;
let splash = null;
let splashDone = false;
let mainReady = false;

const SPLASH_MS = 4500;

/** Главное окно показывается, когда визитка отработала и само окно готово. */
function revealMain() {
  if (!splashDone || !mainReady || !win) return;
  // Программа работает в обычном окне, развёрнутом на весь рабочий стол.
  win.maximize();
  win.show();
  win.focus();
}

function finishSplash() {
  if (splashDone) return;
  splashDone = true;
  splash?.close();
  revealMain();
}

/** Небольшая панель-визитка: отдельное окно без рамки по центру экрана. */
function createSplash() {
  splash = new BrowserWindow({
    width: 640,
    height: 360,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#161b22',
    title: 'Kerdi:s',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splash.once('ready-to-show', () => {
    splash.show();
    setTimeout(finishSplash, SPLASH_MS);
  });
  splash.on('closed', () => {
    splash = null;
    finishSplash();
  });
  splash.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));
}
let config = loadConfig(homeDir());
// Поля даты и времени рисует Chromium: язык ему нужен до запуска окна.
if (config.lang !== 'auto') app.commandLine.appendSwitch('lang', config.lang);
let store = null;
let edition = 'client';
let sync = null;
let syncProblem = null;


async function restartSync() {
  const previous = sync;
  sync = null;
  syncProblem = null;
  await previous?.stop();
  if (!config.syncKey) return;
  const node = new SyncNode({
    store,
    device: { id: config.deviceId, name: config.deviceName },
    networkKey: config.syncKey,
    peers: config.peers,
    peersFile: path.join(homeDir(), 'peers.json'),
    onChange: () => win?.webContents.send('events:changed'),
    version: app.getVersion(),
    edition,
    access: new Access(config.access),
  });
  try {
    await node.start();
    sync = node;
  } catch (err) {
    // Порт занят, например второй учётной записью на этом же компьютере.
    console.error('Обмен не запущен:', err.message);
    syncProblem = err.code === 'EADDRINUSE' ? 'port-busy' : 'failed';
    await node.stop();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    show: false,
    backgroundColor: '#0d1117',
    title: 'Kerdiis',
    fullscreenable: false,
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => {
    mainReady = true;
    revealMain();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // Панель работает днями без присмотра: упавшая страница должна подняться сама.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('Страница завершилась:', details.reason);
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) win.reload();
  });
  win.on('closed', () => {
    win = null;
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/** Ответы для страницы: ошибка записи не должна становиться исключением IPC. */
async function respond(work) {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    return { ok: false, code: err.code || 'io', message: err.message };
  }
}

let lastMemo = null;

/** Пишет записку в «Документы». Если файл открыт в Word, рядом появится копия. */
const BUILTIN_TEMPLATE = path.join(__dirname, '..', 'assets', 'memo-template.docx');
const customTemplate = () => path.join(homeDir(), 'memo-template.docx');
const activeTemplate = () => (existsSync(customTemplate()) ? customTemplate() : BUILTIN_TEMPLATE);

/** Проверяет шаблон до того, как заменить им текущий. */
async function installTemplate(file) {
  const data = await fs.readFile(file);
  let fields;
  try {
    fields = templateFields(data);
  } catch {
    throw Object.assign(new Error('not docx'), { code: 'not-docx' });
  }
  if (!fields.known.length) throw Object.assign(new Error('no fields'), { code: 'no-fields' });
  await fs.writeFile(customTemplate(), data);
  return fields;
}

/* Резервные копии: папка с датой, внутри копия данных и своего шаблона записки. */

const BACKUP_PREFIX = 'Kerdiis-';
const BACKUPS_KEPT = 30;
let backupProblem = null;

async function backupList() {
  try {
    return (await fs.readdir(config.backupDir)).filter((name) => name.startsWith(BACKUP_PREFIX)).sort();
  } catch {
    return [];
  }
}

const backupDate = (name) => name.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);

async function makeBackup() {
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `${BACKUP_PREFIX}${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  const target = path.join(config.backupDir, name);
  try {
    await fs.mkdir(target, { recursive: true });
    await fs.cp(path.join(config.dataDir, 'events'), path.join(target, 'events'), { recursive: true });
    if (existsSync(customTemplate())) await fs.copyFile(customTemplate(), path.join(target, 'memo-template.docx'));
    await fs.writeFile(path.join(target, 'info.txt'), `Kerdi:s ${app.getVersion()}\r\n${config.deviceName}\r\n${stamp.toISOString()}\r\n`);
    for (const old of (await backupList()).slice(0, -BACKUPS_KEPT)) {
      await fs.rm(path.join(config.backupDir, old), { recursive: true, force: true });
    }
    backupProblem = null;
    return name;
  } catch (err) {
    backupProblem = err.message;
    throw Object.assign(err, { code: 'backup-failed' });
  }
}

/** Компьютер преподавателя делает копию раз в день, при первом запуске или в течение дня. */
async function dailyBackup() {
  if (edition !== 'admin') return;
  const today = new Date().toLocaleDateString('sv');
  const last = (await backupList()).at(-1);
  if (last && backupDate(last) === today) return;
  await makeBackup().catch((err) => console.error('Резервная копия не создана:', err.message));
}

async function saveMemo(memo, fileName) {
  const template = await fs.readFile(activeTemplate());
  const folder = path.join(app.getPath('documents'), 'Служебные записки');
  await fs.mkdir(folder, { recursive: true });
  const base = fileName.replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const document = buildMemo(template, { ...memo, from: config.memoFrom, signer: config.memoSigner });
  for (let copy = 0; copy < 50; copy += 1) {
    const target = path.join(folder, `${base}${copy ? ` (${copy + 1})` : ''}.docx`);
    try {
      await fs.writeFile(target, document);
      lastMemo = target;
      return path.basename(target);
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
    }
  }
  throw new Error('Файл записки занят');
}

// Файл пишет системная задача обновления, см. build/update.ps1.
async function readUpdateStatus() {
  try {
    const file = path.join(process.env.ProgramFiles ?? '', 'KerdiisUpdate', 'status.json');
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * Версия: клиент для панелей или для преподавателей. Файл кладёт установщик
 * рядом с программой, куда у обычных пользователей нет записи. Переменная
 * окружения работает только при разработке, иначе ею мог бы воспользоваться любой.
 */
function readEdition() {
  if (!app.isPackaged) return process.env.KERDIIS_EDITION === 'client' ? 'client' : 'admin';
  try {
    return readFileSync(path.join(path.dirname(process.execPath), 'edition.txt'), 'utf8').trim() === 'admin' ? 'admin' : 'client';
  } catch {
    return 'client';
  }
}

/**
 * Часы для отметок. Для проверок их можно сдвинуть, но только вместе со своей папкой данных:
 * на рабочих данных панели время всегда настоящее.
 */
/** Часы программы: настоящие, а в проверках — заданные. */
const clockNow = (() => {
  const fake = Date.parse(process.env.KERDIIS_CLOCK ?? '');
  if (!process.env.KERDIIS_HOME || Number.isNaN(fake)) return () => Date.now();
  const offset = fake - Date.now();
  return () => Date.now() + offset;
})();

function storeClock() {
  const fake = Date.parse(process.env.KERDIIS_CLOCK ?? '');
  if (!process.env.KERDIIS_HOME || Number.isNaN(fake)) return () => Date.now();
  const offset = fake - Date.now();
  return () => Date.now() + offset;
}

/** Действия преподавателя: клиент на панели их не выполняет, даже если обойти кнопки. */
function managed(work) {
  return respond(async () => {
    if (edition === 'client') throw Object.assign(new Error('teacher only'), { code: 'teacher-only' });
    return work();
  });
}

function registerHandlers() {
  ipcMain.handle('events:list', () => respond(() => store.list()));
  // С панели можно добавить только практику и мероприятие: занятия и задания ведут преподаватели.
  const PANEL_TYPES = new Set(['practice', 'event']);
  const panelAllowed = (event) => edition !== 'client' || PANEL_TYPES.has(event?.type);
  const teacherOnly = () => Object.assign(new Error('teacher only'), { code: 'teacher-only' });
  ipcMain.handle('events:save', (_e, event, base) => {
    const save = async () => {
      if (!panelAllowed(event)) throw teacherOnly();
      // Добавленное с панели ждёт согласования преподавателем.
      const saved = await store.save(event, base, { pending: edition === 'client' });
      sync?.nudge();
      return saved;
    };
    // Новое событие можно добавить с панели, а менять уже записанные нельзя.
    return event?.id ? managed(save) : respond(save);
  });
  // Цепочка добавляется целиком; новые события можно добавлять и с панели.
  ipcMain.handle('events:save-many', (_e, events) => respond(async () => {
    // С панели — не больше 30 событий за раз: каждое преподаватель согласует отдельно.
    const limit = edition === 'client' ? 30 : 400;
    if (!Array.isArray(events) || events.length > limit || events.some((event) => event?.id)) {
      throw Object.assign(new Error('invalid'), { code: 'invalid' });
    }
    if (!events.every(panelAllowed)) throw teacherOnly();
    const saved = [];
    for (const event of events) saved.push(await store.save(event, null, { journal: saved.length === 0 && events.length === 1, pending: edition === 'client' }));
    // Цепочка в журнале одной строкой, а не сотней.
    if (saved.length > 1) {
      const first = saved[0];
      await store.journal('create-series', first, { from: first.date, to: saved.at(-1).date, count: saved.length });
    }
    sync?.nudge();
    return saved;
  }));
  ipcMain.handle('journal:list', () => managed(() => store.changes()));

  // Праздничное оформление: выбирает преподаватель, видят все устройства.
  ipcMain.handle('skin:get', () => respond(() => store.skin()));
  ipcMain.handle('skin:set', (_e, mode) => managed(async () => {
    const saved = await store.setSkin(String(mode));
    sync?.nudge();
    return saved;
  }));

  // Изменения мероприятий и заданий с панели: предлагает панель, утверждает преподаватель.
  ipcMain.handle('proposals:list', () => respond(() => store.proposals()));
  ipcMain.handle('proposals:add', (_e, eventId, changes, note) => respond(async () => {
    const proposal = await store.propose(String(eventId), changes, String(note ?? ''));
    sync?.nudge();
    return proposal;
  }));
  ipcMain.handle('proposals:resolve', (_e, id, approve) => managed(async () => {
    const saved = await store.resolveProposal(String(id), approve === true);
    sync?.nudge();
    return saved;
  }));

  // Практика и мероприятия, добавленные студентами с панели: согласует или отклоняет преподаватель.
  ipcMain.handle('events:approve', (_e, id, base) => managed(async () => {
    const saved = await store.approve(String(id), base ?? null);
    sync?.nudge();
    return saved;
  }));
  ipcMain.handle('events:decline', (_e, id, base) => managed(async () => {
    await store.decline(String(id), base ?? null);
    sync?.nudge();
    return true;
  }));

  // Перед массовым удалением всегда делается копия, чтобы ошибку в периоде можно было исправить.
  ipcMain.handle('events:remove-range', (_e, from, to, types) => managed(async () => {
    const backup = await makeBackup();
    const result = await store.removeRange(from, to, types);
    sync?.nudge();
    win?.webContents.send('events:changed');
    return { ...result, backup };
  }));
  ipcMain.handle('events:remove', (_e, id, base) => managed(async () => {
    await store.remove(id, base);
    sync?.nudge();
  }));

  ipcMain.handle('directory:list', () => respond(() => store.directory()));
  ipcMain.handle('directory:save', (_e, refs) => managed(async () => {
    const saved = [];
    // Ручные баллы и прошлые работы подписываются компьютером преподавателя: видно, кто поставил.
    const signed = (ref) => ['bonus', 'pastwork'].includes(ref?.kind);
    for (const { ref, base } of refs) saved.push(await store.saveRef(signed(ref) && !base ? { ...ref, by: config.deviceName } : ref, base));
    sync?.nudge();
    return saved;
  }));
  // Имя питомца группы могут менять и студенты на панелях: это единственная правка справочника с панели.
  ipcMain.handle('pet:name', (_e, groupId, name) => respond(async () => {
    const group = (await store.directory()).find((ref) => ref.kind === 'group' && ref.id === groupId);
    if (!group) throw Object.assign(new Error('no group'), { code: 'not-found' });
    const saved = await store.saveRef({ ...group, petName: String(name ?? '') }, group.updatedAt);
    sync?.nudge();
    return saved;
  }));
  // Вид питомца: студент на панели выбирает один раз, до смерти питомца. Преподаватель меняет вид через справочник.
  ipcMain.handle('pet:kind', (_e, groupId, kind) => respond(async () => {
    const group = (await store.directory()).find((ref) => ref.kind === 'group' && ref.id === groupId);
    if (!group) throw Object.assign(new Error('no group'), { code: 'not-found' });
    if (!PET_KINDS.includes(kind)) throw Object.assign(new Error('bad kind'), { code: 'invalid' });
    if (edition === 'client' && petKindLocked(group)) throw Object.assign(new Error('locked'), { code: 'locked' });
    const saved = await store.saveRef({ ...group, petKind: kind, petKindFor: petKindLockKey(group) }, group.updatedAt);
    sync?.nudge();
    return saved;
  }));
  // Наряд и окрас питомца студенты меняют на панели сами: что надеть из полученных призов и цвет шерсти.
  // Какие призы получены, считает экран по отметкам; здесь проверяется только, что это призы и окрасы.
  ipcMain.handle('pet:dress', (_e, groupId, changes) => respond(async () => {
    const group = (await store.directory()).find((ref) => ref.kind === 'group' && ref.id === groupId);
    if (!group) throw Object.assign(new Error('no group'), { code: 'not-found' });
    const next = { ...group };
    if (changes && typeof changes.look === 'object' && changes.look) next.petLook = changes.look;
    if (changes && 'coat' in changes) {
      if (changes.coat && !PET_COATS_IDS.includes(changes.coat)) throw Object.assign(new Error('bad coat'), { code: 'invalid' });
      next.petCoat = changes.coat;
    }
    const saved = await store.saveRef(next, group.updatedAt);
    sync?.nudge();
    return saved;
  }));
  // Дежурство вписывают сами студенты на панели: только на сегодня и вперёд, прошедшие дни — преподаватель.
  // Меняются только дежурные по датам (duty), и только на студентов этой группы и её подгрупп.
  const dutyGroup = async (groupId) => {
    const directory = await store.directory();
    const group = directory.find((ref) => ref.kind === 'group' && ref.id === groupId);
    if (!group) throw Object.assign(new Error('no group'), { code: 'not-found' });
    return { directory, group };
  };
  ipcMain.handle('duty:set', (_e, groupId, _code, changes) => respond(async () => {
    const { directory, group } = await dutyGroup(groupId);
    const now = new Date(clockNow());
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    // Подгруппы — как parentGroup в logic.mjs: «ИС-21-1» входит в «ИС-21».
    const key = (name) => String(name ?? '').trim().toLowerCase().replaceAll('ё', 'е');
    const groupIds = new Set(directory.filter((ref) => ref.kind === 'group'
      && (ref.id === group.id || key(String(ref.name).trim().match(/^(.+)-\d+$/)?.[1]) === key(group.name))).map((ref) => ref.id));
    const members = new Set(directory.filter((ref) => ref.kind === 'student' && groupIds.has(ref.groupId)).map((ref) => ref.name));
    const duty = { ...(group.duty ?? {}) };
    for (const [date, name] of Object.entries(changes && typeof changes === 'object' ? changes : {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('bad date'), { code: 'invalid' });
      if (edition === 'client' && date < today) throw Object.assign(new Error('past day'), { code: 'forbidden' });
      if (!name) delete duty[date];
      else if (members.has(name)) duty[date] = name;
      else throw Object.assign(new Error('not a member'), { code: 'invalid' });
    }
    const saved = await store.saveRef({ ...group, duty }, group.updatedAt);
    sync?.nudge();
    return saved;
  }));
  ipcMain.handle('directory:remove', (_e, refs) => managed(async () => {
    for (const { id, base } of refs) await store.remove(id, base);
    sync?.nudge();
  }));

  ipcMain.handle('attendance:list', () => respond(() => store.attendance()));
  ipcMain.handle('attendance:mark', (_e, eventId, name, status, options = {}) => respond(async () => {
    const admin = edition === 'admin';
    const doc = await store.saveMark(eventId, name, status, {
      teacher: admin ? config.deviceName : null,
      student: !admin,
      late: options.late === true,
      at: options.at ?? null,
      confirmed: options.confirmed === true,
    });
    sync?.nudge();
    return doc;
  }));
  // «Отметить всех» на перекличке: одной командой, приход — временем начала занятия.
  ipcMain.handle('attendance:mark-all', (_e, eventId, names, at) => respond(async () => {
    const admin = edition === 'admin';
    const when = at && !Number.isNaN(Date.parse(at)) && Date.parse(at) <= clockNow() + 60_000 ? at : null;
    let doc = null;
    for (const name of (Array.isArray(names) ? names : []).slice(0, 500)) {
      doc = await store.saveMark(eventId, String(name), 'present', { teacher: admin ? config.deviceName : null, student: !admin, at: when });
    }
    sync?.nudge();
    return doc;
  }));
  ipcMain.handle('attendance:start', (_e, eventId, at) => respond(async () => {
    const admin = edition === 'admin';
    const doc = await store.startLesson(eventId, { admin, at: admin ? at ?? null : null });
    sync?.nudge();
    return doc;
  }));
  // Панель фиксирует отчёт только начатого занятия; исправления после фиксации — у преподавателя.
  ipcMain.handle('attendance:lock', (_e, eventId, excused) => respond(async () => {
    if (edition !== 'admin') {
      const current = (await store.attendance()).find((doc) => doc.eventId === eventId);
      if (!current?.start) throw Object.assign(new Error('not started'), { code: 'teacher-only' });
    }
    const doc = await store.lockReport(eventId, config.deviceName, excused);
    sync?.nudge();
    return doc;
  }));

  ipcMain.handle('report:save', (_e, fileName, text, labels) => managed(async () => {
    const result = await dialog.showSaveDialog(win, {
      title: labels.title,
      defaultPath: path.join(app.getPath('documents'), fileName),
      filters: [{ name: labels.filter, extensions: ['csv'] }],
    });
    if (result.canceled) return false;
    await fs.writeFile(result.filePath, text, 'utf8');
    return true;
  }));

  ipcMain.handle('memo:create', (_e, memo, fileName) => managed(() => saveMemo(memo, fileName)));
  ipcMain.handle('memo:template', () => ({ custom: existsSync(customTemplate()) }));
  ipcMain.handle('memo:template-upload', (_e, file) => managed(async () => {
    let source = file;
    if (!source) {
      const result = await dialog.showOpenDialog(win, { filters: [{ name: 'Word', extensions: ['docx'] }], properties: ['openFile'] });
      if (result.canceled) return null;
      [source] = result.filePaths;
    }
    return installTemplate(source);
  }));
  ipcMain.handle('memo:template-download', () => respond(async () => {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), 'Шаблон служебной записки.docx'),
      filters: [{ name: 'Word', extensions: ['docx'] }],
    });
    if (result.canceled) return null;
    await fs.copyFile(activeTemplate(), result.filePath);
    shell.showItemInFolder(result.filePath);
    return path.basename(result.filePath);
  }));
  ipcMain.handle('memo:template-reset', () => managed(() => fs.rm(customTemplate(), { force: true })));
  ipcMain.handle('backup:status', async () => {
    const last = (await backupList()).at(-1);
    // Копия на том же диске, что и данные, не спасёт при поломке компьютера.
    const sameDisk = path.parse(path.resolve(config.backupDir)).root.toLowerCase() === path.parse(path.resolve(config.dataDir)).root.toLowerCase();
    const days = last ? Math.floor((Date.now() - Date.parse(`${backupDate(last)}T00:00`)) / 86400000) : null;
    return { dir: config.backupDir, last: last ? last.slice(BACKUP_PREFIX.length) : null, problem: backupProblem, sameDisk, days, admin: edition === 'admin' };
  });

  // Сводка для учебной части.
  const summaryDir = () => config.summaryDir || path.join(app.getPath('documents'), 'Kerdiis сводки');
  ipcMain.handle('summary:status', () => ({ auto: config.summaryAuto, dir: summaryDir(), week: config.summaryWeek }));
  ipcMain.handle('summary:set', (_e, auto) => managed(async () => {
    config = { ...config, summaryAuto: auto === true };
    saveConfig(homeDir(), config);
    return config.summaryAuto;
  }));
  ipcMain.handle('summary:choose-dir', () => managed(async () => {
    const result = await dialog.showOpenDialog(win, { defaultPath: summaryDir(), properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    config = { ...config, summaryDir: result.filePaths[0] };
    saveConfig(homeDir(), config);
    return config.summaryDir;
  }));
  ipcMain.handle('summary:write', (_e, fileName, text, week) => managed(async () => {
    const name = path.basename(String(fileName)).replace(/[<>:"/\\|?*]/g, '_');
    if (!name.endsWith('.csv')) throw Object.assign(new Error('bad name'), { code: 'invalid' });
    await fs.mkdir(summaryDir(), { recursive: true });
    const file = path.join(summaryDir(), name);
    await fs.writeFile(file, String(text), 'utf8');
    if (/^\d{4}-\d{2}-\d{2}$/.test(week ?? '')) {
      config = { ...config, summaryWeek: week };
      saveConfig(homeDir(), config);
    }
    return file;
  }));
  ipcMain.handle('summary:show', (_e, file) => shell.showItemInFolder(String(file)));
  ipcMain.handle('backup:now', () => managed(makeBackup));
  ipcMain.handle('backup:choose-dir', () => managed(async () => {
    const result = await dialog.showOpenDialog(win, { defaultPath: config.backupDir, properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    config = { ...config, backupDir: result.filePaths[0] };
    saveConfig(homeDir(), config);
    return config.backupDir;
  }));
  ipcMain.handle('backup:restore', (_e, folder) => managed(async () => {
    let chosen = folder;
    if (!chosen) {
      const result = await dialog.showOpenDialog(win, { defaultPath: config.backupDir, properties: ['openDirectory'] });
      if (result.canceled) return null;
      [chosen] = result.filePaths;
    }
    const events = existsSync(path.join(chosen, 'events')) ? path.join(chosen, 'events') : chosen;
    const restored = await store.restoreFrom(events);
    sync?.nudge();
    win?.webContents.send('events:changed');
    return restored;
  }));
  ipcMain.handle('memo:open', async () => {
    const problem = lastMemo ? await shell.openPath(lastMemo) : 'нет файла';
    return { ok: !problem };
  });
  ipcMain.handle('memo:reveal', () => {
    if (lastMemo) shell.showItemInFolder(lastMemo);
  });

  ipcMain.handle('update:status', readUpdateStatus);

  // Запускает системную задачу и ждёт её результат. Если новая версия найдена,
  // задача сама закроет программу, установит обновление и откроет её снова.
  ipcMain.handle('update:check', async () => {
    const before = (await readUpdateStatus())?.checkedAt;
    const schtasks = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');
    const started = await new Promise((resolve) => {
      execFile(schtasks, ['/Run', '/TN', 'KerdiisUpdate'], { windowsHide: true }, (err) => resolve(!err));
    });
    if (!started) return { ok: false };
    for (let i = 0; i < 45; i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 2000); });
      const status = await readUpdateStatus();
      if (status && status.checkedAt !== before) return { ok: true, status };
    }
    return { ok: true, status: null };
  });

  // Разделение по ПЦК. Включает и выдаёт коды компьютер с полным доступом (учебная часть).
  const accessPolicy = async () => (await store.records()).find((record) => record.id === POLICY_ID && !record.deleted) ?? null;
  const accessState = async () => {
    const policy = await accessPolicy();
    const access = new Access(config.access);
    return {
      enabled: Boolean(policy?.enabled),
      full: access.full && access.matches(policy),
      grants: access.full ? [] : [...access.grants.keys()],
      hasCode: Boolean(access.code),
    };
  };
  const applyAccess = async (code) => {
    const parsed = parseCode(code);
    if (code && !parsed) throw Object.assign(new Error('bad code'), { code: 'invalid' });
    const access = new Access(code);
    if (access.full && !access.matches(await accessPolicy())) throw Object.assign(new Error('other network'), { code: 'invalid' });
    config = { ...config, access: access.code };
    saveConfig(homeDir(), config);
    await restartSync();
    win?.webContents.send('events:changed');
    return accessState();
  };
  ipcMain.handle('access:get', () => respond(accessState));
  ipcMain.handle('access:enable', () => managed(async () => {
    const policy = await accessPolicy();
    const current = new Access(config.access);
    if (policy?.enabled) throw Object.assign(new Error('already'), { code: 'conflict' });
    // Повторное включение тем же компьютером — тем же секретом, коды остаются в силе.
    const code = current.full && current.matches(policy) ? current.code : fullCode(newSecret());
    config = { ...config, access: code };
    saveConfig(homeDir(), config);
    await store.savePolicy({ enabled: true, print: secretPrint(new Access(code).secret) });
    await restartSync();
    sync?.nudge();
    return accessState();
  }));
  ipcMain.handle('access:disable', () => managed(async () => {
    const policy = await accessPolicy();
    const access = new Access(config.access);
    if (!access.full || !access.matches(policy)) throw Object.assign(new Error('not full'), { code: 'forbidden' });
    await store.savePolicy({ enabled: false, print: policy.print });
    sync?.nudge();
    return accessState();
  }));
  // Код для другого компьютера: полный — для учебной, методической и воспитательной части, или с пропусками.
  ipcMain.handle('access:issue', (_e, grants) => managed(async () => {
    const access = new Access(config.access);
    if (!access.full || !access.matches(await accessPolicy())) throw Object.assign(new Error('not full'), { code: 'forbidden' });
    if (grants === 'all') return fullCode(access.secret);
    return grantCode(access.secret, (Array.isArray(grants) ? grants : []).map(String));
  }));
  // Код вводят в настройках версии для преподавателей и в мастере первого запуска (в том числе на панели).
  ipcMain.handle('access:apply', (_e, code) => (config.setupDone ? managed : respond)(() => applyAccess(String(code ?? '').trim())));

  ipcMain.handle('settings:get', () => ({
    deviceId: config.deviceId,
    deviceName: config.deviceName,
    edition,
    hasKey: Boolean(config.syncKey),
    syncKey: edition === 'admin' ? config.syncKey : '',
    peers: config.peers,
    showAll: config.showAll,
    theme: config.theme,
    uiSize: config.uiSize,
    lang: config.lang,
    setupDone: config.setupDone,
    memoFrom: config.memoFrom,
    memoSigner: config.memoSigner,
    version: app.getVersion(),
    platform: process.platform,
  }));

  ipcMain.handle('settings:save', (_e, settings) =>
    // Мастер первого запуска настраивает и клиент.
    (config.setupDone ? managed : respond)(async () => {
      const syncKey = String(settings.syncKey ?? '').trim();
      if (syncKey && syncKey.length < 12) throw Object.assign(new Error('short key'), { code: 'short-key' });
      const syncChanged = syncKey !== config.syncKey
        || settings.deviceName !== config.deviceName
        || splitPeers(settings.peers).join() !== config.peers.join();
      config = {
        ...config,
        deviceName: String(settings.deviceName ?? '').trim() || config.deviceName,
        syncKey,
        peers: splitPeers(settings.peers),
        showAll: Boolean(settings.showAll),
        theme: settings.theme ?? config.theme,
        memoFrom: String(settings.memoFrom ?? '').trim() || config.memoFrom,
        memoSigner: String(settings.memoSigner ?? '').trim() || config.memoSigner,
      };
      saveConfig(homeDir(), config);
      nativeTheme.themeSource = config.theme;
      if (syncChanged) await restartSync();
    }),
  );

  ipcMain.handle('theme:set', (_e, theme) => respond(() => {
    if (!['dark', 'light', 'system'].includes(theme)) return;
    config = { ...config, theme };
    nativeTheme.themeSource = theme;
    saveConfig(homeDir(), config);
  }));

  // Запрашивается страницей при загрузке, ещё до первого рисунка.
  ipcMain.on('i18n:language', (event) => { event.returnValue = interfaceLanguage(); });
  ipcMain.handle('setup:done', () => {
    config = { ...config, setupDone: true };
    saveConfig(homeDir(), config);
  });

  ipcMain.handle('lang:set', (_e, lang) => {
    if (!LANGUAGES.includes(lang) || lang === config.lang) return;
    config = { ...config, lang };
    saveConfig(homeDir(), config);
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('size:set', (_e, uiSize) => respond(() => {
    if (!['small', 'medium', 'large'].includes(uiSize)) return;
    config = { ...config, uiSize };
    saveConfig(homeDir(), config);
  }));

  // Печатается текущая страница: стили @media print оставляют на ней только лист.
  ipcMain.handle('paper:print', () => new Promise((resolve) => {
    win.webContents.print({ printBackground: false }, (success, reason) => {
      resolve({ ok: success || /cancel/i.test(String(reason)), printed: success, reason });
    });
  }));

  ipcMain.handle('paper:pdf', (_e, fileName, title) => respond(async () => {
    const result = await dialog.showSaveDialog(win, {
      title,
      defaultPath: path.join(app.getPath('documents'), fileName.replace(/[\\/:*?"<>|]/g, ' ')),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled) return false;
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: false, preferCSSPageSize: true });
    await fs.writeFile(result.filePath, pdf);
    return true;
  }));

  ipcMain.handle('sync:status', () => (sync ? sync.status() : { enabled: false, problem: syncProblem, peers: [], unreachable: [] }));
  ipcMain.handle('sync:now', async () => {
    await sync?.round({ all: true });
  });
  ipcMain.handle('sync:generate-key', () => generateKey());
  // Проверка и восстановление связи. Доступны и на панелях: там чаще всего и ломается.
  ipcMain.handle('sync:diagnose', () => respond(async () => {
    const windows = await firewallState(process.execPath);
    if (!sync) return { enabled: false, problem: syncProblem, hasKey: Boolean(config.syncKey), windows, version: app.getVersion(), edition, name: config.deviceName };
    return { enabled: true, ...(await sync.diagnose()), windows, manual: config.peers };
  }));
  ipcMain.handle('sync:add-peer', (_e, address) => respond(async () => {
    if (!sync) throw Object.assign(new Error('sync off'), { code: 'sync-off' });
    const result = await sync.addManual(address);
    const plain = result.address.endsWith(':47800') ? result.address.slice(0, -6) : result.address;
    if (!config.peers.includes(plain) && !config.peers.includes(result.address)) {
      config = { ...config, peers: [...config.peers, plain] };
      saveConfig(homeDir(), config);
    }
    return result;
  }));
  ipcMain.handle('sync:forget', () => respond(() => sync?.forgetStale() ?? 0));
  ipcMain.handle('sync:restart', () => respond(async () => {
    await restartSync();
    await sync?.round({ all: true });
    return Boolean(sync);
  }));
  ipcMain.handle('sync:repair-firewall', () => respond(async () => {
    const state = await repairFirewall(process.execPath);
    await restartSync();
    return state;
  }));

  ipcMain.handle('splash:skip', finishSplash);

}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    nativeTheme.themeSource = config.theme;
    store = new EventStore(config.dataDir, config.deviceId, { clock: storeClock(), deviceName: () => config.deviceName });
    edition = readEdition();
    registerHandlers();
    createSplash();
    createWindow();
    restartSync();
    setTimeout(dailyBackup, 60_000);
    setInterval(dailyBackup, 60 * 60_000);
    // Журнал старше полугода чистит каждое устройство: тогда старые записи не возвращаются при обмене.
    const prune = () => store.pruneChanges().catch((err) => console.error('Журнал не очищен:', err.message));
    setTimeout(prune, 90_000);
    setInterval(prune, 24 * 60 * 60_000);
  });

  app.on('before-quit', () => {
    sync?.stop();
  });

  app.on('window-all-closed', () => app.quit());
}
