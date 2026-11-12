import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, globalShortcut, Menu, nativeTheme, safeStorage, session, shell, type MenuItemConstructorOptions } from 'electron';
import type { AiModel } from '../shared/ai.ts';
import type { ApiEvents } from '../shared/api.ts';
import type { ClipServiceId } from '../shared/clips.ts';
import { APP_NAME, DATA_FOLDER } from '../shared/constants.ts';
import { ScriptWriter } from './ai.ts';
import { AiCatalog } from './ai/catalog.ts';
import { fal } from './ai/fal.ts';
import { AiJobs } from './ai/jobs.ts';
import { KeyStore } from './ai/keys.ts';
import { replicate } from './ai/replicate.ts';
import { runway } from './ai/runway.ts';
import falSnapshot from './ai/snapshot-fal.json';
import runwaySnapshot from './ai/snapshot-runway.json';
import { AssetManager } from './assets.ts';
import { FreeClips } from './clips/freeClips.ts';
import { pexels } from './clips/pexels.ts';
import { pixabay } from './clips/pixabay.ts';
import { registerIpc } from './ipc.ts';
import { LibraryStore } from './library.ts';
import { handleMediaProtocol, registerMediaScheme } from './mediaProtocol.ts';
import { Paths } from './paths.ts';
import { PhoneUpload } from './phone.ts';
import { Recorder } from './recorder.ts';
import { RenderJobs } from './renderJobs.ts';
import { setupUpdater } from './updater.ts';

// A separate data folder can be given for testing, so tests never touch the real library.
if (process.env.VIEWEDITOR_DATA_DIR) app.setPath('userData', process.env.VIEWEDITOR_DATA_DIR);
// Otherwise the data folder keeps the app's first name, ViewEditor, so copies from before it became
// Homecut keep their library, settings and keys.
else app.setPath('userData', join(app.getPath('appData'), DATA_FOLDER));
app.setName(APP_NAME);
registerMediaScheme();

let mainWindow: BrowserWindow | null = null;
/** True from the moment the user asks the whole app to quit (as opposed to closing the window on a Mac). */
let quitting = false;
/** Asked before the window closes; returning false keeps it open. */
let confirmClose: ((win: BrowserWindow) => boolean) | null = null;

/** Closing the window pauses a quit in progress so the page can save, so the quit has to be picked up again here. */
function destroyWindow(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.destroy();
  if (quitting) app.quit();
}

function send<K extends keyof ApiEvents>(event: K, payload: ApiEvents[K]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, payload);
}

// ---------------------------------------------------------------- window

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const stateFile = (): string => join(app.getPath('userData'), 'window.json');

function loadWindowState(): WindowState {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState;
    if (s.width >= 800 && s.height >= 600) return s;
  } catch {
    // First run.
  }
  return { width: 1440, height: 900 };
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const maximized = win.isMaximized();
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    writeFileSync(stateFile(), JSON.stringify({ ...bounds, maximized }));
  } catch {
    // Not worth interrupting a quit for.
  }
}

