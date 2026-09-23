import { setTimeout as delay } from 'node:timers/promises';

// Workers finish active work before settling, including cancellation and failures.
export async function runPool(items, limit, work, { signal } = {}) {
  let next = 0;
  const maximum = typeof limit === 'function' ? limit : () => limit;
  const workers = Array.from({ length: Math.min(maximum(), items.length) }, (_, worker) => (async () => {
    while (next < items.length && worker < maximum()) {
      signal?.throwIfAborted();
      const index = next++;
      await work(items[index], index);
    }
  })());
  const results = await Promise.allSettled(workers);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

export function serialQueue() {
  let tail = Promise.resolve();
  return work => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
}

export const reducedLimit = (limit, state) => Math.max(1, Math.floor(limit / (state?.divisor || 1)));
// yt-dlp reports a failed concurrent fragment fetch as a local ENOENT on the
// fragment temp file (e.g. "...media.mp4.part-Frag29"), hiding the server-side
// hiccup or expired segment URL behind it. Those are worth retrying with
// reduced fragment parallelism and a refetched playlist; anything else yt-dlp
// reports as "Unable to download video" (unavailable, private, ...) still
// fails fast so permanent failures do not burn repeated full downloads.
export function retryable(error) {
  return /HTTP(?: Error)?\s*(?:429|5\d\d)|too many requests|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|temporary failure|connection (?:reset|aborted)|\.part-Frag\d+/i.test(error?.message || '');
}

export async function adaptiveRun(run, { enabled = true, state = { divisor: 1 }, signal, reporter, wait = delay, timer } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await run(attempt); }
    catch (error) {
      if (!enabled || signal?.aborted || !retryable(error) || attempt >= 2) throw error;
      state.divisor = Math.min(16, (state.divisor || 1) * 2);
      const ms = 2000 * 2 ** attempt;
      reporter?.status(`Source busy or connection interrupted; reducing parallelism and retrying in ${ms / 1000}s (${attempt + 1}/2).`);
      const previous = timer?.phase;
      timer?.switch('retryWait');
      try { await wait(ms, undefined, { signal }); } finally { if (previous) timer?.switch(previous); }
    }
  }
}

export function phaseTimer(now = () => performance.now()) {
  const totals = {};
  let phase = 'setup', start = now();
  return {
    get phase() { return phase; },
    switch(next) { const end = now(); totals[phase] = (totals[phase] || 0) + end - start; phase = next; start = end; },
    result() { this.switch(phase); return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Math.round(value)])); },
  };
}

export function formatTimings(timings) {
  const labels = { setup: 'setup', metadata: 'metadata', download: 'download/backend', processing: 'merge/processing', saving: 'saving', retryWait: 'retry wait' };
  return 'Timing: ' + Object.entries(timings).map(([phase, ms]) => `${labels[phase] || phase} ${(ms / 1000).toFixed(1)}s`).join(' | ');
}
