/** Reduce a name to characters that are safe in tmux session names, paths and URLs. */
export function slug(s: string): string {
  const out = s
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return out || 'x';
}

/** Session ids double as tmux session names, so they must never contain `~` (used by viewer sessions). */
export function sessionId(project: string, branchOrDir: string): string {
  return `${slug(project)}__${slug(branchOrDir)}`;
}

const TMUX_WINDOW_NAME = /^[A-Za-z0-9_-]{1,32}$/;

export function isValidWindowName(name: string): boolean {
  return TMUX_WINDOW_NAME.test(name);
}
