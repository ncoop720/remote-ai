import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { keySequence, pasteSequence } from './keys.js';
import type { Launch } from './launch.js';
import type { AttachResult, TermInfo } from './protocol.js';

// Both packages are CommonJS bundles; take the classes off the default export.
const { Terminal: Screen } = headless;
const { SerializeAddon } = serialize;

const SCROLLBACK = 5000;

export interface TermListener {
  data(data: string): void;
  exit(code: number | null): void;
}

function clampSize(n: unknown, fallback: number): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 10 && v <= 500 ? v : fallback;
}

/**
 * One program in a pseudo-terminal. Its output goes to attached viewers, an optional log file, and
 * a headless terminal that keeps the screen and scrollback, so a viewer that connects later gets
 * exactly what is there (as tmux did in v1).
 */
export class Term {
  readonly startedAt = Date.now();
  alive = true;
  exitCode: number | null = null;
  lastOutputAt = 0;
  bells = 0;

  private readonly pty: pty.IPty;
  private readonly screen: InstanceType<typeof Screen>;
  private readonly serializer = new SerializeAddon();
  private readonly listeners = new Set<TermListener>();
  private log: fs.WriteStream | null = null;
  private disposed = false;

  constructor(
    readonly session: string,
    readonly name: string,
    launch: Launch,
    opts: { cwd: string; cols?: number; rows?: number; logFile?: string; onExit?: (code: number | null) => void },
  ) {
    const cols = clampSize(opts.cols, 120);
    const rows = clampSize(opts.rows, 40);
    this.screen = new Screen({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.screen.loadAddon(this.serializer);
    this.screen.onBell(() => this.bells++);
    // Programs ask the terminal things (cursor position, colors, device attributes). A viewer's
    // xterm answers while one is attached; otherwise the headless screen does, so nothing waits forever.
    this.screen.onData((reply) => {
      if (this.alive && this.listeners.size === 0) this.pty.write(reply);
    });

    if (opts.logFile) {
      fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
      this.log = fs.createWriteStream(opts.logFile, { flags: 'a' });
      this.log.on('error', () => (this.log = null));
    }

    this.pty = pty.spawn(launch.file, launch.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env: launch.env,
    });

    this.pty.onData((data) => {
      if (this.disposed) return;
      this.lastOutputAt = Date.now();
      this.log?.write(data);
      // Viewers get data only once the screen has taken it, so an attach snapshot plus the data
      // that follows it never drops or repeats anything.
      this.screen.write(data, () => {
        for (const l of this.listeners) l.data(data);
      });
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.alive = false;
      this.exitCode = signal ? null : exitCode;
      const note = `\r\n\x1b[2m[exited${this.exitCode === null ? '' : ` with code ${this.exitCode}`}]\x1b[0m\r\n`;
      this.log?.end();
      this.log = null;
      if (this.disposed) return;
      this.screen.write(note, () => {
        for (const l of this.listeners) {
          l.data(note);
          l.exit(this.exitCode);
        }
        opts.onExit?.(this.exitCode);
      });
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  info(): TermInfo {
    return {
      session: this.session,
      name: this.name,
      pid: this.pid,
      alive: this.alive,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      lastOutputAt: this.lastOutputAt,
      bells: this.bells,
    };
  }

  write(data: string): void {
    if (this.alive) this.pty.write(data);
  }

  keys(names: string[]): void {
    const seqs = names.map((n) => {
      const seq = keySequence(n, this.screen.modes.applicationCursorKeysMode);
      if (seq === undefined) throw new Error(`Unknown key ${n}`);
      return seq;
    });
    this.write(seqs.join(''));
  }

  paste(text: string): void {
    this.write(pasteSequence(text, this.screen.modes.bracketedPasteMode));
  }

  resize(cols: unknown, rows: unknown): void {
    const c = clampSize(cols, this.screen.cols);
    const r = clampSize(rows, this.screen.rows);
    if (c === this.screen.cols && r === this.screen.rows) return;
    this.screen.resize(c, r);
    if (this.alive) this.pty.resize(c, r);
  }

  /** Resolves once the screen has processed everything received so far. */
  private settled(): Promise<void> {
    return new Promise((resolve) => this.screen.write('', resolve));
  }

  /** The visible screen as plain text, one line per row. */
  async screenText(): Promise<string> {
    await this.settled();
    const buf = this.screen.buffer.active;
    const lines: string[] = [];
    for (let y = buf.viewportY; y < buf.viewportY + this.screen.rows; y++) {
      lines.push(buf.getLine(y)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  }

  /** Snapshot the screen and start delivering what comes after it. */
  async attach(listener: TermListener): Promise<AttachResult> {
    await this.settled();
    const snapshot = this.serializer.serialize({ scrollback: SCROLLBACK });
    if (this.alive) this.listeners.add(listener);
    return { snapshot, alive: this.alive, exitCode: this.exitCode };
  }

  detach(listener: TermListener): void {
    this.listeners.delete(listener);
  }

  kill(): void {
    if (!this.alive) return;
    try {
      this.pty.kill();
    } catch {
      // already gone
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.kill();
    this.listeners.clear();
    this.log?.end();
    this.screen.dispose();
  }
}
