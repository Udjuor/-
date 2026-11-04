'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { LANGUAGES, loadConfig, saveConfig, splitPeers } = require('./config');
const { EventStore } = require('./store');
const { buildMemo } = require('./memo');
const { SyncNode, generateKey } = require('./sync');

// Папка общая для всех учётных записей компьютера: на панелях их бывает несколько.
function homeDir() {
  if (process.env.STUDENT_CALENDAR_HOME) return process.env.STUDENT_CALENDAR_HOME;
  if (process.platform === 'win32' && process.env.ProgramData) {
    return path.join(process.env.ProgramData, 'StudentCalendar');
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
let config = loadConfig(homeDir());
// Поля даты и времени рисует Chromium: язык ему нужен до запуска окна.
if (config.lang !== 'auto') app.commandLine.appendSwitch('lang', config.lang);
let store = null;
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
    fullscreen: config.fullscreen,
    backgroundColor: '#0d1117',
    title: 'Paratus Hora',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => {
    if (!config.fullscreen) win.maximize();
    win.show();
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
async function saveMemo(memo, fileName) {
  const template = await fs.readFile(path.join(__dirname, '..', 'assets', 'memo-template.docx'));
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
    const file = path.join(process.env.ProgramFiles ?? '', 'StudentCalendarUpdate', 'status.json');
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function registerHandlers() {
  ipcMain.handle('events:list', () => respond(() => store.list()));
  ipcMain.handle('events:save', (_e, event, base) => respond(async () => {
    const saved = await store.save(event, base);
    sync?.nudge();
    return saved;
  }));
  ipcMain.handle('events:remove', (_e, id, base) => respond(async () => {
    await store.remove(id, base);
    sync?.nudge();
  }));

  ipcMain.handle('directory:list', () => respond(() => store.directory()));
  ipcMain.handle('directory:save', (_e, refs) => respond(async () => {
    const saved = [];
    for (const { ref, base } of refs) saved.push(await store.saveRef(ref, base));
    sync?.nudge();
    return saved;
  }));
  ipcMain.handle('directory:remove', (_e, refs) => respond(async () => {
    for (const { id, base } of refs) await store.remove(id, base);
    sync?.nudge();
  }));

  ipcMain.handle('attendance:list', () => respond(() => store.attendance()));
  ipcMain.handle('attendance:mark', (_e, eventId, name, status) => respond(async () => {
    const doc = await store.saveMark(eventId, name, status);
    sync?.nudge();
    return doc;
  }));

  ipcMain.handle('report:save', (_e, fileName, text, labels) => respond(async () => {
    const result = await dialog.showSaveDialog(win, {
      title: labels.title,
      defaultPath: path.join(app.getPath('documents'), fileName),
      filters: [{ name: labels.filter, extensions: ['csv'] }],
    });
    if (result.canceled) return false;
    await fs.writeFile(result.filePath, text, 'utf8');
    return true;
  }));

  ipcMain.handle('memo:create', (_e, memo, fileName) => respond(() => saveMemo(memo, fileName)));
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
      execFile(schtasks, ['/Run', '/TN', 'StudentCalendarUpdate'], { windowsHide: true }, (err) => resolve(!err));
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
    syncKey: config.syncKey,
    peers: config.peers,
    showAll: config.showAll,
    theme: config.theme,
    uiSize: config.uiSize,
    lang: config.lang,
    memoFrom: config.memoFrom,
    memoSigner: config.memoSigner,
    fullscreen: win ? win.isFullScreen() : config.fullscreen,
    version: app.getVersion(),
  }));

  ipcMain.handle('settings:save', (_e, settings) =>
    respond(async () => {
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

  ipcMain.handle('window:minimize', () => {
    if (win) win.minimize();
  });
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
    store = new EventStore(config.dataDir, config.deviceId);
    registerHandlers();
    createWindow();
    restartSync();
  });

  app.on('before-quit', () => {
    sync?.stop();
  });

  app.on('window-all-closed', () => app.quit());
}
