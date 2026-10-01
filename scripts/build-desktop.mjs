// Builds the desktop app for electron-builder:
//
//   dist/desktop/                     the app: main process, preload, web app, tray icons
//   dist/host-runtime/<os>-<arch>/    the session host: Node, its script (host.mjs) and node-pty
//                                     (vendor/), shipped as a resource and copied out of the app
//                                     when it runs
//   dist/tailscale/<os>-<arch>/       built-in Tailscale (the Go program in tailscale/)
//
//   node scripts/build-desktop.mjs [--targets linux-x64,mac-arm64,...] [--skip-web] [--skip-tailscale]
//
// Targets default to this machine. node-pty ships prebuilt binaries for macOS and Windows; Linux
// uses the one npm built here, so a Linux target must match this machine. Go cross-compiles, so the
// Tailscale program builds for any target; without Go on PATH, a Go release is downloaded into the
// build cache.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const r = (...p) => path.join(root, ...p);
const pkg = JSON.parse(fs.readFileSync(r('package.json'), 'utf8'));
const OS = { darwin: 'mac', win32: 'win', linux: 'linux' };
const NODE_OS = { mac: 'darwin', win: 'win', linux: 'linux' };
const PTY_OS = { mac: 'darwin', win: 'win32', linux: 'linux' };

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const targets = (option('--targets') ?? `${OS[process.platform]}-${process.arch}`).split(',');

// ESM bundles still contain CommonJS packages that call require() and use __dirname.
const esmShim = [
  "import { createRequire as __createRequire } from 'node:module';",
  "import { fileURLToPath as __fileURLToPath } from 'node:url';",
  "import { dirname as __dirnameOf } from 'node:path';",
  'const require = __createRequire(import.meta.url);',
  'const __filename = __fileURLToPath(import.meta.url);',
  'const __dirname = __dirnameOf(__filename);',
].join('\n');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
  // ws loads these optional speed-ups only if they are installed.
  external: ['bufferutil', 'utf-8-validate'],
};

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

// ---- The app ----

