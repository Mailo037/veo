import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { download, findFinishedMedia, formatSelector, isSidecar, isStagedMedia, listFormats, partialKey, planDownload, predictedExtension, previewPath, runBackend, selectQuality, stagedTitle, stagingTemplate } from '../src/downloader.js';

const URL = 'https://example.com/video';

function fakeBackend({ metadata = {}, calls } = {}) {
  const resolver = async () => ({ ytDlp: 'yt-dlp-fake', ffmpegLocation: path.join('C:', 'fake-tools') });
  const runner = async (executable, args, { onLine } = {}) => {
    calls.push(args);
    if (args.includes('--dump-single-json')) {
      return JSON.stringify({ id: 'abc', title: 'A Title', formats: [{ height: 1080, vcodec: 'h264' }, { height: 720, vcodec: 'h264' }], ...metadata });
    }
    const directory = path.dirname(args[args.indexOf('-o') + 1]);
    const file = path.join(directory, 'media.mp4');
    await writeFile(file, 'media-bytes');
    onLine?.(`veo-progress:${JSON.stringify({ downloaded_bytes: 512, total_bytes: 1024, speed: 256, eta: 2 })}`);
    onLine?.(`veo-file:${JSON.stringify(file)}`);
    return '';
  };
  return { backendResolver: resolver, runner, calls };
}

function recordingReporter() {
  const events = [];
  return {
    events,
    start: name => events.push(['start', name]),
    name: value => events.push(['name', value]),
    status: message => events.push(['status', message]),
    progress: data => events.push(['progress', data.downloaded_bytes]),
    complete: () => events.push(['complete']),
    fail: () => events.push(['fail']),
    finish: () => events.push(['finish']),
  };
}

test('format selectors express an exact height and fall back cleanly', () => {
  assert.equal(formatSelector(1080), 'bv[height=1080]+ba/b[height=1080]/bv[height=1080]');
  assert.equal(formatSelector(null), 'bv+ba/b/bv');
});

test('numeric quality is an upper bound by default and never exceeds the request', () => {
  const formats = [{ height: 360, vcodec: 'h264' }, { height: 720, vcodec: 'h264' }, { height: 2160, vcodec: 'h264' }];
  const capped = selectQuality({ quality: '1080p', formats });
  // 1080p is not offered, so the highest resolution at or below it wins.
  assert.equal(capped.format, 'bv[height=720]+ba/b[height=720]/bv[height=720]');
  assert.equal(capped.label, 'Quality: 720p (highest at or below 1080p)');
  assert.equal(capped.sort, null);
  assert.equal(selectQuality({ quality: '720p', formats }).label, 'Quality: 720p');
  assert.equal(selectQuality({ quality: 'best', formats }).format, null);
  assert.equal(selectQuality({ quality: '1080p', audio: true, formats }).format, null);
  // Audio-only and DRM entries never count as an offered resolution.
  assert.equal(selectQuality({ quality: '720p', formats: [{ height: 720, vcodec: 'none' }, { height: 720, has_drm: true }] }).format, null);
});

test('a request below every offered resolution fails with the offered list', () => {
  const formats = [{ height: 1080, vcodec: 'h264' }, { height: 2160, vcodec: 'h264' }];
  const capped = selectQuality({ quality: '360p', formats });
  assert.equal(capped.format, null);
  assert.equal(capped.label, null);
  assert.match(capped.error, /No stream at or below 360p/);
  assert.match(capped.error, /offered: 1080p, 2160p/);
  assert.match(capped.error, /--quality or "best"/);
});

test('sources without resolution metadata fall back to the best stream', () => {
  const unknown = selectQuality({ quality: '720p', formats: [] });
  assert.equal(unknown.format, null);
  assert.equal(unknown.error, undefined);
  assert.match(unknown.label, /Resolution unknown/);
  assert.equal(selectQuality({ quality: '720p' }).label, unknown.label);
  assert.equal(selectQuality({ quality: '720p', formats: [{ vcodec: 'h264' }] }).label, unknown.label);
});

