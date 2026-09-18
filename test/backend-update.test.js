import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  RELEASE, activeOverride, backendCacheDirectory, backendStateFile,
  clearBackendOverride, readBackendOverride, writeBackendOverride, installBackend, releaseUrl,
} from '../src/backend.js';
import { BACKEND_HELP, backendUpdateMain, checkBackend, fetchLatestBackendRelease, parseChecksums, fetchReleaseChecksum } from '../src/backend-update.js';
import { compareVersions } from '../src/version.js';

function io() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: text => { stdout += text; } },
    stderr: { write: text => { stderr += text; } },
    get out() { return stdout; },
    get err() { return stderr; },
  };
}

function response(body, { ok = true, status = 200, json = false } = {}) {
  return {
    ok,
    status,
    body: { cancel: async () => {} },
    json: async () => body,
    text: async () => body,
    headers: new Map(),
  };
}

test('the newest release tag is validated before it is trusted', async () => {
  assert.equal(await fetchLatestBackendRelease({ fetchImpl: async () => response({ tag_name: '2026.09.01' }, { json: true }) }), '2026.09.01');
  assert.equal(await fetchLatestBackendRelease({ fetchImpl: async () => response({ tag_name: '2026.09.01.123456' }, { json: true }) }), '2026.09.01.123456');
  await assert.rejects(fetchLatestBackendRelease({ fetchImpl: async () => response({ tag_name: 'latest' }, { json: true }) }), /unexpected version/);
  await assert.rejects(fetchLatestBackendRelease({ fetchImpl: async () => response('', { ok: false, status: 503 }) }), /HTTP 503/);
});

test('checksum lists are parsed in the official format only', () => {
  const hashes = parseChecksums([
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  yt-dlp.exe',
    'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB *./yt-dlp_linux',
    'not a checksum line',
    '',
  ].join('\n'));
  assert.equal(hashes.get('yt-dlp.exe'), 'a'.repeat(64));
  assert.equal(hashes.get('yt-dlp_linux'), 'b'.repeat(64));
  assert.throws(() => parseChecksums('garbage'), /could not be parsed/);
});

test('a checksum for the wrong asset or a failing host is a hard error', async () => {
  const sums = `${'c'.repeat(64)}  yt-dlp.exe\n`;
  assert.equal(await fetchReleaseChecksum({ release: '2026.09.01', asset: 'yt-dlp.exe', fetchImpl: async () => response(sums) }), 'c'.repeat(64));
  await assert.rejects(fetchReleaseChecksum({ release: '2026.09.01', asset: 'yt-dlp_macos', fetchImpl: async () => response(sums) }), /does not publish a checksum/);
  await assert.rejects(fetchReleaseChecksum({ release: '2026.09.01', asset: 'yt-dlp.exe', fetchImpl: async () => response('', { ok: false, status: 404 }) }), /HTTP 404/);
  await assert.rejects(fetchReleaseChecksum({ release: 'not-a-release', asset: 'yt-dlp.exe' }), /Invalid yt-dlp release/);
});

