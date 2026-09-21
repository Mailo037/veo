import { runPool, serialQueue, reducedLimit } from './execution.js';
import { styleText } from './progress.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cacheBase } from './paths.js';
import { publicOptions, readJson, writeJson } from './state.js';
import { cleanText, readableError, validateUrl } from './utils.js';

export async function retryOptions(file) {
  const job = await readJson(path.resolve(file), null);
  if (job?.version !== 1 || !Array.isArray(job.items)) throw new Error('Invalid retry job file.');
  const pending = job.items.filter(item => !['saved', 'skipped'].includes(item.status));
  if (!pending.length) throw new Error('This job has no failed or unfinished downloads.');
  return pending.map(item => {
    validateUrl(item.url);
    const entries = item.entries || [];
    // After interruption, retry the original selection; resume history skips completed entries.
    const failures = entries.filter(entry => entry.status === 'failed');
    return { ...job.options, ...item.options, url: item.url, resume: true,
      ...(item.status === 'failed' && failures.length && item.finished ? { playlistItems: failures.map(entry => entry.index).join(',') } : {}) };
  });
}

/**
 * Location of one run's job file. It is created before the first download starts
 * so `veo runs <id>` can report per-item progress from it.
 */
export function jobFilePath(root = cacheBase()) {
  return path.join(root, 'jobs', `${Date.now()}-${randomUUID()}.json`);
}

export async function runJob(options, { download, reporter, signal, openFile, stdout = process.stdout, stderr = process.stderr, jobFile, items, recordStats, recordHistory } = {}) {
  const file = jobFile || jobFilePath();
  const requests = items || options.urls.map(url => ({ ...options, url }));
  const job = { version: 1, options: publicOptions({ ...options, output: path.resolve(options.output) }),
    items: requests.map(item => ({ url: item.url, status: 'pending', entries: [] })) };
  // Each retry item can have its own playlist selection.
  job.items.forEach((item, index) => { item.options = publicOptions(requests[index]); });
  const { cleanupDownloadCache } = await import('./download-cache.js');
  await cleanupDownloadCache();
  const queue = serialQueue();
  const persist = () => queue(() => writeJson(file, job));
  await persist();
  const activeTargets = new Map();
  const totals = { saved: 0, skipped: 0, failed: 0 };
  const adaptiveState = { divisor: 1 };
  const concurrency = options.concurrentDownloads ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Concurrent downloads must be between 1 and 4.');
  await runPool(requests, () => reducedLimit(concurrency, adaptiveState), async (request, index) => {
    const targetKey = JSON.stringify([request.url, path.resolve(request.output)]);
    const previous = activeTargets.get(targetKey);
    let release;
    const current = new Promise(resolve => { release = resolve; });
    activeTargets.set(targetKey, current);
    try {
      await previous;
      signal?.throwIfAborted();
      let saved = 0, skipped = 0, failed = 0;
      const itemReporter = concurrency > 1 && requests.length > 1 ? reporter.scoped?.(index + 1, requests.length, request.url) || reporter : reporter;
      const item = job.items[index];
      const started = performance.now();
      const published = new Set();
      let opened = false;
      let title;
      const publish = async files => {
        if (!options.json) for (const target of files) {
          if (!published.has(target)) stdout.write(styleText(stdout, `Saved: ${cleanText(target)}`, 'success', options.color !== false) + '\n');
          published.add(target);
        }
        if (request.open && !opened && files.length) {
          opened = true;
          try { await openFile(files[0]); }
          catch (error) { stderr.write(`veo: File saved, but could not launch the default app: ${readableError(error)}\n`); }
        }
      };
      if (itemReporter === reporter) reporter.item?.(index + 1, requests.length, request.url);
      try {
        item.status = 'running';
        await persist();
        const result = await download(request, { reporter: itemReporter, signal, adaptiveState, skipCacheCleanup: true, onEntry: async entry => {
          item.entries.push(entry);
          await persist();
          if (entry.status === 'saved') saved++;
          if (entry.status === 'skipped') skipped++;
          if (entry.status === 'failed') failed++;
          await publish(entry.files || []);
        } });
        Object.assign(item, { status: result.status || 'saved', files: result.files, timings: result.timings, entryTimings: result.entryTimings, finished: true });
        title = result.title;
        if (!item.entries.length) {
          saved += result.saved ?? (item.status === 'saved' ? 1 : 0);
          skipped += result.skipped ?? 0;
          failed += result.failures?.length ?? (item.status === 'failed' ? 1 : 0);
        }
        if (options.json) stdout.write(`${JSON.stringify({ ...result, status: item.status })}\n`);
        await publish(result.files);
      } catch (error) {
        item.status = signal?.aborted ? 'cancelled' : 'failed';
        item.error = readableError(error);
        if (!signal?.aborted) failed++;
        item.files = item.entries.flatMap(entry => entry.files || []);
        if (options.json) stdout.write(`${JSON.stringify({ url: request.url, status: item.status, error: item.error, files: item.files })}\n`);
        else stderr.write(styleText(stderr, `veo: ${cleanText(request.url)}: ${item.error}`, 'error', options.color !== false) + '\n');
      }
      if (recordStats) {
        try {
          await recordStats({ videos: request.audio ? 0 : saved,
            audio: request.audio ? saved : 0, failed: failed,
            skipped: skipped, cancelled: item.status === 'cancelled' ? 1 : 0,
            elapsedMs: Math.round(performance.now() - started) });
        } catch (error) { stderr.write(`veo: Could not save statistics: ${readableError(error)}\n`); }
      }
      // History is written per finished item, so `veo history` never reports an
      // attempt that is still running.
      if (recordHistory) {
        try {
          await recordHistory({ url: request.url, title, status: item.status, audio: Boolean(request.audio),
            quality: request.quality, format: request.format, files: item.files || [], error: item.error,
            elapsedMs: Math.round(performance.now() - started) });
        } catch (error) { stderr.write(`veo: Could not save download history: ${readableError(error)}\n`); }
      }
      await persist();
      totals.saved += saved; totals.skipped += skipped; totals.failed += failed;
    } finally { release(); if (activeTargets.get(targetKey) === current) activeTargets.delete(targetKey); }
  }, { signal }).catch(error => { if (!signal?.aborted) throw error; });
  const { saved, skipped, failed } = totals;
  const unfinished = job.items.some(item => !['saved', 'skipped'].includes(item.status));
  stderr.write(styleText(stderr, `Summary: ${saved} saved, ${skipped} skipped, ${failed} failed${signal?.aborted ? ', cancelled' : ''}.`, unfinished ? 'error' : 'success', options.color !== false && !options.json) + '\n');
  if (unfinished) stderr.write(`Retry failed/unfinished downloads: veo --retry-failed "${file}"\n`);
  if (unfinished) reporter.fail(Boolean(signal?.aborted)); else reporter.complete();
  return signal?.aborted ? 130 : unfinished ? 1 : 0;
}
