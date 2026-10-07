import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { isErrorLine, lineText, parseAnsi } from '../ansi';
import type { DevServerInfo, PreviewAccess, SessionInfo } from '../../../shared/types';
import { Play, Stop } from './icons';

const MAX_TEXT = 400_000;
const KEEP_TEXT = 300_000;
const MAX_RENDERED_LINES = 1500;

/** Follow a log over server-sent events; the text is trimmed from the front as it grows. */
function useLogStream(sessionId: string, name: string | null): string {
  const [text, setText] = useState('');
  useEffect(() => {
    setText('');
    if (!name) return;
    const events = new EventSource(api.logsUrl(sessionId, name));
    events.onmessage = (msg) => {
      const data = JSON.parse(msg.data as string) as { reset?: boolean; text: string };
      setText((prev) => {
        let next = data.reset ? data.text : prev + data.text;
        if (next.length > MAX_TEXT) next = next.slice(next.indexOf('\n', next.length - KEEP_TEXT) + 1);
        return next;
      });
    };
    return () => events.close();
  }, [sessionId, name]);
  return text;
}

const agentLabel = (session: SessionInfo) => (session.agent === 'claude' ? 'Claude' : 'the agent');

/** Ask the session's agent to write .remote-ai.json; it starts if it wasn't running. */
function SetUpButton({ session, primary, onDone }: { session: SessionInfo; primary?: boolean; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    setBusy(true);
    try {
      const { started } = await api.configureDev(session.id);
      onDone(
        `${started ? 'Started' : 'Asked'} ${agentLabel(session)} to write .remote-ai.json; follow along in the chat. The servers here update when it's done.`,
      );
    } catch (err) {
      onDone(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={primary ? 'btn btn-primary' : 'link-btn'} disabled={busy} onClick={() => void click()}>
      {busy ? 'Asking…' : `Set up with ${agentLabel(session)}`}
    </button>
  );
}

/** Where the servers below come from, and a way to have the agent set them up properly. */
function ConfigLine({ session }: { session: SessionInfo }) {
  const [message, setMessage] = useState<string | null>(null);
  const { dev } = session;
  const from = dev.source === 'file' ? 'From .remote-ai.json' : `Detected: ${dev.detected ?? 'a guess from the repo'}`;
  return (
    <div className="config-line">
      <span className="muted">{from}</span>
      <SetUpButton session={session} onDone={setMessage} />
      {message && <p className="config-message">{message}</p>}
    </div>
  );
}

function ConfigHelp({ session }: { session: SessionInfo }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="dev-help">
      {session.dev.error ? (
        <p className="error">{session.dev.error}</p>
      ) : (
        <p>No dev servers found for {session.project}.</p>
      )}
      <p className="muted">
        {agentLabel(session) === 'Claude' ? 'Claude' : 'The agent'} can read the repo and write a <code>.remote-ai.json</code> that
        says how to install and run it.
      </p>
      <div className="row">
        <SetUpButton session={session} primary onDone={setMessage} />
      </div>
      {message && <p className="config-message">{message}</p>}
      <p className="muted">
        Or write it yourself (in the repo, or just in the main checkout). Each server runs in its own terminal and gets{' '}
        <code>$PORT</code>, plus <code>$PORT_&lt;NAME&gt;</code> for every server:
      </p>
      <pre>{`{
  "setup": ["npm ci"],
  "servers": [
    { "name": "web", "command": "npm run dev -- --port $PORT" }
  ]
}`}</pre>
    </div>
  );
}

function ServerChip({ server, active, onClick }: { server: DevServerInfo; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className="chip chip-small" aria-pressed={active} onClick={onClick}>
      <span className={`dot ${server.state === 'running' ? 'dot-working' : 'dot-stopped'}`} />
      {server.name}
      {server.port && <span className="chip-port">:{server.port}</span>}
    </button>
  );
}

/** Dev server output with controls. Tap lines to select them and paste them into Claude's prompt. */
export function LogsView({ session }: { session: SessionInfo }) {
  const { dev } = session;
  const sources = [...dev.servers.map((s) => s.name), ...(dev.setup !== 'none' ? ['setup'] : [])];
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected && sources.includes(selected) ? selected : (sources[0] ?? null);
  const server = dev.servers.find((s) => s.name === current);

  const text = useLogStream(session.id, current);
  const lines = useMemo(() => parseAnsi(text), [text]);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => setPicked(new Set()), [current]);
  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines, follow]);

  const visible = useMemo(() => {
    const indexed = lines.map((line, i) => ({ line, i }));
    const filtered = errorsOnly ? indexed.filter(({ line }) => isErrorLine(line)) : indexed;
    return filtered.slice(-MAX_RENDERED_LINES);
  }, [lines, errorsOnly]);

  const act = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (i: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const sendToClaude = () => {
    const chosen = [...picked].sort((a, b) => a - b).map((i) => lineText(lines[i] ?? []));
    const message = `Output from the ${current} dev server:\n\`\`\`\n${chosen.join('\n')}\n\`\`\`\n`;
    void act(async () => {
      await api.text(session.id, message, false);
      setPicked(new Set());
    }, "Pasted into Claude's prompt. Add your question and send it.");
  };

  if (sources.length === 0) return <ConfigHelp session={session} />;

  const stoppedCount = dev.servers.filter((s) => s.state === 'stopped').length;
  return (
    <section className="logs" aria-label="Dev server logs">
      <ConfigLine session={session} />
      <div className="logs-toolbar">
        <div className="chips" role="group" aria-label="Log">
          {dev.servers.map((s) => (
            <ServerChip key={s.name} server={s} active={s.name === current} onClick={() => setSelected(s.name)} />
          ))}
          {dev.setup !== 'none' && (
            <button type="button" className="chip chip-small" aria-pressed={current === 'setup'} onClick={() => setSelected('setup')}>
              setup <span className={`setup-state setup-${dev.setup}`}>{dev.setup}</span>
            </button>
          )}
        </div>
        <div className="row">
          {current === 'setup' ? (
            <button type="button" className="btn btn-small" disabled={busy || dev.setup === 'running'} onClick={() => void act(() => api.dev(session.id, 'setup'))}>
              <Play size={13} /> {dev.setup === 'pending' ? 'Run setup' : 'Run again'}
            </button>
          ) : server?.state === 'running' ? (
            <>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => void act(() => api.dev(session.id, 'restart', current ?? undefined))}>
                Restart
              </button>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => void act(() => api.dev(session.id, 'stop', current ?? undefined))}>
                <Stop size={12} /> Stop
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-small btn-primary" disabled={busy || dev.setup === 'running'} onClick={() => void act(() => api.dev(session.id, 'start', current ?? undefined))}>
              <Play size={13} /> Start
            </button>
          )}
          {dev.servers.length > 1 && stoppedCount > 0 && (
            <button type="button" className="btn btn-small" disabled={busy || dev.setup === 'running'} onClick={() => void act(() => api.dev(session.id, 'start'))}>
              Start all
            </button>
          )}
          <button type="button" className="btn btn-small" aria-pressed={errorsOnly} onClick={() => setErrorsOnly((v) => !v)}>
            {errorsOnly ? 'Errors only' : 'All lines'}
          </button>
        </div>
      </div>
      {dev.setup === 'pending' && current !== 'setup' && (
        <p className="notice-line">This worktree hasn't been set up yet: run setup (the setup tab) to install its dependencies.</p>
      )}
      <div
        className="log-lines"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        {visible.length === 0 && <p className="muted log-empty">{text ? 'No matching lines.' : 'No output yet.'}</p>}
        {visible.map(({ line, i }) => (
          <button
            key={i}
            type="button"
            className={`log-line${picked.has(i) ? ' picked' : ''}${isErrorLine(line) ? ' error-line' : ''}`}
            aria-pressed={picked.has(i)}
            onClick={() => toggle(i)}
          >
            {line.length === 0 ? ' ' : line.map((s, j) => (
              <span key={j} className={s.className || undefined}>
                {s.text}
              </span>
            ))}
          </button>
        ))}
      </div>
      {(picked.size > 0 || notice) && (
        <div className="logs-footer">
          {picked.size > 0 ? (
            <>
              <button type="button" className="btn btn-primary grow" disabled={busy} onClick={sendToClaude}>
                Send {picked.size} {picked.size === 1 ? 'line' : 'lines'} to Claude
              </button>
              <button type="button" className="btn" onClick={() => setPicked(new Set())}>
                Clear
              </button>
            </>
          ) : (
            <span className="muted">{notice}</span>
          )}
        </div>
      )}
    </section>
  );
}

