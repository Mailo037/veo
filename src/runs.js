import { commandOutput } from './output.js';
import { randomInt, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cacheBase } from './paths.js';
import { writeJson } from './state.js';
import { cleanText, localStamp } from './utils.js';

/**
 * Every veo run registers itself under the per-user cache's `runs` directory
 * while it works, so another terminal can list it (`veo runs`), inspect it
 * (`veo runs <id>`) or cancel it (`veo stop <id>`) without guessing at PIDs.
 * Records hold an id, times, URLs, paths and settings — never credentials or
 * cookie settings, and the record itself is always removed when the run ends.
 */
export const RUN_ID = /^[0-9a-z]{6}$/;
export const STOP_TIMEOUT_MS = 15000;
const RECORD = /^[a-f0-9-]{36}\.json$/;
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ITEM_STATUSES = new Set(['pending', 'running', 'saved', 'skipped', 'failed', 'cancelled']);
const SHOWN_ITEMS = 10;
const OUTPUT_WIDTH = 42;

export const RUNS_HELP = `veo runs [id]

List active veo runs with their 6-character id, process id, start time and progress.
With an id, show one run in detail: URLs, media settings, output directory, job file
and the state of every item. A run appears while it works and disappears when it
finishes. Records of crashed runs are kept but marked stale.
Use veo stop <id> to stop one run.
`;

export const STOP_HELP = `veo stop [id]

Ask one run, or every run when no id is given, to stop, and wait until it exits.
A stopped run keeps its partial data and its retry job, so the printed
veo --retry-failed command still works; veo flush removes those later.
Stale records of crashed runs are removed. Exit status is 1 when a run does not
stop in time.
`;

export function runsDirectory(root = cacheBase()) {
  return path.join(path.resolve(root), 'runs');
}

/**
 * A run record is only trusted when it names a plausible process. Older veo
 * versions wrote nothing but a pid, so a missing version is still accepted.
 */
function validRecord(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return false;
  return (run.version === undefined || run.version === 1) && Number.isInteger(run.pid) && run.pid > 0;
}

