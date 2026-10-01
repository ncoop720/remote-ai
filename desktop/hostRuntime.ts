import fs from 'node:fs';
import path from 'node:path';
import type { HostCommand } from '../server/src/hostclient.js';

/** Written by scripts/build-desktop.mjs next to the runtime's files. */
export interface RuntimeManifest {
  /** Changes whenever the host script, Node or node-pty does. */
  hash: string;
  node: string;
  nodePty: string;
}

export interface HostRuntime {
  dir: string;
  command: HostCommand;
}

/** Where a build's host runtime is: shipped as an app resource, or built next to the app when running from source. */
export function runtimeSource(opts: { packaged: boolean; resourcesPath: string; appDir: string }): string {
  if (opts.packaged) return path.join(opts.resourcesPath, 'host');
  const os = { darwin: 'mac', win32: 'win' }[process.platform as string] ?? 'linux';
  return path.join(opts.appDir, '..', 'host-runtime', `${os}-${process.arch}`);
}

/**
 * Copy the session host (Node, the host script and node-pty) out of the app into
 * `<dataDir>/host-runtime/<hash>`, and run it from there. The host outlives the app, and a running
 * program's files can't be replaced on Windows or stay mounted after an AppImage quits, so the app
 * can only update itself if the host runs from a copy. Each version gets its own folder, so an
 * update never touches the copy a running host uses.
 */
export function installHostRuntime(source: string, dataDir: string): HostRuntime {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'runtime.json'), 'utf8')) as RuntimeManifest;
  const root = path.join(dataDir, 'host-runtime');
  const dir = path.join(root, manifest.hash);
  if (!fs.existsSync(path.join(dir, 'runtime.json'))) {
    const partial = `${dir}.partial-${process.pid}`;
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(source, partial, { recursive: true });
    try {
      fs.renameSync(partial, dir);
    } catch (err) {
      // Another copy of the app finished first; theirs is the same.
      fs.rmSync(partial, { recursive: true, force: true });
      if (!fs.existsSync(path.join(dir, 'runtime.json'))) throw err;
    }
  }
  const node = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  return { dir, command: { file: node, args: [path.join(dir, 'host.mjs')] } };
}

/** Delete copies no longer in use: anything but the current one and the one the running host started from. */
export function pruneHostRuntimes(dataDir: string, keep: (string | null | undefined)[]): string[] {
  const root = path.join(dataDir, 'host-runtime');
  const kept = new Set(keep.filter((k): k is string => Boolean(k)).map((k) => path.resolve(k)));
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const dir = path.join(root, name);
    if (kept.has(path.resolve(dir))) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // still in use (Windows locks running programs); try again next start
    }
  }
  return removed;
}
