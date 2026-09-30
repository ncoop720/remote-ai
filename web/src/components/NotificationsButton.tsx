import { useEffect, useState } from 'react';
import { errorMessage } from '../api';
import { disablePush, enablePush, PUSH_HINT, pushState, type PushState } from '../push';

function Bell({ off }: { off: boolean }) {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

/** Turns push notifications for this device on or off, explaining when that isn't possible yet. */
export function NotificationsButton() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void pushState().then(setState);
  }, []);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 8000);
    return () => clearTimeout(t);
  }, [message]);

  if (!state) return null;
  const on = state === 'on';

  const click = async () => {
    const hint = PUSH_HINT[state];
    if (hint) {
      setMessage(hint);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (on) await disablePush();
      else await enablePush();
      const next = await pushState();
      setState(next);
      setMessage(next === 'on' ? 'Notifications are on for this device.' : 'Notifications are off for this device.');
    } catch (err) {
      setMessage(errorMessage(err));
      setState(await pushState());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="notify">
      <button
        type="button"
        className={`icon-btn notify-btn${on ? ' notify-on' : ''}`}
        aria-pressed={on}
        aria-label={on ? 'Turn notifications off' : 'Turn notifications on'}
        title={on ? 'Notifications on' : 'Notifications off'}
        disabled={busy}
        onClick={() => void click()}
      >
        <Bell off={!on} />
      </button>
      {message && (
        <div className="notify-message" role="status">
          {message}
        </div>
      )}
    </div>
  );
}