const exists = file => lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const text = value => typeof value === 'string' ? cleanText(value) : '';
const newRunId = () => Array.from({ length: 6 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('');

export function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function runFiles(root) {
  const directory = runsDirectory(root);
  const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Invalid active run directory: ${directory}`);
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && RECORD.test(entry.name)).map(entry => path.join(directory, entry.name));
}

// Cache files are machine-written: a missing, truncated or foreign file must
// never take a veo command down, so unreadable JSON simply counts as unknown.
async function readRecordFile(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function readRecords(root) {
  const records = [];
  for (const file of await runFiles(root)) {
    // Damaged or foreign files are ignored, never fatal: a single stray file
    // must not block every later veo run. Downloads of a run that could not be
    // recognized stay protected by the staging lock that run holds.
    const run = await readRecordFile(file);
    if (!validRecord(run)) continue;
    records.push({ ...run, id: RUN_ID.test(run.id || '') ? run.id : null, file });
  }
  return records;
}

/** Every registered run, live ones first and then the most recently started. */
export async function listRuns(root = cacheBase()) {
  const runs = await readRecords(root);
  for (const run of runs) run.alive = alive(run.pid);
  return runs.sort((a, b) => Number(b.alive) - Number(a.alive) || String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

/**
 * Register this process as a run and poll for a stop request. The returned
 * handle exposes the run's id, its resolved settings for `veo runs <id>`, and
 * the cleanup that removes the record when the run ends.
 */
export async function registerRun(cancel, root = cacheBase()) {
  const directory = runsDirectory(root);
  await mkdir(directory, { recursive: true });
  const gate = path.join(path.resolve(root), '.flush');
  if (await exists(gate)) throw new Error('veo flush is in progress. Try again after cleanup finishes.');
  const taken = new Set((await readRecords(root)).map(run => run.id).filter(Boolean));
  let id = null;
  for (let attempt = 0; attempt < 20 && !id; attempt++) {
    const candidate = newRunId();
    if (!taken.has(candidate)) id = candidate;
  }
  if (!id) throw new Error('Could not allocate a free run id. Remove stale run records with veo stop or veo flush.');
  const file = path.join(directory, `${randomUUID()}.json`);
  const request = `${file}.cancel`;
  const record = { version: 1, id, pid: process.pid, startedAt: new Date().toISOString(),
    urls: [], output: null, media: null, quality: null, format: null, playlist: false, job: null };
  await writeJson(file, record);
  // A flush that started while this run registered must still win.
  if (await exists(gate)) {
    await rm(file, { force: true });
    throw new Error('veo flush is in progress. Try again after cleanup finishes.');
  }
  const timer = setInterval(() => { exists(request).then(found => { if (found) cancel(); }).catch(() => {}); }, 200);
  timer.unref();
  return {
    id,
    file,
    /** Merge what this run resolved, so other terminals can inspect it. */
    async describe(details = {}) {
      Object.assign(record, {
        urls: (Array.isArray(details.urls) ? details.urls : []).filter(url => typeof url === 'string').slice(0, 200).map(cleanText),
        output: text(details.output) || null,
        media: details.audio ? 'audio' : 'video',
        quality: details.audio ? null : text(details.quality) || null,
        format: text(details.format) || null,
        playlist: Boolean(details.playlist),
        job: text(details.job) || null,
      });
      await writeJson(file, record);
    },
    async unregister() {
      clearInterval(timer);
      await rm(file, { force: true });
      await rm(request, { force: true });
    },
  };
}

/** Per-item progress of a run, read from the job file it writes as it works. */
async function readProgress(jobFile) {
  if (!jobFile) return null;
  const job = await readRecordFile(jobFile);
  if (job?.version !== 1 || !Array.isArray(job.items)) return null;
  const items = job.items.map(item => ({
    url: text(item?.url),
    status: ITEM_STATUSES.has(item?.status) ? item.status : 'pending',
    files: (Array.isArray(item?.files) ? item.files : []).map(text).filter(Boolean),
    error: text(item?.error) || null,
  }));
  const counts = { total: items.length, pending: 0, running: 0, saved: 0, skipped: 0, failed: 0, cancelled: 0 };
  for (const item of items) counts[item.status]++;
  return { items, counts };
}

async function describeRuns(root) {
  const runs = await listRuns(root);
  return Promise.all(runs.map(async run => ({ ...run, progress: await readProgress(run.job) })));
}

export function summarizeProgress(progress) {
  const counts = progress?.counts;
  if (!counts?.total) return 'starting';
  const parts = [];
  const done = counts.saved + counts.skipped;
  if (done) parts.push(`${done}/${counts.total} done`);
  if (counts.running) parts.push(`${counts.running} running`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
  if (counts.pending) parts.push(parts.length ? `${counts.pending} pending` : `${counts.total} pending`);
  return parts.join(', ');
}

function shortDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

const shorten = (value, width = OUTPUT_WIDTH) => value.length <= width ? value : `…${value.slice(-(width - 1))}`;
const label = run => run.id || `PID ${run.pid}`;
// Records of older versions have no start time, so no uptime can be shown.
const uptime = run => Number.isFinite(Date.parse(run.startedAt)) ? shortDuration(Date.now() - Date.parse(run.startedAt)) : null;

function describeMedia(run) {
  const detail = run.media === 'audio' ? run.format : run.quality;
  return `${run.media || 'not resolved yet'}${detail ? `, ${detail}` : ''}${run.playlist ? ', playlist' : ''}`;
}

export function formatRuns(runs) {
  if (!runs.length) return 'veo runs\n\nNo veo runs are active. Start a download to see it here.\n';
  const rows = runs.map(run => {
    const running = uptime(run);
    return [run.id || '-', String(run.pid), run.alive ? `running${running ? ` ${running}` : ''}` : 'stale',
      localStamp(run.startedAt), summarizeProgress(run.progress), run.output ? shorten(text(run.output)) : '-'];
  });
  const header = ['ID', 'PID', 'STATE', 'STARTED', 'ITEMS', 'OUTPUT'];
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map(row => row[index].length)));
  const line = cells => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd();
  return `${['veo runs', '', line(header), ...rows.map(line), '', 'Details: veo runs <id>    Stop: veo stop [id]'].join('\n')}\n`;
}

export function formatRunDetails(run) {
  const lines = [`veo runs ${run.id || '-'}`, ''];
  const running = uptime(run);
  lines.push(`State:   ${run.alive ? `running (PID ${run.pid})` : `stale (PID ${run.pid} is gone)`}`);
  lines.push(`Started: ${localStamp(run.startedAt)}${run.alive && running ? ` (${running} ago)` : ''}`);
  lines.push(`Media:   ${describeMedia(run)}`);
  lines.push(`Output:  ${text(run.output) || 'not resolved yet'}`);
  lines.push(`Job:     ${text(run.job) || 'not created yet'}`);
  const urls = (Array.isArray(run.urls) ? run.urls : []).map(text).filter(Boolean);
  lines.push(`URLs:    ${urls.length ? `${urls.length}` : 'not resolved yet'}`);
  urls.slice(0, SHOWN_ITEMS).forEach((url, index) => lines.push(`  ${index + 1}. ${url}`));
  if (urls.length > SHOWN_ITEMS) lines.push(`  … and ${urls.length - SHOWN_ITEMS} more`);
  const items = run.progress?.items || [];
  if (items.length) {
    lines.push(`Items:   ${summarizeProgress(run.progress)}`);
    items.slice(0, SHOWN_ITEMS).forEach((item, index) => {
      const files = item.files.length ? `  ${item.files[0]}${item.files.length > 1 ? ` (+${item.files.length - 1} file(s))` : ''}` : '';
      lines.push(`  ${String(index + 1).padStart(2)}. ${item.status}${item.status === 'saved' ? files : `  ${item.url}`}`);
      if (item.error) lines.push(`      ${item.error}`);
    });
    if (items.length > SHOWN_ITEMS) lines.push(`  … and ${items.length - SHOWN_ITEMS} more item(s)`);
  }
  lines.push('');
  lines.push(run.alive && run.id ? `Stop:    veo stop ${run.id}` : 'Cleanup: veo stop  (removes stale records)');
  return `${lines.join('\n')}\n`;
}

function normalizeId(value) {
  const id = cleanText(value).toLowerCase();
  if (!RUN_ID.test(id)) throw new Error(`Invalid run id "${cleanText(value)}". Run ids have 6 characters and are listed by veo runs.`);
  return id;
}

export async function runsMain(args = [], { stdout = process.stdout, root = cacheBase() } = {}) {
  [args, stdout] = commandOutput(args, stdout);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    stdout.write(RUNS_HELP);
    return 0;
  }
  if (args.length > 1) throw new Error('Usage: veo runs [id]');
  const runs = await describeRuns(root);
  if (!args.length) {
    stdout.write(formatRuns(runs));
    return 0;
  }
  const id = normalizeId(args[0]);
  const run = runs.find(item => item.id === id);
  if (!run) throw new Error(`No veo run with id ${id} is active. List runs with veo runs.`);
  stdout.write(formatRunDetails(run));
  return 0;
}

/**
 * A run answers a stop request by cleaning up its own record, so a run counts as
 * gone as soon as its record disappears — a live-looking process is not enough
 * (the pid may already belong to something else).
 */
export async function waitForExit(runs, timeoutMs) {
  const pending = async () => {
    for (const run of runs) if (alive(run.pid) && await exists(run.file)) return true;
    return false;
  };
  const deadline = Date.now() + timeoutMs;
  while (await pending()) {
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
  return true;
}

export async function stopMain(args = [], { stdout = process.stdout, root = cacheBase(), timeoutMs = STOP_TIMEOUT_MS } = {}) {
  [args, stdout] = commandOutput(args, stdout);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    stdout.write(STOP_HELP);
    return 0;
  }
  if (args.length > 1) throw new Error('Usage: veo stop [id]');
  let targets = await listRuns(root);
  if (args.length) {
    const id = normalizeId(args[0]);
    targets = targets.filter(run => run.id === id);
    if (!targets.length) throw new Error(`No veo run with id ${id} is active. List runs with veo runs.`);
  }
  const stale = targets.filter(run => !run.alive);
  const live = targets.filter(run => run.alive);
  for (const run of live) await writeFile(`${run.file}.cancel`, 'stop');
  if (live.length) await waitForExit(live, timeoutMs);
  const remaining = [];
  for (const run of live) if (await exists(run.file) && alive(run.pid)) remaining.push(run);
  const stopped = live.filter(run => !remaining.includes(run));
  for (const run of [...stale, ...stopped]) {
    await rm(run.file, { force: true });
    await rm(`${run.file}.cancel`, { force: true });
  }
  const lines = ['veo stop', ''];
  if (stopped.length) lines.push(`Stopped: ${stopped.map(label).join(', ')}`);
  if (stale.length) lines.push(`Removed ${stale.length} stale record(s): ${stale.map(label).join(', ')}`);
  if (remaining.length) lines.push(`Still running: ${remaining.map(label).join(', ')}`);
  if (!stopped.length && !stale.length && !remaining.length) lines.push('No veo runs were active.');
  if (stopped.length) lines.push('', 'Partial data and retry jobs are kept; veo flush removes them.');
  stdout.write(`${lines.join('\n')}\n`);
  return remaining.length ? 1 : 0;
}
