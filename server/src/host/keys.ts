/** Escape sequences for the named keys the dashboard sends (tmux-style names, kept from v1). */
const KEYS: Record<string, string> = {
  Enter: '\r',
  Escape: '\x1b',
  Tab: '\t',
  BTab: '\x1b[Z',
  'C-c': '\x03',
};

const ARROWS: Record<string, string> = { Up: 'A', Down: 'B', Right: 'C', Left: 'D' };

/** The bytes for a key, or undefined for a name we don't know. Arrows follow the app's cursor-key mode. */
export function keySequence(name: string, applicationCursor: boolean): string | undefined {
  const arrow = ARROWS[name];
  if (arrow) return `${applicationCursor ? '\x1bO' : '\x1b['}${arrow}`;
  return KEYS[name];
}

/**
 * Text as a terminal paste. Bracketed when the program asked for it (so multi-line text arrives as
 * one paste); otherwise newlines become carriage returns, as a terminal would send them.
 */
export function pasteSequence(text: string, bracketed: boolean): string {
  if (bracketed) return `\x1b[200~${text.replace(/\x1b\[20[01]~/g, '')}\x1b[201~`;
  return text.replace(/\r?\n/g, '\r');
}
