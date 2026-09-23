import test from 'node:test';
import assert from 'node:assert/strict';
import { createReporter, formatProgress } from '../src/progress.js';
import { outputStream } from '../src/output.js';
import { readableError } from '../src/utils.js';
import { runBackend } from '../src/downloader.js';

const data = { stream: 'Media', downloaded_bytes: 90 * 1024 ** 2, total_bytes_estimate: 1024 ** 3, speed: 12.6 * 1024 ** 2, eta: 77 };

test('non-default profile is white after a gray label only when terminal colors are enabled', () => {
  const output = () => ({ isTTY: true, text: '', write(value) { this.text += value; } });
  const terminal = output();
  const reporter = createReporter(terminal, { setTitle() {}, env: {} });
  reporter.profile('kino');
  assert.equal(terminal.text, '\x1b[90mProfile: \x1b[0m\x1b[97mkino\x1b[0m\n');
  terminal.text = '';
  reporter.profile('default');
  assert.equal(terminal.text, '\x1b[90mProfile: default\x1b[0m\n');
  reporter.configure({ color: false });
  terminal.text = '';
  reporter.profile('kino');
  assert.equal(terminal.text, 'Profile: kino\n');
  const noColor = output();
  createReporter(noColor, { setTitle() {}, env: { NO_COLOR: '1' } }).profile('kino');
  assert.equal(noColor.text, 'Profile: kino\n');
  const pipe = output(); pipe.isTTY = false;
  createReporter(pipe, { setTitle() {}, env: {} }).profile('kino');
  assert.equal(pipe.text, 'Profile: kino\n');
});

test('Termux progress stays within the terminal and reuses one line across resizing', () => {
  const output = { isTTY: true, columns: 60, text: '', write(text) { this.text += text; } };
  const wrapped = outputStream(output);
  const reporter = createReporter(wrapped, { setTitle() {} });
  reporter.progress(data);
  const headerLines = output.text.split('\n').length;
  for (const columns of [60, 40, 32, 20, 10, 80, 120]) {
    output.columns = columns;
    assert.equal(wrapped.columns, columns);
    for (let index = 0; index < 10; index++) reporter.progress({ ...data, downloaded_bytes: data.downloaded_bytes + index });
    const lastLine = output.text.split('\r\x1b[2K').at(-1);
    assert.ok(lastLine.length < columns, `${columns}: ${lastLine}`);
    assert.equal(output.text.split('\n').length, headerLines);
  }
  reporter.finish();
  assert.ok(output.text.endsWith('\r\x1b[2K'));
});

test('estimated totals cannot display 100 percent; completed streams are not completed jobs', () => {
  const estimated = formatProgress({ downloaded_bytes: 1024, total_bytes_estimate: 1024 });
  assert.match(estimated, /~99%/);
  assert.match(estimated, /~1.0 KiB/);
  assert.doesNotMatch(estimated, /100%/);
  assert.match(formatProgress({ status: 'finished', downloaded_bytes: 1024, total_bytes: 1024 }), /received; processing/);
});

test('parallel progress shares a compact live line and handles wide titles', () => {
  const output = { isTTY: true, columns: 40, text: '', write(text) { this.text += text; } };
  const reporter = createReporter(output, { setTitle() {} });
  const first = reporter.scoped(1, 2, '🎥日本語'.repeat(20));
  const second = reporter.scoped(2, 2, 'Second');
  for (let index = 0; index < 20; index++) { first.progress(data); second.progress(data); }
  assert.equal(output.text.includes('\n'), false);
  for (const line of output.text.split('\r\x1b[2K').filter(Boolean)) assert.ok(line.length < 40);
  assert.match(output.text, /\[1\/2\]/);
  assert.match(output.text, /\[2\/2\]/);
});

test('redirected output remains throttled and contains no terminal control codes', () => {
  const output = { text: '', write(text) { this.text += text; } };
  const reporter = createReporter(output, { setTitle() {} });
  for (let index = 0; index < 20; index++) reporter.progress(data);
  assert.equal(output.text.split('\n').filter(Boolean).length, 2);
  assert.doesNotMatch(output.text, /\x1b|\r/);
});

