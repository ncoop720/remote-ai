import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { loadConfig } from './config.js';
import { CommandError } from './exec.js';
import { isValidWindowName } from './ids.js';
import { loadHookToken, PERMISSION_MODES, writeClaudeSettings } from './claude.js';
import { DevManager } from './dev.js';
import { HttpError } from './errors.js';
import { EventHub } from './events.js';
import { streamLog } from './logs.js';
import { listeningPorts } from './ports.js';
import { SessionManager } from './sessions.js';
import { StateStore } from './state.js';
import { StatusStore, type HookPayload } from './status.js';
import { attachTerminal } from './terminal.js';
import { Tmux } from './tmux.js';
import type { CreateSessionRequest, DevAction, StartSessionRequest } from '../../shared/types.js';

const cfg = loadConfig();
const tmux = new Tmux(cfg.tmuxSocket, cfg.dataDir);
const state = new StateStore(cfg.dataDir, cfg.portBase, cfg.portStep);
const statuses = new StatusStore();
const hookToken = loadHookToken(cfg.dataDir);
const settingsPath = writeClaudeSettings(cfg.dataDir, cfg.port, hookToken);
const dev = new DevManager(cfg, tmux, state);
const sessions = new SessionManager(cfg, tmux, state, statuses, settingsPath, dev);
const hub = new EventHub();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 8 * 1024 * 1024 });

try {
  await tmux.reloadConfig();
} catch (err) {
  app.log.warn({ err }, 'could not apply tmux.conf (is tmux installed?)');
}

statuses.on('change', (sessionId: string, status) => hub.broadcast({ type: 'status', sessionId, status }));

await app.register(websocket);

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
  if (err instanceof CommandError) {
    req.log.warn({ err }, 'command failed');
    return reply.code(500).send({ error: err.message });
  }
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) req.log.error({ err }, 'request failed');
  return reply.code(status).send({ error: (err as Error).message });
});

// Browsers always send Origin on cross-site requests and WebSocket upgrades; refuse any
// that don't match the host they were sent to (directly or via a proxy such as tailscale serve).
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return reply.code(403).send({ error: 'Bad origin' });
  }
  const hosts = [req.headers.host, req.headers['x-forwarded-host']].flat().filter(Boolean);
  if (!hosts.includes(originHost)) return reply.code(403).send({ error: 'Cross-origin request blocked' });
});

// ---- API ----

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/projects', async () => sessions.listProjects());

app.get('/api/events', (req, reply) => {
  hub.subscribe(reply);
});

app.post<{ Params: { project: string }; Body: CreateSessionRequest }>(
  '/api/projects/:project/sessions',
  async (req) => {
    const body = req.body ?? ({} as CreateSessionRequest);
    if (body.permissionMode && !PERMISSION_MODES.includes(body.permissionMode)) {
      throw new HttpError(400, 'Invalid permission mode');
    }
    const id = await sessions.createSession(req.params.project, body);
    hub.broadcast({ type: 'sessions' });
    return { id };
  },
);

app.post<{ Params: { id: string }; Body: StartSessionRequest }>('/api/sessions/:id/start', async (req) => {
  const body = req.body ?? {};
  if (body.permissionMode && !PERMISSION_MODES.includes(body.permissionMode)) {
    throw new HttpError(400, 'Invalid permission mode');
  }
  await sessions.startSession(req.params.id, body);
  hub.broadcast({ type: 'sessions' });
  return { ok: true };
});

app.post<{ Params: { id: string } }>('/api/sessions/:id/stop', async (req) => {
  await sessions.stopSession(req.params.id);
  hub.broadcast({ type: 'sessions' });
  return { ok: true };
});

