import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installHostRuntime, pruneHostRuntimes } from './hostRuntime.js';

function build(dir: string, hash: string): string {
  fs.mkdirSync(path.join(dir, 'vendor', 'node-pty'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ hash, node: '22.0.0', nodePty: '1.1.0' }));
  fs.writeFileSync(path.join(dir, 'host.mjs'), `// ${hash}`);
  fs.writeFileSync(path.join(dir, 'node'), '', { mode: 0o755 });
  return dir;
}

test('the host runtime is copied out once per version, and old copies are pruned', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-runtime-'));
  const data = path.join(tmp, 'data');
  const v1 = installHostRuntime(build(path.join(tmp, 'app1'), 'aaa'), data);
  assert.equal(v1.dir, path.join(data, 'host-runtime', 'aaa'));
  assert.equal(v1.command.args[0], path.join(v1.dir, 'host.mjs'));
  assert.ok(fs.existsSync(path.join(v1.dir, 'vendor', 'node-pty')));
  if (process.platform !== 'win32') assert.ok(fs.statSync(v1.command.file).mode & 0o100, 'node stays executable');

  // A second start with the same build reuses the copy (even if the app's files changed meanwhile).
  fs.writeFileSync(path.join(tmp, 'app1', 'host.mjs'), '// edited');
  installHostRuntime(path.join(tmp, 'app1'), data);
  assert.equal(fs.readFileSync(path.join(v1.dir, 'host.mjs'), 'utf8'), '// aaa');

  // An update brings a new copy; the old one stays while a host runs from it.
  const v2 = installHostRuntime(build(path.join(tmp, 'app2'), 'bbb'), data);
  fs.mkdirSync(path.join(data, 'host-runtime', 'ccc.partial-123'));
  assert.deepEqual(pruneHostRuntimes(data, [v2.dir, v1.dir]).map((d) => path.basename(d)), ['ccc.partial-123']);
  assert.deepEqual(pruneHostRuntimes(data, [v2.dir, undefined]).map((d) => path.basename(d)), ['aaa']);
  assert.deepEqual(fs.readdirSync(path.join(data, 'host-runtime')), ['bbb']);
  fs.rmSync(tmp, { recursive: true, force: true });
});