test('the override state file is read, written, and ignored when malformed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-state-'));
  const stateFile = path.join(directory, 'nested', 'backend-override.json');
  try {
    assert.equal(await readBackendOverride(stateFile), null);
    assert.equal(await clearBackendOverride(stateFile), false);
    await writeBackendOverride({ release: '2026.09.01', asset: 'yt-dlp.exe', sha256: 'd'.repeat(64) }, stateFile);
    assert.equal((await readBackendOverride(stateFile)).release, '2026.09.01');
    assert.match(await readFile(stateFile, 'utf8'), /2026\.09\.01/);
    assert.equal(await clearBackendOverride(stateFile), true);
    assert.equal(await clearBackendOverride(stateFile), false);
    await writeBackendOverride({ release: '2026.09.01', asset: 'yt-dlp.exe', sha256: 'd'.repeat(64) }, stateFile);
    await writeFile(stateFile, '{ not json');
    assert.equal(await readBackendOverride(stateFile), null);
    await writeFile(stateFile, '"a string"');
    assert.equal(await readBackendOverride(stateFile), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only a newer, correctly hashed install is treated as active', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-active-'));
  const stateFile = path.join(directory, 'state.json');
  const asset = 'yt-dlp.exe';
  const write = state => writeFile(stateFile, JSON.stringify(state));
  try {
    // Older than the pinned release: the pinned backend must stay in charge.
    await write({ release: '2020.01.01', asset, sha256: 'e'.repeat(64) });
    assert.equal(await activeOverride(asset, { stateFile, matchesImpl: async () => true }), null);
    // Newer, but the recorded bytes no longer match: refuse it.
    await write({ release: '2099.01.01', asset, sha256: 'e'.repeat(64) });
    assert.equal(await activeOverride(asset, { stateFile, matchesImpl: async () => false }), null);
    // Wrong platform asset: refuse it.
    await write({ release: '2099.01.01', asset: 'yt-dlp_macos', sha256: 'e'.repeat(64) });
    assert.equal(await activeOverride(asset, { stateFile, matchesImpl: async () => true }), null);
    // Malformed hash: refuse it.
    await write({ release: '2099.01.01', asset, sha256: 'nope' });
    assert.equal(await activeOverride(asset, { stateFile, matchesImpl: async () => true }), null);
    // A newer, verified install wins and points into the versioned cache.
    await write({ release: '2099.01.01', asset, sha256: 'e'.repeat(64) });
    const active = await activeOverride(asset, { stateFile, matchesImpl: async () => true });
    assert.equal(active.release, '2099.01.01');
    assert.equal(active.path, path.join(backendCacheDirectory('2099.01.01'), 'yt-dlp.exe'));
    assert.equal(await activeOverride(undefined, { stateFile, matchesImpl: async () => true }), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('installation refuses a malformed request before touching the network', async () => {
  await assert.rejects(installBackend({ release: 'head', asset: 'yt-dlp.exe', sha256: 'f'.repeat(64) }), /Invalid yt-dlp release/);
  await assert.rejects(installBackend({ release: '2099.01.01', asset: undefined, sha256: 'f'.repeat(64) }), /No standalone yt-dlp/);
  await assert.rejects(installBackend({ release: '2099.01.01', asset: 'yt-dlp.exe', sha256: 'short' }), /checksum is missing/);
});

test('an up-to-date backend is reported without installing anything', async () => {
  const streams = io();
  let installed = null;
  const code = await backendUpdateMain(['update'], {
    stdout: streams.stdout,
    stderr: streams.stderr,
    env: {},
    check: async () => ({ asset: 'yt-dlp.exe', current: RELEASE, latest: RELEASE }),
    install: async () => { installed = 'called'; },
    stateFile: 'unused',
  });
  assert.equal(code, 0);
  assert.equal(installed, null);
  assert.match(streams.out, /is up to date \(pinned release/);
  assert.equal(streams.err, '');
});

test('--check only reports, and a newer release is installed with its published checksum', async () => {
  const streams = io();
  const calls = [];
  const deps = {
    stdout: streams.stdout,
    stderr: streams.stderr,
    env: {},
    stateFile: path.join(await mkdtemp(path.join(os.tmpdir(), 'veo-bu-')), 'state.json'),
    check: async () => ({ asset: 'yt-dlp.exe', current: RELEASE, latest: '2099.01.01' }),
    fetchImpl: async url => {
      calls.push(url);
      return response(`${'1'.repeat(64)}  yt-dlp.exe\n`);
    },
    install: async options => { calls.push(options); },
  };
  try {
    assert.equal(await backendUpdateMain(['update', '--check'], deps), 0);
    assert.match(streams.out, /Newer yt-dlp release available: 2099\.01\.01/);
    assert.equal(calls.length, 0);
  } finally { await rm(path.dirname(deps.stateFile), { recursive: true, force: true }); }

  const second = io();
  const installs = [];
  const stateFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'veo-bu-')), 'state.json');
  try {
    const code = await backendUpdateMain(['update'], {
      ...deps,
      stdout: second.stdout,
      stderr: second.stderr,
      stateFile,
      calls,
      install: async options => { installs.push(options); },
    });
    assert.equal(code, 0);
    assert.equal(installs.length, 1);
    assert.equal(installs[0].release, '2099.01.01');
    assert.equal(installs[0].sha256, '1'.repeat(64));
    assert.match(second.out, /installed and will be used/);
    // The weaker trust anchor must be stated, never hidden.
    assert.match(second.err, /not against a hash shipped with veo/);
    assert.equal((await readBackendOverride(stateFile)).release, '2099.01.01');
  } finally { await rm(path.dirname(stateFile), { recursive: true, force: true }); }
});

