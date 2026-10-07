import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../api';
import { Send } from './icons';

const KEYS: { label: string; key: string; aria?: string }[] = [
  { label: 'Esc', key: 'Escape' },
  { label: '^C', key: 'C-c', aria: 'Control C' },
  { label: '⇧Tab', key: 'BTab', aria: 'Shift Tab' },
  { label: 'Tab', key: 'Tab' },
  { label: '↑', key: 'Up', aria: 'Up arrow' },
  { label: '↓', key: 'Down', aria: 'Down arrow' },
  { label: '←', key: 'Left', aria: 'Left arrow' },
  { label: '→', key: 'Right', aria: 'Right arrow' },
  { label: '⏎', key: 'Enter', aria: 'Enter' },
];

/** Keys phones don't have, sent straight to the claude window. */
export function KeyBar({ sessionId }: { sessionId: string }) {
  const [error, setError] = useState<string | null>(null);
  const press = (key: string) => {
    setError(null);
    api.keys(sessionId, [key]).catch((err) => setError(errorMessage(err)));
  };
  return (
    <>
      <div className="keybar" role="group" aria-label="Terminal keys">
        {KEYS.map((k) => (
          <button key={k.key} type="button" className="key" aria-label={k.aria} onClick={() => press(k.key)}>
            {k.label}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}

/**
 * A normal text box that pastes into Claude's prompt and presses Enter. On a keyboard,
 * Enter sends and Shift+Enter adds a line; on a phone the Send button sends.
 */
export function Composer({ sessionId, working, submitOnEnter }: { sessionId: string; working?: boolean; submitOnEnter?: boolean }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || sending) return;
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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (submitOnEnter && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <>
      <form className="composer" onSubmit={(e) => void submit(e)}>
        {working && (
          <button type="button" className="interrupt" onClick={() => void api.keys(sessionId, ['Escape'])} aria-label="Interrupt Claude (Esc)">
            Interrupt
          </button>
        )}
        <textarea
          aria-label="Message Claude"
          placeholder={working ? 'Claude is working… you can queue a message' : 'Message Claude…'}
          rows={Math.min(4, Math.max(1, text.split('\n').length))}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="send" aria-label="Send" disabled={sending || !text.trim()}>
          <Send size={20} />
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </>
  );
}

/** Terminal tab controls on a phone: the key bar plus the composer. */
export function MobileControls({ sessionId }: { sessionId: string }) {
  return (
    <div className="mobile-controls">
      <KeyBar sessionId={sessionId} />
      <Composer sessionId={sessionId} />
    </div>
  );
}
