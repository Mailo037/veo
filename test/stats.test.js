import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStatsRecorder, readStats } from '../src/stats.js';
import { flush } from '../src/flush.js';
import { runJob } from '../src/jobs.js';

test('concurrent statistics survive flush and reset only with stats enabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-stats-'));
  try {
    const a = createStatsRecorder(root), b = createStatsRecorder(root);
    await Promise.all([a({ videos: 2, failed: 1, elapsedMs: 2000 }), b({ audio: 1, elapsedMs: 3000 })]);
    await a({ skipped: 1, cancelled: 1 });
    const totals = await readStats(root);
    assert.equal(totals.videos, 2);
    assert.equal(totals.audio, 1);
    assert.equal(totals.failed, 1);
    assert.equal(totals.elapsedMs, 5000);
    await flush({ root });
    assert.deepEqual(await readStats(root), totals);
    await flush({ root, stats: true });
    assert.equal((await readStats(root)).since, null);
    assert.equal((await readStats(root)).videos, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('job statistics count playlist outcomes once and failures separately', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-stats-job-'));
  try {
    let calls = 0;
    await runJob({ urls: ['https://example.test/list', 'https://example.test/fail'], output: root }, {
      jobFile: path.join(root, 'job.json'), recordStats: createStatsRecorder(root),
      stdout: { write() {} }, stderr: { write() {} }, reporter: { fail() {}, complete() {} },
      download: async (_, { onEntry }) => {
        if (calls++) throw new Error('failed');
        await onEntry({ status: 'saved', files: [] });
        await onEntry({ status: 'failed', files: [] });
        await onEntry({ status: 'skipped', files: [] });
        return { status: 'failed', saved: 1, skipped: 1, failures: [{}], files: [] };
      },
    });
    const totals = await readStats(root);
    assert.equal(totals.videos, 1);
    assert.equal(totals.failed, 2);
    assert.equal(totals.skipped, 1);
    assert.equal(totals.cancelled, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
