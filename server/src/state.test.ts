import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { oneSpelling, StateStore, type StateData } from './state.js';

const main = 'C:\\Users\\me\\code\\game';
const walk = 'C:\\Users\\me\\worktrees\\game\\walk';

/** A Windows state.json from before paths had one spelling: walk was created, then its dev servers started. */
const split: StateData = {
  ports: {
    'C:/Users/me/code/game': 3110,
    [walk]: 3120, // what the agent was told
    'C:/Users/me/worktrees/game/walk': 3130, // where its dev servers run
  },
  bases: { [walk]: 'main' },
  agents: { [walk]: 'claude' },
  projects: [main],
};

function store(contents: object) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-state-'));
  const file = path.join(dataDir, 'state.json');
  fs.writeFileSync(file, JSON.stringify(contents));
  return { dataDir, state: new StateStore(dataDir, 3100, 10), saved: () => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown };
}

test('each worktree keeps one entry: the port block its dev servers use, and what was stored under either spelling', () => {
  const migrated = oneSpelling(split, 'win32');
  assert.deepEqual(migrated, {
    ports: { [main]: 3110, [walk]: 3130 },
    bases: { [walk]: 'main' },
    agents: { [walk]: 'claude' },
    projects: [main],
  });
  assert.deepEqual(oneSpelling(migrated, 'win32'), migrated, 'once is enough');
  assert.deepEqual(oneSpelling(split, 'linux'), split, 'nothing to do elsewhere');
});

test('the store saves state.json as it migrates it, keeping fields it does not know', () => {
  const { dataDir, saved } = store({ ...split, extra: true });
  assert.deepEqual(saved(), { ...oneSpelling(split), extra: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('on Windows the store loads one entry per worktree, and the dropped block is free again', { skip: process.platform !== 'win32' }, () => {
  const { dataDir, state } = store(split);
  assert.equal(state.portFor(walk), 3130);
  assert.equal(state.baseFor(walk), 'main');
  assert.deepEqual(state.worktreePaths().sort(), [main, walk]);
  assert.equal(state.allocatePort('C:\\Users\\me\\worktrees\\game\\run'), 3100);
  assert.equal(state.allocatePort('C:\\Users\\me\\worktrees\\game\\jump'), 3120);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
