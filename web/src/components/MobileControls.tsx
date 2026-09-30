import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { Send } from './icons';

const KEYS: { label: string; key: string; aria?: string }[] = [
  { label: 'Esc', key: 'Escape' },
  { label: '^C', key: 'C-c', aria: 'Control C' },
  { label: '⇧Tab', key: 'BTab', aria: 'Shift Tab' },
  { label: 'Tab', key: 'Tab' },
  { label: '↑', key: 'Up', aria: 'Up arrow' },
  { label: '↓', key: 'Down', aria: 'Down arrow' },
  { label: '⏎', key: 'Enter', aria: 'Enter' },
];

/** Keys phones don't have, plus a normal text box that pastes into Claude's prompt. */
export function MobileControls({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const press = (key: string) => {
    api.keys(sessionId, [key]).catch((err) => setError(errorMessage(err)));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api.text(sessionId, text);
      setText('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mobile-controls">
      <div className="keybar" role="group" aria-label="Terminal keys">
        {KEYS.map((k) => (
          <button key={k.key} type="button" className="key" aria-label={k.aria} onClick={() => press(k.key)}>
            {k.label}
          </button>
        ))}
      </div>
      <form className="composer" onSubmit={(e) => void submit(e)}>
        <textarea
          aria-label="Message Claude"
          placeholder="Message Claude…"
          rows={Math.min(4, Math.max(1, text.split('\n').length))}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="send" aria-label="Send" disabled={sending || !text.trim()}>
          <Send size={20} />
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
