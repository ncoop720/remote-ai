import { execFile } from 'node:child_process';

export class CommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

/** Run a program without a shell and resolve with its stdout. `label` names the command in errors. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; label?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') {
            reject(new CommandError(`${cmd} is not installed or not on PATH`, '', null));
            return;
          }
          const code = typeof err.code === 'number' ? err.code : null;
          const detail = stderr.trim() || err.message;
          reject(new CommandError(`${opts.label ?? `${cmd} ${args[0] ?? ''}`}: ${detail}`, stderr, code));
        } else {
          resolve(stdout);
        }
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Quote a string for a POSIX shell. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
