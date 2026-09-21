import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runPool, adaptiveRun, reducedLimit, phaseTimer } from '../src/execution.js';
import { reserveSpace, estimateMediaBytes } from '../src/disk-space.js';
import { mediaDestination, validateTemplate, prepareDestination } from '../src/naming.js';
import { effectiveConfig } from '../src/config.js';
import { parseCli } from '../src/cli.js';
import { createReporter, styleText } from '../src/progress.js';
import { download, planDownload } from '../src/downloader.js';
import { runJob, retryOptions } from '../src/jobs.js';

const url = 'https://example.test/video';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sink = () => ({ text: '', write(value) { this.text += value; } });
const reporter = { status() {}, progress() {}, finish() {}, complete() {}, fail() {} };
const backendResolver = async () => ({ ytDlp: 'fake', ffmpegLocation: 'fake' });

test('URL pool reduces future concurrency and drains active work after cancellation', async () => {
  const state = { divisor: 1 }, controller = new AbortController();
  let active = 0, peak = 0;
  const started = [];
  await assert.rejects(runPool([0, 1, 2, 3, 4], () => reducedLimit(3, state), async index => {
    active++; peak = Math.max(peak, active); started.push(index);
    try {
      if (index === 0) { await sleep(1); state.divisor = 2; await sleep(20); controller.abort(); }
      else await sleep(30);
    } finally { active--; }
  }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.deepEqual(started, [0, 1, 2]);
});

test('adaptive retries are bounded, cancellable and do not retry permanent failures', async () => {
  let attempts = 0;
  const state = { divisor: 1 }, waits = [];
  assert.equal(await adaptiveRun(async () => { if (++attempts < 3) throw new Error('HTTP Error 429'); return 'done'; }, {
    state, wait: async ms => waits.push(ms),
  }), 'done');
  assert.equal(state.divisor, 4);
  assert.deepEqual(waits, [2000, 4000]);
  attempts = 0;
  await assert.rejects(adaptiveRun(() => { attempts++; throw new Error('HTTP 503'); }, { wait: async () => {} }), /503/);
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(adaptiveRun(() => { attempts++; throw new Error('HTTP 404'); }), /404/);
  assert.equal(attempts, 1);
  const controller = new AbortController();
  await assert.rejects(adaptiveRun(() => { throw new Error('ETIMEDOUT'); }, {
    signal: controller.signal, wait: async () => { controller.abort(); controller.signal.throwIfAborted(); },
  }), { name: 'AbortError' });
});

test('space reservations combine same-volume cache/output and account for parallel work', async () => {
  const inspect = async () => ({ key: 'test-volume', free: 1000 });
  const release = await reserveSpace({ cache: 'cache', destination: 'output', bytes: 200, inspect });
  try {
    await assert.rejects(reserveSpace({ cache: 'cache', destination: 'output', bytes: 200, inspect }), /Not enough disk space/);
  } finally { release(); release(); }
  const releaseAgain = await reserveSpace({ cache: 'cache', destination: 'output', bytes: 300, inspect });
  releaseAgain();
  const cached = await reserveSpace({ cache: 'cache', destination: 'output', bytes: 900, cached: true, inspect });
  cached();
  const separate = async target => ({ key: target, free: target === 'cache' ? 700 : 200 });
  await assert.rejects(reserveSpace({ cache: 'cache', destination: 'output', bytes: 300, inspect: separate }), /Not enough disk space/);
  const messages = [];
  (await reserveSpace({ cache: 'cache', destination: 'output', bytes: null, inspect, reporter: { status: message => messages.push(message) } }))();
  assert.match(messages[0], /Size unknown/);
  assert.equal(estimateMediaBytes({ formats: [{ height: 720, vcodec: 'h264', acodec: 'none', filesize: 100 }, { vcodec: 'none', acodec: 'aac', filesize: 20 }] }), 120);
  assert.equal(estimateMediaBytes({ formats: [{ vcodec: 'h264', acodec: 'none', filesize: 100 }] }), null);
});

test('templates sanitize metadata, reject traversal, and refuse junction subfolders', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-template-path-'));
  try {
    for (const value of ['../outside', '/absolute', 'C:/absolute', '{bad}', '{title', 'x//y', 'x/../y']) assert.throws(() => validateTemplate(value, { folders: true }));
    const result = mediaDestination({ output: directory, folderTemplate: '{channel}/{year}', filenameTemplate: '{index} - {title}', _entryIndex: 9 }, { channel: '../escape', title: '../../bad', upload_date: '20240101' }, 'fallback');
    assert.ok(!path.relative(directory, result.directory).startsWith('..' + path.sep));
    assert.ok(!result.title.includes('/'));
    assert.ok(result.title.startsWith('009 - '));
    await symlink(directory, path.join(directory, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareDestination(directory, path.join(directory, 'redirect', 'child'), { create: true }), /plain directory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('named output matches dry-run, keeps sidecars, and resumes from nested history', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-named-save-'));
  const metadata = { id: 'id', title: 'Title', channel: 'Channel', upload_date: '20260920', formats: [] };
  let downloads = 0;
  const runner = async (_, args, { onLine } = {}) => {
    if (args.includes('--dump-single-json')) return JSON.stringify(metadata);
    downloads++;
    const stage = path.dirname(args[args.indexOf('-o') + 1]);
    await writeFile(path.join(stage, 'media.mp4'), 'original');
    await writeFile(path.join(stage, 'media.en.vtt'), 'subtitle');
    onLine(`veo-file:${JSON.stringify(path.join(stage, 'media.mp4'))}`);
  };
  const options = { url, output: directory, folderTemplate: '{channel}/{year}', filenameTemplate: '{title} - {id}', skipExisting: true };
  try {
    const plan = await planDownload(options, { runner, backendResolver });
    assert.deepEqual(await readdir(directory), []);
    const result = await download(options, { runner, backendResolver, localRoot: path.join(directory, 'cache') });
    assert.equal(result.files[0], plan.entries[0].path);
    assert.equal(await readFile(result.files[1], 'utf8'), 'subtitle');
    assert.equal(result.timings.saving >= 0, true);
    const skipped = await download(options, { runner, backendResolver, localRoot: path.join(directory, 'cache') });
    assert.equal(skipped.status, 'skipped');
    assert.equal(downloads, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('download retry lowers fragments, resumes data and preserves format selection', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-adaptive-'));
  const calls = [];
  const runner = async (_, args, { onLine } = {}) => {
    if (args.includes('--dump-single-json')) return JSON.stringify({ id: 'x', title: 'X', formats: [{ height: 720, vcodec: 'h264' }] });
    calls.push(args);
    if (calls.length === 1) throw new Error('HTTP Error 429');
    const file = path.join(path.dirname(args[args.indexOf('-o') + 1]), 'media.mp4');
    onLine('veo-postprocess:{"postprocessor":"Merger","status":"started"}');
    await writeFile(file, 'same quality');
    onLine(`veo-file:${JSON.stringify(file)}`);
  };
  try {
    const result = await download({ url, output: directory, quality: '720p' }, { runner, backendResolver, localRoot: directory, wait: async () => {} });
    assert.deepEqual(calls.map(args => args[args.indexOf('--concurrent-fragments') + 1]), ['8', '4']);
    assert.equal(calls[0][calls[0].indexOf('-f') + 1], calls[1][calls[1].indexOf('-f') + 1]);
    assert.ok(calls[1].includes('--continue'));
    assert.ok(result.timings.processing >= 0);
    assert.ok(result.timings.retryWait >= 0);
    assert.equal(await readFile(result.files[0], 'utf8'), 'same quality');
    await assert.rejects(download({ url, output: directory }, { runner, backendResolver, localRoot: directory, diskChecker: async () => { throw new Error('Not enough disk space'); } }), /Not enough disk space/);
    assert.equal(calls.length, 2, 'low space must stop before downloading media');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('parallel URL jobs serialize duplicates and retain per-item statistics and retries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-url-pool-'));
  let active = 0, peak = 0;
  const activeUrls = new Set(), records = [];
  const stdout = sink(), stderr = sink();
  const urls = [url, `${url}/audio`, url, `${url}/fail`];
  const jobFile = path.join(directory, 'job.json');
  try {
    const code = await runJob({ urls, output: directory, concurrentDownloads: 2, json: true }, {
      jobFile, reporter, stdout, stderr, recordStats: async record => records.push(record),
      items: urls.map((url, index) => ({ url, output: directory, audio: index === 1 })),
      download: async options => {
        assert.ok(!activeUrls.has(options.url), 'duplicates cannot share an active staging directory');
        activeUrls.add(options.url); active++; peak = Math.max(active, peak);
        try { await sleep(20); if (options.url.endsWith('/fail')) throw new Error('failed'); return { files: [options.url], status: 'saved', saved: 1 }; }
        finally { active--; activeUrls.delete(options.url); }
      },
    });
    assert.equal(code, 1); assert.equal(peak, 2); assert.equal(active, 0);
    assert.equal(records.reduce((sum, item) => sum + item.videos, 0), 2);
    assert.equal(records.reduce((sum, item) => sum + item.audio, 0), 1);
    assert.equal(records.reduce((sum, item) => sum + item.failed, 0), 1);
    assert.equal(stdout.text.trim().split('\n').map(line => JSON.parse(line)).length, 4);
    assert.equal((await retryOptions(jobFile)).length, 1);
    assert.deepEqual(JSON.parse(await readFile(jobFile, 'utf8')).items.map(item => item.status), ['saved', 'saved', 'saved', 'failed']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('effective config resolves profiles, validates conflicts and redacts credentials', async () => {
  const result = await effectiveConfig({ concurrentDownloads: 3, cookies: 'private-path', profiles: { default: { concurrentDownloads: 1 }, fast: { timings: false } } }, 'fast');
  assert.equal(result.concurrentDownloads, 3); assert.equal(result.timings, false);
  assert.equal(result.cookies, '[configured]'); assert.equal(result.concurrentFragments, 8);
  await assert.rejects(effectiveConfig({ profiles: { bad: { concurrentDownloads: 9 } } }, 'bad'), /between 1 and 4/);
  await assert.rejects(effectiveConfig({ rename: 'fixed', filenameTemplate: '{title}' }), /cannot be combined/);
  const flags = parseCli([url, '--no-check-space', '--no-adaptive-concurrency', '--no-color', '--no-timings']);
  for (const key of ['checkSpace', 'adaptiveConcurrency', 'color', 'timings']) assert.equal(flags[key], false);
});

test('gray details are limited to terminals and respect explicit color disabling', () => {
  assert.equal(styleText({ isTTY: true }, 'detail', 'muted', true, {}), '\x1b[90mdetail\x1b[0m');
  assert.equal(styleText({ isTTY: false }, 'detail', 'muted', true, {}), 'detail');
  assert.equal(styleText({ isTTY: true }, 'detail', 'muted', true, { NO_COLOR: '' }), 'detail');
  const output = { ...sink(), isTTY: true };
  const instance = createReporter(output, { setTitle() {} });
  instance.configure({ color: false }); instance.status('Reading metadata');
  assert.equal(output.text, 'Reading metadata\n');
  const nested = instance.scoped(1, 2, 'URL').scoped(2, 3, 'Video');
  nested.status('Reading');
  assert.match(output.text, /\[1\/2\] \[2\/3\] Video: Reading/);
});

test('phase timings measure disjoint intervals', () => {
  let time = 0; const timer = phaseTimer(() => time);
  time = 10; timer.switch('metadata'); time = 30; timer.switch('download'); time = 80; timer.switch('processing'); time = 100;
  assert.deepEqual(timer.result(), { setup: 10, metadata: 20, download: 50, processing: 20 });
});