app.delete<{ Params: { id: string }; Querystring: { force?: string } }>('/api/sessions/:id', async (req) => {
  await sessions.deleteSession(req.params.id, req.query.force === '1');
  hub.broadcast({ type: 'sessions' });
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: { keys: string[] } }>('/api/sessions/:id/keys', async (req) => {
  await sessions.sendKeys(req.params.id, req.body?.keys);
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: { text: string; submit?: boolean } }>(
  '/api/sessions/:id/text',
  async (req) => {
    await sessions.sendText(req.params.id, req.body?.text, req.body?.submit ?? true);
    return { ok: true };
  },
);

app.get<{ Params: { id: string } }>('/api/sessions/:id/prompt', async (req) => ({
  prompt: await sessions.visiblePrompt(req.params.id),
}));

app.post<{ Params: { id: string }; Body: { key: string } }>('/api/sessions/:id/answer', async (req) => {
  await sessions.answer(req.params.id, String(req.body?.key ?? ''));
  return { ok: true };
});

const DEV_ACTIONS: readonly DevAction[] = ['start', 'stop', 'restart', 'setup'];

// Also called by Claude itself (see DevManager.describeForClaude), so the server name can go in the query string.
app.post<{ Params: { id: string; action: string }; Querystring: { name?: string } }>(
  '/api/sessions/:id/dev/:action',
  async (req) => {
    const action = req.params.action as DevAction;
    if (!DEV_ACTIONS.includes(action)) throw new HttpError(404, `Unknown action ${action}`);
    await sessions.devAction(req.params.id, action, req.query.name || undefined);
    hub.broadcast({ type: 'sessions' });
    return { ok: true };
  },
);

app.get<{ Params: { id: string; name: string } }>('/api/sessions/:id/logs/:name', async (req, reply) => {
  const file = await sessions.logPath(req.params.id, req.params.name);
  streamLog(reply, file);
  return reply;
});

// Claude Code hooks post here (see claude.ts). Always answer 204 quickly; hooks must never block Claude.
app.post<{ Body: HookPayload }>('/api/hook', async (req, reply) => {
  if (req.headers['x-remote-ai-token'] !== hookToken) return reply.code(401).send();
  const payload = req.body;
  if (payload?.cwd) {
    try {
      const id = await sessions.resolveByCwd(payload.cwd);
      if (id) statuses.apply(id, payload);
      else req.log.debug({ cwd: payload.cwd }, 'hook from unknown cwd');
    } catch (err) {
      req.log.warn({ err }, 'could not resolve hook');
    }
  }
  return reply.code(204).send();
});

// ---- Terminal WebSocket ----

app.get<{ Params: { id: string }; Querystring: { window?: string; cols?: string; rows?: string } }>(
  '/ws/terminal/:id',
  { websocket: true },
  async (socket, req) => {
    const window = req.query.window ?? 'claude';
    if (!isValidWindowName(window) || !(await tmux.hasSession(req.params.id))) {
      socket.close(4404, 'Session is not running');
      return;
    }
    attachTerminal(socket, { tmux, sessionId: req.params.id, window, cols: req.query.cols, rows: req.query.rows });
  },
);

// ---- Built web app (in development Vite serves it instead) ----

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = [path.resolve(here, '../../web'), path.resolve(here, '../../../dist/web')].find((d) =>
  fs.existsSync(path.join(d, 'index.html')),
);
if (webDir) {
  // Files are looked up per request (not registered at startup), so `npm run build` while the
  // server runs takes effect on the next page load; index.html is revalidated every time.
  await app.register(fastifyStatic, { root: webDir });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

// Things change outside the dashboard: a session's last window exits, a dev server crashes back to
// its shell, a process starts listening. Poll cheaply and tell browsers when anything moved.
let lastSignature = '';
setInterval(async () => {
  try {
    const [windows, ports] = await Promise.all([tmux.listWindows(), listeningPorts()]);
    const signature = JSON.stringify([
      [...windows.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ports.map((p) => `${p.port}:${p.pid}`),
    ]);
    if (signature !== lastSignature) {
      lastSignature = signature;
      sessions.invalidate();
      hub.broadcast({ type: 'sessions' });
    }
  } catch {
    // tmux unavailable; the next request will surface the error
  }
}, 3000).unref();

await app.listen({ host: cfg.host, port: cfg.port });
app.log.info(`projects: ${cfg.projectsDir}  worktrees: ${cfg.worktreesDir}  tmux socket: ${cfg.tmuxSocket}`);
