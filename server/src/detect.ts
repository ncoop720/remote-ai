import fs from 'node:fs';
import path from 'node:path';
import type { DevServerConfig, ProjectConfig } from './devconfig.js';

/**
 * Guesses a repo's setup and dev servers when it has no .remote-ai.json, from the files most
 * projects already have. Each server gets $PORT; commands for servers that ignore that variable
 * (Vite, Astro, Angular) pass it as a flag. Anything this misses, "Set up with Claude" handles.
 */

type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface Pkg {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  workspaces?: unknown;
}

const DEV_SCRIPTS = ['dev', 'develop', 'start:dev', 'serve', 'start'];
/** Folders that often hold one app each, by these names or longer ones (client-threejs), backends first (they start first). */
const APP_FOLDERS = ['server', 'backend', 'api', 'client', 'frontend', 'web', 'app'];

const exists = (...p: string[]) => fs.existsSync(path.join(...p));

function read(...p: string[]): string | null {
  try {
    return fs.readFileSync(path.join(...p), 'utf8');
  } catch {
    return null;
  }
}

function readPkg(dir: string): Pkg | null {
  const text = read(dir, 'package.json');
  if (text === null) return null;
  try {
    return JSON.parse(text) as Pkg;
  } catch {
    return null;
  }
}

/** A lowercase name a server can have: letters, digits and dashes. */
export function serverName(raw: string): string {
  const name = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return !name || name === 'claude' || name === 'setup' ? 'app' : name;
}

// ---- Node ----

function managerOf(dir: string, root: string): Manager {
  for (const d of [dir, root]) {
    if (exists(d, 'pnpm-lock.yaml')) return 'pnpm';
    if (exists(d, 'bun.lockb') || exists(d, 'bun.lock')) return 'bun';
    if (exists(d, 'yarn.lock')) return 'yarn';
    if (exists(d, 'package-lock.json')) return 'npm';
  }
  return 'npm';
}

/**
 * An app in a folder installs from inside it (each setup command starts from the root). Pointed
 * there from the root instead (npm --prefix), npm sets INIT_CWD to the root, and install steps that
 * look there, such as Prisma generating its client, don't find the app's files.
 */
function installCommand(pm: Manager, rel: string, locked: boolean): string {
  const install = pm === 'npm' ? `npm ${locked ? 'ci' : 'install'}` : `${pm} install${locked ? ' --frozen-lockfile' : ''}`;
  return rel ? `cd ${rel} && ${install}` : install;
}

function runCommand(pm: Manager, script: string, args: string): string {
  if (pm === 'npm') return `npm run ${script}${args ? ` -- ${args}` : ''}`;
  return `${pm} run ${script}${args ? ` ${args}` : ''}`;
}

/** What a dev script runs, and the flags it needs to use $PORT. */
function framework(pkg: Pkg, script: string): { name: string; args: string } {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (/\bnext\b/.test(script) || ('next' in deps && /next/.test(script))) return { name: 'Next.js', args: '' };
  if (/\bnuxi?\b/.test(script)) return { name: 'Nuxt', args: '' };
  if (/\bastro\b/.test(script)) return { name: 'Astro', args: '--port $PORT' };
  if (/\bng\s+serve\b/.test(script)) return { name: 'Angular', args: '--port $PORT' };
  if (/\bvite(?!st)\b/.test(script)) return { name: 'Vite', args: '--port $PORT --strictPort' };
  if (/\breact-scripts\s+start\b/.test(script)) return { name: 'Create React App', args: '' };
  if (/\bwebpack(-dev-server|\s+serve)\b/.test(script)) return { name: 'webpack', args: '--port $PORT' };
  return { name: 'Node', args: '' };
}

interface NodeApp {
  rel: string;
  pm: Manager;
  script: string;
  framework: { name: string; args: string };
}

function nodeApp(root: string, rel: string): NodeApp | null {
  const dir = path.join(root, rel);
  const pkg = readPkg(dir);
  const script = DEV_SCRIPTS.find((s) => typeof pkg?.scripts?.[s] === 'string');
  if (!pkg || !script) return null;
  return { rel, pm: managerOf(dir, root), script, framework: framework(pkg, String(pkg.scripts![script])) };
}

/** Top-level folders named for an app, server/ or game-server/, client/ or client-threejs/: backends first. */
function appFolders(root: string): string[] {
  let names: string[];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const rank = (name: string) => {
    const words = name.toLowerCase().split(/[-_.]/);
    return APP_FOLDERS.findIndex((f) => words.includes(f));
  };
  return names
    .filter((n) => rank(n) !== -1)
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b));
}

function isWorkspaceRoot(root: string, pkg: Pkg | null): boolean {
  return Boolean(pkg?.workspaces) || exists(root, 'pnpm-workspace.yaml');
}

