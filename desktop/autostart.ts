import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Starting at login on Linux, where Electron's login-item settings don't apply: a desktop entry in
 * the XDG autostart folder, which GNOME, KDE and most other desktops read.
 */
export function autostartFile(env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(config, 'autostart', 'remote-ai.desktop');
}

/** Quote a path for a desktop entry's Exec line. */
function execQuote(arg: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(arg) ? arg : `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;
}

export function autostartEntry(exec: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=remote-ai',
    'Comment=Coding agents on this computer, from any device',
    `Exec=${execQuote(exec)} --hidden`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function linuxOpenAtLogin(): boolean {
  return fs.existsSync(autostartFile());
}

/** `exec` is the program to start: the AppImage file itself, or the installed binary. */
export function setLinuxOpenAtLogin(on: boolean, exec: string): void {
  const file = autostartFile();
  if (!on) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, autostartEntry(exec));
}
