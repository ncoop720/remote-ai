export interface Span {
  text: string;
  className: string;
}
export type Line = Span[];

// CSI sequences (colors, cursor moves, erases), OSC sequences (titles, links) and two-byte escapes.
const ESCAPE = /\x1b\[([0-9;?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\^_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Turn terminal output into lines of styled spans. Colors carry across lines like a terminal
 * would. A carriage return mid-line means the program redrew the line (progress bars), so
 * only what came after the last one is kept. Cursor movement and screen clears are dropped.
 */
export function parseAnsi(text: string): Line[] {
  let fg: number | null = null;
  let bold = false;
  let dim = false;
  const className = () => [fg === null ? '' : `c${fg}`, bold ? 'b' : '', dim ? 'd' : ''].filter(Boolean).join(' ');

  const applySgr = (params: string) => {
    const codes = params === '' ? [0] : params.split(';').map((c) => Number(c) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) [fg, bold, dim] = [null, false, false];
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) [bold, dim] = [false, false];
      else if (c >= 30 && c <= 37) fg = c - 30;
      else if (c >= 90 && c <= 97) fg = c - 90 + 8;
      else if (c === 39) fg = null;
      else if (c === 38 || c === 48) {
        // 256-color and truecolor: keep the 16 basic colors, skip the rest.
        if (codes[i + 1] === 5) {
          const n = codes[i + 2] ?? 0;
          if (c === 38) fg = n < 16 ? n : null;
          i += 2;
        } else if (codes[i + 1] === 2) {
          if (c === 38) fg = null;
          i += 4;
        }
      }
    }
  };

  const lines: Line[] = [];
  const rows = text.split('\n');
  if (rows.at(-1) === '') rows.pop();
  for (const row of rows) {
    const raw = row.replace(/\r+$/, '');
    const spans: Span[] = [];
    const emit = (chunk: string) => {
      chunk.split('\r').forEach((part, i) => {
        if (i > 0) spans.length = 0;
        const clean = part.replace(CONTROL, '');
        if (clean) spans.push({ text: clean, className: className() });
      });
    };
    let last = 0;
    for (const m of raw.matchAll(ESCAPE)) {
      emit(raw.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[2] === 'm') applySgr(m[1] ?? '');
    }
    emit(raw.slice(last));
    lines.push(spans);
  }
  return lines;
}

export function lineText(line: Line): string {
  return line.map((s) => s.text).join('');
}

const ERROR_WORDS = /\b(error|errors|exception|failed|failure|fatal|unhandled|panic)\b|ERR!|✘|✖/i;

export function isErrorLine(line: Line): boolean {
  return ERROR_WORDS.test(lineText(line));
}
