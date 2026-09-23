import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import {
  compareVersions, defaultRegistry, fetchLatestVersion, maybeUpdateNotice,
  updateMain, pruneBackendCaches, npmSpawnCommand, runNpmUpdate, UPDATE_HELP,
} from '../src/updater.js';
import { main } from '../src/cli.js';

function jsonOutput() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(String(chunk)); },
    text() { return chunks.join(''); },
  };
}

test('version comparison handles numeric and prerelease ordering', () => {
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.throws(() => compareVersions('nine', '1.0.0'));
});

test('registry override honors VEO_REGISTRY and npm config, rejects junk', () => {
  assert.equal(defaultRegistry({}), 'https://registry.npmjs.org');
  assert.equal(defaultRegistry({ VEO_REGISTRY: 'http://localhost:4873/' }), 'http://localhost:4873');
  assert.equal(defaultRegistry({ npm_config_registry: 'https://registry.example.org/' }), 'https://registry.example.org');
  assert.equal(defaultRegistry({ VEO_REGISTRY: 'not a url' }), 'https://registry.npmjs.org');
});

test('latest-version fetch validates and surfaces HTTP failures', async () => {
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) }) }), '9.9.9');
  await assert.rejects(fetchLatestVersion({ fetchImpl: async () => ({ ok: false, status: 404, body: { cancel: async () => {} } }) }), /HTTP 404/);
  await assert.rejects(fetchLatestVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({ version: 'x' }) }) }), /invalid version/);
});

test('post-download notice is throttled, silent on failure, and skippable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veo-update-'));
  try {
    const stateFile = path.join(dir, 'update-check.json');
    const fetchImpl = async () => ({ ok: true, json: async () => ({ version: '2.0.0' }) });
    const first = await maybeUpdateNotice({ currentVersion: '1.0.1', stateFile, fetchImpl });
    assert.match(first, /Update available: veo 2\.0\.0/);
    assert.equal(await maybeUpdateNotice({ currentVersion: '1.0.1', stateFile, fetchImpl }), null, 'second check within TTL must be throttled');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.latest, '2.0.0');
    await writeFile(stateFile, '{"lastCheck":1}'); // TTL expired again.
    const failing = async () => { throw new Error('offline'); };
    assert.equal(await maybeUpdateNotice({ currentVersion: '1.0.1', stateFile, fetchImpl: failing }), null);
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(saved.latest, null, 'unreachable registry consumes the interval');
    await writeFile(stateFile, '{"lastCheck":1}');
    assert.equal(await maybeUpdateNotice({ currentVersion: '1.0.1', stateFile, fetchImpl, env: { VEO_NO_UPDATE_CHECK: '1' } }), null);
    await writeFile(stateFile, 'corrupted');
    // Corrupted state only resets the throttle; the check runs again immediately.
    assert.match(await maybeUpdateNotice({ currentVersion: '1.0.1', stateFile, fetchImpl }), /Update available/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('update command checks, refuses unknown options, and prints help', async () => {
  const out = jsonOutput();
  const err = jsonOutput();
  const fetchOf = version => (async () => ({ ok: true, json: async () => ({ version }) }));
  assert.equal(await updateMain(['update', '--check'], { current: '1.0.0', fetchImpl: fetchOf('1.0.1'), stdout: out, stderr: err }), 0);
  assert.match(out.text(), /Update available: veo 1\.0\.1/);
  assert.equal(await updateMain(['check', 'update'], { current: '9.9.9', fetchImpl: fetchOf('1.0.1'), stdout: out, stderr: err }), 0);
  assert.match(out.text(), /is up to date/);
  assert.equal(await updateMain(['upgrade', '--check'], { current: '1.0.0', fetchImpl: fetchOf('1.0.2'), stdout: out, stderr: err }), 0);
  assert.match(out.text(), /Update available: veo 1\.0\.2/);
  await assert.rejects(() => updateMain(['update', '--fancy'], { current: '1.0.0', fetchImpl: fetchOf('1.0.1'), stdout: out, stderr: err }), /Unknown option/);
  assert.equal(await updateMain(['update', '--help'], { current: '1.0.0', fetchImpl: fetchOf('1.0.1'), stdout: out, stderr: err }), 0);
  assert.match(out.text(), /veo update - keep veo current/);
  assert.equal(await updateMain(['upgrade'], { current: '1.0.0', fetchImpl: async () => ({ ok: false, status: 500, body: { cancel: async () => {} } }), stdout: out, stderr: err }), 1);
  assert.match(err.text(), /Update manually/);
  assert.match(UPDATE_HELP, /veo check update/);
});

test('update runs npm install and prunes old backend caches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veo-prune-'));
  try {
    const backends = path.join(dir, 'backends');
    await mkdir(path.join(backends, '2026.01.01-win32-x64'), { recursive: true });
    await mkdir(path.join(backends, '2026.08.19-win32-x64'), { recursive: true });
    let spawned = null;
    const out = jsonOutput();
    const err = jsonOutput();
    const code = await updateMain(['update'], {
      platform: 'linux',
      current: '1.0.0',
      fetchImpl: async () => ({ ok: true, json: async () => ({ version: '1.0.2' }) }),
      spawnImpl(command, args, options) {
        spawned = { command, args, options };
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', 0));
        return child;
      },
      stdout: out,
      stderr: err,
      pruneRoot: backends,
      keep: '2026.08.19-win32-x64',
    });
    assert.equal(code, 0);
    assert.equal(spawned.command, 'npm');
    assert.deepEqual(spawned.args, ['install', '-g', '--no-fund', '--no-audit', 'veod@latest']);
    assert.deepEqual((await readdir(backends)).sort(), ['2026.08.19-win32-x64']);
    assert.match(out.text(), /veo updated to 1\.0\.2/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('npm spawn avoids shell:true on every platform and reports ENOENT cleanly', async () => {
  const spec = npmSpawnCommand({ platform: 'win32' });
  assert.equal(spec.shell, false);
  assert.equal(spec.command, 'cmd.exe');
  assert.deepEqual(spec.args, ['/d', '/s', '/c', 'npm install -g --no-fund --no-audit veod@latest']);
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.equal(npmSpawnCommand({ platform: 'linux' }).shell, false);
  const out = jsonOutput();
  const err = jsonOutput();
  const code = await updateMain(['update'], {
    current: '1.0.0',
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '1.0.2' }) }),
    spawnImpl: () => { throw Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }); },
    stdout: out,
    stderr: err,
  });
  assert.equal(code, 1);
  assert.match(err.text(), /npm was not found/);
});

