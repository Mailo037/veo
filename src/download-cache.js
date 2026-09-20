import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { cacheBase } from './paths.js';
import { readJson } from './state.js';

export const TRANSFER_RETENTION_MS = 15 * 60 * 1000;
export const downloadCacheRoot = () => path.join(cacheBase(), 'downloads');

export async function cleanupDownloadCache(root = downloadCacheRoot(), now = Date.now()) {
  await mkdir(root, { recursive: true });
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.veo-part-[a-f0-9]{24}$/.test(entry.name)) continue;
    const directory = path.resolve(root, entry.name);
    const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (path.dirname(directory) !== path.resolve(root) || !info?.isDirectory() || info.isSymbolicLink()) continue;
    const lockPath = path.join(directory, '.lock');
    let lock;
    try { lock = await open(lockPath, 'wx'); }
    catch (error) { if (error.code === 'EEXIST' || error.code === 'ENOENT') continue; throw error; }
    let expired = false;
    try {
      const manifest = await readJson(path.join(directory, 'job.json'), null);
      expired = manifest?.version === 1 && Number.isFinite(manifest.expiresAt) && manifest.expiresAt <= now;
    } catch { /* Unknown state is left untouched. */ }
    finally { await lock.close(); }
    if (expired) {
      // Lock remains present until our private cache directory is removed.
      await rm(directory, { recursive: true, force: true });
    } else await rm(lockPath, { force: true });
  }
}
