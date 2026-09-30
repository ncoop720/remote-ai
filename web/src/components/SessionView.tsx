import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { navigate, routes } from '../hooks';
import type { PermissionMode, SessionInfo } from '../../../shared/types';
import { ChevronLeft, Play, Stop, Trash } from './icons';
import { MobileControls } from './MobileControls';
import { PromptCard } from './PromptCard';
import { StatusPill } from './StatusDot';
import { Terminal } from './Terminal';

/** A button that asks for a second tap before doing something destructive. */
function ConfirmButton({ label, confirmLabel, icon, onConfirm }: {
  label: string;
  confirmLabel: string;
  icon: React.ReactNode;
  onConfirm: () => void;
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
      <p>No tmux session is running for this worktree.</p>
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
          </div>
          {isDesktop ? <Meta session={session} /> : <div className="session-meta">{session.project}</div>}
        </div>
        <div className="session-actions">
          {session.running && (
            <ConfirmButton label="Stop" confirmLabel="Stop session?" icon={<Stop size={14} />} onConfirm={() => void act(() => api.stop(session.id))} />
          )}
          {!session.isMain && (
            <ConfirmButton label={isDesktop ? 'Remove worktree' : ''} confirmLabel="Remove?" icon={<Trash size={15} />} onConfirm={() => void remove(false)} />
          )}
        </div>
      </header>

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

      {session.running ? (
        <div className="session-body">
          <Terminal key={session.id} sessionId={session.id} fontSize={isDesktop ? 13 : 12} />
          <PromptCard session={session} />
          {!isDesktop && <MobileControls sessionId={session.id} />}
        </div>
      ) : (
        <StoppedPanel session={session} onChanged={onChanged} />
      )}
    </div>
  );
}
