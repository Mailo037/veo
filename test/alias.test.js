import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import {
  ALIAS_MARKER, addAlias, aliasMain, aliasStatus, listAliases, removeAlias, validateAliasName,
} from '../src/alias.js';
import { npmUninstallCommand, uninstallMain } from '../src/uninstall.js';

function output() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(String(chunk)); },
    text() { return chunks.join(''); },
  };
}

test('alias names are validated strictly', () => {
  assert.equal(validateAliasName('veo-dl'), 'veo-dl');
  assert.equal(validateAliasName('  veo2  '), 'veo2');
  for (const bad of ['', 'x', 'Veo', 'veo_dl', 'veo/dl', 'veo dl', '1veo', '-veo', 'a'.repeat(32), 'veo\u001b[31m']) {
    assert.throws(() => validateAliasName(bad), /alias/i, `should reject ${JSON.stringify(bad)}`);
  }
});

test('add/remove/list round-trips a wrapper on this platform', async () => {
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'veo-alias-'));
  try {
    const created = await addAlias('veo-test', { binDir });
    assert.equal(created.name, 'veo-test');
    assert.equal(created.binDir, path.resolve(binDir));
    for (const file of created.paths) {
      const text = await readFile(file, 'utf8');
      assert.match(text, new RegExp(ALIAS_MARKER));
      assert.match(text, /veo/);
    }
    const status = await aliasStatus('veo-test', { binDir });
    assert.equal(status.present, true);
    assert.equal(status.managed, true);

    const listed = await listAliases({ binDir });
    assert.equal(listed.binDir, path.resolve(binDir));
    const found = listed.aliases.find(entry => entry.name === 'veo-test');
    assert.ok(found?.present && found?.managed && !found?.builtin);

    await assert.rejects(addAlias('veo-test', { binDir }), /already exists/);
    await addAlias('veo-test', { binDir, force: true });

    const removed = await removeAlias('veo-test', { binDir });
    assert.equal(removed.name, 'veo-test');
    assert.equal((await aliasStatus('veo-test', { binDir })).present, false);
    await assert.rejects(removeAlias('veo-test', { binDir }), /not installed/);
  } finally { await rm(binDir, { recursive: true, force: true }); }
});

test('POSIX alias executes veo with literal arguments and uninstall -p removes it', { skip: process.platform === 'win32' }, async () => {
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'veo-alias-exec-'));
  try {
    const veo = path.join(binDir, 'veo');
    await writeFile(veo, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await chmod(veo, 0o755);
    const out = output();
    assert.equal(await aliasMain(['add', 'vo', '--bin-dir', binDir], { stdout: out }), 0);
    const wrapper = path.join(binDir, 'vo');
    const args = ['--json', 'file name', 'literal$(date)'];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(wrapper, args, {
        shell: false, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), args);
    const removed = output();
    assert.equal(await uninstallMain(['-p', 'vo', '--bin-dir', binDir], { stdout: removed }), 0);
    assert.match(removed.text(), /Alias removed: vo/);
    assert.deepEqual(await readdir(binDir), ['veo']);
  } finally { await rm(binDir, { recursive: true, force: true }); }
});

test('veo itself is protected and builtins are flagged', async () => {
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'veo-alias-'));
  try {
    await assert.rejects(addAlias('veo', { binDir }), /already the main/);
    await assert.rejects(removeAlias('veo', { binDir }), /Refusing/);
    const status = await aliasStatus('veodl', { binDir });
    assert.equal(status.builtin, true);
    assert.equal(status.present, false);
  } finally { await rm(binDir, { recursive: true, force: true }); }
});

test('builtin removal deletes npm shims and warns about recreation', async () => {
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'veo-alias-'));
  const out = output();
  const err = output();
  try {
    const platform = process.platform;
    const suffixes = platform === 'win32' ? ['', '.cmd', '.ps1'] : [''];
    for (const suffix of suffixes) await writeFile(path.join(binDir, `veodl${suffix}`), 'npm shim');
    const removed = await removeAlias('veodl', { binDir });
    assert.equal(removed.builtin, true);
    assert.deepEqual(await readdir(binDir), []);
    await writeFile(path.join(binDir, platform === 'win32' ? 'veodl.cmd' : 'veodl'), 'npm shim');
    assert.equal(await aliasMain(['remove', 'veodl', '--bin-dir', binDir], { stdout: out, stderr: err }), 0);
    assert.match(out.text(), /Alias removed: veodl/);
    assert.match(out.text(), /veo update recreates/);
  } finally { await rm(binDir, { recursive: true, force: true }); }
});

test('aliasMain lists, adds and reports usage errors', async () => {
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'veo-alias-'));
  const out = output();
  const err = output();
  try {
    assert.equal(await aliasMain(['add', 'veo-extra', '--bin-dir', binDir], { stdout: out, stderr: err }), 0);
    assert.match(out.text(), /Alias installed: veo-extra/);
    const listOut = output();
    assert.equal(await aliasMain(['list', '--bin-dir', binDir], { stdout: listOut, stderr: err }), 0);
    assert.match(listOut.text(), /veo-extra/);
    const jsonOut = output();
    assert.equal(await aliasMain(['list', '--json', '--bin-dir', binDir], { stdout: jsonOut, stderr: err }), 0);
    const parsed = JSON.parse(jsonOut.text());
    assert.ok(parsed.aliases.some(entry => entry.name === 'veo-extra'));
    await assert.rejects(aliasMain(['add', 'Bad_Name', '--bin-dir', binDir], { stdout: out, stderr: err }), /Invalid alias/);
    await assert.rejects(aliasMain(['bogus', '--bin-dir', binDir], { stdout: out, stderr: err }), /Unknown alias/);
    assert.equal(await aliasMain(['--help'], { stdout: out, stderr: err }), 0);
    assert.match(out.text(), /veo alias - manage/);
  } finally { await rm(binDir, { recursive: true, force: true }); }
});