test('waiting status animates in place and processing replaces it with a colored result', async () => {
  const output = { isTTY: true, columns: 80, text: '', write(text) { this.text += text; } };
  const reporter = createReporter(output, { setTitle() {}, env: {} });
  reporter.status('Reading video…');
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.match(output.text, /Reading video\./);
  assert.match(output.text, /Reading video\.\./);
  assert.equal(output.text.includes('\n'), false);
  reporter.processing({ postprocessor: 'MoveFiles', status: 'started' });
  assert.equal(output.text.includes('\n'), false);
  reporter.processing({ postprocessor: 'MoveFiles', status: 'finished' });
  assert.match(output.text, /Preparing saved file: \x1b\[0m\x1b\[32mdone\x1b\[0m\n$/);
  const settled = output.text;
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(output.text, settled);
});

test('failed processing is red with color and plain with no color', () => {
  for (const color of [true, false]) {
    const output = { isTTY: true, columns: 80, text: '', write(text) { this.text += text; } };
    const reporter = createReporter(output, { setTitle() {}, env: {} });
    reporter.configure({ color });
    reporter.processing({ postprocessor: 'MoveFiles', status: 'started' });
    reporter.processing({ postprocessor: 'MoveFiles', status: 'failed' });
    assert.ok(output.text.endsWith(color ? 'Preparing saved file: \x1b[0m\x1b[31mfailed\x1b[0m\n' : 'Preparing saved file: failed\n'));
    reporter.complete();
  }
});

test('an active save failure replaces its animation without affecting another scoped item', () => {
  const output = { isTTY: true, columns: 80, text: '', write(text) { this.text += text; } };
  const reporter = createReporter(output, { setTitle() {}, env: {} });
  const first = reporter.scoped(1, 2, 'First');
  const second = reporter.scoped(2, 2, 'Second');
  first.status('Reading video…');
  second.processing({ postprocessor: 'MoveFiles', status: 'started' });
  first.failStep();
  assert.equal(output.text.includes('failed'), false);
  second.failStep();
  assert.match(output.text, /Second: Preparing saved file: \x1b\[0m\x1b\[31mfailed\x1b\[0m\n$/);
  reporter.complete();
});

test('completed yt-dlp check and video read remain as separate lines', () => {
  const output = { isTTY: true, columns: 80, text: '', write(text) { this.text += text; } };
  const reporter = createReporter(output, { setTitle() {}, env: {} });
  reporter.configure({ color: false });
  reporter.status('Checking yt-dlp…');
  reporter.finishStatus('Checking yt-dlp…', 'done');
  reporter.status('Reading video…');
  reporter.finishStatus('Reading video…', 'done');
  const lines = output.text.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].endsWith('Checking yt-dlp: done'));
  assert.ok(lines[1].endsWith('Reading video: done'));
  reporter.status('Downloading…');
  assert.ok(output.text.includes('Checking yt-dlp: done\n'));
  assert.ok(output.text.includes('Reading video: done\n'));
  reporter.finish();
});

test('yt-dlp check and video read use success and error colors when enabled', () => {
  for (const label of ['Checking yt-dlp', 'Reading video']) for (const outcome of ['done', 'failed']) {
    const output = { isTTY: true, columns: 80, text: '', write(text) { this.text += text; } };
    const reporter = createReporter(output, { setTitle() {}, env: {} });
    reporter.status(`${label}…`);
    reporter.finishStatus(`${label}…`, outcome);
    assert.ok(output.text.endsWith(`${label}: \x1b[0m\x1b[${outcome === 'done' ? 32 : 31}m${outcome}\x1b[0m\n`));
    reporter.finish();
  }
});

test('download errors select the final backend failure and retain HTTP status', async () => {
  await assert.rejects(runBackend(process.execPath, ['-e', 'console.error("WARNING: cookies were not needed"); console.error("ERROR: unable to download video data: HTTP Error 403: Forbidden"); console.error("veo-progress:{}"); process.exit(1)']), error => {
    assert.match(readableError(error), /HTTP 403 Forbidden/);
    assert.doesNotMatch(error.message, /veo-progress|WARNING/);
    return true;
  });
  assert.match(readableError(new Error('HTTP Error 429: Too Many Requests')), /429.*rate-limiting/);
  assert.match(readableError(new Error('HTTP Error 503: Service Unavailable')), /HTTP 503/);
  assert.match(readableError(new Error('read ECONNRESET')), /ECONNRESET/);
});