async function buildApp() {
  if (!flag('--skip-web')) {
    step('web app');
    execFileSync(process.execPath, [r('node_modules/vite/bin/vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
  }
  const out = r('dist/desktop');
  fs.rmSync(out, { recursive: true, force: true });

  step('main process and preload');
  await build({
    ...common,
    entryPoints: [r('desktop/main.ts')],
    outfile: path.join(out, 'main.mjs'),
    format: 'esm',
    banner: { js: esmShim },
    external: [...common.external, 'electron'],
  });
  await build({
    ...common,
    entryPoints: [r('desktop/preload.ts')],
    outfile: path.join(out, 'preload.cjs'),
    format: 'cjs',
    external: ['electron'],
  });

  fs.cpSync(r('dist/web'), path.join(out, 'web'), { recursive: true });
  fs.cpSync(r('desktop/assets'), path.join(out, 'assets'), { recursive: true });
  // electron-builder reads the app's name and version from here; the app has no dependencies of its own.
  const appPkg = {
    name: pkg.name,
    productName: 'remote-ai',
    // Linux desktops match the window to its launcher entry by this name.
    desktopName: 'remote-ai.desktop',
    version: pkg.version,
    description: pkg.description,
    homepage: 'https://github.com/ncoop720/remote-ai',
    author: 'ncoop720',
    license: pkg.license,
    type: 'module',
    main: 'main.mjs',
  };
  fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`);
}

// ---- The session host runtime ----

async function buildHostScript() {
  step('session host script');
  const file = r('dist/host-bundle/host.mjs');
  await build({
    ...common,
    entryPoints: [r('server/src/host/main.ts')],
    outfile: file,
    format: 'esm',
    banner: { js: esmShim },
    sourcemap: false,
    // node-pty ships next to the script, in vendor/: electron-builder leaves out any folder named
    // node_modules from the app's extra resources.
    plugins: [
      {
        name: 'vendored-node-pty',
        setup(b) {
          b.onResolve({ filter: /^node-pty$/ }, () => ({ path: './vendor/node-pty/lib/index.js', external: true }));
        },
      },
    ],
  });
  return file;
}

const cacheRoot = process.env.REMOTE_AI_BUILD_CACHE ?? path.join(os.homedir(), '.cache', 'remote-ai-build');

/** The newest Node release of a major version; offline, the newest one already downloaded. */
async function latestNode(major) {
  try {
    const index = await (await fetch('https://nodejs.org/dist/index.json')).json();
    const found = index.find((v) => v.version.startsWith(`v${major}.`));
    if (found) return found.version.slice(1);
  } catch (err) {
    const newer = (a, b) => b.split('.').map(Number).reduce((d, n, i) => d || n - Number(a.split('.')[i]), 0);
    const cached = (fs.existsSync(path.join(cacheRoot, 'node')) ? fs.readdirSync(path.join(cacheRoot, 'node')) : [])
      .filter((v) => v.startsWith(`${major}.`))
      .sort(newer);
    if (cached[0]) {
      console.log(`  offline (${err.cause?.code ?? err.message}); using cached Node ${cached[0]}`);
      return cached[0];
    }
    throw err;
  }
  throw new Error(`No Node.js ${major} release found`);
}

/** The official Node binary for a target, checked against the release's SHASUMS256.txt and cached. */
async function nodeBinary(version, target) {
  const [os_, arch] = target.split('-');
  const isWin = os_ === 'win';
  const base = `node-v${version}-${NODE_OS[os_]}-${arch}`;
  const archive = `${base}.${isWin ? 'zip' : 'tar.gz'}`;
  const cacheDir = path.join(cacheRoot, 'node', version);
  const binary = path.join(cacheDir, base, isWin ? 'node.exe' : 'node');
  if (fs.existsSync(binary)) return binary;

  const url = `https://nodejs.org/dist/v${version}`;
  console.log(`  downloading ${archive}`);
  const sums = await (await fetch(`${url}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((l) => l.endsWith(`  ${archive}`))?.split(' ')[0];
  if (!expected) throw new Error(`${archive} is not in SHASUMS256.txt`);
  const res = await fetch(`${url}/${archive}`);
  if (!res.ok) throw new Error(`Downloading ${archive}: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== expected) throw new Error(`${archive} checksum mismatch`);

  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, archive);
  fs.writeFileSync(archivePath, data);
  const member = isWin ? `${base}/node.exe` : `${base}/bin/node`;
  // bsdtar (macOS, Windows) reads zip files too.
  execFileSync('tar', ['-xf', archivePath, '-C', cacheDir, member], { stdio: 'inherit' });
  if (!isWin) fs.renameSync(path.join(cacheDir, member), binary);
  fs.rmSync(archivePath);
  return binary;
}

/** Copy node-pty with only what the target needs at run time. */
function copyNodePty(target, dest) {
  const [os_, arch] = target.split('-');
  const src = r('node_modules/node-pty');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['package.json', 'LICENSE']) fs.copyFileSync(path.join(src, f), path.join(dest, f));
  fs.cpSync(path.join(src, 'lib'), path.join(dest, 'lib'), {
    recursive: true,
    filter: (p) => !/(\.test\.js|\.map)$/.test(p),
  });
  const noDebugSymbols = (p) => !p.endsWith('.pdb');
  if (os_ === 'linux') {
    if (process.platform !== 'linux' || process.arch !== arch) {
      throw new Error(`node-pty for ${target} has to be built on ${target}`);
    }
    fs.cpSync(path.join(src, 'build', 'Release'), path.join(dest, 'build', 'Release'), {
      recursive: true,
      filter: (p) => fs.statSync(p).isDirectory() || p.endsWith('.node'),
    });
  } else {
    const prebuild = `${PTY_OS[os_]}-${arch}`;
    const from = path.join(src, 'prebuilds', prebuild);
    if (!fs.existsSync(from)) throw new Error(`node-pty has no prebuilt binary for ${prebuild}`);
    fs.cpSync(from, path.join(dest, 'prebuilds', prebuild), { recursive: true, filter: noDebugSymbols });
  }
}

async function buildRuntime(target, hostScript, nodeVersion) {
  step(`session host runtime for ${target}`);
  const [os_] = target.split('-');
  const out = r('dist/host-runtime', target);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  fs.copyFileSync(hostScript, path.join(out, 'host.mjs'));
  const node = path.join(out, os_ === 'win' ? 'node.exe' : 'node');
  fs.copyFileSync(await nodeBinary(nodeVersion, target), node);
  fs.chmodSync(node, 0o755);
  // Node's Linux binary carries ~18 MB of symbols. (Stripping the macOS one would break its signature.)
  if (os_ === 'linux' && process.platform === 'linux') {
    try {
      execFileSync('strip', ['--strip-unneeded', node]);
    } catch {
      console.log('  strip is not installed; keeping symbols');
    }
  }
  copyNodePty(target, path.join(out, 'vendor', 'node-pty'));

  const nodePty = JSON.parse(fs.readFileSync(r('node_modules/node-pty/package.json'), 'utf8')).version;
  const hash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(hostScript))
    .update(`${target} node ${nodeVersion} node-pty ${nodePty}`)
    .digest('hex')
    .slice(0, 16);
  fs.writeFileSync(path.join(out, 'runtime.json'), `${JSON.stringify({ hash, node: nodeVersion, nodePty }, null, 2)}\n`);
  console.log(`  ${target}: Node ${nodeVersion}, node-pty ${nodePty}, runtime ${hash}`);
}

// ---- Built-in Tailscale ----

const GO_OS = { mac: 'darwin', win: 'windows', linux: 'linux' };
const GO_ARCH = { x64: 'amd64', arm64: 'arm64' };

/** `go` from PATH, or the newest Go release in the build cache (downloaded and checked if need be). */
async function goToolchain() {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return { go: 'go', env: {} };
  } catch {
    // not installed
  }
  const goDir = path.join(cacheRoot, 'go');
  const exe = process.platform === 'win32' ? 'go.exe' : 'go';
  const binOf = (version) => path.join(goDir, version, 'go', 'bin', exe);
  // Its module and build caches stay in the build cache too.
  const env = { GOPATH: path.join(cacheRoot, 'gopath'), GOCACHE: path.join(cacheRoot, 'gocache'), GOTOOLCHAIN: 'local' };
  let release;
  try {
    [release] = await (await fetch('https://go.dev/dl/?mode=json')).json();
  } catch (err) {
    const cached = (fs.existsSync(goDir) ? fs.readdirSync(goDir) : []).filter((v) => fs.existsSync(binOf(v))).sort().reverse();
    if (cached[0]) return { go: binOf(cached[0]), env };
    throw err;
  }
  if (fs.existsSync(binOf(release.version))) return { go: binOf(release.version), env };

  const goos = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform];
  const file = release.files.find((f) => f.os === goos && f.arch === GO_ARCH[process.arch] && f.kind === 'archive');
  if (!file) throw new Error(`No Go download for ${process.platform}-${process.arch}`);
  console.log(`  downloading ${file.filename}`);
  const res = await fetch(`https://go.dev/dl/${file.filename}`);
  if (!res.ok) throw new Error(`Downloading ${file.filename}: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`${file.filename} checksum mismatch`);
  const dest = path.join(goDir, release.version);
  fs.mkdirSync(dest, { recursive: true });
  const archive = path.join(goDir, file.filename);
  fs.writeFileSync(archive, data);
  execFileSync('tar', ['-xf', archive, '-C', dest], { stdio: 'inherit' });
  fs.rmSync(archive);
  return { go: binOf(release.version), env };
}

async function buildTailscale(targets) {
  step('built-in Tailscale');
  const { go, env } = await goToolchain();
  for (const target of targets) {
    const [os_, arch] = target.split('-');
    const out = r('dist/tailscale', target, os_ === 'win' ? 'remote-ai-tailscale.exe' : 'remote-ai-tailscale');
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
    execFileSync(go, ['build', '-trimpath', '-ldflags=-s -w', '-o', out, '.'], {
      cwd: r('tailscale'),
      stdio: 'inherit',
      env: { ...process.env, ...env, GOOS: GO_OS[os_], GOARCH: GO_ARCH[arch], CGO_ENABLED: '0' },
    });
    console.log(`  ${target}: ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
  }
}

await buildApp();
if (!flag('--skip-tailscale')) await buildTailscale(targets);
const hostScript = await buildHostScript();
// The host runs on the current Node LTS line this project builds with, unless pinned.
const nodeVersion = process.env.REMOTE_AI_HOST_NODE ?? (await latestNode(process.versions.node.split('.')[0]));
for (const target of targets) await buildRuntime(target, hostScript, nodeVersion);
console.log('\nBuilt dist/desktop and dist/host-runtime. Package with: npx electron-builder');
