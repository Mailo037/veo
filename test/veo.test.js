import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseCli } from '../src/cli.js';
import { allocate, closestHeight, sanitizeTitle, saveUnique, readableError, validateUrl, validateCookieFile, validateBrowserSpec, cookieFileWarning } from '../src/utils.js';
import { formatProgress } from '../src/progress.js';

const url = 'https://example.com/video.mp4';
test('CLI defaults, flags, help, and version', () => {
  const defaults = parseCli([url]);
  assert.equal(defaults.quality, 'best');
  assert.equal(defaults.output, process.cwd());
  assert.equal(defaults.audio, false);
  assert.equal(defaults.resume, false);
  assert.equal(defaults.closestQuality, false);
  assert.equal(defaults.json, false);
  assert.equal(defaults.playlist, false);
  assert.deepEqual(defaults.urls, [url]);
  assert.equal(defaults.url, url);
  assert.equal(parseCli([url, '-q', '1080p', '-o', './videos', '--format', 'mp4']).quality, '1080p');
  assert.equal(parseCli([url, '--audio', '--format', 'flac']).audio, true);
  assert.equal(parseCli([url, '--resume']).resume, true);
  assert.equal(parseCli([url, '--audio', '--rename', 'My Music', '--open']).open, true);
  assert.deepEqual(parseCli([url, url.replace('video', 'other')]).urls.length, 2);
  assert.equal(parseCli([url, '-q', '1080p', '--closest-quality']).closestQuality, true);
  assert.equal(parseCli([url, '--sub-langs', 'de,en']).subs, true);
  assert.equal(parseCli([url, '-N', '4']).concurrentFragments, 4);
  assert.equal(parseCli(['--help']).help, true);
  assert.equal(parseCli(['--version']).version, true);
});
test('config values act as defaults and explicit flags win', () => {
  const config = { quality: '480p', output: './stored', audio: true, embedMetadata: true, concurrentFragments: 8 };
  assert.equal(parseCli([url], { config }).quality, '480p');
  assert.equal(parseCli([url], { config }).output, './stored');
  assert.equal(parseCli([url], { config }).audio, true);
  assert.equal(parseCli([url], { config }).embedMetadata, true);
  assert.equal(parseCli([url], { config }).concurrentFragments, 8);
  assert.equal(parseCli([url, '-q', '720p', '-o', './cli'], { config }).quality, '720p');
  assert.equal(parseCli([url, '-o', './cli'], { config }).output, './cli');
  // An explicit numeric quality states video intent and overrides audio-only defaults.
  assert.equal(parseCli([url, '-q', '720p'], { config }).audio, false);
  // With no stored audio preference the explicit quality still wins.
  assert.equal(parseCli([url, '-q', '720p'], { config: { audio: false } }).quality, '720p');
  // A single URL must still be renderable with --rename.
  assert.throws(() => parseCli([url, url, '-q', '720p'], { config: { rename: 'x' } }), /--rename only applies to a single URL/);
});
test('invalid and conflicting options fail before backend acquisition', () => {
  for (const args of [[], ['foo'], [url, '-q', '0p'], [url, '--format', 'exe'], [url, '--audio', '--format', 'mp4'], [url, '--audio', '-q', '720p'], [url, '--output', ''], [url, '--unknown'], [url, '--closest-quality'], [url, '--audio', '--closest-quality'], [url, '-q', '720p', '--closest-quality', '--audio'], [url, url, '-r', 'x'], [url, '-N', '0'], [url, '-N', '99'], [url, '-N', 'two'], [url, '--list-formats', url], [url, '--list-formats', '--audio'], [url, '--section', 'abc'], [url, '--sponsorblock-remove', 'sponsor;rm -rf']]) assert.throws(() => parseCli(args), `should reject ${args.join(' ')}`);
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
test('allocation prefers a hard link and falls back to a copy without clobbering', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veo-unit-'));
  try {
    const source = path.join(dir, 'staged.mp4');
    const linked = path.join(dir, 'linked.mp4');
    await writeFile(source, 'payload');
    assert.equal(await allocate(source, linked), true);
    // Same inode proves the data was never copied when the filesystem can link.
    assert.equal((await stat(linked)).ino, (await stat(source)).ino);

    const denied = Object.assign(new Error('hard links are unavailable'), { code: 'EPERM' });
    const copied = path.join(dir, 'copied.mp4');
    assert.equal(await allocate(source, copied, { linkImpl: async () => { throw denied; } }), true);
    assert.equal(await readFile(copied, 'utf8'), 'payload');
    assert.notEqual((await stat(copied)).ino, (await stat(source)).ino);

    const taken = path.join(dir, 'taken.mp4');
    await writeFile(taken, 'keep');
    assert.equal(await allocate(source, taken), false);
    assert.equal(await allocate(source, taken, { linkImpl: async () => { throw denied; } }), false);
    assert.equal(await readFile(taken, 'utf8'), 'keep');
    await assert.rejects(allocate(source, path.join(dir, 'x.mp4'), { linkImpl: async () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } }), /io/);
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
  // A blocked login must point at the opt-in credential flags.
  assert.match(readableError(new Error('Sign in to confirm you are not a bot')), /--cookies/);
});
test('cookie files are validated before any network work', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veo-cookie-'));
  try {
    const file = path.join(dir, 'cookies.txt');
    await writeFile(file, '# Netscape HTTP Cookie File\n');
    assert.equal(validateCookieFile(file), path.resolve(file));
    assert.equal(validateCookieFile(`  ${file}  `), path.resolve(file));
    assert.throws(() => validateCookieFile(path.join(dir, 'absent.txt')), /does not exist/);
    assert.throws(() => validateCookieFile(dir), /not a regular file/);
    for (const input of ['', '   ', 'cookies\0.txt']) assert.throws(() => validateCookieFile(input));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('browser cookie specs accept yt-dlp syntax and reject anything else', () => {
  for (const spec of ['chrome', 'Chrome', 'firefox:Profile 1', 'edge::container', 'chrome+gnomekeyring:Default', 'brave+basic']) {
    assert.equal(validateBrowserSpec(spec), spec);
  }
  for (const spec of ['', 'netscape', 'chrome:', 'chrome: ', 'chrome:a:b', 'chrome::', 'chrome+keyring+extra', 'chrome+unknown', 'chrome:--exec=rm']) {
    assert.throws(() => validateBrowserSpec(spec), `should reject ${JSON.stringify(spec)}`);
  }
  // Terminal escapes are stripped rather than forwarded to the backend.
  assert.equal(validateBrowserSpec('firefox:\u001b[31mWork'), 'firefox:Work');
});
test('a world-readable cookie file produces a warning, not a failure', () => {
  assert.equal(cookieFileWarning(undefined), null);
  assert.equal(cookieFileWarning('/tmp/cookies.txt', { platform: 'win32' }), null);
  assert.match(cookieFileWarning('/tmp/cookies.txt', { platform: 'linux', stat: () => ({ mode: 0o644 }) }), /readable by other users/);
  assert.equal(cookieFileWarning('/tmp/cookies.txt', { platform: 'linux', stat: () => ({ mode: 0o600 }) }), null);
  assert.equal(cookieFileWarning('/tmp/cookies.txt', { platform: 'linux', stat: () => { throw new Error('ENOENT'); } }), null);
});
test('the CLI forwards credential options without leaking the kebab-case key', () => {
  const parsed = parseCli([url, '--cookies-from-browser', 'firefox:Work']);
  assert.equal(parsed.cookiesFromBrowser, 'firefox:Work');
  assert.equal(Object.hasOwn(parsed, 'cookies-from-browser'), false);
  assert.throws(() => parseCli([url, '--cookies-from-browser', 'netscape']), /Unsupported browser/);
  assert.throws(() => parseCli([url, '--cookies', './absent-cookies.txt']), /does not exist/);
});
