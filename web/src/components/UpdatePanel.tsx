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

/** Version, and pulling updates from the install's git upstream. */
export function UpdatePanel() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.version().then(setInfo).catch(() => undefined);
  }, []);
  if (!info) return null;

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setInfo(await api.version(true));
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
      else setInfo(await api.version());
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
