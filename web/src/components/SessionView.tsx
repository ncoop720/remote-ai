import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { navigate, routes } from '../hooks';
import type { PermissionMode, SessionInfo } from '../../../shared/types';
import { ChatView } from './ChatView';
import { DevPanel, LogsView, PreviewView } from './DevViews';
import { DiffView } from './DiffView';
import { changeSummary } from '../status';
import { ChevronLeft, Play, Stop, Trash } from './icons';
import { Composer, MobileControls } from './MobileControls';
import { PromptCard } from './PromptCard';
import { StatusPill } from './StatusDot';
import { Terminal } from './Terminal';

/** A button that asks for a second tap before doing something destructive. */
function ConfirmButton({ label, confirmLabel, icon, onConfirm, ariaLabel }: {
  label: string;
  confirmLabel: string;
  icon: React.ReactNode;
  onConfirm: () => void;
  /** Needed when `label` is empty (icon-only on phones). */
  ariaLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={armed ? 'btn btn-danger' : 'btn'}
      aria-label={armed ? confirmLabel : ariaLabel}
      onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
    >
      {icon}
      {armed ? confirmLabel : label}
    </button>
  );
}

function Meta({ session }: { session: SessionInfo }) {
  const bits: string[] = [session.path];
  if (session.base) bits.push(`from ${session.base}`);
  if (session.ahead) bits.push(`${session.ahead} ahead`);
  if (session.dirty) bits.push(`${session.dirty} changed`);
  if (session.port) bits.push(`:${session.port}`);
  return <div className="session-meta">{bits.join(' · ')}</div>;
}

