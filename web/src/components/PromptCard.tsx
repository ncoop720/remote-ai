import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { describeTool } from '../status';
import type { SessionInfo, VisiblePrompt } from '../../../shared/types';

/**
 * When Claude is waiting on a choice, show it as big buttons. The options are read from
 * the actual screen, so the labels always match what the terminal offers.
 */
export function PromptCard({ session }: { session: SessionInfo }) {
  // Menus also appear without any hook firing (the folder-trust prompt at startup, one-time
  // announcements while idle), so watch the screen whenever the session is running.
  const needsInput = session.running;
  const [prompt, setPrompt] = useState<VisiblePrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!needsInput) {
      setPrompt(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      api
        .prompt(session.id)
        .then((r) => !cancelled && setPrompt(r.prompt))
        .catch(() => undefined);
    void load();
    // The screen can change without a hook firing (e.g. answered in another tab).
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [needsInput, session.id, session.status.updatedAt]);

  if (!needsInput || !prompt) return null;

  const detail = describeTool(session.status.tool);
  // The highlighted default isn't always the one you want (the trust prompt defaults to "No, exit").
  const primaryKey = prompt.options.find((o) => /^yes\b/i.test(o.label))?.key;
  const choose = async (key: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.answer(session.id, key);
      setPrompt(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="prompt-card" aria-label="Claude is waiting for your answer">
      <div className="prompt-head">
        <span className="prompt-title">{prompt.question || 'Claude is asking'}</span>
        {session.status.tool && <span className="prompt-tool">{session.status.tool.name}</span>}
      </div>
      {detail && <pre className="prompt-detail">{detail}</pre>}
      <div className="prompt-options">
        {prompt.options.map((o) => (
          <button
            key={o.key}
            type="button"
            className={o.key === primaryKey ? 'btn btn-primary' : 'btn'}
            disabled={busy}
            onClick={() => void choose(o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