test('a failing checksum download never installs and keeps the pinned release', async () => {
  const streams = io();
  const stateFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'veo-bu-')), 'state.json');
  try {
    const code = await backendUpdateMain(['update'], {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: {},
      stateFile,
      check: async () => ({ asset: 'yt-dlp.exe', current: RELEASE, latest: '2099.01.01' }),
      fetchImpl: async () => response('', { ok: false, status: 500 }),
      install: async () => assert.fail('must not install without a verified checksum'),
    });
    assert.equal(code, 1);
    assert.match(streams.err, /HTTP 500/);
    assert.match(streams.err, /still in use/);
    assert.equal(await readBackendOverride(stateFile), null);
  } finally { await rm(path.dirname(stateFile), { recursive: true, force: true }); }
});

test('reset removes the pointer and the downloaded release', async () => {
  const streams = io();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-reset-'));
  const stateFile = path.join(directory, 'state.json');
  const releaseDirectory = path.join(directory, 'backends', '2099.01.01', 'win32-x64');
  try {
    await mkdir(releaseDirectory, { recursive: true });
    await writeFile(path.join(releaseDirectory, 'yt-dlp.exe'), 'binary');
    await writeBackendOverride({ release: '2099.01.01', asset: 'yt-dlp.exe', sha256: 'a'.repeat(64) }, stateFile);
    const code = await backendUpdateMain(['reset'], {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: {},
      stateFile,
      removeFiles: target => rm(target, { recursive: true, force: true }),
    });
    assert.equal(code, 0);
    assert.match(streams.out, new RegExp(`Removed yt-dlp 2099\\.01\\.01\\. veo uses the pinned release ${RELEASE.replace(/\./g, '\\.')}`));
    assert.equal(await readBackendOverride(stateFile), null);
    // Only a redirected removeFiles target is touched, so the real cache is safe.
    assert.equal(await readBackendOverride(stateFile), null);
  } finally { await rm(directory, { recursive: true, force: true }); }

  const empty = io();
  assert.equal(await backendUpdateMain(['reset'], { stdout: empty.stdout, stderr: empty.stderr, env: {}, stateFile: path.join(directory, 'absent.json') }), 0);
  assert.match(empty.out, /No installed backend to remove/);
});

test('backend arguments, help, and the environment warning', async () => {
  const streams = io();
  assert.equal(await backendUpdateMain([], { stdout: streams.stdout, stderr: streams.stderr }), 0);
  assert.equal(streams.out, BACKEND_HELP);
  const help = io();
  assert.equal(await backendUpdateMain(['update', '--help'], { stdout: help.stdout, stderr: help.stderr }), 0);
  assert.equal(help.out, BACKEND_HELP);
  await assert.rejects(backendUpdateMain(['frobnicate'], { stdout: io().stdout, stderr: io().stderr }), /Unknown backend command/);
  await assert.rejects(backendUpdateMain(['update', '--force'], { stdout: io().stdout, stderr: io().stderr }), /Unknown option for veo backend update/);
  await assert.rejects(backendUpdateMain(['reset', '--nope'], { stdout: io().stdout, stderr: io().stderr }), /Unknown option for veo backend reset/);

  const warned = io();
  assert.equal(await backendUpdateMain(['update'], {
    stdout: warned.stdout,
    stderr: warned.stderr,
    env: { VEO_YT_DLP_PATH: 'C:/yt-dlp.exe' },
    check: async () => ({ asset: 'yt-dlp.exe', current: RELEASE, latest: RELEASE }),
  }), 0);
  assert.match(warned.err, /VEO_YT_DLP_PATH is set/);
});

test('the pinned release is newer than any older state and compareVersions handles both schemes', () => {
  assert.ok(compareVersions(RELEASE, '2020.01.01') > 0);
  assert.ok(compareVersions('2026.09.01', RELEASE) > 0);
  assert.equal(releaseUrl('2026.09.01', 'SHA2-256SUMS'), 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.09.01/SHA2-256SUMS');
  assert.equal(backendStateFile({ env: { LOCALAPPDATA: path.join(os.homedir(), '.cache', 'veo-test') } }).endsWith('backend-override.json'), true);
});

test('checkBackend reports the pinned release when nothing is installed', async () => {
  const info = await checkBackend({
    platform: 'win32',
    arch: 'x64',
    musl: false,
    stateFile: path.join(os.tmpdir(), 'veo-absent-state.json'),
    latest: '2099.01.01',
    installed: null,
  });
  assert.equal(info.asset, 'yt-dlp.exe');
  assert.equal(info.current, RELEASE);
  assert.equal(info.latest, '2099.01.01');
});
