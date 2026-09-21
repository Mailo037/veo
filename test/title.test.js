import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalTitle } from '../src/terminal-title.js';
import { createReporter } from '../src/progress.js';
import { parseCli } from '../src/cli.js';

function stream(isTTY = true) {
  return { isTTY, output: '', write(text) { this.output += text; } };
}

test('parallel playlist progress keeps each title and stream attached to its entry', () => {
  const output = stream();
  const reporter = createReporter(output, { setTitle() {} });
  const first = reporter.scoped(1, 2, 'First');
  const second = reporter.scoped(2, 2, 'Second');
  first.name('Renamed first');
  second.progress({ stream: 'Audio', downloaded_bytes: 10, total_bytes: 20 });
  first.progress({ stream: 'Video', downloaded_bytes: 10, total_bytes: 10 });
  second.processing({ postprocessor: 'VideoRemuxer', status: 'finished' });
  assert.match(output.output, /\[2\/2\] Second: Audio/);
  assert.match(output.output, /\[1\/2\] Renamed first: Video/);
  assert.match(output.output, /\[2\/2\] Second: Changing video container: done/);
});

test('rename accepts short/long flags and rejects empty names', () => {
  const url = 'https://example.com/video.mp4';
  assert.equal(parseCli([url, '-r', 'My Video']).rename, 'My Video');
  assert.equal(parseCli([url, '--audio', '--rename', 'Music']).rename, 'Music');
  for (const name of ['', '   ', '\x1b[31m\x07']) {
    assert.throws(() => parseCli([url, '-r', name]), /filename cannot be empty/);
  }
  assert.throws(() => parseCli([url, '-r']));
});

test('Linux/macOS titles use sanitized OSC sequences and suppress duplicates', () => {
  for (const platform of ['linux', 'darwin']) {
    const output = stream();
    const setTitle = createTerminalTitle(output, { platform, env: {} });
    setTitle('Download café 🎥\x07\x1b[31m');
    setTitle('Download café 🎥\x07\x1b[31m');
    assert.equal(output.output, '\x1b]0;Download café 🎥\x07');
  }
});

test('Windows uses the console title API without emitting OSC', () => {
  const output = stream();
  const processInfo = { title: 'PowerShell' };
  createTerminalTitle(output, { platform: 'win32', env: {}, processInfo })('veo | 50% | Video');
  assert.equal(processInfo.title, 'veo | 50% | Video');
  assert.equal(output.output, '');
});

test('redirected output and dumb terminals never change titles', () => {
  for (const platform of ['linux', 'win32']) {
    for (const [isTTY, env] of [[false, {}], [true, { TERM: 'dumb' }]]) {
      const output = stream(isTTY);
      const processInfo = { title: 'original' };
      createTerminalTitle(output, { platform, env, processInfo })('veo');
      assert.equal(output.output, '');
      assert.equal(processInfo.title, 'original');
    }
  }
});

test('title API failures do not fail a download', () => {
  const processInfo = { set title(value) { throw new Error('unsupported'); } };
  assert.doesNotThrow(() => createTerminalTitle(stream(), { platform: 'win32', env: {}, processInfo })('veo'));
});

test('reporter titles follow name, progress, processing, and completion', () => {
  const titles = [];
  const reporter = createReporter(stream(), { setTitle: title => titles.push(title) });
  reporter.start('My Video');
  assert.equal(titles.at(-1), 'veo | Starting… | My Video');
  reporter.status('Reading video…');
  assert.equal(titles.at(-1), 'veo | Reading video… | My Video');
  reporter.name('Original title');
  reporter.progress({ downloaded_bytes: 50, total_bytes: 100 });
  assert.equal(titles.at(-1), 'veo | 50% | Original title');
  reporter.progress({});
  assert.equal(titles.at(-1), 'veo | Downloading… | Original title');
  reporter.progress({ status: 'finished', downloaded_bytes: 100, total_bytes: 100 });
  assert.equal(titles.at(-1), 'veo | Processing… | Original title');
  reporter.finish(); // Clearing a progress line is not download completion.
  assert.equal(titles.at(-1), 'veo | Processing… | Original title');
  reporter.complete();
  assert.equal(titles.at(-1), 'veo | Done | Original title');
});

test('reporter failure/cancellation titles only apply after starting a download', () => {
  const titles = [];
  const reporter = createReporter(stream(), { setTitle: title => titles.push(title) });
  reporter.fail(false);
  assert.equal(titles.length, 0);
  reporter.start();
  reporter.fail(false);
  assert.equal(titles.at(-1), 'veo | Failed');
  reporter.fail(true);
  assert.equal(titles.at(-1), 'veo | Cancelled');
});
