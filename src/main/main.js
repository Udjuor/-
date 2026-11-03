'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadConfig, saveConfig, splitPeers } = require('./config');
const { EventStore } = require('./store');
const { SyncNode, generateKey } = require('./sync');

// Папка общая для всех учётных записей компьютера: на панелях их бывает несколько.
function homeDir() {
  if (process.env.STUDENT_CALENDAR_HOME) return process.env.STUDENT_CALENDAR_HOME;
  if (process.platform === 'win32' && process.env.ProgramData) {
    return path.join(process.env.ProgramData, 'StudentCalendar');
  }
  return app.getPath('userData');
}

// Подписи в полях даты и времени — по-русски и в 24-часовом формате.
app.commandLine.appendSwitch('lang', 'ru');

let win = null;
let config = null;
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
    title: 'Календарь мероприятий',
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

  ipcMain.handle('report:save', (_e, fileName, text) => respond(async () => {
    const result = await dialog.showSaveDialog(win, {
      title: 'Сохранить отчёт',
      defaultPath: path.join(app.getPath('documents'), fileName),
      filters: [{ name: 'Таблица для Excel', extensions: ['csv'] }],
    });
    if (result.canceled) return false;
    await fs.writeFile(result.filePath, text, 'utf8');
    return true;
  }));

  // Файл пишет системная задача обновления, см. build/update.ps1.
  ipcMain.handle('update:status', async () => {
    try {
      const file = path.join(process.env.ProgramFiles ?? '', 'StudentCalendarUpdate', 'status.json');
      return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  });

  ipcMain.handle('settings:get', () => ({
    deviceId: config.deviceId,
    deviceName: config.deviceName,
    syncKey: config.syncKey,
    peers: config.peers,
    showAll: config.showAll,
    theme: config.theme,
    uiSize: config.uiSize,
    fullscreen: win ? win.isFullScreen() : config.fullscreen,
    version: app.getVersion(),
  }));

  ipcMain.handle('settings:save', (_e, settings) =>
    respond(async () => {
      const syncKey = String(settings.syncKey ?? '').trim();
      if (syncKey && syncKey.length < 12) {
        throw Object.assign(new Error('Ключ сети должен быть не короче 12 символов'), { code: 'invalid' });
      }
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

  ipcMain.handle('size:set', (_e, uiSize) => respond(() => {
    if (!['small', 'medium', 'large'].includes(uiSize)) return;
    config = { ...config, uiSize };
    saveConfig(homeDir(), config);
  }));

  // Печатается текущая страница: стили @media print оставляют на ней только лист.
  ipcMain.handle('paper:print', () => new Promise((resolve) => {
    win.webContents.print({ printBackground: false }, (success, reason) => {
      resolve({ ok: success || reason === 'Print job canceled', printed: success, reason });
    });
  }));

  ipcMain.handle('paper:pdf', (_e, fileName) => respond(async () => {
    const result = await dialog.showSaveDialog(win, {
      title: 'Сохранить техническое задание',
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
    config = loadConfig(homeDir());
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
