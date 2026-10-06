import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutAppImagePaths } from './host/launch.js';
import {
  loadHostToken,
  PROTOCOL_VERSION,
  readLines,
  socketPath,
  writeLine,
  type AttachResult,
  type HelloResult,
  type HostEvent,
  type Message,
  type Request,
  type TermInfo,
  type TermRef,
  type TermSpec,
} from './host/protocol.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const START_TIMEOUT_MS = 15_000;

/**
 * On Linux, child processes inherit every descriptor not marked close-on-exec, and Electron's
 * process has many (its sockets, its .pak and .asar files). The host outlives the app, so it is
 * started through bash, which closes everything above stderr and then becomes the host. (No
 * redirections in the loop: bash would park stderr on a higher descriptor, which the loop closes.)
 * (macOS spawns with POSIX_SPAWN_CLOEXEC_DEFAULT, and Windows handles aren't inherited by default.)
 */
const CLOSE_INHERITED_FDS =
  'for fd in /proc/$$/fd/*; do n=${fd##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done; exec "$@"';

/** The host outlives an AppImage's mount, so it must not load anything from it. */
export function hostEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const clean = withoutAppImagePaths(env);
  for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete clean[k];
  return clean;
}

export function detachedCommand(file: string, args: string[], platform = process.platform): { file: string; args: string[] } {
  if (platform !== 'linux' || !fs.existsSync('/bin/bash')) return { file, args };
  return { file: '/bin/bash', args: ['-c', CLOSE_INHERITED_FDS, 'remote-ai-host', file, ...args] };
}

/** One authenticated connection to the host. Emits `event` (HostEvent) and `close`. */
class Connection extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  closed = false;

  private constructor(private readonly socket: net.Socket) {
    super();
    readLines(socket, (msg) => this.onMessage(msg as Message));
    socket.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('The session host disconnected'));
      this.pending.clear();
      this.emit('close');
    });
    socket.on('error', () => socket.destroy());
  }

  static open(file: string, token: string): Promise<{ conn: Connection; hello: HelloResult }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(file);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        const conn = new Connection(socket);
        conn
          .request<HelloResult>({ op: 'hello', token, version: PROTOCOL_VERSION })
          .then((hello) => resolve({ conn, hello }), reject);
      });
    });
  }

  private onMessage(msg: Message): void {
    if ('ev' in msg) {
      this.emit('event', msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  request<T>(req: Request): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The session host disconnected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      writeLine(this.socket, { ...req, id });
    });
  }

  close(): void {
    this.socket.end();
  }
}

/** A browser's view of one terminal: the snapshot to draw first, then a live stream. */
export interface Attachment extends AttachResult {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** A program and arguments that start the host; `--data-dir <dir>` is added to them. */
export interface HostCommand {
  file: string;
  args: string[];
}

/** How to start the host by default: from source under tsx in development, or the built JavaScript. */
function defaultHostCommand(): HostCommand {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ts = path.join(here, 'host', 'main.ts');
  if (fs.existsSync(ts)) return { file: process.execPath, args: ['--import', import.meta.resolve('tsx/esm'), ts] };
  return { file: process.execPath, args: [path.join(here, 'host', 'main.js')] };
}

/**
 * The UI server's handle on the session host. Starts the host if it isn't running and keeps one
 * control connection that watches for terminals starting and exiting (re-emitted as `spawn` and
 * `exit` with a TermRef). Terminals live in the host, so they survive this process restarting.
 */
export class HostClient extends EventEmitter {
  private readonly socket: string;
  private readonly token: string;
  private control: Promise<Connection> | null = null;
  private hello: HelloResult | null = null;
  private closed = false;

  constructor(
    private readonly dataDir: string,
    private readonly log: { info(msg: string): void; warn(obj: object, msg: string): void },
    private readonly command: HostCommand = defaultHostCommand(),
  ) {
    super();
    this.socket = socketPath(dataDir);
    this.token = loadHostToken(dataDir);
  }

  private start(): void {
    const { file, args } = detachedCommand(this.command.file, [...this.command.args, '--data-dir', this.dataDir]);
    const out = fs.openSync(path.join(this.dataDir, 'host.log'), 'a');
    const child = spawn(file, args, {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      cwd: this.dataDir,
      env: hostEnvironment(process.env),
    });
    child.unref();
    fs.closeSync(out);
    this.log.info(`started session host (pid ${child.pid})`);
  }

  /** Connect, starting the host first if nobody is listening. */
  private async open(): Promise<Connection> {
    let started = false;
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      try {
        const { conn, hello } = await Connection.open(this.socket, this.token);
        if (hello.version !== PROTOCOL_VERSION) return await this.replaceOutdated(conn, hello);
        this.hello = hello;
        return conn;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw err;
        if (!started) {
          this.start();
          started = true;
        }
        if (Date.now() > deadline) throw new Error(`The session host did not start; see ${path.join(this.dataDir, 'host.log')}`);
        await sleep(150);
      }
    }
  }

