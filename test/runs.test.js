import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { RUNS_HELP, STOP_HELP, alive, listRuns, registerRun, runsDirectory, runsMain, stopMain } from '../src/runs.js';
import { jobFilePath } from '../src/jobs.js';

const sink = () => { let text = ''; return { stdout: { write: chunk => { text += chunk; } }, read: () => text }; };

// A job file in the shape runJob writes while it works.
async function fakeJob(file, items) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, options: {}, items }));
}

test('a registered run has a 6-character id, a live record and its resolved settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-runs-'));
  try {
    const first = await registerRun(() => {}, root);
    const second = await registerRun(() => {}, root);
    try {
      assert.match(first.id, /^[0-9a-z]{6}$/);
      assert.notEqual(first.id, second.id);
      const records = await listRuns(root);
      assert.equal(records.length, 2);
      assert.deepEqual(records.map(run => run.id).sort(), [first.id, second.id].sort());
      assert.ok(records.every(run => run.alive && run.pid === process.pid));

      const job = jobFilePath(root);
      await first.describe({ urls: ['https://example.test/a', 'https://example.test/b'], output: path.join(root, 'out'),
        audio: false, quality: '1080p', playlist: true, job });
      const [run] = (await listRuns(root)).filter(item => item.id === first.id);
      assert.deepEqual(run.urls, ['https://example.test/a', 'https://example.test/b']);
      assert.equal(run.output, path.join(root, 'out'));
      assert.equal(run.media, 'video');
      assert.equal(run.quality, '1080p');
      assert.equal(run.playlist, true);
      assert.equal(run.job, job);
      assert.ok(Date.parse(run.startedAt) > 0);
    } finally {
      await first.unregister();
      await second.unregister();
    }
    assert.deepEqual(await readdir(runsDirectory(root)), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('veo runs lists active runs with progress and shows one run in detail', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-runs-list-'));
  const run = await registerRun(() => {}, root);
  try {
    const job = jobFilePath(root);
    await fakeJob(job, [
      { url: 'https://example.test/one', status: 'saved', entries: [], files: [path.join(root, 'one.mp4')] },
      { url: 'https://example.test/two', status: 'running', entries: [] },
      { url: 'https://example.test/three', status: 'pending', entries: [] },
    ]);
    await run.describe({ urls: ['https://example.test/one', 'https://example.test/two'], output: path.join(root, 'out'),
      audio: false, quality: '720p', format: null, playlist: false, job });

    const list = sink();
    assert.equal(await runsMain([], { root, stdout: list.stdout }), 0);
    assert.match(list.read(), /^veo runs\n/);
    assert.match(list.read(), /ID\s+PID\s+STATE\s+STARTED\s+ITEMS\s+OUTPUT/);
    assert.match(list.read(), new RegExp(`${run.id}\\s+${process.pid}\\s+running \\d+[ms]( \\d+s)?`));
    assert.match(list.read(), /1\/3 done, 1 running, 1 pending/);
    assert.match(list.read(), /Details: veo runs <id> {4}Stop: veo stop \[id\]/);

    const detail = sink();
    assert.equal(await runsMain([run.id], { root, stdout: detail.stdout }), 0);
    assert.match(detail.read(), new RegExp(`^veo runs ${run.id}\\n`));
    assert.match(detail.read(), new RegExp(`State:   running \\(PID ${process.pid}\\)`));
    assert.match(detail.read(), /Media:   video, 720p/);
    assert.match(detail.read(), new RegExp(`Output:  ${path.join(root, 'out').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(detail.read(), /URLs:    2\n {2}1\. https:\/\/example\.test\/one\n {2}2\. https:\/\/example\.test\/two/);
    assert.match(detail.read(), /Items:   1\/3 done, 1 running, 1 pending/);
    assert.match(detail.read(), / {2}1\. saved {2}.*one\.mp4/);
    assert.match(detail.read(), / {2}2\. running {2}https:\/\/example\.test\/two/);
    assert.match(detail.read(), / {2}3\. pending {2}https:\/\/example\.test\/three/);
    assert.match(detail.read(), new RegExp(`Stop:    veo stop ${run.id}`));

    // An upper-case id is normalized, an unknown or malformed id is refused.
    const upper = sink();
    assert.equal(await runsMain([run.id.toUpperCase()], { root, stdout: upper.stdout }), 0);
    assert.match(upper.read(), new RegExp(`veo runs ${run.id}`));
    await assert.rejects(runsMain(['zzzzzz'], { root, stdout: sink().stdout }), /No veo run with id zzzzzz/);
    await assert.rejects(runsMain(['nope'], { root, stdout: sink().stdout }), /Invalid run id/);
    await assert.rejects(runsMain([run.id, 'extra'], { root, stdout: sink().stdout }), /Usage: veo runs \[id\]/);
  } finally { await run.unregister(); await rm(root, { recursive: true, force: true }); }
});

test('veo runs reports an empty list and its own help', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-runs-empty-'));
  try {
    const list = sink();
    assert.equal(await runsMain([], { root, stdout: list.stdout }), 0);
    assert.match(list.read(), /No veo runs are active/);
    const help = sink();
    assert.equal(await runsMain(['--help'], { root, stdout: help.stdout }), 0);
    assert.equal(help.read(), RUNS_HELP);
    const stopHelp = sink();
    assert.equal(await stopMain(['-h'], { root, stdout: stopHelp.stdout }), 0);
    assert.equal(stopHelp.read(), STOP_HELP);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('veo stop cancels the named run only, and every run without an id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-stop-'));
  let first, second;
  try {
    const cancelled = [];
    first = await registerRun(() => { cancelled.push('first'); void first.unregister(); }, root);
    second = await registerRun(() => { cancelled.push('second'); void second.unregister(); }, root);

    const one = sink();
    assert.equal(await stopMain([first.id], { root, stdout: one.stdout }), 0);
    assert.deepEqual(cancelled, ['first']);
    assert.match(one.read(), new RegExp(`Stopped: ${first.id}`));
    assert.match(one.read(), /Partial data and retry jobs are kept; veo flush removes them\./);
    assert.deepEqual((await listRuns(root)).map(run => run.id), [second.id]);

    const rest = sink();
    assert.equal(await stopMain([], { root, stdout: rest.stdout }), 0);
    assert.deepEqual(cancelled, ['first', 'second']);
    assert.match(rest.read(), new RegExp(`Stopped: ${second.id}`));
    assert.deepEqual(await listRuns(root), []);

    const none = sink();
    assert.equal(await stopMain([], { root, stdout: none.stdout }), 0);
    assert.match(none.read(), /No veo runs were active\./);
    await assert.rejects(stopMain(['zzzzzz'], { root, stdout: sink().stdout }), /No veo run with id zzzzzz/);
    await assert.rejects(stopMain(['toolong'], { root, stdout: sink().stdout }), /Invalid run id/);
    await assert.rejects(stopMain(['a', 'b'], { root, stdout: sink().stdout }), /Usage: veo stop \[id\]/);
  } finally { await second.unregister(); await rm(root, { recursive: true, force: true }); }
});

test('veo stop removes stale records and reports a run that ignores the request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-stop-stale-'));
  try {
    // A record from a crashed run: its process existed once and is gone now.
    const crashed = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
    await once(crashed, 'close');
    const dead = await registerRun(() => {}, root);
    const record = JSON.parse(await readFile(dead.file, 'utf8'));
    await writeFile(dead.file, JSON.stringify({ ...record, pid: crashed.pid }));
    assert.equal(alive(crashed.pid), false);
    const stale = sink();
    assert.equal(await stopMain([dead.id], { root, stdout: stale.stdout }), 0);
    assert.match(stale.read(), new RegExp(`Removed 1 stale record\\(s\\): ${dead.id}`));
    assert.deepEqual(await readdir(runsDirectory(root)), []);
    await dead.unregister();

    const stubborn = await registerRun(() => {}, root);
    try {
      const timeout = sink();
      assert.equal(await stopMain([stubborn.id], { root, timeoutMs: 200, stdout: timeout.stdout }), 1);
      assert.match(timeout.read(), new RegExp(`Still running: ${stubborn.id}`));
      assert.ok(alive(process.pid));
    } finally { await stubborn.unregister(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('another terminal stops a real veo run by its id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-stop-process-'));
  const script = `
    import { registerRun } from ${JSON.stringify(new URL('../src/runs.js', import.meta.url).href)};
    const controller = new AbortController();
    const run = await registerRun(() => controller.abort(), ${JSON.stringify(root)});
    console.log(JSON.stringify({ id: run.id }));
    // Real runs are busy while they work; this keeps an idle test run alive for the request.
    const keepAlive = setInterval(() => {}, 1000);
    try { await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); }
    finally { clearInterval(keepAlive); await run.unregister(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  try {
    const [chunk] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
    const { id } = JSON.parse(String(chunk));
    const listed = sink();
    assert.equal(await runsMain([], { root, stdout: listed.stdout }), 0);
    assert.match(listed.read(), new RegExp(`${id}\\s+${child.pid}\\s+running`));

    const stopped = sink();
    assert.equal(await stopMain([id], { root, stdout: stopped.stdout }), 0);
    assert.match(stopped.read(), new RegExp(`Stopped: ${id}`));
    assert.equal((await closed)[0], 0, 'the run must exit cleanly');
    assert.deepEqual(await readdir(runsDirectory(root)), []);
  } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
});

test('damaged and foreign records are ignored, records of older versions are honored', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-runs-broken-'));
  try {
    const directory = runsDirectory(root);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'not-a-run.txt'), '{}');
    await writeFile(path.join(directory, `${randomUUID()}.json`), '{"version":1,"pid":"nope"}');
    await writeFile(path.join(directory, `${randomUUID()}.json`), 'not json at all');
    assert.deepEqual(await listRuns(root), []);
    const list = sink();
    assert.equal(await runsMain([], { root, stdout: list.stdout }), 0);
    assert.match(list.read(), /No veo runs are active/);

    // veo 1.4.0 wrote nothing but a pid; such a record must still be usable.
    await writeFile(path.join(directory, `${randomUUID()}.json`), JSON.stringify({ pid: process.pid }));
    const legacy = await listRuns(root);
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].id, null);
    assert.equal(legacy[0].alive, true);
    const legacyText = sink();
    assert.equal(await runsMain([], { root, stdout: legacyText.stdout }), 0);
    assert.match(legacyText.read(), new RegExp(`-\\s+${process.pid}\\s+running`));
    const cleaned = sink();
    assert.equal(await stopMain([], { root, timeoutMs: 200, stdout: cleaned.stdout }), 1);
    assert.match(cleaned.read(), new RegExp(`Still running: PID ${process.pid}`));
  } finally { await rm(root, { recursive: true, force: true }); }
});
