/** Reduce a name to characters that are safe in terminal names, paths and URLs. */
export function slug(s: string): string {
  const out = s
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return out || 'x';
}

/** Session ids name the session's terminals in the host and appear in URLs and log paths. */
export function sessionId(project: string, branchOrDir: string): string {
  return `${slug(project)}__${slug(branchOrDir)}`;
}