function StoppedPanel({ session, onChanged }: { session: SessionInfo; onChanged: () => void }) {
  const [mode, setMode] = useState<PermissionMode>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (resume: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.start(session.id, { resume, permissionMode: mode });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stopped-panel">
      <p>Claude isn't running in this worktree.</p>
      <label className="field">
        <span>Permissions</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
          <option value="auto">Auto (a classifier approves safe actions)</option>
          <option value="manual">Ask before acting</option>
          <option value="acceptEdits">Accept edits</option>
          <option value="plan">Plan only</option>
        </select>
      </label>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start(false)}>
          <Play size={16} /> New conversation
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void start(true)}>
          Resume last conversation
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function SessionView({ session, isDesktop, onChanged }: {
  session: SessionInfo;
  isDesktop: boolean;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [needsForce, setNeedsForce] = useState(false);
  const [tab, setTab] = useState<Tab>('chat');
  const [leftView, setLeftView] = useState<'terminal' | 'chat'>('terminal');
  const working = session.status.state === 'working';
  const [devToggled, setDevToggled] = useState<boolean | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const changes = changeSummary(session);
  const showDev = devToggled ?? hasDevContent(session);
  const runningServers = session.dev.servers.filter((s) => s.state === 'running').length;

  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
      if (/modified or untracked|use --force/i.test(msg)) setNeedsForce(true);
    }
  };

  const remove = (force: boolean) =>
    act(async () => {
      await api.remove(session.id, force);
      navigate(routes.home());
    });

  return (
    <div className="session-view">
      <header className="session-header">
        {!isDesktop && (
          <a className="icon-btn" href={routes.home()} aria-label="Back to sessions">
            <ChevronLeft size={22} />
          </a>
        )}
        <div className="session-title">
          <div className="session-name">
            {isDesktop && <span className="muted">{session.project} /</span>}
            <span className="mono">{session.branch ?? 'detached'}</span>
            <StatusPill state={session.status.state} />
            {isDesktop && session.title && <span className="session-topic">{session.title}</span>}
          </div>
          {isDesktop ? (
            <Meta session={session} />
          ) : (
            <div className="session-meta session-meta-sans">{session.title ? `${session.project} · ${session.title}` : session.project}</div>
          )}
        </div>
        <div className="session-actions">
          {changes && (
            <button type="button" className="btn changes-btn" onClick={() => setShowDiff(true)} aria-label={`Review changes (${changes})`}>
              {isDesktop && 'Changes '}
              <span className="mono">{changes}</span>
            </button>
          )}
          {isDesktop && session.running && (
            <button type="button" className="btn" aria-pressed={showDev} onClick={() => setDevToggled(!showDev)}>
              {showDev ? 'Hide preview & logs' : 'Preview & logs'}
            </button>
          )}
          {session.running && (
            <ConfirmButton
              label={isDesktop ? 'End session' : 'End'}
              ariaLabel="End session (stops Claude and the dev servers)"
              confirmLabel="End session?"
              icon={<Stop size={14} />}
              onConfirm={() => void act(() => api.stop(session.id))}
            />
          )}
          {!session.isMain && (
            <ConfirmButton
              label={isDesktop ? 'Remove worktree' : ''}
              ariaLabel="Remove worktree"
              confirmLabel="Remove?"
              icon={<Trash size={15} />}
              onConfirm={() => void remove(false)}
            />
          )}
        </div>
      </header>

      {showDiff && <DiffView session={session} onClose={() => setShowDiff(false)} />}

      {error && (
        <div className="notice error">
          {error}
          {needsForce && (
            <button type="button" className="btn btn-danger" onClick={() => void remove(true)}>
              Discard changes and remove
            </button>
          )}
        </div>
      )}

      {!session.running ? (
        <StoppedPanel session={session} onChanged={onChanged} />
      ) : isDesktop ? (
        <div className="session-split">
          <div className="session-body">
            <div className="segmented segmented-small" role="group" aria-label="View">
              <button type="button" aria-pressed={leftView === 'terminal'} onClick={() => setLeftView('terminal')}>
                Terminal
              </button>
              <button type="button" aria-pressed={leftView === 'chat'} onClick={() => setLeftView('chat')}>
                Chat
              </button>
            </div>
            {/* The terminal stays mounted so switching views doesn't drop its connection. */}
            <div className="pane" hidden={leftView !== 'terminal'}>
              <Terminal key={session.id} sessionId={session.id} fontSize={13} />
            </div>
            {leftView === 'chat' && <ChatView session={session} />}
            <PromptCard session={session} />
            {leftView === 'chat' && <Composer sessionId={session.id} working={working} submitOnEnter />}
          </div>
          {showDev && <DevPanel session={session} />}
        </div>
      ) : (
        <>
          <nav className="tabs" aria-label="Session views">
            {TABS.map((t) => (
              <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === 'logs' && runningServers > 0 && <span className="tab-count">{runningServers}</span>}
                {t.id === 'preview' && session.ports.length > 0 && <span className="tab-count">{session.ports.length}</span>}
              </button>
            ))}
          </nav>
          {tab === 'chat' && (
            <div className="session-body">
              <ChatView session={session} />
              <PromptCard session={session} />
              <div className="mobile-controls">
                <Composer sessionId={session.id} working={working} />
              </div>
            </div>
          )}
          {/* The terminal stays mounted so switching tabs doesn't drop its connection. */}
          <div className="session-body" hidden={tab !== 'terminal'}>
            <Terminal key={session.id} sessionId={session.id} fontSize={12} />
            <PromptCard session={session} />
            <MobileControls sessionId={session.id} />
          </div>
          {tab === 'logs' && (
            <div className="session-body">
              <LogsView session={session} />
            </div>
          )}
          {tab === 'preview' && (
            <div className="session-body">
              <PreviewView session={session} isDesktop={false} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const TABS = [
  { id: 'chat', label: 'Chat' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'logs', label: 'Logs' },
  { id: 'preview', label: 'Preview' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/** Show the dev panel by default only when there is something in it. */
function hasDevContent(session: SessionInfo): boolean {
  return session.dev.servers.length > 0 || session.dev.setup !== 'none' || session.ports.length > 0 || Boolean(session.dev.error);
}
