import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { openFile } from '../src/open-file.js';
import { parseCli, HELP } from '../src/cli.js';

test('--open combines with rename and audio without changing defaults', () => {
  const url = 'https://example.com/video.mp4';
  const options = parseCli([url, '--audio', '-r', 'My Music', '--open']);
  assert.equal(options.open, true);
  assert.equal(options.rename, 'My Music');
  assert.equal(options.audio, true);
  assert.equal(parseCli([url]).open, false);
  assert.match(HELP, /--open/);
});

for (const [platform, command] of [['win32', 'explorer.exe'], ['linux', 'xdg-open'], ['darwin', 'open']]) {
  test(`${platform} opens one literal absolute filename without a shell`, async () => {
    let unreferenced = false;
    const filename = './My video & $(echo hello).mp4';
    await openFile(filename, { platform, spawnProcess(executable, args, options) {
      assert.equal(executable, command);
      assert.deepEqual(args, [path.resolve(filename)]);
      assert.equal(options.shell, false);
      assert.equal(options.detached, true);
      assert.equal(options.stdio, 'ignore');
      const child = new EventEmitter();
      child.unref = () => { unreferenced = true; };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    } });
    assert.equal(unreferenced, true);
  });
}

test('missing desktop opener reports a launch failure', async () => {
  await assert.rejects(openFile('video.mp4', { platform: 'linux', spawnProcess() {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })));
    return child;
  } }), /ENOENT/);
});
