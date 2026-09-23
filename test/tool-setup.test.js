import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveBackend, resolveMediaTools } from '../src/backend.js';
import { createReporter } from '../src/progress.js';
import { runSetup, installTermuxTools, installMediaTools, mediaPackagePlan } from '../src/tool-setup.js';

const status = () => {};

test('fresh Termux setup installs once, rechecks tools and skips installation on later runs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-termux-test-'));
  let installed = false;
  let installs = 0;
  const probes = [];
  try {
    const find = async names => installed ? path.join(directory, names[0]) : undefined;
    const options = { platform: 'android', find, hasEjs: async () => installed,
      setupTermux: async () => {
        installs++;
        for (const tool of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
          const file = path.join(directory, tool);
          await writeFile(file, 'fixture');
          await chmod(file, 0o755);
        }
        installed = true;
      },
      run: async (command, args) => { probes.push([path.basename(command), args]); },
    };
    assert.equal((await resolveBackend(options)).ffmpegLocation, directory);
    assert.deepEqual(probes, [['yt-dlp', ['--version']], ['ffmpeg', ['-version']], ['ffprobe', ['-version']]]);
    await resolveBackend(options);
    assert.equal(installs, 1);
    installed = false;
    await assert.rejects(resolveBackend({ ...options, offline: true }), /without --offline/);
    assert.equal(installs, 1);
    await assert.rejects(resolveBackend({ ...options, setupTermux: async () => {} }), /still missing/);
    await assert.rejects(resolveBackend({ ...options, setupTermux: async () => { throw new Error('repository unavailable'); } }), /repository unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Termux pkg uses fixed noninteractive arguments and concurrent callers share installation', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const options = { find: async () => '/termux/bin/pkg', status, env: {},
    run: async (...args) => { calls.push(args); await gate; },
  };
  const first = installTermuxTools(options);
  const second = installTermuxTools(options);
  release();
  await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['/termux/bin/pkg', ['install', '-y', 'python-yt-dlp', 'yt-dlp-ejs', 'ffmpeg']]);
  assert.equal(calls[0][2].env.DEBIAN_FRONTEND, 'noninteractive');
  await installTermuxTools({ ...options, env: { TERMUX_APP_PACKAGE_MANAGER: 'pacman' } });
  assert.equal(calls[1][1][1], '--noconfirm');
  await assert.rejects(installTermuxTools({ ...options, run: async () => { throw new Error('repository unavailable'); } }), /Automatic Termux setup failed/);
  await installTermuxTools(options); // failed attempts must not poison retries
});

test('desktop missing-media fallback obeys offline, cache and system-tool precedence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-media-test-'));
  let installs = 0;
  const options = { directory, managed: async () => 'no bundled tools', find: async () => undefined,
    install: async () => { installs++; return directory; },
  };
  try {
    await assert.rejects(resolveMediaTools({ ...options, offline: true }), /without --offline/);
    assert.equal(installs, 0);
    assert.equal(await resolveMediaTools(options), directory);
    assert.equal(installs, 1);
    await resolveMediaTools({ ...options, find: async names => path.join(directory, names[0]) });
    assert.equal(installs, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('media-tool preparation is reported before checking bundled tools', async () => {
  const events = [];
  await resolveMediaTools({ directory: '.', status: message => events.push(message),
    managed: async () => { events.push('managed'); return null; } });
  assert.deepEqual(events, ['Preparing ffmpeg and ffprobe…', 'managed']);
});

test('ffmpeg preparation animates and finishes with a colored result', async () => {
  for (const outcome of ['done', 'failed']) {
    const output = { isTTY: true, columns: 80, text: '', write(value) { this.text += value; } };
    const reporter = createReporter(output, { setTitle() {}, env: {} });
    const options = { directory: '.', status: message => reporter.status(message),
      statusDone: (message, result) => reporter.finishStatus(message, result),
      managed: async () => { if (outcome === 'failed') throw new Error('media tools unavailable'); return null; } };
    if (outcome === 'failed') await assert.rejects(resolveMediaTools(options), /media tools unavailable/);
    else await resolveMediaTools(options);
    assert.match(output.text, /Preparing ffmpeg and ffprobe\./);
    assert.ok(output.text.endsWith(`Preparing ffmpeg and ffprobe: \x1b[0m\x1b[${outcome === 'done' ? 32 : 31}m${outcome}\x1b[0m\n`));
  }
});

test('desktop installer stages only probed binaries and cleans temporary npm files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-media-install-'));
  const calls = [];
  const staged = [];
  const options = { directory, platform: 'linux', arch: 'arm64', status, env: {},
    locateNpm: async () => '/node/npm-cli.js', stage: async (source, destination) => staged.push([source, destination]),
    run: async (command, args) => {
      calls.push([command, args]);
      if (args[1] !== 'install') return;
      const root = args[args.indexOf('--prefix') + 1];
      for (const file of ['ffmpeg-static/ffmpeg', '@ffprobe-installer/linux-arm64/ffprobe']) {
        const target = path.join(root, 'node_modules', file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, 'fixture');
      }
    },
  };
  try {
    await installMediaTools(options);
    assert.ok(calls[0][1].includes('--ignore-scripts'));
    assert.ok(calls[0][1].includes('@ffprobe-installer/linux-arm64@5.2.0'));
    assert.equal(calls.length, 4); // npm, pinned installer, two binary probes
    assert.equal(staged.length, 2);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(installMediaTools({ ...options, run: async () => { throw new Error('network down'); } }), /network down/);
    assert.deepEqual(await readdir(directory), []);
    assert.equal(mediaPackagePlan('win32', 'arm64').binaryArch, 'x64');
    assert.equal(mediaPackagePlan('android', 'arm64'), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('installer runner handles success, failure, timeout and cancellation', async () => {
  assert.match(await runSetup(process.execPath, ['-e', 'console.log("setup ready")']), /setup ready/);
  await assert.rejects(runSetup(process.execPath, ['-e', 'process.exit(7)']), /code 7/);
  await assert.rejects(runSetup(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /timed out/);
  const controller = new AbortController();
  const pending = runSetup(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort(new Error('setup cancelled'));
  await assert.rejects(pending, /setup cancelled/);
});
