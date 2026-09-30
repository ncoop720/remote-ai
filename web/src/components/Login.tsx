import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <img src="/icon-192.png" alt="" width={56} height={56} />
        <h1>remote-ai</h1>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary btn-large" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
