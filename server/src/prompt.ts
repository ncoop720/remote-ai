import type { VisiblePrompt } from '../../shared/types.js';

// Matches Claude Code's numbered choices, e.g. "❯ 1. Yes" or "  2. Yes, and don't ask again…",
// with optional box-drawing borders around the line.
const OPTION = /^[\s│┃|]*(❯|>)?\s*(\d)\.\s+(.+?)[\s│┃|]*$/;

/**
 * Find the numbered choice list Claude Code is currently showing (permission prompts,
 * questions), reading only the bottom of the screen so old scrollback can't match.
 */
export function parseVisiblePrompt(screen: string, bottomLines = 30): VisiblePrompt | null {
  const lines = screen.replace(/\s+$/, '').split('\n').slice(-bottomLines);

  // Walk upward from the bottom to the last contiguous run of numbered options.
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  let start = end;
  while (start > 0 && OPTION.test(lines[start - 1] ?? '')) start--;

  const options = lines.slice(start, end + 1).map((line) => {
    const m = OPTION.exec(line)!;
    return { key: m[2]!, label: m[3]!.trim(), selected: Boolean(m[1]) };
  });

  // Options must be numbered 1..n in order, and there must be a choice to make.
  if (options.length < 2 || options.some((o, i) => o.key !== String(i + 1))) return null;
  if (!options.some((o) => o.selected)) return null;

  let question = '';
  for (let i = start - 1; i >= 0; i--) {
    const text = (lines[i] ?? '').replace(/[│┃|╭╮╰╯─]/g, '').trim();
    if (text) {
      question = text;
      break;
    }
  }
  return { question, options };
}
