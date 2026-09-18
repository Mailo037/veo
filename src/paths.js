import os from 'node:os';
import path from 'node:path';

/**
 * Single source of truth for veo's per-user cache root. Used for the yt-dlp
 * backend, the staged FFmpeg binaries, and small state files.
 * An invalid relative OS cache setting must never write into the output directory.
 */
export function cacheBase({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  let base;
  if (platform === 'win32') base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  else if (platform === 'darwin') base = path.join(home, 'Library', 'Caches');
  else base = env.XDG_CACHE_HOME || path.join(home, '.cache');
  if (!path.isAbsolute(base)) base = path.join(home, '.cache');
  return path.join(base, 'veo');
}

/** Per-user configuration directory, following each platform's own convention. */
export function configBase({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  let base;
  if (platform === 'win32') base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  else if (platform === 'darwin') base = path.join(home, 'Library', 'Application Support');
  else base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  if (!path.isAbsolute(base)) base = path.join(home, '.config');
  return path.join(base, 'veo');
}
