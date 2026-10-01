import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import type { AuthInfo } from '../../../shared/types';

/** Shown to a browser that isn't paired yet: type the code from the computer (or the password, if set). */
export function Login({ info, initialError, onDone }: { info: AuthInfo | null; initialError?: string | null; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);

  const run = async (e: FormEvent, fn: () => Promise<unknown>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <img src="/icon-192.png" alt="" width={56} height={56} />
        <h1>Connect this device</h1>
        <p className="login-help">
          On your computer, open remote-ai and choose <strong>Connect a phone</strong>. Scan the QR code, or type the code shown
          there.
        </p>
        <form className="login-form" onSubmit={(e) => void run(e, () => api.pair(code))}>
          <label className="field">
            <span>Pairing code</span>
            <input
              className="mono login-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD-EFGH"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="one-time-code"
              spellCheck={false}
              autoFocus
            />
          </label>
          <button type="submit" className="btn btn-primary btn-large" disabled={busy || code.replace(/[^A-Za-z0-9]/g, '').length < 8}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </form>
        {info?.password && (
          <form className="login-form" onSubmit={(e) => void run(e, () => api.login(password))}>
            <div className="login-or">or</div>
            <label className="field">
              <span>Password</span>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button type="submit" className="btn btn-large" disabled={busy || !password}>
              Log in
            </button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
