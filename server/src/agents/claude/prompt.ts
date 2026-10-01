import type { PromptOption, VisiblePrompt } from '../../../../shared/types.js';

// The highlighted choice in a Claude Code menu: "❯ Yes", "❯ 1. Yes", or "> 1. Yes" in older versions,
// optionally inside a box border.
const SELECTED = /^([\s│┃|]*)(?:❯|>(?=\s+\d\.\s))\s+(\S.*)$/;
const ONLY_BORDER = /^[\s│┃|]*$/;
const NUMBERED_LABEL = /^(\d)\.\s+(.+)$/;

function clean(text: string): string {
  return text.replace(/[\s│┃|╭╮╰╯─]+$/, '').replace(/^[\s│┃|╭╮╰╯─]+/, '').trim();
}

/**
 * Find the menu Claude Code is showing (permission prompts, the folder-trust prompt, questions),
 * reading only the bottom of the screen so old scrollback can't match. Options are the lines
 * aligned with the highlighted one; deeper-indented lines under an option are its description.
 */
export function parseVisiblePrompt(screen: string, bottomLines = 30): VisiblePrompt | null {
  const lines = screen.replace(/\s+$/, '').split('\n').slice(-bottomLines);

  let sel = -1;
  let match: RegExpExecArray | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    match = SELECTED.exec(lines[i] ?? '');
    if (match) {
      sel = i;
      break;
    }
  }
  if (!match) return null;
  const textCol = (lines[sel] ?? '').length - (match[2] ?? '').length;

  const isOption = (line: string) =>
    line.length > textCol && ONLY_BORDER.test(line.slice(0, textCol)) && line[textCol] !== ' ';
  const isDescription = (line: string) =>
    ONLY_BORDER.test(line.slice(0, textCol + 1)) && clean(line.slice(textCol + 1)) !== '';
  const inBlock = (i: number) => i === sel || isOption(lines[i] ?? '') || isDescription(lines[i] ?? '');

  let start = sel;
  while (start > 0 && inBlock(start - 1)) start--;
  let end = sel;
  while (end < lines.length - 1 && inBlock(end + 1)) end++;

  const raw: { label: string; selected: boolean }[] = [];
  for (let i = start; i <= end; i++) {
    if (i === sel) raw.push({ label: clean(match[2] ?? ''), selected: true });
    else if (isOption(lines[i] ?? '')) raw.push({ label: clean((lines[i] ?? '').slice(textCol)), selected: false });
  }
  if (raw.length < 2) return null;

  // Numbered menus must count 1..n; otherwise number the options in screen order.
  const numbered = raw.every((o) => NUMBERED_LABEL.test(o.label));
  const options: PromptOption[] = raw.map((o, i) => {
    const m = numbered ? NUMBERED_LABEL.exec(o.label) : null;
    return { key: m ? m[1]! : String(i + 1), label: m ? m[2]!.trim() : o.label, selected: o.selected };
  });
  if (numbered && options.some((o, i) => o.key !== String(i + 1))) return null;

  // Prefer a nearby line that asks something; fall back to the closest text above the menu.
  let question = '';
  let fallback = '';
  for (let i = start - 1; i >= 0 && i >= start - 10; i--) {
    const text = clean(lines[i] ?? '');
    if (!text) continue;
    fallback ||= text;
    if (text.includes('?')) {
      question = text;
      break;
    }
  }
  question ||= fallback;
  if (question.length > 160) question = `${question.slice(0, 157)}…`;
  return { question, options };
}
