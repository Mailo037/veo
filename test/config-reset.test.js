import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetConfig } from '../src/config-reset.js';
import { CONFIG_TEMPLATE } from '../src/config-template.js';

test('config reset requires confirmation, preserves exact backup and restores malformed config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-reset-'));
  const file = path.join(root, 'config.json');
  const output = { write() {} };
  const original = Buffer.from('{ broken config with user settings\r\n');
  try {
    await writeFile(file, original);
    await assert.rejects(resetConfig(file, { output, input: { isTTY: false } }), /interactive terminal/);
    await resetConfig(file, { output, confirm: async () => '' });
    assert.deepEqual(await readFile(file), original);
    assert.deepEqual(await readdir(root), ['config.json']);
    await resetConfig(file, { output, confirm: async () => 'y' });
    assert.equal(await readFile(file, 'utf8'), CONFIG_TEMPLATE);
    const backups = (await readdir(root)).filter(name => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.deepEqual(await readFile(path.join(root, backups[0])), original);
    await resetConfig(file, { output, confirm: async () => 'yes' });
    assert.equal((await readdir(root)).filter(name => name.endsWith('.bak')).length, 2);
    const missing = path.join(root, 'nested', 'new.json');
    await resetConfig(missing, { output, confirm: async () => 'y' });
    assert.equal(await readFile(missing, 'utf8'), CONFIG_TEMPLATE);
    assert.deepEqual(await readdir(path.dirname(missing)), ['new.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
