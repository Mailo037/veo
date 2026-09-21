import { commandOutput } from './output.js';
import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { cacheBase } from './paths.js';
import { readJson, writeJson } from './state.js';
import { cleanText, localStamp } from './utils.js';

/**
 * `veo history` shows the most recent download attempts. Every finished item is
 * written as its own small file named after its millisecond timestamp, so
 * parallel veo runs never rewrite each other's records and the newest entries
 * can be listed without parsing an ever-growing log.
 */
export const HISTORY_LIMIT = 5;
const SHOWN_FILES = 5;
const MAX_FILES = 200;
const STATUSES = new Set(['saved', 'skipped', 'failed', 'cancelled']);
const NAME = /^(\d{13})-[a-f0-9-]{36}\.json$/;

export const HISTORY_HELP = `veo history [--json]

Show the last ${HISTORY_LIMIT} download attempts, newest first, with title, status, media
type, date, URL and saved files. Saved, skipped, failed and cancelled items are
recorded; playlist entries and retried attempts count individually.
Use veo history --json for scripting. History is kept in the per-user veo cache
and survives veo flush. Active downloads appear once they finish.
`;

/** Directory holding one JSON record per finished download attempt. */
export function historyRoot(root = cacheBase()) {
  return path.join(path.resolve(root), 'history');
}

function valid(record) {
  return record?.version === 1
    && Number.isFinite(Date.parse(record.at))
    && typeof record.url === 'string' && Boolean(record.url)
    && typeof record.title === 'string'
    && STATUSES.has(record.status)
    && ['video', 'audio'].includes(record.media)
    && [record.quality, record.format, record.error].every(value => value === null || typeof value === 'string')
    && Array.isArray(record.files) && record.files.every(file => typeof file === 'string' && Boolean(file));
}

// Only strings can become history text; a missing title must not become "undefined".
function text(value, limit) {
  if (typeof value !== 'string') return '';
  const cleaned = cleanText(value);
  return limit === undefined ? cleaned : cleaned.slice(0, limit);
}

/**
 * Records must never write into the output directory, contain terminal escapes
 * or grow without bound, so untrusted titles, paths and messages are cleaned and
 * the file list is capped here.
 */
export function createHistoryRecorder(root = cacheBase(), { now = Date.now } = {}) {
  const directory = historyRoot(root);
  let previous = 0;
  return async item => {
    // Strictly increasing names keep "newest first" deterministic even when
    // several items finish inside the same millisecond.
    const at = Math.max(now(), previous + 1);
    previous = at;
    const audio = Boolean(item.audio);
    const record = {
      version: 1,
      at: new Date(at).toISOString(),
      url: text(item.url),
      title: text(item.title) || text(item.url),
      status: STATUSES.has(item.status) ? item.status : 'failed',
      media: audio ? 'audio' : 'video',
      quality: audio ? null : text(item.quality) || null,
      format: text(item.format) || (audio ? 'mp3' : null),
      files: (Array.isArray(item.files) ? item.files : []).slice(0, MAX_FILES).map(file => text(file)).filter(Boolean),
      error: text(item.error, 400) || null,
      elapsedMs: Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0 ? Math.round(item.elapsedMs) : 0,
    };
    await writeJson(path.join(directory, `${at}-${randomUUID()}.json`), record);
  };
}

/** The newest `limit` records, newest first. Missing history is not an error. */
export async function readHistory(root = cacheBase(), limit = HISTORY_LIMIT) {
  const directory = historyRoot(root);
  const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Invalid history directory: ${directory}`);
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && NAME.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => Number(b.slice(0, 13)) - Number(a.slice(0, 13)));
  const records = [];
  for (const name of names) {
    if (records.length >= limit) break;
    const file = path.join(directory, name);
    const record = await readJson(file, null);
    if (!valid(record)) throw new Error(`Invalid history file: ${file}`);
    records.push(record);
  }
  return records;
}

function describeDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

function describeMedia(entry) {
  const detail = entry.media === 'audio' ? entry.format : entry.quality;
  return detail ? `${entry.media}, ${detail}` : entry.media;
}

export function formatHistory(entries, limit = HISTORY_LIMIT) {
  if (!entries.length) return 'veo history\n\nNo downloads recorded yet. Download something with veo first.\n';
  const lines = [`veo history (last ${limit}, newest first)`, ''];
  for (const [index, entry] of entries.entries()) {
    lines.push(`${index + 1}. ${entry.title}`);
    lines.push(`   Status: ${entry.status}${entry.status === 'skipped' ? ' (already on disk)' : ''}`);
    lines.push(`   Media:  ${describeMedia(entry)}`);
    lines.push(`   Date:   ${localStamp(entry.at)}${entry.elapsedMs ? ` (${describeDuration(entry.elapsedMs)})` : ''}`);
    lines.push(`   URL:    ${entry.url}`);
    if (entry.error) lines.push(`   Error:  ${entry.error}`);
    for (const [position, file] of entry.files.slice(0, SHOWN_FILES).entries()) {
      lines.push(`${position ? '           ' : '   Saved:  '}${file}`);
    }
    if (entry.files.length > SHOWN_FILES) lines.push(`           … and ${entry.files.length - SHOWN_FILES} more file(s); use veo history --json for the full list.`);
    if (index !== entries.length - 1) lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export async function historyMain(args = [], { stdout = process.stdout, root = cacheBase(), limit = HISTORY_LIMIT } = {}) {
  [args, stdout] = commandOutput(args, stdout);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    stdout.write(HISTORY_HELP);
    return 0;
  }
  if (args.length && (args.length !== 1 || args[0] !== '--json')) throw new Error('Usage: veo history [--json]');
  const entries = await readHistory(root, limit);
  if (args[0] === '--json') stdout.write(`${JSON.stringify({ count: entries.length, entries })}\n`);
  else stdout.write(formatHistory(entries, limit));
  return 0;
}
