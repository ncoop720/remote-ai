import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatItem, SessionInfo } from '../../../shared/types';
import { Markdown } from './Markdown';

type Tool = Extract<ChatItem, { kind: 'tool' }>;
type Result = Extract<ChatItem, { kind: 'result' }>;
type Entry =
  | { kind: 'user' | 'assistant' | 'command'; id: string; text: string }
  | { kind: 'tools'; id: string; tools: Tool[] };

const MAX_ITEMS = 600;

/** Chat items for the session's current conversation, following the transcript as it grows. */
function useChat(sessionId: string, conversation: string): ChatItem[] {
  const [items, setItems] = useState<ChatItem[]>([]);
  useEffect(() => {
    setItems([]);
    const events = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/chat`);
    events.onmessage = (msg) => {
      const data = JSON.parse(msg.data as string) as { reset?: boolean; items: ChatItem[] };
      setItems((prev) => {
        const base = data.reset ? [] : prev;
        const seen = new Set(base.map((i) => i.id));
        return [...base, ...data.items.filter((i) => !seen.has(i.id))].slice(-MAX_ITEMS);
      });
    };
    return () => events.close();
  }, [sessionId, conversation]);
  return items;
}

const VERB: Record<string, string> = {
  Bash: 'Ran',
  Read: 'Read',
  Edit: 'Edited',
  MultiEdit: 'Edited',
  Write: 'Wrote',
  NotebookEdit: 'Edited',
  Grep: 'Searched',
  Glob: 'Listed',
  WebFetch: 'Fetched',
  WebSearch: 'Searched the web',
  Task: 'Agent',
  Agent: 'Agent',
  TodoWrite: 'Updated todos',
};

function ToolRow({ tool, result, root, running }: { tool: Tool; result?: Result; root: string; running: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = tool.summary.startsWith(`${root}/`) ? tool.summary.slice(root.length + 1) : tool.summary;
  const state = result ? (result.ok ? 'ok' : 'failed') : running ? 'running' : 'unknown';
  return (
    <div className="tool">
      <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`tool-state tool-${state}`} aria-label={state} />
        <span className="tool-verb">{VERB[tool.name] ?? tool.name}</span>
        <span className="tool-summary mono">{summary}</span>
      </button>
      {open && (
        <div className="tool-detail">
          <div className="muted">{tool.name}</div>
          <pre>{tool.summary || '(no input shown)'}</pre>
          {result && <pre className={result.ok ? '' : 'tool-error'}>{result.output || '(no output)'}</pre>}
        </div>
      )}
    </div>
  );
}

/**
 * The conversation as chat: your messages, Claude's replies (Markdown), and its tool calls as
 * compact rows that expand to show input and output. Read from the transcript, so it works
 * alongside the terminal rather than replacing it.
 */
export function ChatView({ session }: { session: SessionInfo }) {
  const items = useChat(session.id, session.status.agentSessionId ?? '');
  const working = session.status.state === 'working';
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  const { entries, results } = useMemo(() => {
    const results = new Map<string, Result>();
    const entries: Entry[] = [];
    for (const item of items) {
      if (item.kind === 'result') {
        results.set(item.toolUseId, item);
      } else if (item.kind === 'tool') {
        const last = entries.at(-1);
        if (last?.kind === 'tools') last.tools.push(item);
        else entries.push({ kind: 'tools', id: item.id, tools: [item] });
      } else {
        entries.push({ kind: item.kind, id: item.id, text: item.text });
      }
    }
    return { entries, results };
  }, [items]);

  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [entries, results, working, follow]);

  return (
    <div
      className="chat"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
      }}
    >
      {entries.length === 0 && (
        <p className="chat-empty muted">
          {session.status.state === 'unknown' ? 'Waiting for Claude to start…' : 'No messages yet. Say something below.'}
        </p>
      )}
      {entries.map((e) => (
        <Fragment key={e.id}>
          {e.kind === 'user' && <div className="bubble">{e.text}</div>}
          {e.kind === 'command' && <div className="chat-command mono">{e.text}</div>}
          {e.kind === 'assistant' && <Markdown text={e.text} />}
          {e.kind === 'tools' && (
            <div className="tools">
              {e.tools.map((t) => (
                <ToolRow key={t.id} tool={t} result={results.get(t.toolUseId)} root={session.path} running={working} />
              ))}
            </div>
          )}
        </Fragment>
      ))}
      {working && <div className="chat-working">Claude is working…</div>}
    </div>
  );
}
