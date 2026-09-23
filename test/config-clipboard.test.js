import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardCommands, clipboardText } from '../src/config-clipboard.js';

test('clipboard commands cover Windows, macOS, Wayland and X11', () => {
  assert.equal(clipboardCommands('copy', { platform: 'win32' })[0][0], 'powershell.exe');
  assert.equal(clipboardCommands('paste', { platform: 'darwin' })[0][0], 'pbpaste');
  assert.equal(clipboardCommands('copy', { platform: 'darwin' })[0][0], 'pbcopy');
  assert.deepEqual(clipboardCommands('copy', { platform: 'android' }), [['termux-clipboard-set', []]]);
  assert.deepEqual(clipboardCommands('paste', { platform: 'android' }), [['termux-clipboard-get', []]]);
  assert.deepEqual(clipboardCommands('copy', { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } }).map(([name]) => name), ['wl-copy', 'xclip', 'xsel']);
  assert.deepEqual(clipboardCommands('paste', { platform: 'linux', env: { DISPLAY: ':0' } }).map(([name]) => name), ['xclip', 'xsel', 'wl-paste']);
  assert.deepEqual(clipboardCommands('paste', { platform: 'linux', env: {} }).map(([name]) => name), ['wl-paste', 'xclip', 'xsel']);
});

test('Linux clipboard falls back when the first tool is unavailable', async () => {
  const attempts = [];
  const options = { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, run: async ([name], operation, value) => {
    attempts.push([name, operation, value]);
    if (name.startsWith('wl-')) throw new Error('not installed');
    return operation === 'paste' ? 'Grüße\n' : undefined;
  } };
  await clipboardText('copy', 'Grüße\n', options);
  assert.deepEqual(attempts.map(([name]) => name), ['wl-copy', 'xclip']);
  attempts.length = 0;
  assert.equal(await clipboardText('paste', '', options), 'Grüße\n');
  assert.deepEqual(attempts.map(([name]) => name), ['wl-paste', 'xclip']);
});

test('clipboard errors are actionable and copied text is size limited by UTF-8 bytes', async () => {
  const options = { platform: 'linux', env: {}, run: async () => { throw new Error('missing'); } };
  await assert.rejects(clipboardText('paste', '', options), /install wl-clipboard, xclip or xsel/i);
  await assert.rejects(clipboardText('copy', 'ü'.repeat(1024 * 1024 + 1), options), /too large/);
});
