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

type Size = { cols: number; rows: number };
const sameSize = (a: Size | null | undefined, b: Size | null | undefined) => !!a && !!b && a.cols === b.cols && a.rows === b.rows;
// The sizes the server accepts (server/src/terminal.ts).
const clampSize = (n: number) => Math.min(500, Math.max(10, n));

/** Sent in binary frames; output comes in text frames. */
type ServerMessage = { t: 'size' | 'resize'; c: number; r: number };

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

/**
 * A live view of one of a session's terminals (the agent's by default), reconnecting on its own after network drops.
 *
 * The program draws for one size at a time, which the screen in use sets: one that opens the terminal
 * in view, switches to it, or is touched or typed on while it shows. Every other screen draws the
 * terminal at that size, cut off or with room to spare, until it's used in turn.
 */
export function Terminal({ sessionId, name = 'agent', fontSize }: { sessionId: string; name?: string; fontSize: number }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const claimRef = useRef<() => void>(() => undefined);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [scrolledUp, setScrolledUp] = useState(false);
  const [sizedElsewhere, setSizedElsewhere] = useState(false);

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

    let owner = false; // whether this screen sets the program's size
    let program: Size | null = null; // the program's size, as far as we know
    let shown = false;

    /** The size that fills this screen, or undefined while the terminal is hidden (sizes measured then are nonsense). */
    const measure = (): Size | undefined => {
      if (!el.clientWidth || !el.clientHeight) return undefined;
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return undefined;
      return { cols: clampSize(dims.cols), rows: clampSize(dims.rows) };
    };

    /** Draw at the program's size, or, as the owner, size the program to this screen. */
    const sync = () => {
      const fits = measure();
      const mine = owner ? fits : undefined;
      const size = mine ?? program;
      if (size && !sameSize(size, term)) term.resize(size.cols, size.rows);
      if (mine && !sameSize(mine, program) && ws?.readyState === WebSocket.OPEN) {
        send({ t: 'r', c: mine.cols, r: mine.rows });
        program = mine;
      }
      setSizedElsewhere(!mine && !!fits && !!program && !sameSize(fits, program));
    };

    /** This screen is in use: if the terminal shows, the program should draw for it. */
    const claim = () => {
      if (owner || disposed || !measure()) return;
      owner = true;
      sync();
    };
    claimRef.current = claim;

    const onControl = (msg: ServerMessage) => {
      // Only after the output before it, which was drawn for the old size.
      term.write('', () => {
        if (disposed) return;
        program = { cols: msg.c, rows: msg.r };
        if (msg.t === 'resize') owner = false; // another screen is in use
        sync();
      });
    };

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const qs = new URLSearchParams({ name });
      // The owner sizes the program as it attaches, so the snapshot comes drawn for this screen.
      const mine = owner ? measure() : undefined;
      if (mine) {
        qs.set('cols', String(mine.cols));
        qs.set('rows', String(mine.rows));
      }
      program = mine ?? null;
      ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${encodeURIComponent(sessionId)}?${qs}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        attempt = 0;
        term.reset(); // the server starts with a snapshot of the whole screen
        setConn('open');
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') term.write(ev.data);
        else onControl(JSON.parse(new TextDecoder().decode(ev.data as ArrayBuffer)) as ServerMessage);
      };
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
    const checkScroll = () => setScrolledUp(term.buffer.active.viewportY < term.buffer.active.baseY);
    const onScroll = term.onScroll(checkScroll);
    const onWrite = term.onWriteParsed(checkScroll);
    let stopTouch: (() => void) | undefined;
    const observer = new ResizeObserver(() => {
      const visible = el.clientWidth > 0 && el.clientHeight > 0;
      if (visible && !shown) owner = true; // switched to the terminal
      shown = visible;
      sync();
    });
    const onVisible = () => document.visibilityState === 'visible' && claim();

    // Measure the cell size only after the web font is ready, or columns come out wrong.
    void document.fonts
      .load(`${fontSize}px "JetBrains Mono"`)
      .catch(() => undefined)
      .then(() => {
        if (disposed) return;
        term.open(el);
        stopTouch = touchScroll(el, term);
        owner = shown = measure() !== undefined; // opened in view
        sync();
        observer.observe(el);
        window.addEventListener('pointerdown', claim, true);
        window.addEventListener('keydown', claim, true);
        window.addEventListener('focus', claim);
        document.addEventListener('visibilitychange', onVisible);
        connect();
      });

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      observer.disconnect();
      window.removeEventListener('pointerdown', claim, true);
      window.removeEventListener('keydown', claim, true);
      window.removeEventListener('focus', claim);
      document.removeEventListener('visibilitychange', onVisible);
      stopTouch?.();
      onData.dispose();
      onScroll.dispose();
      onWrite.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
      claimRef.current = () => undefined;
      setScrolledUp(false);
      setSizedElsewhere(false);
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
      {conn === 'open' && sizedElsewhere && (
        <button type="button" className="terminal-banner terminal-fit" onClick={() => claimRef.current()}>
          Sized for another screen · Fit here
        </button>
      )}
      {conn === 'reconnecting' && <div className="terminal-banner">Reconnecting…</div>}
      {conn === 'not-running' && <div className="terminal-banner">This session isn't running.</div>}
      {conn === 'exited' && <div className="terminal-banner">The program has exited.</div>}
    </div>
  );
}
