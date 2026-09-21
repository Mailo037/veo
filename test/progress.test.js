import test from 'node:test';
import assert from 'node:assert/strict';
import { createReporter, formatProgress } from '../src/progress.js';
import { outputStream } from '../src/output.js';
import { readableError } from '../src/utils.js';
import { runBackend } from '../src/downloader.js';

const data = { stream: 'Media', downloaded_bytes: 90 * 1024 ** 2, total_bytes_estimate: 1024 ** 3, speed: 12.6 * 1024 ** 2, eta: 77 };

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
