import { useEffect, useState } from 'react';
import { api, errorMessage, type UpdateResult, type VersionInfo } from '../api';

/** Wait for the server to come back after it restarts itself, then load the new version. */
async function reloadWhenBack(): Promise<void> {
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('/api/health')).ok) break;
    } catch {
      // still restarting
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  window.location.reload();
}

/** Version and updates: the desktop app's releases, or the install's git upstream. */
export function UpdatePanel() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  useEffect(() => {
    api.version().then(setInfo).catch(() => undefined);
  }, []);
  if (!info) return null;
  return info.kind === 'desktop' ? <DesktopUpdates initial={info} /> : <GitUpdates initial={info} />;
}

type DesktopInfo = Extract<VersionInfo, { kind: 'desktop' }>;

/** The desktop app downloads updates by itself; this shows progress and restarts into the new version. */
function DesktopUpdates({ initial }: { initial: DesktopInfo }) {
  const [info, setInfo] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  // Follow a check or download while it runs.
  const busy = info.state === 'checking' || info.state === 'downloading';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      api.version().then((v) => v.kind === 'desktop' && setInfo(v)).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [busy]);

  const check = async () => {
    setError(null);
    try {
      const v = await api.version(true);
      if (v.kind === 'desktop') setInfo(v);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const restart = async () => {
    setError(null);
    try {
      const r = await api.update();
      if (r.restarting) {
        setRestarting(true);
        void reloadWhenBack();
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  let action: React.ReactNode;
  if (restarting) action = <span>Restarting…</span>;
  else if (info.state === 'ready') {
    action = (
      <button type="button" className="btn btn-small btn-primary" onClick={() => void restart()}>
        Restart to update · {info.latest}
      </button>
    );
  } else if (info.state === 'downloading') action = <span>Downloading {info.latest}… {info.progress ?? 0}%</span>;
  else if (info.state === 'checking') action = <span>Checking…</span>;
  else if (info.state === 'unsupported') action = <span>{info.error ?? 'No automatic updates'}</span>;
  else {
    action = (
      <button type="button" className="link-btn" onClick={() => void check()}>
        {info.state === 'up-to-date' ? 'Up to date · check again' : 'Check for updates'}
      </button>
    );
  }

  return (
    <div className="update-panel">
      <div className="update-line">
        <span className="mono">v{info.version}</span>
        {action}
      </div>
      {info.state === 'error' && info.error && <p className="error">{info.error}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Pulling updates from the install's git upstream. */
function GitUpdates({ initial }: { initial: Extract<VersionInfo, { kind: 'git' }> }) {
  const [info, setInfo] = useState(initial);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const v = await api.version(true);
      if (v.kind === 'git') setInfo(v);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.update();
      setResult(r);
      if (r.restarting) void reloadWhenBack();
      else {
        const v = await api.version();
        if (v.kind === 'git') setInfo(v);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  let status: React.ReactNode = null;
  if (result?.restarting) status = 'Updated. Restarting the server…';
  else if (result && !result.ok) status = <span className="error">Update failed: {result.log.at(-1)}</span>;
  else if (result?.restartNeeded) status = 'Updated. Restart the server to finish (Ctrl-C, then npm start).';
  else if (result && result.from !== result.to) {
    status = (
      <>
        Updated.{' '}
        <button type="button" className="link-btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </>
    );
  }

  return (
    <div className="update-panel">
      <div className="update-line">
        <span className="mono">
          {info.commit}
          {info.branch !== 'main' ? ` (${info.branch})` : ''}
        </span>
        {info.behind ? (
          <button type="button" className="btn btn-small btn-primary" disabled={busy || info.dirty} onClick={() => void run()}>
            {busy ? 'Updating…' : `Update · ${info.behind} new`}
          </button>
        ) : (
          <button type="button" className="link-btn" disabled={checking} onClick={() => void check()}>
            {checking ? 'Checking…' : info.behind === 0 ? 'Up to date · check again' : 'Check for updates'}
          </button>
        )}
      </div>
      {info.dirty && info.behind ? <p className="muted">The install has local changes, so it can't update itself.</p> : null}
      {status && <p className="muted">{status}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
