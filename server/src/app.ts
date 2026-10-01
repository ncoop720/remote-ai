import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { Auth } from './auth.js';
import type { Config } from './config.js';
import { gitUpdates, installRoot, type UpdateProvider } from './update.js';
import { CommandError, run } from './exec.js';
import { AgentRegistry, loadHookToken } from './agents/index.js';
import { claudeAdapter } from './agents/claude/index.js';
import { writeClaudeSettings } from './agents/claude/hooks.js';
import { DevManager } from './dev.js';
import { HttpError } from './errors.js';
import { EventHub } from './events.js';
import { streamLog } from './logs.js';
import { listeningPorts } from './ports.js';
import { noticeFor, PushService, type Notice } from './push.js';
import { AGENT_TERMINAL, SessionManager } from './sessions.js';
import { StateStore } from './state.js';
import { StatusStore } from './status.js';
import { attachTerminal, CLOSE_NOT_FOUND } from './terminal.js';
import { streamTranscript } from './transcript.js';
import { HostClient, type HostCommand } from './hostclient.js';
import { isValidTermName, type TermRef } from './host/protocol.js';
import type { CreateSessionRequest, DevAction, SessionStatus, SetupInfo, StartSessionRequest } from '../../shared/types.js';

export interface ServerOptions {
  config: Config;
  /** The built web app. Looked for next to the server when left out (in development Vite serves it). */
  webDir?: string;
  /** How to start the session host; the desktop app runs its own copy. */
  hostCommand?: HostCommand;
  /** Where /api/version and /api/update get their answers; git when running from a checkout. */
  updates?: UpdateProvider | null;
  /** Every notification that would go to phones (the desktop app shows them itself). */
  onNotice?: (notice: Notice) => void;
  /** Log here instead of stdout. */
  logFile?: string;
}

export interface RunningServer {
  url: string;
  host: HostClient;
  sessions: SessionManager;
  statuses: StatusStore;
  log: FastifyBaseLogger;
  close(): Promise<void>;
}

/** Terminals for installing and signing in to agents live in this pseudo-session. */
export const SETUP_SESSION = '_setup';

async function gitVersion(): Promise<SetupInfo['git']> {
  try {
    return { installed: true, version: /\d+\.\d+(\.\d+)?/.exec(await run('git', ['--version']))?.[0] };
  } catch {
    return { installed: false };
  }
}

