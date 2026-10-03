import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ArrowDown } from './icons';

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

// The session host keeps this much and sends all of it on attach (server/src/host/term.ts).
const SCROLLBACK = 5000;

type ConnState = 'connecting' | 'open' | 'reconnecting' | 'not-running' | 'exited';

/**
 * Scroll the terminal by dragging a finger, carrying on after a flick. xterm 6 scrolls only with
 * the mouse wheel, so without this a phone can't reach the scrollback. Taps still focus the terminal.
 */
function touchScroll(el: HTMLElement, term: XTerm): () => void {
  let lastY = 0;
  let lastT = 0;
  let velocity = 0; // px/ms, positive when the finger moves up (towards later lines)
  let carry = 0; // dragged pixels not yet a whole line
  let lineHeight = 1;
  let dragging = false;
  let frame = 0;

  // Returns false once the viewport can't move any further that way.
  const scrollBy = (px: number): boolean => {
    carry += px;
    const lines = Math.trunc(carry / lineHeight);
    if (!lines) return true;
    carry -= lines * lineHeight;
    const before = term.buffer.active.viewportY;
    term.scrollLines(lines);
    return term.buffer.active.viewportY !== before;
  };

  const onStart = (e: TouchEvent) => {
    cancelAnimationFrame(frame);
    dragging = false;
    if (e.touches.length !== 1) return;
    lastY = e.touches[0]!.clientY;
    lastT = e.timeStamp;
    velocity = 0;
    carry = 0;
    lineHeight = (el.querySelector('.xterm-screen')?.clientHeight ?? term.rows) / term.rows;
  };
  const onMove = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const y = e.touches[0]!.clientY;
    const dy = lastY - y;
    if (!dragging && Math.abs(dy) < 8) return; // still a tap
    dragging = true;
    e.preventDefault();
    velocity = 0.8 * (dy / Math.max(1, e.timeStamp - lastT)) + 0.2 * velocity;
    lastY = y;
    lastT = e.timeStamp;
    scrollBy(dy);
  };
  const onEnd = (e: TouchEvent) => {
    if (!dragging || e.timeStamp - lastT > 100) return; // the finger stopped before lifting
    let v = velocity;
    let t = performance.now();
    const step = (now: number) => {
      const dt = now - t;
      t = now;
      v *= 0.998 ** dt; // about the rate a native scroll view slows down
      if (Math.abs(v) > 0.02 && scrollBy(v * dt)) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: false });
  el.addEventListener('touchend', onEnd, { passive: true });
  return () => {
    cancelAnimationFrame(frame);
    el.removeEventListener('touchstart', onStart);
    el.removeEventListener('touchmove', onMove);
    el.removeEventListener('touchend', onEnd);
  };
}

/** A live view of one of a session's terminals (the agent's by default), reconnecting on its own after network drops. */
export function Terminal({ sessionId, name = 'agent', fontSize }: { sessionId: string; name?: string; fontSize: number }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [scrolledUp, setScrolledUp] = useState(false);

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
      scrollback: SCROLLBACK,
      allowProposedApi: false,
    });
    termRef.current = term;
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
    const checkScroll = () => setScrolledUp(term.buffer.active.viewportY < term.buffer.active.baseY);
    const onScroll = term.onScroll(checkScroll);
    const onWrite = term.onWriteParsed(checkScroll);
    let stopTouch: (() => void) | undefined;
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
        stopTouch = touchScroll(el, term);
        fit.fit();
        observer.observe(el);
        connect();
      });

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      observer.disconnect();
      stopTouch?.();
      onData.dispose();
      onResize.dispose();
      onScroll.dispose();
      onWrite.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
      setScrolledUp(false);
    };
  }, [sessionId, name, fontSize]);

  return (
    <div className="terminal-wrap">
      <div className="terminal" ref={host} />
      {scrolledUp && (
        <button type="button" className="terminal-bottom" aria-label="Scroll to the latest output" onClick={() => termRef.current?.scrollToBottom()}>
          <ArrowDown size={18} />
        </button>
      )}
      {conn === 'reconnecting' && <div className="terminal-banner">Reconnecting…</div>}
      {conn === 'not-running' && <div className="terminal-banner">This session isn't running.</div>}
      {conn === 'exited' && <div className="terminal-banner">The program has exited.</div>}
    </div>
  );
}