test('--closest-quality keeps the nearest-resolution behaviour', () => {
  const formats = [{ height: 1440, vcodec: 'h264' }, { height: 720, vcodec: 'h264' }];
  const exact = selectQuality({ quality: '1080p', closest: true, formats });
  assert.equal(exact.format, 'bv[height=720]+ba/b[height=720]/bv[height=720]');
  assert.equal(exact.label, 'Quality: 720p (closest to 1080p)');
  assert.equal(selectQuality({ quality: '720p', closest: true, formats }).label, 'Quality: 720p');
  // Unlike the default, a closest match may pick a resolution above the request.
  const above = selectQuality({ quality: '1200p', closest: true, formats: [{ height: 1440, vcodec: 'h264' }] });
  assert.equal(above.format, 'bv[height=1440]+ba/b[height=1440]/bv[height=1440]');
});

test('a download resolves metadata, streams progress, and saves one file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-dl-'));
  const calls = [];
  const reporter = recordingReporter();
  try {
    const { backendResolver, runner } = fakeBackend({ calls });
    const result = await download({ url: URL, output: directory, quality: '720p' }, { backendResolver, runner, reporter });
    const saved = result.files[0];
    assert.equal(result.title, 'A Title');
    assert.deepEqual(result.files, [saved]);
    assert.equal(path.dirname(saved), directory);
    assert.equal(await readFile(saved, 'utf8'), 'media-bytes');
    assert.equal(path.basename(saved), 'A Title.mp4');
    // The private staging directory is removed and nothing else is left behind.
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('.veo-')), []);
    assert.ok(reporter.events.some(([kind, value]) => kind === 'progress' && value === 512));
    assert.ok(reporter.events.some(([kind, value]) => kind === 'status' && /Quality: 720p$/.test(value)));
    assert.equal(calls.length, 2);
    // Both passes carry the same vetted base arguments.
    for (const args of calls) {
      assert.ok(args.includes('--ignore-config'));
      assert.ok(args.includes('--no-playlist'));
      assert.ok(!args.includes('--cookies'));
    }
    assert.ok(calls[0].includes('--dump-single-json'));
    assert.ok(calls[1].includes('--no-overwrites'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('credential options reach both backend passes and are never shell-interpreted', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-dl-'));
  const calls = [];
  try {
    const { backendResolver, runner } = fakeBackend({ calls });
    const cookies = path.join(directory, 'cookies.txt');
    await writeFile(cookies, '# Netscape HTTP Cookie File\n');
    await download({ url: URL, output: directory, quality: 'best', cookies, cookiesFromBrowser: 'firefox:Work' }, { backendResolver, runner });
    assert.equal(calls.length, 2);
    for (const args of calls) {
      assert.equal(args[args.indexOf('--cookies') + 1], cookies);
      assert.equal(args[args.indexOf('--cookies-from-browser') + 1], 'firefox:Work');
      // The URL stays behind a separator so it can never be read as an option.
      assert.equal(args[args.length - 2], '--');
      assert.equal(args[args.length - 1], URL);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('collections, live streams, and DRM are refused before staging anything', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-dl-'));
  try {
    for (const [metadata, pattern] of [
      [{ _type: 'playlist', entries: [{}] }, /collection/],
      [{ is_live: true }, /Live streams/],
      [{ has_drm: true }, /DRM/],
    ]) {
      const { backendResolver, runner } = fakeBackend({ metadata, calls: [] });
      await assert.rejects(download({ url: URL, output: directory, quality: 'best' }, { backendResolver, runner }), pattern);
    }
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a backend that produces no file fails loudly and leaves no staging data', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-dl-'));
  try {
    const backendResolver = async () => ({ ytDlp: 'yt-dlp-fake', ffmpegLocation: 'tools' });
    const runner = async (executable, args) => (args.includes('--dump-single-json') ? JSON.stringify({ title: 'x', formats: [] }) : '');
    await assert.rejects(download({ url: URL, output: directory, quality: 'best' }, { backendResolver, runner }), /without producing a file/);
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('.veo-')), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cancellation after the backend finished still cleans up the staging directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-dl-'));
  try {
    const controller = new AbortController();
    const backendResolver = async () => ({ ytDlp: 'yt-dlp-fake', ffmpegLocation: 'tools' });
    const runner = async (executable, args, { onLine } = {}) => {
      if (args.includes('--dump-single-json')) return JSON.stringify({ title: 'x', formats: [] });
      const staging = path.dirname(args[args.indexOf('-o') + 1]);
      const file = path.join(staging, 'media.mp4');
      await writeFile(file, 'partial');
      onLine?.(`veo-file:${JSON.stringify(file)}`);
      controller.abort();
      return '';
    };
    await assert.rejects(download({ url: URL, output: directory, quality: 'best' }, { backendResolver, runner, signal: controller.signal }), error => error.name === 'AbortError');
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('.veo-')), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('runBackend caps captured metadata and reports a nonzero exit', async () => {
  const ok = await runBackend(process.execPath, ['-e', 'console.log("hello")']);
  assert.equal(ok, 'hello\n');
  await assert.rejects(runBackend(process.execPath, ['-e', 'console.error("boom"); process.exit(3)']), /boom/);
});

test('partial keys are stable, safe, and independent of site titles', () => {
  assert.equal(partialKey({ id: 'dQw4w9WgXcQ' }, 'https://x'), 'dQw4w9WgXcQ');
  assert.equal(partialKey({ id: '../../etc/passwd' }, 'https://x'), 'etc_passwd');
  assert.match(partialKey({}, 'https://example.com/v'), /^[a-f0-9]{16}$/);
  assert.equal(partialKey({}, 'https://example.com/v'), partialKey({}, 'https://example.com/v'));
  assert.notEqual(partialKey({}, 'https://example.com/a'), partialKey({}, 'https://example.com/b'));
  assert.ok(partialKey({ id: 'x'.repeat(200) }, 'https://x').length <= 64);
  assert.equal(partialKey({ id: '!!!' }, 'https://example.com/v').length, 16);
});

test('only a complete staged media file counts as a finished partial download', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-part-'));
  try {
    assert.equal(await findFinishedMedia(directory), undefined);
    await writeFile(path.join(directory, 'media.mp4.part'), 'half');
    await writeFile(path.join(directory, 'media.f137.mp4'), 'fragment');
    await writeFile(path.join(directory, 'media.mp4.ytdl'), 'meta');
    assert.equal(await findFinishedMedia(directory), undefined);
    await writeFile(path.join(directory, 'media.webm'), 'complete');
    assert.equal(await findFinishedMedia(directory), path.join(directory, 'media.webm'));
    assert.equal(await findFinishedMedia(path.join(directory, 'absent')), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('--resume reuses one staging directory, continues, and keeps it on failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-resume-'));
  const calls = [];
  try {
    // First attempt is interrupted mid-download.
    const abort = new AbortController();
    const first = fakeBackend({ calls });
    await assert.rejects(download(
      { url: URL, output: directory, quality: 'best', resume: true },
      {
        backendResolver: first.backendResolver,
        signal: abort.signal,
        runner: async (executable, args, { onLine } = {}) => {
          calls.push(args);
          if (args.includes('--dump-single-json')) return JSON.stringify({ id: 'vid123', title: 'A Title', formats: [] });
          const staging = path.dirname(args[args.indexOf('-o') + 1]);
          await writeFile(path.join(staging, 'media.mp4.part'), 'half');
          abort.abort();
          return '';
        },
      },
    ), error => error.name === 'AbortError');
    const kept = (await readdir(directory)).filter(name => name.startsWith('.veo-part-'));
    assert.deepEqual(kept, ['.veo-part-vid123']);
    // Resuming must ask the backend to continue, not to start over.
    assert.ok(calls[1].includes('--continue'));
    assert.ok(!calls[1].includes('--no-continue'));

    // Second attempt finds the finished file and saves it without a new download.
    const second = fakeBackend({ calls: [] });
    const reporter = recordingReporter();
    await writeFile(path.join(directory, '.veo-part-vid123', 'media.mp4.part'), 'half');
    const resumed = await download(
      { url: URL, output: directory, quality: 'best', resume: true },
      {
        backendResolver: second.backendResolver,
        reporter,
        runner: async (executable, args, { onLine } = {}) => {
          calls.push(args);
          if (args.includes('--dump-single-json')) return JSON.stringify({ id: 'vid123', title: 'A Title', formats: [] });
          const staging = path.dirname(args[args.indexOf('-o') + 1]);
          await writeFile(path.join(staging, 'media.mp4'), 'finished-bytes');
          onLine?.(`veo-file:${JSON.stringify(path.join(staging, 'media.mp4'))}`);
          return '';
        },
      },
    );
    assert.equal(await readFile(resumed.files[0], 'utf8'), 'finished-bytes');
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('.veo')), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a finished staged file is saved without asking the backend again', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-finish-'));
  const calls = [];
  try {
    await mkdir(path.join(directory, '.veo-part-vid123'));
    await writeFile(path.join(directory, '.veo-part-vid123', 'media.mkv'), 'already-complete');
    const backendResolver = async () => ({ ytDlp: 'yt-dlp-fake', ffmpegLocation: 'tools' });
    const result = await download(
      { url: URL, output: directory, quality: 'best', resume: true },
      {
        backendResolver,
        runner: async (executable, args) => {
          calls.push(args);
          if (args.includes('--dump-single-json')) return JSON.stringify({ id: 'vid123', title: 'A Title', formats: [] });
          assert.fail('the download pass must not run when a finished file exists');
        },
      },
    );
    assert.equal(await readFile(result.files[0], 'utf8'), 'already-complete');
    assert.equal(calls.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a symlinked staging path is refused instead of followed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-link-'));
  const target = await mkdtemp(path.join(os.tmpdir(), 'veo-target-'));
  try {
    await symlink(target, path.join(directory, '.veo-part-vid123'), 'dir').catch(() => undefined);
    const backendResolver = async () => ({ ytDlp: 'yt-dlp-fake', ffmpegLocation: 'tools' });
    const runner = async (executable, args) => (args.includes('--dump-single-json') ? JSON.stringify({ id: 'vid123', title: 't', formats: [] }) : '');
    await assert.rejects(
      download({ url: URL, output: directory, quality: 'best', resume: true }, { backendResolver, runner }),
      /not a plain directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('collections download every entry with its own title and sidecars', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-playlist-'));
  const calls = [];
  const metadata = {
    id: 'PL1',
    title: 'My Playlist',
    entries: [{ title: 'First Song' }, { title: 'Second Song' }],
  };
  try {
    const backendResolver = async () => ({ ytDlp: 'yt-dlp-fake', ffmpegLocation: 'tools' });
    const runner = async (executable, args, { onLine } = {}) => {
      calls.push(args);
      if (args.includes('--dump-single-json')) return JSON.stringify(metadata);
      const staging = path.dirname(args[args.indexOf('-o') + 1]);
      for (const index of [1, 2]) {
        await writeFile(path.join(staging, `media-00${index}.mp4`), `entry-${index}`);
        await writeFile(path.join(staging, `media-00${index}.en.vtt`), `subs-${index}`);
        onLine?.(`veo-file:${JSON.stringify(path.join(staging, `media-00${index}.mp4`))}`);
      }
      return '';
    };
    const result = await download({ url: URL, output: directory, quality: 'best', playlist: true, subs: true }, { backendResolver, runner });
    assert.equal(result.title, 'My Playlist');
    assert.deepEqual(result.files.map(file => path.basename(file)), ['First Song.mp4', 'First Song.en.vtt', 'Second Song.mp4', 'Second Song.en.vtt']);
    assert.equal(await readFile(result.files[0], 'utf8'), 'entry-1');
    assert.equal(await readFile(result.files[1], 'utf8'), 'subs-1');
    assert.equal(await readFile(result.files[3], 'utf8'), 'subs-2');
    // Collections stage by index and never use --no-playlist.
    assert.ok(calls[0].includes('--flat-playlist'));
    assert.ok(!calls[1].includes('--no-playlist'));
    assert.match(calls[1][calls[1].indexOf('-o') + 1], /media-%\(playlist_index\)03d\.%\(ext\)s$/);
    assert.ok(calls[1].includes('--write-subs'));
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('.veo')), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a collection URL without --playlist is refused with the flag to use', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-noplaylist-'));
  try {
    const backendResolver = async () => ({ ytDlp: 'yt-dlp-fake', ffmpegLocation: 'tools' });
    const runner = async (executable, args) => (args.includes('--dump-single-json') ? JSON.stringify({ _type: 'playlist', entries: [{}] }) : '');
    await assert.rejects(download({ url: URL, output: directory, quality: 'best' }, { backendResolver, runner }), /Add --playlist/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('metadata flags reach the backend in the documented form', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-flags-'));
  const calls = [];
  try {
    const { backendResolver, runner } = fakeBackend({ calls });
    await download({
      url: URL, output: directory, quality: 'best',
      subs: true, subLangs: 'de,en', embedSubs: true, embedMetadata: true, embedThumbnail: true,
      sponsorblockRemove: 'sponsor,selfpromo', section: '*10:00-12:00', concurrentFragments: 4,
    }, { backendResolver, runner });
    const args = calls[1];
    assert.equal(args[args.indexOf('--sub-langs') + 1], 'de,en');
    assert.ok(args.includes('--write-subs'));
    assert.ok(args.includes('--embed-subs'));
    assert.ok(args.includes('--embed-metadata'));
    assert.ok(args.includes('--embed-thumbnail'));
    assert.equal(args[args.indexOf('--sponsorblock-remove') + 1], 'sponsor,selfpromo');
    assert.equal(args[args.indexOf('--download-sections') + 1], '*10:00-12:00');
    assert.ok(args.includes('--force-keyframes-at-cuts'));
    assert.equal(args[args.indexOf('--concurrent-fragments') + 1], '4');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only media extensions count as the downloaded file', () => {
  for (const name of ['media.mp4', 'media-003.mkv', 'media.webm', 'media.flac']) assert.equal(isStagedMedia(name), true, name);
  for (const name of ['media.jpg', 'media.en.vtt', 'media.mp4.part', 'media.mp4.ytdl', 'media.f137.mp4', 'other.mp4', '.media.mp4']) {
    assert.equal(isStagedMedia(name), false, name);
    // Merge fragments and partial files must never be treated as deliverables.
    assert.equal(isSidecar(name), name === 'media.jpg' || name === 'media.en.vtt', name);
  }
  for (const name of ['media.srt', 'media-003.ass', 'media.png', 'media.en.json']) assert.equal(isSidecar(name), true, name);
  assert.equal(stagedTitle('C:/tmp/media-002.mp4', { title: 'List', entries: [{ title: 'One' }, { title: 'Two' }] }), 'Two');
  assert.equal(stagedTitle('C:/tmp/media-005.mp4', { title: 'List', entries: [] }), 'List - 005');
  assert.equal(stagedTitle('C:/tmp/media.mp4', { title: 'Solo' }), 'Solo');
  assert.equal(stagedTitle('C:/tmp/media.mp4', { title: 'Solo' }, 'My Name'), 'My Name');
  assert.equal(stagedTitle('C:/tmp/media-004.mp4', { title: 'List', entries: [{ title: 'One' }] }, 'My Name'), 'My Name - 004');
  assert.match(stagingTemplate('C:/tmp/x', false), /media\.%\(ext\)s$/);
});

test('--dry-run plans each entry without writing anything', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-plan-'));
  const calls = [];
  try {
    const backendResolver = async () => ({ ytDlp: 'yt-dlp-fake', ffmpegLocation: 'tools' });
    const runner = async (executable, args) => {
      calls.push(args);
      return JSON.stringify({ id: 'abc', title: 'A/B: Video?', formats: [{ height: 720, vcodec: 'h264' }, { height: 1080, vcodec: 'h264' }] });
    };
    const plan = await planDownload({ url: URL, output: directory, quality: '720p' }, { backendResolver, runner });
    assert.equal(plan.quality, 'Quality: 720p');
    assert.equal(plan.entries.length, 1);
    assert.equal(path.basename(plan.entries[0].path), 'A_B_ Video_.mp4');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('--skip-download'));
    assert.deepEqual(await readdir(directory), []);

    // An existing file is reported with the suffix the real save would use.
    await writeFile(plan.entries[0].path, 'taken');
    const second = await planDownload({ url: URL, output: directory, quality: '720p' }, { backendResolver, runner });
    assert.equal(path.basename(second.entries[0].path), 'A_B_ Video_ (1).mp4');

    // A request below everything offered is refused before any download.
    await assert.rejects(planDownload({ url: URL, output: directory, quality: '360p' }, { backendResolver, runner }), /No stream at or below 360p/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('--list-formats returns the backend table and predicted extensions stay honest', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-formats-'));
  const calls = [];
  try {
    const backendResolver = async () => ({ ytDlp: 'yt-dlp-fake', ffmpegLocation: 'tools' });
    const runner = async (executable, args) => { calls.push(args); return 'ID  EXT  RESOLUTION\n137 mp4  1920x1080\n'; };
    const table = await listFormats({ url: URL, quality: 'best' }, { backendResolver, runner });
    assert.match(table, /1920x1080/);
    assert.ok(calls[0].includes('-F'));
    assert.equal(predictedExtension({ audio: false }), 'mp4');
    assert.equal(predictedExtension({ audio: true }), 'mp3');
    assert.equal(predictedExtension({ audio: true, format: 'flac' }), 'flac');
    assert.equal(predictedExtension({ audio: false, format: 'webm' }), 'webm');
    assert.equal(await previewPath(directory, 'Title', 'mp4', { exists: candidate => candidate.endsWith('Title.mp4') }), path.join(directory, 'Title (1).mp4'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
