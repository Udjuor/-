'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { execFile } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { LANGUAGES, loadConfig, saveConfig, splitPeers } = require('./config');
const { EventStore } = require('./store');
const { buildMemo, templateFields } = require('./memo');
const { SyncNode, generateKey, localNetworks } = require('./sync');
const { StudentPortal, PORTAL_PORT } = require('./portal');

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
  // Полный экран только здесь: заданный при создании окна, он показал бы его раньше панели.
  // И только после показа: на скрытом окне панель задач Windows остаётся поверх нижней строки.
  if (!config.fullscreen) win.maximize();
  win.show();
  win.focus();
  if (config.fullscreen) win.setFullScreen(true);
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

let portal = null;
let portalProblem = null;

/** Адреса страницы. Выбранный в настройках адрес идёт первым: он попадает в QR-код. */
const portalUrls = (port) => {
  const addresses = localNetworks().addresses;
  const chosen = addresses.includes(config.portalAddress) ? [config.portalAddress] : [];
  return [...chosen, ...addresses.filter((address) => address !== config.portalAddress)].map((address) => `http://${address}:${port}/`);
};

/** Сеть могла смениться (подключили роутер): адреса на панелях обновляются сами. */
async function refreshPortalUrls() {
  if (!portal) return;
  await store.setPortal(portalUrls(portal.port), config.deviceName, true).catch(() => {});
  sync?.nudge();
}

/** Студенческая страница: запускается на компьютере преподавателя, если включена в настройках. */
async function restartPortal() {
  const previous = portal;
  portal = null;
  portalProblem = null;
  await previous?.stop();
  const wanted = edition === 'admin' && config.portal;
  if (!wanted) {
    if (previous) await store.setPortal([], config.deviceName, false).catch(() => {});
    sync?.nudge();
    return;
  }
  const logic = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'logic.mjs')).href);
  const node = new StudentPortal({
    store,
    logic,
    clock: clockNow,
    port: Number(process.env.KERDIIS_PORTAL_PORT) || PORTAL_PORT,
    onChange: () => {
      sync?.nudge();
      win?.webContents.send('events:changed');
    },
  });
  try {
    const port = await node.start();
    portal = node;
    await store.setPortal(portalUrls(port), config.deviceName, true);
    sync?.nudge();
  } catch (err) {
    console.error('Студенческая страница не запущена:', err.message);
    portalProblem = err.code === 'EADDRINUSE' ? 'port-busy' : 'failed';
    await node.stop();
  }
}

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
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
  // Свои кнопки «Свернуть» и «Закрыть» нужны только на весь экран: в окне есть обычная рамка.
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('window:fullscreen', false));
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
  ipcMain.handle('events:save', (_e, event, base) => {
    const save = async () => {
      const saved = await store.save(event, base);
      sync?.nudge();
      return saved;
    };
    // Новое событие можно добавить с панели, а менять уже записанные нельзя.
    return event?.id ? managed(save) : respond(save);
  });
  // Цепочка добавляется целиком; новые события можно добавлять и с панели.
  ipcMain.handle('events:save-many', (_e, events) => respond(async () => {
    if (!Array.isArray(events) || events.length > 400 || events.some((event) => event?.id)) {
      throw Object.assign(new Error('invalid'), { code: 'invalid' });
    }
    const saved = [];
    for (const event of events) saved.push(await store.save(event, null, { journal: saved.length === 0 && events.length === 1 }));
    // Цепочка в журнале одной строкой, а не сотней.
    if (saved.length > 1) {
      const first = saved[0];
      await store.journal('create-series', first, { from: first.date, to: saved.at(-1).date, count: saved.length });
    }
    sync?.nudge();
    return saved;
  }));
  ipcMain.handle('journal:list', () => managed(() => store.changes()));

  // Студенческая страница.
  ipcMain.handle('portal:status', () => ({
    on: config.portal,
    running: Boolean(portal),
    problem: portalProblem,
    urls: portal ? portalUrls(portal.port) : [],
    addresses: localNetworks().addresses,
    address: config.portalAddress,
  }));
  ipcMain.handle('portal:address', (_e, address) => managed(async () => {
    config = { ...config, portalAddress: localNetworks().addresses.includes(address) ? address : '' };
    saveConfig(homeDir(), config);
    await refreshPortalUrls();
    return config.portalAddress;
  }));
  ipcMain.handle('portal:set', (_e, on) => managed(async () => {
    config = { ...config, portal: on === true };
    saveConfig(homeDir(), config);
    await restartPortal();
    return Boolean(portal) === config.portal;
  }));
  ipcMain.handle('portal:info', () => respond(() => store.portal()));
  ipcMain.handle('presence:today', () => respond(() => {
    const d = new Date(clockNow());
    return store.presenceOn(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }));
  ipcMain.handle('student:code', (_e, id) => managed(async () => {
    const code = await store.studentCode(id);
    sync?.nudge();
    return code;
  }));
  ipcMain.handle('student:unbind', (_e, id) => managed(async () => {
    await store.unbindPhone(id);
    sync?.nudge();
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
    for (const { ref, base } of refs) saved.push(await store.saveRef(ref, base));
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
  ipcMain.handle('attendance:start', (_e, eventId, at) => respond(async () => {
    const admin = edition === 'admin';
    const doc = await store.startLesson(eventId, { admin, at: admin ? at ?? null : null });
    sync?.nudge();
    return doc;
  }));
  ipcMain.handle('attendance:lock', (_e, eventId, excused) => managed(async () => {
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
    return { dir: config.backupDir, last: last ? last.slice(BACKUP_PREFIX.length) : null, problem: backupProblem };
  });
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
    fullscreen: win ? win.isFullScreen() : config.fullscreen,
    version: app.getVersion(),
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
        fullscreen: Boolean(settings.fullscreen),
        theme: settings.theme ?? config.theme,
        memoFrom: String(settings.memoFrom ?? '').trim() || config.memoFrom,
        memoSigner: String(settings.memoSigner ?? '').trim() || config.memoSigner,
      };
      saveConfig(homeDir(), config);
      nativeTheme.themeSource = config.theme;
      if (win) win.setFullScreen(config.fullscreen);
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

  ipcMain.handle('splash:skip', finishSplash);

  ipcMain.handle('window:minimize', () => {
    if (win) win.minimize();
  });
  ipcMain.handle('window:quit', () => app.quit());
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
    restartSync().then(restartPortal);
    setTimeout(dailyBackup, 60_000);
    setInterval(dailyBackup, 60 * 60_000);
    setInterval(refreshPortalUrls, 60_000);
    // Журнал старше полугода чистит каждое устройство: тогда старые записи не возвращаются при обмене.
    const prune = () => store.pruneChanges().catch((err) => console.error('Журнал не очищен:', err.message));
    setTimeout(prune, 90_000);
    setInterval(prune, 24 * 60 * 60_000);
  });

  app.on('before-quit', () => {
    sync?.stop();
    portal?.stop();
  });

  app.on('window-all-closed', () => app.quit());
}