test('Windows update launches npm.cmd with literal arguments and preserves its exit code', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo npm test '));
  const warnings = [];
  const onWarning = warning => warnings.push(warning.code);
  process.on('warning', onWarning);
  try {
    await writeFile(path.join(directory, 'npm.cmd'), '@echo off\r\necho %*\r\nexit /b 7\r\n');
    let output = '';
    const code = await runNpmUpdate({ spawnImpl(command, args, options) {
      assert.equal(options.shell, false);
      const child = spawn(command, args, { ...options, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      return child;
    } });
    assert.equal(code, 7);
    assert.equal(output.trim(), 'install -g --no-fund --no-audit veod@latest');
    assert.ok(!warnings.includes('DEP0190'));
  } finally {
    process.off('warning', onWarning);
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI routes update subcommands without URL validation', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: '1.0.1' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.VEO_REGISTRY;
  process.env.VEO_REGISTRY = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await main(['upgrade', '--check']), 0);
    assert.equal(await main(['check', 'update']), 0);
    assert.equal(await main(['check']), 0); // Bare `veo check` prints usage.
  } finally {
    if (previous === undefined) delete process.env.VEO_REGISTRY;
    else process.env.VEO_REGISTRY = previous;
    await new Promise(resolve => server.close(resolve));
  }
});

test('prune keeps current cache and ignores missing roots', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veo-prune2-'));
  try {
    await mkdir(path.join(dir, 'keep'), { recursive: true });
    await mkdir(path.join(dir, 'old'), { recursive: true });
    await writeFile(path.join(dir, 'keep', 'x'), 'x');
    assert.equal(await pruneBackendCaches({ root: dir, keep: 'keep' }), 1);
    assert.deepEqual(await readdir(dir), ['keep']);
    assert.equal(await pruneBackendCaches({ root: path.join(dir, 'missing'), keep: 'keep' }), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