test('npm uninstall avoids shell and reports failures like update', () => {
  const spec = npmUninstallCommand({ platform: 'win32' });
  assert.equal(spec.shell, false);
  assert.equal(spec.command, 'cmd.exe');
  assert.deepEqual(spec.args, ['/d', '/s', '/c', 'npm uninstall -g veodl']);
  assert.equal(npmUninstallCommand({ platform: 'linux' }).command, 'npm');
  assert.deepEqual(npmUninstallCommand({ platform: 'darwin' }), {
    command: 'npm', args: ['uninstall', '-g', 'veodl'], shell: false,
  });
});

test('uninstall -p removes one alias; bare uninstall plans without --yes', async () => {
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'veo-uninstall-'));
  try {
    await addAlias('veo-short', { binDir });
    const out = output();
    const err = output();
    assert.equal(await uninstallMain(['-p', 'veo-short', '--bin-dir', binDir], { stdout: out, stderr: err }), 0);
    assert.match(out.text(), /Alias removed: veo-short/);

    const plan = output();
    assert.equal(await uninstallMain([], { stdout: plan, stderr: err }), 0);
    assert.match(plan.text(), /npm uninstall -g veodl/);
    assert.match(plan.text(), /--yes/);
    assert.match(plan.text(), /removes everything/i);

    const planned = output();
    assert.equal(await uninstallMain(['--json'], { stdout: planned, stderr: err }), 0);
    assert.equal(JSON.parse(planned.text()).status, 'planned');
    await assert.rejects(uninstallMain(['-p', 'veo-short', '--keep-cache', '--bin-dir', binDir], { stdout: out, stderr: err }), /--keep-/);
  } finally { await rm(binDir, { recursive: true, force: true }); }
});

test('uninstall plans the active VEO_CONFIG path on macOS', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-uninstall-macos-'));
  try {
    const config = path.join(root, 'custom-config.json');
    await writeFile(config, '{}');
    const out = output();
    assert.equal(await uninstallMain(['--json', '--bin-dir', root], {
      platform: 'darwin', env: { ...process.env, VEO_CONFIG: config }, stdout: out,
      cacheRoot: path.join(root, 'cache'),
    }), 0);
    assert.equal(JSON.parse(out.text()).config, config);
    assert.equal(await readFile(config, 'utf8'), '{}', 'planning must not delete config');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uninstall --yes removes aliases, package, cache and config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-uninstall-full-'));
  const binDir = path.join(root, 'bin');
  const cache = path.join(root, 'cache');
  const config = path.join(root, 'config.json');
  await writeFile(config, '{}');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(binDir, { recursive: true });
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, 'x'), 'x');
  await addAlias('veo-short', { binDir });
  const spawns = [];
  const spawnImpl = (command, args, options) => {
    spawns.push({ command, args });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  const out = output();
  const err = output();
  assert.equal(await uninstallMain(['--yes', '--bin-dir', binDir], { stdout: out, stderr: err, spawnImpl, cacheRoot: cache, configFile: config }), 0);
  if (process.platform === 'win32') {
    assert.equal(spawns[0].command, 'cmd.exe');
    assert.deepEqual(spawns[0].args, ['/d', '/s', '/c', 'npm uninstall -g veodl']);
  } else {
    assert.equal(spawns[0].command, 'npm');
    assert.deepEqual(spawns[0].args, ['uninstall', '-g', 'veodl']);
  }
  assert.match(out.text(), /uninstalled/);
  assert.match(out.text(), /Aliases deleted: veo-short/);
  assert.match(out.text(), /Cache deleted/);
  assert.match(out.text(), /Config deleted/);
  await assert.rejects(async () => readFile(path.join(cache, 'x'), 'utf8'));
  await assert.rejects(async () => readFile(config, 'utf8'));
  await assert.rejects(async () => readFile(path.join(binDir, process.platform === 'win32' ? 'veo-short.cmd' : 'veo-short'), 'utf8'));

  const failing = output();
  const failErr = output();
  assert.equal(await uninstallMain(['--yes', '--bin-dir', binDir], {
    stdout: failing, stderr: failErr, cacheRoot: cache, configFile: config,
    spawnImpl: () => { throw Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }); },
  }), 1);
  assert.match(failErr.text(), /npm was not found/);
});

test('uninstall --yes honors keep flags', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-uninstall-keep-'));
  const binDir = path.join(root, 'bin');
  const cache = path.join(root, 'cache');
  const config = path.join(root, 'config.json');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(binDir, { recursive: true });
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, 'x'), 'x');
  await writeFile(config, '{}');
  await addAlias('veo-short', { binDir });
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  const out = output();
  const err = output();
  assert.equal(await uninstallMain(
    ['--yes', '--keep-cache', '--keep-config', '--keep-aliases', '--bin-dir', binDir],
    { stdout: out, stderr: err, spawnImpl, cacheRoot: cache, configFile: config },
  ), 0);
  assert.match(out.text(), /Cache kept/);
  assert.match(out.text(), /Config kept/);
  assert.equal(await readFile(path.join(cache, 'x'), 'utf8'), 'x');
  assert.equal(await readFile(config, 'utf8'), '{}');
  await rm(root, { recursive: true, force: true });
});
