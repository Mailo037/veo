import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { flush } from '../src/flush.js';
import { registerRun } from '../src/runs.js';

test('flush stops a separate veo run and its backend process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-flush-process-'));
  const script = `
    import { registerRun } from ${JSON.stringify(new URL('../src/runs.js', import.meta.url).href)};
    import { runBackend } from ${JSON.stringify(new URL('../src/downloader.js', import.meta.url).href)};
    const controller = new AbortController();
    const run = await registerRun(() => controller.abort(), ${JSON.stringify(root)});
    try {
      await runBackend(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], {
        signal: controller.signal, onLine: () => console.log('ready')
      });
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { await run.unregister(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  try {
    await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
    assert.equal((await flush({ root })).stopped, 1);
    assert.equal((await closed)[0], 0);
  } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
});

test('flush cancels registered work before removing downloads and jobs; preserves other files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-flush-'));
  let run;
  try {
    for (const name of ['downloads', 'jobs', 'backends']) await mkdir(path.join(root, name));
    const folder = path.join(root, 'downloads', `.veo-part-${'a'.repeat(24)}`);
    await mkdir(folder);
    await writeFile(path.join(folder, 'media.mp4'), 'temporary');
    await writeFile(path.join(root, 'jobs', '123-12345678-1234-1234-1234-123456789abc.json'), '{}');
    await writeFile(path.join(root, 'config.json'), 'keep');
    await writeFile(path.join(root, 'jobs', 'unknown.json'), 'keep');
    run = await registerRun(() => { void run.unregister(); }, root);
    const result = await flush({ root });
    assert.deepEqual(result, { stopped: 1, downloads: 1, jobs: 1, skipped: 0 });
    assert.deepEqual(await readdir(path.join(root, 'jobs')), ['unknown.json']);
    assert.ok((await readdir(root)).includes('config.json'));
    assert.ok((await readdir(root)).includes('backends'));
  } finally { await run?.unregister(); await rm(root, { recursive: true, force: true }); }
});

test('flush timeout preserves data and gate blocks new runs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-flush-'));
  let run;
  try {
    run = await registerRun(() => {}, root);
    await assert.rejects(flush({ root, timeoutMs: 10, status: () => {} }), /did not stop/);
    await run.unregister();
    await mkdir(path.join(root, '.flush'));
    await assert.rejects(registerRun(() => {}, root), /flush is in progress/);
  } finally { await run?.unregister(); await rm(root, { recursive: true, force: true }); }
});

test('flush preserves unknown locked downloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-flush-'));
  try {
    const folder = path.join(root, 'downloads', `.veo-part-${'b'.repeat(24)}`);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, '.lock'), '');
    assert.equal((await flush({ root })).skipped, 1);
    assert.deepEqual(await readdir(folder), ['.lock']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
