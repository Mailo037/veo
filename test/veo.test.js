import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseCli } from '../src/cli.js';
import { closestHeight, sanitizeTitle, saveUnique, readableError, validateUrl } from '../src/utils.js';
import { formatProgress } from '../src/progress.js';

const url = 'https://example.com/video.mp4';
test('CLI defaults, flags, help, and version', () => {
  assert.deepEqual(parseCli([url]), { quality: 'best', output: process.cwd(), audio: false, url });
  assert.equal(parseCli([url, '-q', '1080p', '-o', './videos', '--format', 'mp4']).quality, '1080p');
  assert.equal(parseCli([url, '--audio', '--format', 'flac']).audio, true);
  assert.equal(parseCli(['--help']).help, true);
  assert.equal(parseCli(['--version']).version, true);
});
test('invalid and conflicting options fail before backend acquisition', () => {
  for (const args of [[], [url, url], ['foo'], [url, '-q', '999p'], [url, '--format', 'exe'], [url, '--audio', '--format', 'mp4'], [url, '--audio', '-q', '720p'], [url, '--output', ''], [url, '--unknown']]) assert.throws(() => parseCli(args));
  for (const input of ['file:///tmp/video', 'ftp://example.com/v', 'https://user:password@example.com', '--exec=echo']) assert.throws(() => validateUrl(input));
});
test('nearest resolution selects above or below, ties below; ignores DRM and audio', () => {
  const formats = [360, 720, 1440].map(height => ({ height, vcodec: 'h264' }));
  assert.equal(closestHeight(formats, '720p'), 720);
  assert.equal(closestHeight(formats, '1080p'), 720);
  assert.equal(closestHeight(formats, '2160p'), 1440);
  assert.equal(closestHeight([{ height: 1440 }], '1080p'), 1440);
  assert.equal(closestHeight(formats, 'best'), null);
  assert.equal(closestHeight([{ height: 720, has_drm: true }, { height: 720, vcodec: 'none' }], '720p'), null);
  assert.equal(closestHeight([], '720p'), null);
});
test('safe Unicode-preserving titles', () => {
  assert.equal(sanitizeTitle('A video: "hello" / world?'), 'A video_ _hello_ _ world_');
  assert.equal(sanitizeTitle('日本語 café'), '日本語 café');
  assert.equal(sanitizeTitle('CON.mp4'), '_CON.mp4');
  assert.equal(sanitizeTitle('..'), 'video');
  assert.equal(sanitizeTitle('Hello.  '), 'Hello');
  assert(!sanitizeTitle('../../evil\u001b[31m').includes('/'));
  assert(Buffer.byteLength(sanitizeTitle('🎥'.repeat(100))) <= 180);
});
test('concurrent save never overwrites an existing filename', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veo-unit-'));
  try {
    const first = path.join(dir, 'a.mp4');
    const second = path.join(dir, 'b.mp4');
    await writeFile(first, 'one'); await writeFile(second, 'two');
    await writeFile(path.join(dir, 'Title.mp4'), 'original');
    const results = await Promise.all([saveUnique(first, dir, 'Title'), saveUnique(second, dir, 'Title')]);
    assert.equal(new Set(results).size, 2);
    assert.equal(await readFile(path.join(dir, 'Title.mp4'), 'utf8'), 'original');
    assert.deepEqual(results.map(p => path.basename(p)).sort(), ['Title (1).mp4', 'Title (2).mp4']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('progress contains all requested fields, with honest unknown totals', () => {
  const line = formatProgress({ downloaded_bytes: 1024, total_bytes: 2048, speed: 1024, eta: 2 });
  assert.match(line, /50%/); assert.match(line, /1.0 KiB\/s/);
  assert.match(line, /1.0 KiB \/ 2.0 KiB/); assert.match(line, /ETA 0:02/);
  assert.match(formatProgress({}), /\?%/);
});
test('readable backend and filesystem errors', () => {
  for (const [message, pattern] of [['Unsupported URL', /not supported/], ['This video is private', /private/], ['Video deleted', /deleted/], ['Connection timed out', /Network/], ['Requested format is not available', /format is unavailable/], ['DRM-protected', /DRM/]]) assert.match(readableError(new Error(message)), pattern);
  assert.match(readableError(Object.assign(new Error(), { code: 'ENOSPC' })), /disk space/);
  assert.equal(readableError(new DOMException('abort', 'AbortError')), 'Cancelled.');
});
