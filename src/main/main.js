'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, saveConfig } = require('./config');
const { EventStore } = require('./store');

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

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    show: false,
    fullscreen: config.fullscreen,
    backgroundColor: '#1d3f36',
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
  ipcMain.handle('events:save', (_e, event, base) => respond(() => store.save(event, base)));
  ipcMain.handle('events:remove', (_e, id, base) => respond(() => store.remove(id, base)));

  ipcMain.handle('settings:get', () => ({
    dataDir: config.dataDir,
    fullscreen: win ? win.isFullScreen() : config.fullscreen,
    version: app.getVersion(),
  }));

  ipcMain.handle('settings:save', (_e, settings) =>
    respond(async () => {
      const dataDir = String(settings.dataDir || '').trim();
      if (!dataDir) throw new Error('Укажите папку с мероприятиями');
      await fs.promises.mkdir(path.join(dataDir, 'events'), { recursive: true });
      config = { dataDir, fullscreen: Boolean(settings.fullscreen) };
      saveConfig(homeDir(), config);
      store = new EventStore(config.dataDir);
      if (win) win.setFullScreen(config.fullscreen);
    }),
  );

  ipcMain.handle('settings:pick-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Папка с мероприятиями',
      defaultPath: config.dataDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

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
    store = new EventStore(config.dataDir);
    registerHandlers();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
