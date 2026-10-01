import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autostartEntry, autostartFile } from './autostart.js';

test('the Linux autostart entry starts the app hidden', () => {
  assert.equal(autostartFile({ XDG_CONFIG_HOME: '/home/me/.cfg' }), '/home/me/.cfg/autostart/remote-ai.desktop');
  const entry = autostartEntry('/home/me/Apps/remote-ai.AppImage');
  assert.match(entry, /^\[Desktop Entry\]\nType=Application\n/);
  assert.match(entry, /\nExec=\/home\/me\/Apps\/remote-ai\.AppImage --hidden\n/);
  assert.match(autostartEntry('/home/me/My Apps/remote ai'), /\nExec="\/home\/me\/My Apps\/remote ai" --hidden\n/);
});
