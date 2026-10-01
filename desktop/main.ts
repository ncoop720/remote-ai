/**
 * The desktop app: runs the dashboard server, shows it in a window, and lives in the tray so
 * notifications and updates keep working with the window closed. Sessions run in the session host,
 * a separate process that keeps going when the app quits or updates.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { startServer, type RunningServer } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { loginShellEnv, withoutAppImagePaths } from '../server/src/host/launch.js';
import type { Notice } from '../server/src/push.js';
import { linuxOpenAtLogin, setLinuxOpenAtLogin } from './autostart.js';
import { installHostRuntime, pruneHostRuntimes, runtimeSource } from './hostRuntime.js';
import { createUpdater, type Updater } from './updater.js';

/** Must match appId in electron-builder.yml; Windows ties notifications to it. */
const APP_ID = 'io.github.ncoop720.remote-ai';
const here = path.dirname(fileURLToPath(import.meta.url));

let server: RunningServer | null = null;
let updater: Updater | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// Running from source keeps its own data (and host) apart from an installed copy.
if (!app.isPackaged) app.setPath('userData', `${app.getPath('userData')}-dev`);

/**
 * remote-ai's own files (state, logs, the host runtime) live in ~/.remote-ai like a server
 * install's, not among Electron's browser data, and out of roaming AppData on Windows.
 */
function dataDirectory(): string | undefined {
  if (process.env.REMOTE_AI_DATA_DIR) return process.env.REMOTE_AI_DATA_DIR;
  return app.isPackaged ? undefined : path.join(os.homedir(), '.remote-ai-desktop-dev');
}

// ---- Start at login ----

// Windows starts the app with these arguments; macOS reports wasOpenedAtLogin instead.
const LOGIN_ITEM = { args: ['--hidden'] };

function openAtLogin(): boolean {
  if (process.platform === 'linux') return linuxOpenAtLogin();
  return app.getLoginItemSettings(LOGIN_ITEM).openAtLogin;
}

function setOpenAtLogin(on: boolean): void {
  if (process.platform === 'linux') setLinuxOpenAtLogin(on, process.env.APPIMAGE ?? process.execPath);
  else app.setLoginItemSettings({ openAtLogin: on, ...LOGIN_ITEM });
}

function startedAtLogin(): boolean {
  return process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
}

/** Small file for the app's own one-time decisions. */
function firstRun(dataDir: string): boolean {
  const file = path.join(dataDir, 'desktop.json');
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, JSON.stringify({ firstRunAt: new Date().toISOString() }, null, 2));
  return true;
}

// ---- Window ----

function showWindow(at?: string): void {
  if (!server) return;
  const base = server.url;
  if (!win) {
    win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 420,
      minHeight: 480,
      title: 'remote-ai',
      backgroundColor: '#121110',
      autoHideMenuBar: true,
      show: false,
      webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
    });
    // Shown once it has painted, so it doesn't flash empty. Some Linux compositors never paint a
    // hidden window, so it is shown anyway after a moment.
    let revealed = false;
    const reveal = () => {
      if (!revealed) win?.show();
      revealed = true;
    };
    win.once('ready-to-show', reveal);
    setTimeout(reveal, 3000);
    // Closing the window keeps the app in the tray; Quit is in the tray menu.
    win.on('close', (e) => {
      if (quitting) return;
      revealed = true;
      e.preventDefault();
      win?.hide();
      if (process.platform === 'darwin') app.dock?.hide();
    });
    win.on('closed', () => (win = null));
    // Links out of the dashboard (previews, docs, sign-in pages) open in the browser.
    const isExternal = (url: string) => /^(https?|mailto):/.test(url) && url !== base && !url.startsWith(`${base}/`);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (url === base || url.startsWith(`${base}/`)) return;
      e.preventDefault();
      if (isExternal(url)) void shell.openExternal(url);
    });
    void win.loadURL(`${base}${at ?? '/'}`);
  } else {
    const hash = at?.slice(at.indexOf('#'));
    if (hash?.startsWith('#')) void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
    win.show();
    win.focus();
  }
  if (process.platform === 'darwin') void app.dock?.show();
}