let previewAccess: Promise<PreviewAccess> | null = null;

/**
 * How this browser reaches dev servers: directly by port on this computer, or through the address
 * it came in on (Tailscale or Wi-Fi), where remote-ai serves each session's ports. Asked once.
 */
function usePreviewAccess(): PreviewAccess | undefined {
  const [access, setAccess] = useState<PreviewAccess | undefined>(undefined);
  useEffect(() => {
    previewAccess ??= api.preview().catch(() => null);
    void previewAccess.then(setAccess);
  }, []);
  return access;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function previewUrl(access: PreviewAccess, port: number, path: string): string {
  if (access) return `${access.scheme}://${access.host}:${port + access.offset}${path}`;
  // The desktop app opens the dashboard on 127.0.0.1, but dev servers may listen on ::1 only (Vite on
  // recent Node), and sites register localhost as their origin (Google sign-in), so use localhost.
  const host = LOOPBACK.has(location.hostname) ? 'localhost' : location.hostname;
  return `http://${host}:${port}${path}`;
}

/** The session's web pages: its dev servers, by port. */
export function PreviewView({ session, isDesktop }: { session: SessionInfo; isDesktop: boolean }) {
  const { ports } = session;
  const access = usePreviewAccess();
  const [port, setPort] = useState<number | null>(null);
  const [path, setPath] = useState('/');
  const [draft, setDraft] = useState('/');
  const [reload, setReload] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  // Default to the last configured server that is listening (configs list backends before the
  // frontend that talks to them), then to any listening port.
  const listening = new Set(ports.map((p) => p.port));
  const fallback =
    [...session.dev.servers].reverse().find((s) => s.port !== null && listening.has(s.port))?.port ?? ports[0]?.port ?? null;
  const current = port !== null && ports.some((p) => p.port === port) ? port : fallback;

  if (current === null) {
    return (
      <div className="preview-empty">
        <p>Nothing in this worktree is listening on a port yet.</p>
        <p className="muted">Start the dev servers from the logs panel, and pages will show up here.</p>
      </div>
    );
  }

  if (access === undefined) return <div className="preview-empty muted">Loading…</div>;
  const url = previewUrl(access, current, path);
  const server = ports.find((p) => p.port === current)?.server;
  const stop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      await api.stopPort(session.id, current);
    } catch (err) {
      setStopError(errorMessage(err));
    } finally {
      setStopping(false);
    }
  };
  // An https page can't show an http one: only when reached through a proxy remote-ai doesn't run.
  const blocked = url.startsWith('http:') && location.protocol === 'https:';
  return (
    <section className="preview" aria-label="Web preview">
      <form
        className="preview-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setPath(draft.startsWith('/') ? draft : `/${draft}`);
          setReload((n) => n + 1);
        }}
      >
        <select
          aria-label="Port"
          value={current}
          onChange={(e) => {
            setPort(Number(e.target.value));
            setStopError(null);
          }}
        >
          {ports.map((p) => (
            <option key={p.port} value={p.port}>
              :{p.port} {p.command.split(' ').slice(0, 2).join(' ')}
            </option>
          ))}
        </select>
        <input aria-label="Path" className="mono grow" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} autoCapitalize="off" />
        <button type="submit" className="btn btn-small" aria-label="Reload">
          ↻
        </button>
        {isDesktop && (
          <button type="button" className="btn btn-small" aria-pressed={narrow} onClick={() => setNarrow((v) => !v)}>
            {narrow ? 'Phone' : 'Full'}
          </button>
        )}
        <a className="btn btn-small" href={url} target="_blank" rel="noreferrer">
          Open ↗
        </a>
        <button
          type="button"
          className="btn btn-small"
          disabled={stopping}
          aria-label={`Stop ${server ? `the ${server} server` : `what's listening on port ${current}`}`}
          title={`Stop ${server ? `the ${server} server` : `what's listening on :${current}`}`}
          onClick={() => void stop()}
        >
          {/* Phones show just the icon, so the port stays readable */}
          <Stop size={12} />
          {isDesktop && 'Stop'}
        </button>
      </form>
      {stopError && <p className="error preview-error">{stopError}</p>}
      {blocked ? (
        <div className="preview-empty">
          <p>Browsers don't show http pages inside an https page.</p>
          <p className="muted">
            Use Open ↗ to view {url} in its own tab, or reach remote-ai through its built-in Tailscale, which serves previews
            over https.
          </p>
        </div>
      ) : (
        <div className="preview-frame-wrap">
          {/* The page is cross-origin to the dashboard, and Sign in with Google (FedCM) only runs in such a frame when the parent allows it */}
          <iframe
            key={`${url}#${reload}`}
            title={`Preview of ${url}`}
            src={url}
            allow="identity-credentials-get"
            className={narrow ? 'preview-frame narrow' : 'preview-frame'}
          />
        </div>
      )}
    </section>
  );
}

/** Desktop right-hand column: the page on top, server output below. */
export function DevPanel({ session }: { session: SessionInfo }) {
  return (
    <aside className="dev-panel">
      <div className="dev-panel-preview">
        <PreviewView session={session} isDesktop />
      </div>
      <div className="dev-panel-logs">
        <LogsView session={session} />
      </div>
    </aside>
  );
}