/** Start the dashboard server: the HTTP API, terminals over WebSocket, and the built web app. */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const cfg = opts.config;
  const logStream = opts.logFile ? fs.createWriteStream(opts.logFile, { flags: 'a' }) : undefined;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', stream: logStream }, bodyLimit: 8 * 1024 * 1024 });

  const host = new HostClient(cfg.dataDir, app.log, opts.hostCommand);
  const state = new StateStore(cfg.dataDir, cfg.portBase, cfg.portStep);
  const statuses = new StatusStore();
  const hookToken = loadHookToken(cfg.dataDir);
  const agents = new AgentRegistry([
    claudeAdapter({ command: cfg.claudeCommand, settingsPath: writeClaudeSettings(cfg.dataDir, cfg.port, hookToken) }),
  ]);
  const dev = new DevManager(cfg, host, state);
  const auth = new Auth(cfg.dataDir, cfg.password);
  const sessions = new SessionManager(cfg, host, state, statuses, agents, dev);
  const hub = new EventHub();

  const push = new PushService(cfg.dataDir, cfg.pushSubject);
  const lastNotice = new Map<string, number>();

  statuses.on('change', (sessionId: string, status: SessionStatus, prev: SessionStatus) => {
    hub.broadcast({ type: 'status', sessionId, status });
    void (async () => {
      const notice = noticeFor(await sessions.label(sessionId), prev, status);
      if (!notice) return;
      // A prompt answered and re-asked within seconds shouldn't buzz the phone twice.
      const key = `${sessionId}:${notice.title}`;
      if (Date.now() - (lastNotice.get(key) ?? 0) < 5000) return;
      lastNotice.set(key, Date.now());
      opts.onNotice?.(notice);
      if (push.info().subscriptions === 0) return;
      app.log.info({ sessionId, title: notice.title }, 'push notification');
      const result = await push.send(notice);
      if (result.failed > 0) app.log.warn({ sessionId, title: notice.title, ...result }, 'push notification not delivered to every device');
    })().catch((err: unknown) => app.log.warn({ err }, 'push notification failed'));
  });

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

  // The page itself loads without a login (it shows the login form); the API and terminals need one.
  const OPEN_PATHS = new Set(['/api/health', '/api/auth', '/api/login', '/api/logout']);
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/') && !url.startsWith('/ws/')) return;
    // Agent hooks carry their own token.
    if (OPEN_PATHS.has(url) || url.startsWith('/api/hooks/') || auth.allowed(req)) return;
    return reply.code(401).send({ error: 'Log in first' });
  });

  app.get('/api/auth', async (req) => ({ required: auth.enabled && !auth.allowed(req), enabled: auth.enabled }));

  app.post<{ Body: { password?: string } }>('/api/login', async (req, reply) => {
    const result = auth.login(req, reply, req.body?.password);
    if (result === 'limited') return reply.code(429).send({ error: 'Too many attempts; wait a few minutes' });
    if (result === 'wrong') return reply.code(401).send({ error: 'Wrong password' });
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    auth.logout(req, reply);
    return { ok: true };
  });

  // ---- Updates ----

  const root = installRoot(path.dirname(fileURLToPath(import.meta.url)));
  const updates = opts.updates === undefined ? (root ? gitUpdates(root) : null) : opts.updates;

  app.get<{ Querystring: { fetch?: string } }>('/api/version', async (req) => {
    if (!updates) throw new HttpError(404, "This install doesn't update itself");
    return updates.info(req.query.fetch === '1');
  });

  let updating = false;
  app.post('/api/update', async () => {
    if (!updates) throw new HttpError(404, "This install doesn't update itself");
    if (updating) throw new HttpError(409, 'An update is already running');
    updating = true;
    try {
      return await updates.update();
    } finally {
      updating = false;
    }
  });

  // ---- API ----

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/projects', async () => sessions.listProjects());

  app.get('/api/agents', async () => agents.detect());

  // ---- First run: tools, agents and projects ----

  app.get('/api/setup', async (): Promise<SetupInfo> => {
    const [git, agentInfo] = await Promise.all([gitVersion(), agents.detect()]);
    return { platform: process.platform, git, agents: agentInfo };
  });

  /** Run an agent's installer or sign-in in a terminal the page can show. Reuses one that is still running. */
  const agentTask = async (agentId: string, task: 'install' | 'signin'): Promise<TermRef> => {
    const adapter = agents.get(agentId);
    const argv = task === 'install' ? adapter.install?.(process.platform) : adapter.signIn?.();
    if (!argv) throw new HttpError(400, `${adapter.name} can't be set up from here`);
    const ref = { session: SETUP_SESSION, name: `${task}-${adapter.id}` };
    if ((await host.list()).some((t) => t.session === ref.session && t.name === ref.name && t.alive)) return ref;
    try {
      await host.spawn({ ...ref, cwd: os.homedir(), argv });
    } catch (err) {
      throw new HttpError(500, (err as Error).message);
    }
    return ref;
  };

  app.post<{ Params: { id: string } }>('/api/agents/:id/install', async (req) => agentTask(req.params.id, 'install'));

  app.post<{ Params: { id: string } }>('/api/agents/:id/signin', async (req) => agentTask(req.params.id, 'signin'));

  app.post<{ Body: { path?: string } }>('/api/projects', async (req) => {
    const name = await sessions.addProject(String(req.body?.path ?? ''));
    hub.broadcast({ type: 'sessions' });
    return { name };
  });

  app.delete<{ Params: { name: string } }>('/api/projects/:name', async (req) => {
    await sessions.removeProject(req.params.name);
    hub.broadcast({ type: 'sessions' });
    return { ok: true };
  });

  app.get('/api/events', (req, reply) => {
    hub.subscribe(reply);
  });

  app.post<{ Params: { project: string }; Body: CreateSessionRequest }>(
    '/api/projects/:project/sessions',
    async (req) => {
      const id = await sessions.createSession(req.params.project, req.body ?? ({} as CreateSessionRequest));
      hub.broadcast({ type: 'sessions' });
      return { id };
    },
  );

  app.post<{ Params: { id: string }; Body: StartSessionRequest }>('/api/sessions/:id/start', async (req) => {
    await sessions.startSession(req.params.id, req.body ?? {});
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

  // Also called by the agent itself (see DevManager.describeForAgent), so the server name can go in the query string.
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

  app.get<{ Params: { id: string } }>('/api/sessions/:id/chat', async (req, reply) => {
    const { file, parse } = await sessions.transcriptFor(req.params.id);
    streamTranscript(reply, file, parse);
    return reply;
  });

  app.get<{ Params: { id: string; name: string } }>('/api/sessions/:id/logs/:name', async (req, reply) => {
    const file = await sessions.logPath(req.params.id, req.params.name);
    streamLog(reply, file);
    return reply;
  });

  // ---- Push notifications ----

  app.get('/api/push', async () => push.info());

  app.post<{ Body: { subscription: unknown } }>('/api/push/subscribe', async (req) => {
    const sub = push.subscribe(req.body?.subscription, req.headers['user-agent']);
    // Confirms the whole path (keys, relay, service worker) works on this device.
    const result = await push.send({ title: 'Notifications are on', body: "You'll hear when a session needs you or finishes.", tag: 'remote-ai', url: '/' }, sub);
    return { ok: result.sent === 1 };
  });

  app.post<{ Body: { endpoint: string } }>('/api/push/unsubscribe', async (req) => {
    push.unsubscribe(String(req.body?.endpoint ?? ''));
    return { ok: true };
  });

  app.post('/api/push/test', async () =>
    push.send({ title: 'Test notification', body: 'Push notifications from remote-ai work.', tag: 'remote-ai', url: '/' }),
  );

  // Agents' hooks post here (for Claude, see agents/claude/hooks.ts). Always answer 204 quickly;
  // hooks must never block the agent.
  app.post<{ Params: { agent: string } }>('/api/hooks/:agent', async (req, reply) => {
    if (req.headers['x-remote-ai-token'] !== hookToken) return reply.code(401).send();
    if (!agents.has(req.params.agent)) return reply.code(404).send();
    try {
      const id = await sessions.applyAgentEvent(req.params.agent, req.body);
      if (!id) req.log.debug({ agent: req.params.agent }, 'hook from an unknown session');
    } catch (err) {
      req.log.warn({ err }, 'could not apply hook');
    }
    return reply.code(204).send();
  });

  // ---- Terminal WebSocket ----

  app.get<{ Params: { id: string }; Querystring: { name?: string; cols?: string; rows?: string } }>(
    '/ws/terminal/:id',
    { websocket: true },
    async (socket, req) => {
      const name = req.query.name ?? AGENT_TERMINAL;
      if (!isValidTermName(req.params.id) || !isValidTermName(name)) {
        socket.close(CLOSE_NOT_FOUND, 'No such terminal');
        return;
      }
      try {
        await attachTerminal(socket, { host, ref: { session: req.params.id, name }, cols: req.query.cols, rows: req.query.rows });
      } catch (err) {
        req.log.warn({ err }, 'terminal attach failed');
        socket.close(1011, 'Session host unavailable');
      }
    },
  );

  // ---- Built web app (in development Vite serves it instead) ----

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = (opts.webDir ? [opts.webDir] : [path.resolve(here, '../../web'), path.resolve(here, '../../../dist/web')]).find((d) =>
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

  // The host reports terminals starting and exiting (an agent quits, a dev server crashes).
  const terminalsChanged = () => {
    sessions.invalidate();
    hub.broadcast({ type: 'sessions' });
  };
  host.on('spawn', terminalsChanged);
  host.on('exit', terminalsChanged);
  host.on('disconnect', terminalsChanged);

  // Ports aren't announced: a process starts listening. Poll cheaply and tell browsers when anything moved.
  let lastSignature = '';
  const portPoll = setInterval(async () => {
    try {
      const signature = (await listeningPorts()).map((p) => `${p.port}:${p.pid}`).join(',');
      if (signature !== lastSignature) {
        lastSignature = signature;
        terminalsChanged();
      }
    } catch {
      // no port listing on this platform
    }
  }, 3000).unref();

  try {
    await host.list();
  } catch (err) {
    app.log.error({ err }, 'could not reach the session host');
  }

  await app.listen({ host: cfg.host, port: cfg.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : cfg.port;
  app.log.info(`projects: ${cfg.projectsDir ?? '(added only)'}  worktrees: ${cfg.worktreesDir}  data: ${cfg.dataDir}`);

  return {
    url: `http://${cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host}:${port}`,
    host,
    sessions,
    statuses,
    log: app.log,
    async close() {
      clearInterval(portPoll);
      host.close();
      await app.close();
      logStream?.end();
    },
  };
}
