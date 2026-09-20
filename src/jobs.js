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

export async function runJob(options, { download, reporter, signal, openFile, stdout = process.stdout, stderr = process.stderr, jobFile, items, recordStats } = {}) {
  const file = jobFile || path.join(cacheBase(), 'jobs', `${Date.now()}-${randomUUID()}.json`);
  const requests = items || options.urls.map(url => ({ ...options, url }));
  const job = { version: 1, options: publicOptions({ ...options, output: path.resolve(options.output) }),
    items: requests.map(item => ({ url: item.url, status: 'pending', entries: [] })) };
  // Each retry item can have its own playlist selection.
  job.items.forEach((item, index) => { item.options = publicOptions(requests[index]); });
  await writeJson(file, job);
  let saved = 0, skipped = 0, failed = 0;
  for (const [index, request] of requests.entries()) {
    if (signal?.aborted) break;
    const item = job.items[index];
    const started = performance.now();
    const before = { saved, skipped, failed };
    const published = new Set();
    let opened = false;
    const publish = async files => {
      if (!options.json) for (const target of files) {
        if (!published.has(target)) stdout.write(`Saved: ${cleanText(target)}\n`);
        published.add(target);
      }
      if (request.open && !opened && files.length) {
        opened = true;
        try { await openFile(files[0]); }
        catch (error) { stderr.write(`veo: File saved, but could not launch the default app: ${readableError(error)}\n`); }
      }
    };
    reporter.item?.(index + 1, requests.length, request.url);
    try {
      item.status = 'running';
      await writeJson(file, job);
      const result = await download(request, { reporter, signal, onEntry: async entry => {
        item.entries.push(entry);
        await writeJson(file, job);
        if (entry.status === 'saved') saved++;
        if (entry.status === 'skipped') skipped++;
        if (entry.status === 'failed') failed++;
        await publish(entry.files || []);
      } });
      Object.assign(item, { status: result.status || 'saved', files: result.files, finished: true });
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
      else stderr.write(`veo: ${cleanText(request.url)}: ${item.error}\n`);
    }
    if (recordStats) {
      try {
        await recordStats({ videos: request.audio ? 0 : saved - before.saved,
          audio: request.audio ? saved - before.saved : 0, failed: failed - before.failed,
          skipped: skipped - before.skipped, cancelled: item.status === 'cancelled' ? 1 : 0,
          elapsedMs: Math.round(performance.now() - started) });
      } catch (error) { stderr.write(`veo: Could not save statistics: ${readableError(error)}\n`); }
    }
    await writeJson(file, job);
  }
  const unfinished = job.items.some(item => !['saved', 'skipped'].includes(item.status));
  stderr.write(`Summary: ${saved} saved, ${skipped} skipped, ${failed} failed${signal?.aborted ? ', cancelled' : ''}.\n`);
  if (unfinished) stderr.write(`Retry failed/unfinished downloads: veo --retry-failed "${file}"\n`);
  if (unfinished) reporter.fail(Boolean(signal?.aborted)); else reporter.complete();
  return signal?.aborted ? 130 : unfinished ? 1 : 0;
}
