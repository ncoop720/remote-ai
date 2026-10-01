import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

const FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

const THEME = {
  background: '#0E0D0C',
  foreground: '#D6D1C9',
  cursor: '#EDEAE4',
  cursorAccent: '#0E0D0C',
  selectionBackground: '#3A3632',
  black: '#1A1917',
  red: '#FF8A7A',
  green: '#7FD1A4',
  yellow: '#F2C27A',
  blue: '#7AB0FF',
  magenta: '#D7A6FF',
  cyan: '#72D3D8',
  white: '#D6D1C9',
  brightBlack: '#6B665F',
  brightRed: '#FFA89B',
  brightGreen: '#A3E4C1',
  brightYellow: '#F7D59E',
  brightBlue: '#A3C8FF',
  brightMagenta: '#E4C3FF',
  brightCyan: '#9BE3E7',
  brightWhite: '#FFFFFF',
};

type ConnState = 'connecting' | 'open' | 'reconnecting' | 'not-running' | 'exited';

/** A live view of one of a session's terminals (the agent's by default), reconnecting on its own after network drops. */
export function Terminal({ sessionId, name = 'agent', fontSize }: { sessionId: string; name?: string; fontSize: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [conn, setConn] = useState<ConnState>('connecting');

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const term = new XTerm({
      fontFamily: FONT,
      fontSize,
      lineHeight: 1.15,
      theme: THEME,
      cursorBlink: true,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    const send = (msg: object) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const qs = new URLSearchParams({ name, cols: String(term.cols), rows: String(term.rows) });
      ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${encodeURIComponent(sessionId)}?${qs}`);
      ws.onopen = () => {
        attempt = 0;
        term.reset(); // the server starts with a snapshot of the whole screen
        setConn('open');
      };
      ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
      ws.onclose = (ev) => {
        if (disposed) return;
        if (ev.code === 4404 || ev.code === 4410) {
          setConn(ev.code === 4404 ? 'not-running' : 'exited');
          return;
        }
        setConn('reconnecting');
        retryTimer = setTimeout(connect, Math.min(500 * 2 ** attempt++, 8000));
      };
    };

    const onData = term.onData((d) => send({ t: 'i', d }));
    const onResize = term.onResize(({ cols, rows }) => send({ t: 'r', c: cols, r: rows }));
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
    });

    // Measure the cell size only after the web font is ready, or columns come out wrong.
    void document.fonts
      .load(`${fontSize}px "JetBrains Mono"`)
      .catch(() => undefined)
      .then(() => {
        if (disposed) return;
        term.open(el);
        fit.fit();
        observer.observe(el);
        connect();
      });

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      ws?.close();
      term.dispose();
    };
  }, [sessionId, name, fontSize]);

  return (
    <div className="terminal-wrap">
      <div className="terminal" ref={host} />
      {conn === 'reconnecting' && <div className="terminal-banner">Reconnecting…</div>}
      {conn === 'not-running' && <div className="terminal-banner">This session isn't running.</div>}
      {conn === 'exited' && <div className="terminal-banner">The program has exited.</div>}
    </div>
  );
}