  /** A host from another version is restarted when nothing runs in it; otherwise it's kept, with a warning. */
  private async replaceOutdated(conn: Connection, hello: HelloResult): Promise<Connection> {
    const terms = await conn.request<TermInfo[]>({ op: 'list' });
    if (terms.some((t) => t.alive)) {
      this.log.warn({ hostVersion: hello.version, expected: PROTOCOL_VERSION }, 'session host is from another version; stop all sessions to restart it');
      this.hello = hello;
      return conn;
    }
    this.log.info(`restarting session host (protocol ${hello.version} → ${PROTOCOL_VERSION})`);
    await conn.request({ op: 'shutdown' }).catch(() => undefined);
    conn.close();
    await sleep(300);
    return this.open();
  }

  private connection(): Promise<Connection> {
    if (this.closed) return Promise.reject(new Error('The session host client is closed'));
    this.control ??= this.open().then(
      async (conn) => {
        conn.on('event', (ev: HostEvent) => {
          if (ev.ev === 'exit') this.emit('exit', { session: ev.session, name: ev.name }, ev.code);
          else if (ev.ev === 'spawn') this.emit('spawn', { session: ev.session, name: ev.name });
        });
        conn.on('close', () => {
          this.control = null;
          this.emit('disconnect');
        });
        await conn.request({ op: 'watch' });
        return conn;
      },
      (err: unknown) => {
        this.control = null;
        throw err;
      },
    );
    return this.control;
  }

  private async request<T>(req: Request): Promise<T> {
    return (await this.connection()).request<T>(req);
  }

  list(): Promise<TermInfo[]> {
    return this.request<TermInfo[]>({ op: 'list' });
  }

  spawn(spec: TermSpec): Promise<TermInfo> {
    return this.request<TermInfo>({ op: 'spawn', spec });
  }

  write(ref: TermRef, data: string): Promise<void> {
    return this.request({ op: 'write', ...ref, data });
  }

  /** Named keys: Enter, Escape, Tab, BTab, C-c, Up, Down, Left, Right. */
  keys(ref: TermRef, keys: string[]): Promise<void> {
    return this.request({ op: 'keys', ...ref, keys });
  }

  paste(ref: TermRef, text: string): Promise<void> {
    return this.request({ op: 'paste', ...ref, text });
  }

  screen(ref: TermRef): Promise<string> {
    return this.request<string>({ op: 'screen', ...ref });
  }

  kill(ref: TermRef): Promise<void> {
    return this.request({ op: 'kill', ...ref });
  }

  remove(ref: TermRef): Promise<void> {
    return this.request({ op: 'remove', ...ref });
  }

  killSession(session: string): Promise<void> {
    return this.request({ op: 'killSession', session });
  }

  shutdown(): Promise<void> {
    return this.request({ op: 'shutdown' });
  }

  /** The running host's version, pid and script. Starts the host if needed. */
  async info(): Promise<HelloResult> {
    await this.connection();
    return this.hello!;
  }

  /** Disconnect from the host (which keeps running). */
  close(): void {
    this.closed = true;
    void this.control?.then((conn) => conn.close()).catch(() => undefined);
    this.control = null;
  }

  /**
   * Open a terminal for one viewer on its own connection, so a slow browser never holds up anyone
   * else. Returns null if there is no such terminal.
   */
  async attach(
    ref: TermRef,
    size: { cols?: number; rows?: number },
    on: { data(data: string): void; resize(cols: number, rows: number): void; exit(code: number | null): void; close(): void },
  ): Promise<Attachment | null> {
    await this.connection(); // makes sure the host is running
    const { conn } = await Connection.open(this.socket, this.token);
    conn.on('event', (ev: HostEvent) => {
      if (ev.ev === 'data') on.data(ev.data);
      else if (ev.ev === 'resize') on.resize(ev.cols, ev.rows);
      else if (ev.ev === 'exit') on.exit(ev.code);
    });
    conn.on('close', () => on.close());
    let result: AttachResult;
    try {
      result = await conn.request<AttachResult>({ op: 'attach', ...ref, ...size });
    } catch {
      conn.close();
      return null;
    }
    return {
      ...result,
      write: (data) => void conn.request({ op: 'write', ...ref, data }).catch(() => undefined),
      resize: (cols, rows) => void conn.request({ op: 'resize', ...ref, cols, rows }).catch(() => undefined),
      close: () => conn.close(),
    };
  }
}
