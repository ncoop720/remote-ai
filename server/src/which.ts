import fs from 'node:fs';
import path from 'node:path';

/** Find a program the way a shell would: PATH, plus PATHEXT on Windows. */
export function findExecutable(
  name: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const isWin = platform === 'win32';
  const pathMod = isWin ? path.win32 : path.posix;
  const exts = isWin ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const candidates = (dir: string) => [
    ...(isWin && pathMod.extname(name) ? [pathMod.join(dir, name)] : []),
    ...exts.map((ext) => pathMod.join(dir, name + ext)),
  ];
  const isFile = (p: string) => {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return false;
      if (!isWin) fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (name.includes('/') || (isWin && name.includes('\\'))) {
    return candidates('').map((c) => pathMod.resolve(c)).find(isFile) ?? null;
  }
  const pathVar = (isWin ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  for (const dir of pathVar.split(isWin ? ';' : ':')) {
    if (!dir) continue;
    const found = candidates(dir).find(isFile);
    if (found) return found;
  }
  return null;
}
