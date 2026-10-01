import { app, type MenuItemConstructorOptions } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateProvider } from '../server/src/update.js';
import type { DesktopUpdateState, UpdateResult, VersionInfo } from '../shared/types.js';

const { autoUpdater } = electronUpdater;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Why this copy can't update itself, or null if it can. */
function unsupportedReason(): string | null {
  if (!app.isPackaged) return 'Running from source';
  // Of the Linux packages only the AppImage can replace itself; .deb installs update through new downloads.
  if (process.platform === 'linux' && !process.env.APPIMAGE) return 'Install the AppImage for automatic updates';
  return null;
}

/** electron-updater's errors are often a bare HTTP status or a long stack; say what happened. */
function describeError(err: Error): string {
  const first = err.message.split('\n')[0]!.trim();
  // A private repository answers 404 to anyone signed out, as does one with no published release.
  if (/^404\b|HttpError: 404|Unable to find latest version/i.test(first)) {
    return 'No release to update from: get new versions from the releases page';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::ERR_/.test(first)) return "Couldn't reach GitHub to check for updates";
  if (/code signature|not signed/i.test(first)) return 'This copy is unsigned, so macOS won’t let it update itself';
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

export interface Updater {
  provider: UpdateProvider;
  /** The tray's update item: check, progress, or restart. */
  menuItem(): MenuItemConstructorOptions;
  /** Check now and every few hours. */
  start(): void;
}

/**
 * Updates from the project's GitHub releases (electron-updater). New versions download in the
 * background and install when the app restarts. The session host runs from its own copy outside
 * the app, so sessions keep running through an update.
 */
export function createUpdater(opts: {
  log: { info(msg: string): void; warn(obj: object, msg: string): void };
  onChange(): void;
  onReady(version: string): void;
}): Updater {
  const reason = unsupportedReason();
  let state: DesktopUpdateState = reason ? 'unsupported' : 'idle';
  let latest: string | null = null;
  let progress: number | null = null;
  let error: string | undefined = reason ?? undefined;

  const set = (next: DesktopUpdateState, extra: { latest?: string; progress?: number | null; error?: string } = {}) => {
    state = next;
    if (extra.latest) latest = extra.latest;
    if (extra.progress !== undefined) progress = extra.progress;
    error = extra.error;
    opts.onChange();
  };

  if (!reason) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => set('checking'));
    autoUpdater.on('update-not-available', () => set('up-to-date'));
    autoUpdater.on('update-available', (info) => set('downloading', { latest: info.version, progress: 0 }));
    autoUpdater.on('download-progress', (p) => set('downloading', { progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => {
      set('ready', { latest: info.version, progress: 100 });
      opts.log.info(`update ${info.version} downloaded`);
      opts.onReady(info.version);
    });
    autoUpdater.on('error', (err: Error) => {
      opts.log.warn({ err }, 'update failed');
      set('error', { error: describeError(err) });
    });
  }

  const check = () => {
    if (reason || state === 'downloading' || state === 'ready') return;
    set('checking');
    autoUpdater.checkForUpdates().catch(() => undefined); // reported through the 'error' event
  };

  const restart = (): UpdateResult => {
    const from = app.getVersion();
    if (state !== 'ready' || !latest) {
      check();
      return { ok: false, from, to: from, restartNeeded: false, restarting: false, log: ['No update is ready yet'] };
    }
    // Give the response time to reach the page before the app quits.
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 300);
    return { ok: true, from, to: latest, restartNeeded: true, restarting: true, log: [] };
  };

  const info = (): VersionInfo => ({ kind: 'desktop', version: app.getVersion(), state, latest, progress, error });

  return {
    provider: {
      async info(doCheck) {
        if (doCheck) check();
        return info();
      },
      update: async () => restart(),
    },
    menuItem() {
      switch (state) {
        case 'unsupported':
          return { label: `Version ${app.getVersion()}`, enabled: false };
        case 'checking':
          return { label: 'Checking for updates…', enabled: false };
        case 'downloading':
          return { label: `Downloading ${latest ?? 'update'}… ${progress ?? 0}%`, enabled: false };
        case 'ready':
          return { label: `Restart to update to ${latest}`, click: () => void restart() };
        default:
          return { label: state === 'up-to-date' ? 'Up to date · check again' : 'Check for updates', click: check };
      }
    },
    start() {
      if (reason) return;
      check();
      setInterval(check, CHECK_EVERY_MS).unref();
    },
  };
}
