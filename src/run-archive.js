import { createHash } from 'node:crypto';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { cacheBase } from './paths.js';
import { readJson, writeJson } from './state.js';

export const RUN_ARCHIVE_ID = /^[0-9a-z]{6}$/;
const SAMPLE_BYTES = 64 * 1024;
const MAX_SEARCH_FILES = 200_000;
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.mp3', '.m4a', '.aac', '.opus', '.ogg', '.flac', '.wav', '.mka', '.ts']);

export function runArchiveFile(id, root = cacheBase()) {
  if (!RUN_ARCHIVE_ID.test(id)) throw new Error('Run ids have 6 letters or digits.');
  return path.join(path.resolve(root), 'run-history', `${id}.json`);
}

export function isMediaFile(file) { return MEDIA_EXTENSIONS.has(path.extname(file).toLowerCase()); }

async function regularFile(file) {
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return info?.isFile() && !info.isSymbolicLink() ? info : null;
}

/** Sample three parts of a file so renames can be found without rereading a huge video. */
export async function fileFingerprint(file, knownInfo) {
  const info = knownInfo || await regularFile(file);
  if (!info) return null;
  const digest = createHash('sha256').update(`veo-file-v1:${info.size}:`);
  const positions = [...new Set([0, Math.floor(Math.max(0, info.size - SAMPLE_BYTES) / 2), Math.max(0, info.size - SAMPLE_BYTES)])];
  const handle = await open(file, 'r');
  try {
    for (const position of positions) {
      const bytes = Math.min(SAMPLE_BYTES, info.size - position);
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, position);
      if (bytesRead !== bytes) throw new Error(`File changed while recording its identity: ${file}`);
      digest.update(String(position)).update(':').update(buffer);
    }
  } finally { await handle.close(); }
  return { size: info.size, sampleSha256: digest.digest('hex'),
    device: info.dev, inode: info.ino };
}

export async function archiveRun(job, { root = cacheBase(), now = new Date() } = {}) {
  const id = job.runId;
  if (!RUN_ARCHIVE_ID.test(id || '')) return null;
  const items = [];
  for (const item of job.items || []) {
    const files = [];
    for (const file of item.files || []) {
      const media = isMediaFile(file);
      files.push({ originalPath: path.resolve(file), media,
        fingerprint: media ? item.fingerprints?.[file] || await fileFingerprint(file).catch(() => null) : null });
    }
    items.push({ url: item.url, status: item.status, error: item.error || null,
      output: path.resolve(item.options?.output || job.options?.output || process.cwd()), files });
  }
  const archived = { version: 1, id, startedAt: job.startedAt || null, finishedAt: now.toISOString(),
    status: items.every(item => ['saved', 'skipped'].includes(item.status)) ? 'completed' : 'incomplete', items };
  if (await lstat(runArchiveFile(id, root)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    throw new Error(`Run archive ${id} already exists; refusing to overwrite it.`);
  }
  await writeJson(runArchiveFile(id, root), archived);
  return archived;
}

export async function readRunArchive(id, root = cacheBase()) {
  const archive = await readJson(runArchiveFile(id, root), null);
  if (!archive) throw new Error(`No finished run with id ${id} was found. Active runs appear in veo runs --json.`);
  if (archive.version !== 1 || archive.id !== id || !Array.isArray(archive.items)) throw new Error(`Invalid archived run: ${id}`);
  return archive;
}

async function scan(root, wantedSizes, signal) {
  const info = await regularFile(root);
  if (info) throw new Error(`Search root is a file: ${root}`);
  const directory = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!directory) return [];
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(`Search root is not a plain directory: ${root}`);
  const candidates = [];
  const pending = [root];
  let seen = 0;
  while (pending.length) {
    signal?.throwIfAborted();
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        if (++seen > MAX_SEARCH_FILES) throw new Error(`Too many files under ${root}; use --search with a narrower directory.`);
        const details = await regularFile(file);
        if (details && wantedSizes.has(details.size)) candidates.push({ file, details });
      }
    }
  }
  return candidates;
}

/** Resolve original paths first, then use fingerprints to find renamed media. */
export async function locateRunFiles(archive, { searchRoot, signal } = {}) {
  const items = [];
  const missing = [];
  for (const item of archive.items) {
    signal?.throwIfAborted();
    const files = [];
    for (const entry of item.files || []) {
      const details = await regularFile(entry.originalPath);
      const fingerprint = details && entry.fingerprint ? await fileFingerprint(entry.originalPath, details).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : null;
      const valid = details && (!entry.fingerprint || (fingerprint?.size === entry.fingerprint.size && fingerprint.sampleSha256 === entry.fingerprint.sampleSha256));
      const resolved = { originalPath: entry.originalPath, path: valid ? entry.originalPath : null,
        found: Boolean(valid), renamed: false, media: Boolean(entry.media) };
      files.push(resolved);
      if (!valid && entry.media && entry.fingerprint) missing.push({ resolved, entry, output: item.output });
    }
    items.push({ url: item.url, status: item.status, error: item.error || null, files });
  }
  if (missing.length) {
    const roots = [...new Set(missing.map(item => item.output).concat(searchRoot ? [path.resolve(searchRoot)] : []))];
    const wanted = new Set(missing.map(item => item.entry.fingerprint.size));
    const matches = new Map();
    for (const root of roots) for (const candidate of await scan(root, wanted, signal)) {
      signal?.throwIfAborted();
      const fingerprint = await fileFingerprint(candidate.file, candidate.details).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!fingerprint) continue;
      const key = `${fingerprint.size}:${fingerprint.sampleSha256}`;
      const paths = matches.get(key) || new Set();
      paths.add(candidate.file);
      matches.set(key, paths);
    }
    for (const { resolved, entry } of missing) {
      const key = `${entry.fingerprint.size}:${entry.fingerprint.sampleSha256}`;
      const paths = [...(matches.get(key) || [])];
      let selected = paths.length === 1 ? paths[0] : null;
      if (!selected && paths.length > 1 && entry.fingerprint.inode > 0) {
        const sameFile = [];
        for (const file of paths) {
          const details = await regularFile(file);
          if (details?.dev === entry.fingerprint.device && details.ino === entry.fingerprint.inode) sameFile.push(file);
        }
        if (sameFile.length === 1) selected = sameFile[0];
      }
      if (selected) {
        resolved.path = selected; resolved.found = true; resolved.renamed = selected !== entry.originalPath;
      } else if (paths.length > 1) resolved.candidates = paths;
    }
  }
  return items;
}