function createWindow(): BrowserWindow {
  const state = loadWindowState();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1014' : '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The editor starts and stops playback from code, not only from clicks.
      autoplayPolicy: 'no-user-gesture-required',
      // Recording has to keep running while the window is minimised.
      backgroundThrottling: false,
    },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // The app is a single local page: it never navigates away and never opens child windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }

  // Give the editor a moment to write unsaved changes before the window goes away.
  let closing = false;
  win.on('close', (event) => {
    saveWindowState(win);
    if (closing) return;
    if (confirmClose && !confirmClose(win)) {
      event.preventDefault();
      quitting = false;
      return;
    }
    closing = true;
    event.preventDefault();
    send('app:closing', null);
    setTimeout(() => destroyWindow(win), 2500);
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

// ---------------------------------------------------------------- menu

function buildMenu(): void {
  if (process.platform !== 'darwin') {
    // Windows and Linux: no menu bar; every command lives in the window itself.
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS routes shortcuts through the menu. Undo, redo and select-all are forwarded to the page,
  // which applies them to the timeline or to the focused text field as appropriate.
  const forward = (action: ApiEvents['menu:action']) => (): void => send('menu:action', action);
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'Cmd+Z', click: forward('undo') },
        { label: 'Redo', accelerator: 'Shift+Cmd+Z', click: forward('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Select All', accelerator: 'Cmd+A', click: forward('selectAll') },
      ],
    },
    { role: 'windowMenu' },
  ];
  if (!app.isPackaged) template.push({ role: 'viewMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- startup

async function start(): Promise<void> {
  const lib = new LibraryStore(new Paths(join(app.getPath('userData'), 'library')));
  await lib.init();

  const assets = new AssetManager(lib);
  const jobs = new RenderJobs(lib, (p) => send('render:progress', p));
  const recorder = new Recorder(lib, assets, () => mainWindow);
  const writer = new ScriptWriter(join(app.getPath('userData'), 'anthropic.key'), () => lib.data.settings.claudeCode);
  const phone = new PhoneUpload(lib, assets, (r) => send('phone:received', r));

  const userData = app.getPath('userData');
  const aiProviders = [fal, runway, replicate];
  const cipher = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text: string) => safeStorage.encryptString(text),
    decrypt: (data: Buffer) => safeStorage.decryptString(data),
  };
  const aiKeys = new KeyStore(join(userData, 'ai-keys.json'), cipher);
  await aiKeys.load();
  const aiCatalog = new AiCatalog(userData, aiProviders, aiKeys, { fal: falSnapshot as AiModel[], runway: runwaySnapshot as AiModel[] });
  const aiJobs = new AiJobs({ lib, assets, keys: aiKeys, catalog: aiCatalog, providers: aiProviders, pollMs: Number(process.env.VIEWEDITOR_AI_POLL_MS) || undefined });

  const clipKeys = new KeyStore<ClipServiceId>(join(userData, 'clip-keys.json'), cipher);
  await clipKeys.load();
  const clips = new FreeClips({ lib, assets, keys: clipKeys, services: [pexels, pixabay], searchDir: join(userData, 'clip-searches'), onProgress: (p) => send('clips:progress', p) });
  void clips.tidySearches();

  if (lib.data.settings.hasApiKey !== writer.hasKey()) lib.updateSettings({ hasApiKey: writer.hasKey() });
  nativeTheme.themeSource = lib.data.settings.theme;

  // Many small changes can land in one tick (an import touches the index several times); send one update.
  let pending = false;
  lib.on('changed', () => {
    if (nativeTheme.themeSource !== lib.data.settings.theme) nativeTheme.themeSource = lib.data.settings.theme;
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      send('library:changed', lib.data);
    }, 15);
  });
  lib.on('error', (err) => console.error('Could not save the library:', err));
  assets.onImportProgress = (p) => send('assets:importing', p);

  handleMediaProtocol(lib, (key, what) => clips.address(key, what));
  recorder.install();

  // Camera, microphone and screen capture are used by the recorder; nothing else is granted.
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  registerIpc({
    lib, assets, jobs, recorder, writer, phone, aiProviders, aiKeys, aiCatalog, aiJobs, clips,
    updater: setupUpdater((state) => send('update:changed', state)),
    window: () => mainWindow,
    readyToClose: () => {
      if (mainWindow) destroyWindow(mainWindow);
    },
  });

  confirmClose = (win) => {
    if (!jobs.current()) return true;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep rendering', 'Close and cancel the export'],
      defaultId: 0,
      cancelId: 0,
      message: 'A video is still rendering.',
      detail: 'Closing now cancels the export. Your project is safe and can be exported again.',
    });
    return choice === 1;
  };

  buildMenu();
  mainWindow = createWindow();
  assets.resume();
  aiJobs.resume();

  // Projects stay in Trash for 30 days; check once an hour while the app is open.
  setInterval(() => void lib.purgeTrash(), 60 * 60 * 1000).unref();

  app.on('activate', () => {
    if (!mainWindow) mainWindow = createWindow();
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  // The last step of quitting: every window is gone, so nothing can change the library any more.
  let flushed = false;
  app.on('will-quit', (event) => {
    if (flushed) return;
    event.preventDefault();
    jobs.shutdown();
    aiJobs.shutdown();
    clips.shutdown();
    globalShortcut.unregisterAll();
    void Promise.allSettled([lib.flush(), phone.stop()]).then(() => {
      flushed = true;
      app.quit();
    });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  void app.whenReady().then(start).catch((err) => {
    console.error(err);
    app.exit(1);
  });
}
