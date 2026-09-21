import path from 'node:path';
import { stat, statfs } from 'node:fs/promises';

const reservations = new Map();
export function estimateMediaBytes(metadata, options = {}) {
  const size = format => {
    const direct = format.filesize || format.filesize_approx;
    if (Number.isFinite(direct) && direct > 0) return direct;
    return Number.isFinite(format.tbr) && metadata.duration > 0 ? format.tbr * 1000 / 8 * metadata.duration : 0;
  };
  if (size(metadata)) return Math.ceil(size(metadata));
  const target = options.quality && options.quality !== 'best' ? parseInt(options.quality, 10) : Infinity;
  const formats = (metadata.formats || []).filter(format => !format.has_drm && (options.closestQuality || !format.height || format.height <= target));
  const video = formats.filter(format => format.vcodec !== 'none');
  const audio = formats.filter(format => format.vcodec === 'none' && format.acodec !== 'none');
  const bestVideo = Math.max(0, ...video.map(size));
  const bestAudio = Math.max(0, ...audio.map(size));
  if (options.audio) return bestAudio ? Math.ceil(bestAudio) : null;
  if (!bestVideo) return null;
  // Separate video needs an audio estimate too; otherwise the total is unknown.
  if (video.some(format => format.acodec === 'none') && !bestAudio) return null;
  return Math.ceil(bestVideo + bestAudio);
}

async function volume(directory) {
  let current = path.resolve(directory);
  while (true) {
    try {
      const info = await stat(current);
      if (info.isDirectory()) {
        const fs = await statfs(current);
        return { key: String(info.dev), free: fs.bavail * fs.bsize };
      }
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('No existing parent directory.');
    current = parent;
  }
}

export async function reserveSpace({ cache, destination, bytes, cached = false, reporter, inspect = volume } = {}) {
  let cacheVolume, outputVolume;
  try { [cacheVolume, outputVolume] = await Promise.all([inspect(cache), inspect(destination)]); }
  catch { reporter?.status('Free-space check unavailable on this filesystem; continuing.'); return () => {}; }
  if (!Number.isFinite(bytes) || bytes <= 0) {
    reporter?.status(`Size unknown; free space: cache ${(cacheVolume.free / 1073741824).toFixed(1)} GiB, destination ${(outputVolume.free / 1073741824).toFixed(1)} GiB.`);
    return () => {};
  }
  // Allow space for temporary merge output and destination copy. Conservative even
  // when the filesystem can hard-link; conversion sizes remain estimates.
  const needs = new Map();
  for (const [volume, amount] of [[cacheVolume, cached ? 0 : bytes * 2], [outputVolume, bytes]]) {
    const entry = needs.get(volume.key) || { free: volume.free, bytes: 0 };
    entry.free = Math.min(entry.free, volume.free); entry.bytes += amount;
    needs.set(volume.key, entry);
  }
  for (const [key, need] of needs) {
    const available = need.free - (reservations.get(key) || 0);
    if (available < need.bytes) throw new Error(`Not enough disk space: approximately ${(need.bytes / 1048576).toFixed(1)} MiB needed including temporary files; ${(Math.max(0, available) / 1048576).toFixed(1)} MiB available after active downloads.`);
  }
  for (const [key, need] of needs) reservations.set(key, (reservations.get(key) || 0) + need.bytes);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const [key, need] of needs) { const remaining = (reservations.get(key) || 0) - need.bytes; if (remaining > 0) reservations.set(key, remaining); else reservations.delete(key); }
  };
}
