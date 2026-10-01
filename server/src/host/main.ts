/**
 * The session host: a small background process that owns every agent's and dev server's terminal,
 * so they keep running while the UI server restarts or updates. It replaces tmux, and runs the same
 * way on macOS, Windows and Linux.
 *
 *   node host/main.js --data-dir ~/.remote-ai
 */
import fs from 'node:fs';
import net from 'node:net';
import { baseEnvironment, resolveLaunch } from './launch.js';
import {
  isValidTermName,
  loadHostToken,
  PROTOCOL_VERSION,
  readLines,
  socketPath,
  writeLine,
  type HelloResult,
  type HostEvent,
  type RequestMessage,
  type TermRef,
} from './protocol.js';
import { Term, type TermListener } from './term.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const dataDir = arg('--data-dir');
if (!dataDir) {
  console.error('usage: main.js --data-dir <dir>');
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true });

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const token = loadHostToken(dataDir);
const sockPath = socketPath(dataDir);
const env = baseEnvironment();
const terms = new Map<string, Term>();
const watchers = new Set<net.Socket>();

const keyOf = (r: TermRef) => `${r.session}/${r.name}`;
const hello: HelloResult = { version: PROTOCOL_VERSION, pid: process.pid, entry: process.argv[1] };

function getTerm(r: TermRef): Term {
  const term = terms.get(keyOf(r));
  if (!term) throw new Error(`No terminal ${keyOf(r)}`);
  return term;
}

function notify(event: HostEvent): void {
  for (const w of watchers) writeLine(w, event);
}

function checkRef(r: Partial<TermRef>): void {
  if (!isValidTermName(r.session) || !isValidTermName(r.name)) throw new Error('Invalid session or terminal name');
}

function handleConnection(socket: net.Socket): void {
  let authed = false;
  const attached = new Map<string, TermListener>();

  const cleanup = () => {
    watchers.delete(socket);
    for (const [key, listener] of attached) terms.get(key)?.detach(listener);
    attached.clear();
  };
  socket.on('close', cleanup);
  socket.on('error', () => socket.destroy());

  const handle = async (req: RequestMessage): Promise<unknown> => {
    if (!authed) {
      if (req.op !== 'hello' || req.token !== token) throw new Error('Not authorized');
      authed = true;
      return hello;
    }
    switch (req.op) {
      case 'hello':
        return hello;
      case 'list':
        return [...terms.values()].map((t) => t.info());
      case 'watch':
        watchers.add(socket);
        return undefined;
      case 'spawn': {
        const spec = req.spec;
        checkRef(spec);
        const key = keyOf(spec);
        const existing = terms.get(key);
        if (existing?.alive) throw new Error(`${key} is already running`);
        const term: Term = new Term(spec.session, spec.name, resolveLaunch(spec, env), {
          ...spec,
          onExit: (code) => onExit(term, code),
        });
        existing?.dispose();
        terms.set(key, term);
        log(`spawn ${key} pid ${term.pid}`);
        notify({ ev: 'spawn', session: spec.session, name: spec.name });
        return term.info();
      }
      case 'write':
        checkRef(req);
        getTerm(req).write(String(req.data));
        return undefined;
      case 'keys':
        checkRef(req);
        getTerm(req).keys(req.keys);
        return undefined;
      case 'paste':
        checkRef(req);
        getTerm(req).paste(String(req.text));
        return undefined;
      case 'screen':
        checkRef(req);
        return getTerm(req).screenText();
      case 'resize':
        checkRef(req);
        getTerm(req).resize(req.cols, req.rows);
        return undefined;
      case 'kill':
        checkRef(req);
        getTerm(req).kill();
        return undefined;
      case 'remove': {
        checkRef(req);
        const term = terms.get(keyOf(req));
        term?.dispose();
        terms.delete(keyOf(req));
        return undefined;
      }
      case 'killSession': {
        for (const [key, term] of terms) {
          if (term.session !== req.session) continue;
          term.dispose();
          terms.delete(key);
        }
        log(`killed session ${req.session}`);
        return undefined;
      }
      case 'attach': {
        checkRef(req);
        const key = keyOf(req);
        const term = getTerm(req);
        if (req.cols && req.rows) term.resize(req.cols, req.rows);
        const prev = attached.get(key);
        if (prev) term.detach(prev);
        const listener: TermListener = {
          data: (data) => writeLine(socket, { ev: 'data', session: req.session, name: req.name, data }),
          exit: (code) => writeLine(socket, { ev: 'exit', session: req.session, name: req.name, code }),
        };
        attached.set(key, listener);
        return term.attach(listener);
      }
      case 'detach': {
        checkRef(req);
        const listener = attached.get(keyOf(req));
        if (listener) terms.get(keyOf(req))?.detach(listener);
        attached.delete(keyOf(req));
        return undefined;
      }
      case 'shutdown':
        log('shutdown requested');
        setTimeout(shutdown, 50);
        return undefined;
      default:
        throw new Error(`Unknown op ${(req as { op?: string }).op}`);
    }
  };

  readLines(socket, (msg) => {
    const req = msg as RequestMessage;
    if (typeof req?.id !== 'number') return;
    handle(req).then(
      (result) => writeLine(socket, { id: req.id, ok: true, result }),
      (err: unknown) => {
        writeLine(socket, { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        if (!authed) socket.end();
      },
    );
  });
}

function onExit(term: Term, code: number | null): void {
  log(`exit ${term.session}/${term.name} code ${code}`);
  // A terminal that was replaced or removed has nothing left to report.
  if (terms.get(keyOf(term)) !== term) return;
  notify({ ev: 'exit', session: term.session, name: term.name, code });
}

function shutdown(): void {
  for (const term of terms.values()) term.dispose();
  server.close();
  if (process.platform !== 'win32') fs.rmSync(sockPath, { force: true });
  process.exit(0);
}

const server = net.createServer(handleConnection);

/** Listen on the socket unless another host already does. A socket file nobody answers on is stale. */
function listen(retried = false): void {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE' || retried || process.platform === 'win32') {
      log(`cannot listen on ${sockPath}: ${err.message}`);
      process.exit(err.code === 'EADDRINUSE' ? 0 : 1);
    }
    const probe = net.connect(sockPath);
    probe.once('connect', () => {
      log('another host is already running');
      probe.destroy();
      process.exit(0);
    });
    probe.once('error', () => {
      fs.rmSync(sockPath, { force: true });
      listen(true);
    });
  });
  server.listen(sockPath, () => {
    if (process.platform !== 'win32') fs.chmodSync(sockPath, 0o600);
    log(`session host ${process.pid} listening on ${sockPath}`);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// Started detached, but ignore a hangup from whatever terminal launched it.
if (process.platform !== 'win32') process.on('SIGHUP', () => undefined);

listen();