ipcMain.handle('remote-ai:pick-folder', async (event) => {
  if (!win || event.sender !== win.webContents) return null;
  const result = await dialog.showOpenDialog(win, { title: 'Choose a repository', properties: ['openDirectory'] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// ---- Notifications ----

function notify(notice: Notice): void {
  if (!Notification.isSupported() || win?.isFocused()) return;
  const n = new Notification({ title: notice.title, body: notice.body });
  n.on('click', () => showWindow(notice.url));
  n.show();
}

// ---- Tray ----

async function sessionSummary(): Promise<string> {
  if (!server) return 'Starting…';
  try {
    const sessions = (await server.sessions.listProjects()).flatMap((p) => p.sessions).filter((s) => s.running);
    const needs = sessions.filter((s) => s.status.state === 'needs_input').length;
    if (sessions.length === 0) return 'No sessions running';
    const running = `${sessions.length} session${sessions.length === 1 ? '' : 's'} running`;
    return needs ? `${running} · ${needs} need${needs === 1 ? 's' : ''} you` : running;
  } catch {
    return 'Session host unavailable';
  }
}

let trayTimer: ReturnType<typeof setTimeout> | undefined;
function refreshTray(): void {
  clearTimeout(trayTimer);
  trayTimer = setTimeout(() => void buildTrayMenu(), 300);
}

async function buildTrayMenu(): Promise<void> {
  if (!tray) return;
  const summary = await sessionSummary();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open remote-ai', click: () => showWindow() },
      { label: summary, enabled: false },
      { type: 'separator' },
      {
        label: 'Open at login',
        type: 'checkbox',
        checked: app.isPackaged && openAtLogin(),
        enabled: app.isPackaged,
        click: (item) => setOpenAtLogin(item.checked),
      },
      ...(updater ? [updater.menuItem()] : []),
      { type: 'separator' },
      { label: 'Quit (sessions keep running)', click: () => quit(false) },
      { label: 'Stop all sessions and quit…', click: () => quit(true) },
    ]),
  );
  tray.setToolTip(`remote-ai · ${summary}`);
}

function createTray(): void {
  const icon = nativeImage.createFromPath(
    path.join(here, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'),
  );
  tray = new Tray(icon);
  tray.on('click', () => showWindow());
  void buildTrayMenu();
}

// ---- Quit ----

async function quit(stopSessions: boolean): Promise<void> {
  if (stopSessions) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: 'Stop all sessions and quit?',
      detail: 'Every agent, dev server and setup that is running ends now. Conversations can be resumed later.',
      buttons: ['Stop and quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
    await server?.host.shutdown().catch(() => undefined);
  }
  quitting = true;
  await server?.close().catch(() => undefined);
  app.quit();
}

app.on('before-quit', () => {
  quitting = true;
});
// The app lives in the tray; closing the window doesn't quit it.
app.on('window-all-closed', () => undefined);
app.on('activate', () => showWindow());

// ---- Start ----

/** Programs we start should see the user's PATH, not the minimal one a desktop launcher gives apps. */
function prepareEnvironment(): void {
  const fromShell = loginShellEnv();
  const env = withoutAppImagePaths({ ...process.env, PATH: fromShell?.PATH ?? process.env.PATH });
  if (env.PATH) process.env.PATH = env.PATH;
}

function startupError(err: unknown, port: number, dataDir: string): string {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'EADDRINUSE') {
    return (
      `Port ${port} is already in use, perhaps by another copy of remote-ai.\n\n` +
      `To use another port, set "port" in ${path.join(dataDir, 'config.json')}.`
    );
  }
  return e.message ?? String(err);
}

async function main(): Promise<void> {
  await app.whenReady();
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  prepareEnvironment();

  const config = loadConfig({ dataDir: dataDirectory(), projectsDir: null });
  const dataDir = config.dataDir;

  let runtime;
  try {
    runtime = installHostRuntime(runtimeSource({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appDir: here }), dataDir);
  } catch (err) {
    dialog.showErrorBox('remote-ai could not start', `The session host is missing from this build.\n\n${(err as Error).message}`);
    app.exit(1);
    return;
  }

  const log = {
    info: (msg: string) => server?.log.info(msg),
    warn: (obj: object, msg: string) => server?.log.warn(obj, msg),
  };
  updater = createUpdater({
    log,
    onChange: refreshTray,
    onReady: (version) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: 'remote-ai update ready', body: `Restart to update to ${version}. Sessions keep running.` });
      n.on('click', () => showWindow());
      n.show();
    },
  });

  try {
    server = await startServer({
      config,
      webDir: path.join(here, 'web'),
      hostCommand: runtime.command,
      updates: updater.provider,
      onNotice: notify,
      logFile: path.join(dataDir, 'server.log'),
    });
  } catch (err) {
    dialog.showErrorBox('remote-ai could not start', startupError(err, config.port, dataDir));
    app.exit(1);
    return;
  }

  // Old copies of the host can go once nothing runs from them.
  server.host
    .info()
    .then((h) => pruneHostRuntimes(dataDir, [runtime.dir, h.entry && path.dirname(h.entry)]))
    .catch(() => undefined);

  createTray();
  server.statuses.on('change', refreshTray);
  server.host.on('spawn', refreshTray);
  server.host.on('exit', refreshTray);

  if (firstRun(dataDir) && app.isPackaged) setOpenAtLogin(true);
  if (!startedAtLogin()) showWindow();
  updater.start();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  main().catch((err: unknown) => {
    dialog.showErrorBox('remote-ai could not start', (err as Error).stack ?? String(err));
    app.exit(1);
  });
}