function detectNode(root: string): ProjectConfig | null {
  const rootPkg = readPkg(root);
  const locked = (dir: string) =>
    ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].some((f) => exists(dir, f));
  const app = nodeApp(root, '');
  if (app) {
    const tooling = /turbo|nx|lerna/.test(String(rootPkg?.scripts?.[app.script] ?? '')) ? ' monorepo' : '';
    return {
      source: 'detected',
      detected: `${app.framework.name}${tooling} with ${app.pm}`,
      setup: [installCommand(app.pm, '', locked(root))],
      servers: [{ name: 'dev', command: runCommand(app.pm, app.script, app.framework.args), cwd: '' }],
    };
  }

  // No dev script at the root: apps in their own folders (server/ and client/, or apps/*).
  const folders = [
    ...appFolders(root),
    ...['apps', 'packages'].flatMap((parent) => {
      try {
        return fs
          .readdirSync(path.join(root, parent), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => `${parent}/${d.name}`)
          .sort();
      } catch {
        return [];
      }
    }),
  ];
  const apps = folders.map((rel) => nodeApp(root, rel)).filter((a): a is NodeApp => a !== null).slice(0, 10);
  if (apps.length === 0) return null;
  const pm = apps[0]!.pm;
  // A workspace installs everything from the root; otherwise each app installs its own.
  const setup = isWorkspaceRoot(root, rootPkg)
    ? [installCommand(managerOf(root, root), '', locked(root))]
    : apps.map((a) => installCommand(a.pm, a.rel, locked(path.join(root, a.rel)) || locked(root)));
  const servers: DevServerConfig[] = [];
  for (const a of apps) {
    let name = serverName(path.basename(a.rel));
    if (servers.some((s) => s.name === name)) name = serverName(a.rel);
    servers.push({ name, command: runCommand(a.pm, a.script, a.framework.args), cwd: a.rel });
  }
  const kinds = [...new Set(apps.map((a) => a.framework.name))].join(' and ');
  return { source: 'detected', detected: `${apps.length} ${kinds} apps with ${pm}`, setup, servers };
}

// ---- Python, Ruby, Go, Rust ----

function pythonRunner(root: string): { prefix: string; setup: string[]; with: string } {
  if (exists(root, 'uv.lock')) return { prefix: 'uv run ', setup: ['uv sync'], with: 'uv' };
  if (exists(root, 'poetry.lock')) return { prefix: 'poetry run ', setup: ['poetry install'], with: 'Poetry' };
  if (exists(root, 'Pipfile')) return { prefix: 'pipenv run ', setup: ['pipenv install --dev'], with: 'Pipenv' };
  // A bare requirements.txt: which environment to install into is the user's choice.
  return { prefix: '', setup: [], with: 'pip' };
}

function detectPython(root: string): ProjectConfig | null {
  const deps = [read(root, 'pyproject.toml'), read(root, 'requirements.txt'), read(root, 'Pipfile')].join('\n').toLowerCase();
  const run = pythonRunner(root);
  const config = (name: string, command: string): ProjectConfig => ({
    source: 'detected',
    detected: `${name} with ${run.with}`,
    setup: run.setup,
    servers: [{ name: 'web', command: `${run.prefix}${command}`, cwd: '' }],
  });
  if (exists(root, 'manage.py')) return config('Django', 'python manage.py runserver $PORT');
  if (deps.includes('fastapi')) {
    for (const [file, module] of [['main.py', 'main'], ['app/main.py', 'app.main'], ['src/main.py', 'src.main'], ['app.py', 'app']]) {
      const text = read(root, file!);
      const app = text && /^(\w+)\s*=\s*FastAPI\(/m.exec(text);
      if (app) return config('FastAPI', `uvicorn ${module}:${app[1]} --reload --port $PORT`);
    }
  }
  if (deps.includes('flask') && (exists(root, 'app.py') || exists(root, 'wsgi.py'))) {
    return config('Flask', 'flask run --debug --port $PORT');
  }
  return null;
}

/** Procfile lines: `name: command`. */
export function parseProcfile(text: string): { name: string; command: string }[] {
  return text
    .split(/\r?\n/)
    .map((l) => /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: serverName(m[1]!), command: m[2]!.trim() }));
}

function detectRails(root: string): ProjectConfig | null {
  if (!exists(root, 'bin', 'rails') || !/\brails\b/.test(read(root, 'Gemfile') ?? '')) return null;
  // bin/dev's Procfile.dev usually pins the web port; keep its other processes (CSS, JS watchers).
  const others = parseProcfile(read(root, 'Procfile.dev') ?? '').filter((p) => p.name !== 'web');
  return {
    source: 'detected',
    detected: 'Rails',
    setup: ['bundle install'],
    servers: [{ name: 'web', command: 'bin/rails server -p $PORT', cwd: '' }, ...others.map((p) => ({ ...p, cwd: '' }))],
  };
}

function detectCompiled(root: string): ProjectConfig | null {
  if (exists(root, 'go.mod') && /^package main\b/m.test(read(root, 'main.go') ?? '')) {
    return { source: 'detected', detected: 'Go', setup: ['go mod download'], servers: [{ name: 'app', command: 'go run .', cwd: '' }] };
  }
  if (exists(root, 'Cargo.toml') && exists(root, 'src', 'main.rs')) {
    return { source: 'detected', detected: 'Rust', setup: ['cargo build'], servers: [{ name: 'app', command: 'cargo run', cwd: '' }] };
  }
  return null;
}

function fromProcfile(root: string, file: string, what: string): ProjectConfig | null {
  const procs = parseProcfile(read(root, file) ?? '');
  if (procs.length === 0) return null;
  const node = detectNode(root);
  return {
    source: 'detected',
    detected: what,
    setup: node?.setup ?? [],
    servers: procs.slice(0, 10).map((p) => ({ ...p, cwd: '' })),
  };
}

function detectCompose(root: string): ProjectConfig | null {
  const file = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find((f) => exists(root, f));
  if (!file) return null;
  return { source: 'detected', detected: 'Docker Compose', setup: [], servers: [{ name: 'compose', command: 'docker compose up', cwd: '' }] };
}

/** The best guess for a repo, or null when nothing familiar is there. */
export function detectDevConfig(root: string): ProjectConfig | null {
  return (
    detectRails(root) ??
    fromProcfile(root, 'Procfile.dev', 'Procfile.dev') ??
    detectNode(root) ??
    detectPython(root) ??
    detectCompiled(root) ??
    fromProcfile(root, 'Procfile', 'Procfile') ??
    detectCompose(root)
  );
}
