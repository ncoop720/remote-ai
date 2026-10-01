import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildClaudeArgs, claudeInstallArgs, parseAuthStatus } from './index.js';

test('buildClaudeArgs adds flags only when needed', () => {
  assert.deepEqual(buildClaudeArgs(['claude'], '/d/s.json', {}), ['claude', '--settings', '/d/s.json']);
  assert.deepEqual(buildClaudeArgs(['claude'], '/d/s.json', { mode: 'manual' }), [
    'claude', '--settings', '/d/s.json', '--permission-mode', 'manual',
  ]);
  assert.deepEqual(
    buildClaudeArgs(['npx', 'claude'], '/d/s.json', {
      mode: 'plan',
      resume: true,
      systemPrompt: 'Dev servers run elsewhere',
      prompt: "  Add a dark-mode toggle; don't break SSR\n",
    }),
    [
      'npx', 'claude', '--settings', '/d/s.json', '--permission-mode', 'plan',
      '--append-system-prompt', 'Dev servers run elsewhere', '--continue', "Add a dark-mode toggle; don't break SSR",
    ],
  );
});

test('sign-in status comes from `claude auth status --json`', () => {
  assert.equal(parseAuthStatus('{"loggedIn": true, "authMethod": "claude.ai"}'), true);
  assert.equal(parseAuthStatus('{"loggedIn": false}'), false);
  assert.equal(parseAuthStatus('Not logged in'), false);
});

test('the official installer for each platform', () => {
  assert.deepEqual(claudeInstallArgs('darwin'), ['bash', '-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
  // PowerShell gets the script as one argument, never through cmd.exe.
  assert.deepEqual(claudeInstallArgs('win32').slice(0, 1), ['powershell']);
  assert.equal(claudeInstallArgs('win32').at(-1), 'irm https://claude.ai/install.ps1 | iex');
});
