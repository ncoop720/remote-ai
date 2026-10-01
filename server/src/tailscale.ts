import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { TailscaleInfo } from '../../shared/types.js';

export interface TailscaleOptions {
  /** The remote-ai-tailscale program (built from tailscale/); null when this install doesn't have it. */
  binary: string | null;
  dataDir: string;
  /** The dashboard, as the proxy should reach it. */
  target: string;
  /** Marks the proxy's requests, so the server believes the login it adds. */
  secret: string;
  log: { info(msg: string): void; warn(obj: object, msg: string): void };
}

type State = Omit<TailscaleInfo, 'available' | 'enabled'>;

/** The device name on the tailnet: remote-ai-<this computer's name>. */
export function tailnetHostname(hostname = os.hostname()): string {
  const name = hostname.split('.')[0]!.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `remote-ai-${name || 'computer'}`.slice(0, 63);
}

/** Read one JSON line from the sidecar into a state, ignoring anything malformed. */
export function parseEvent(line: string): State | null {
  try {
    const e = JSON.parse(line) as Partial<State> & { state?: string };
    const states: State['state'][] = ['starting', 'needs-login', 'needs-approval', 'running', 'error'];
    if (!e.state || !states.includes(e.state as State['state'])) return null;
    return {
      state: e.state as State['state'],
      loginUrl: e.loginUrl,
      url: e.url,
      login: e.login,
      https: e.https,
      message: e.message,
    };
  } catch {
    return null;
  }
}

/**
 * Built-in Tailscale: runs the remote-ai-tailscale sidecar, which joins the tailnet with tsnet and
 * serves the dashboard over HTTPS. It lives as long as the server; the tailnet identity it signs in
 * with is kept in <dataDir>/tailscale. Emits `change` whenever its state does.
 */
export class Tailscale extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: State = { state: 'off' };
  private wanted = false;
  private failures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: TailscaleOptions) {
    super();
  }

  get available(): boolean {
    return this.opts.binary !== null;
  }

  info(): State {
    return this.state;
  }

  /** The Tailscale login this computer is signed in as, once running. */
  owner(): string | null {
    return this.state.state === 'running' ? (this.state.login ?? null) : null;
  }

  private set(next: State): void {
    this.state = next;
    this.emit('change');
  }

  start(): void {
    this.wanted = true;
    if (this.child || !this.opts.binary) return;
    clearTimeout(this.restartTimer);
    const args = ['--state-dir', path.join(this.opts.dataDir, 'tailscale'), '--hostname', tailnetHostname(), '--target', this.opts.target];
    const child = spawn(this.opts.binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, REMOTE_AI_PROXY_SECRET: this.opts.secret },
    });
    this.child = child;
    this.set({ state: 'starting' });

    let buffered = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffered += chunk;
      let nl: number;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const event = parseEvent(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
        if (!event) continue;
        if (event.state === 'running') this.failures = 0;
        if (event.state === 'running' && this.state.state !== 'running') this.opts.log.info(`tailscale: serving ${event.url}`);
        this.set(event);
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (text: string) => {
      for (const line of text.split('\n')) if (line.trim()) this.opts.log.info(`tailscale: ${line.trim()}`);
    });
    child.stdin!.on('error', () => undefined);
    child.on('error', (err) => {
      this.opts.log.warn({ err }, 'tailscale sidecar failed to start');
      this.set({ state: 'error', message: err.message });
    });
    child.on('exit', (code) => {
      this.child = null;
      if (!this.wanted) {
        this.set({ state: 'off' });
        return;
      }
      // Crashed or failed: say why (its last event), and try again, waiting longer each time.
      const message = this.state.state === 'error' ? this.state.message : `stopped unexpectedly (exit ${code})`;
      this.set({ state: 'error', message });
      const delay = Math.min(60_000, 2000 * 2 ** this.failures++);
      this.restartTimer = setTimeout(() => this.wanted && this.start(), delay);
      this.restartTimer.unref();
    });
  }

  /** Stop serving on the tailnet. The device stays signed in for next time. */
  stop(): void {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) {
      this.set({ state: 'off' });
      return;
    }
    this.set({ state: 'off' });
    // Closing stdin tells it to stop; make sure it does.
    child.stdin!.end();
    setTimeout(() => child.exitCode === null && child.kill(), 3000).unref();
  }

  /** Sign this computer out of the tailnet (it will offer to sign in again). */
  logout(): void {
    this.child?.stdin!.write('{"cmd":"logout"}\n');
  }
}
