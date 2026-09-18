import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
export const RELEASE = '2026.08.19';
const RELEASE_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${RELEASE}`;
const MAX_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 180_000;
// Official hashes fetched at development time; never trust a runtime checksum download.
// https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/SHA2-256SUMS
const HASHES = Object.freeze({
  'yt-dlp.exe': '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a',
  'yt-dlp_arm64.exe': '05b438997bafc3affdfda9d041353c9d73e04dc842207254b655b0887c4445b0',
  'yt-dlp_x86.exe': 'a8f91bd41452506bc81ebd2f369b186fea0ee7075413ba00cef9fd346a0a5d0c',
  'yt-dlp_macos': '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
  'yt-dlp_linux': '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a',
  'yt-dlp_linux_aarch64': 'b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc',
  'yt-dlp_musllinux': 'f3dec9cfeaf304cec98290fe41c6ad465d4b747d302473559643e7af24929722',
  'yt-dlp_musllinux_aarch64': '17b164c4d258be92bb1ad146cb7c336b783aedb380814aabbcb7d52937f77e57',
});

export function selectAsset(platform = process.platform, arch = process.arch, musl = false) {
  if (platform === 'win32') return { x64: 'yt-dlp.exe', arm64: 'yt-dlp_arm64.exe', ia32: 'yt-dlp_x86.exe' }[arch];
  if (platform === 'darwin' && ['x64', 'arm64'].includes(arch)) return 'yt-dlp_macos';
  if (platform === 'linux' && ['x64', 'arm64'].includes(arch)) return `yt-dlp_${musl ? 'musl' : ''}linux${arch === 'arm64' ? '_aarch64' : ''}`;
}

function cacheDirectory(asset) {
  const home = os.homedir();
  let base;
  if (process.platform === 'win32') base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  else if (process.platform === 'darwin') base = path.join(home, 'Library', 'Caches');
  else base = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
  // Invalid relative OS cache settings must not write into the working directory.
  if (!path.isAbsolute(base)) base = path.join(home, '.cache');
  return path.join(base, 'veo', 'backends', RELEASE, `${process.platform}-${process.arch}`);
}

function envPath(name) {
  if (!(name in process.env)) return undefined;
  const value = process.env[name];
  if (!value?.trim() || value.includes('\0')) throw new Error(`${name} must be a non-empty filesystem path.`);
  return path.resolve(value);
}

async function executable(file, label) {
  if (typeof file !== 'string' || !file) throw new Error(`${label} is unavailable on ${process.platform}/${process.arch}.`);
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a regular file');
    await access(file, process.platform === 'win32' ? constants.R_OK : constants.X_OK);
  } catch (cause) {
    throw new Error(`${label} is missing or not executable: ${file}`, { cause });
  }
  return path.resolve(file);
}

async function sha256(file, signal) {
  signal?.throwIfAborted();
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file, { signal })) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error(`Backend file exceeds ${MAX_BYTES / 1024 / 1024} MiB: ${file}`);
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function matches(file, expected, signal) {
  try {
    const info = await lstat(file);
    // Do not accept cached symlinks or special files.
    if (!info.isFile() || info.size > MAX_BYTES) return false;
    return await sha256(file, signal) === expected;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function publish(temp, destination, expected, signal) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32') await chmod(temp, 0o755);
  try {
    await rename(temp, destination);
  } catch (error) {
    // Another process may have finished the same acquisition on Windows.
    if (['EEXIST', 'EPERM', 'EACCES'].includes(error.code)
      && await matches(destination, expected, signal)) return;
    // A directory at the destination is stale cache from an older layout.
    if (['EEXIST', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EISDIR'].includes(error.code)) {
      const info = await lstat(destination).catch(() => undefined);
      if (info?.isDirectory()) {
        await rm(destination, { recursive: true, force: true });
        try { await rename(temp, destination); return; } catch { /* Fall through. */ }
      }
    }
    throw error;
  }
}

async function acquire(asset, directory, signal, status) {
  const destination = path.join(directory, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  const expected = HASHES[asset];
  status('Checking yt-dlp…');
  if (await matches(destination, expected, signal)) {
    if (process.platform !== 'win32') await chmod(destination, 0o755);
    return destination;
  }
  const temp = `${destination}.${randomUUID()}.tmp`;
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT);
  const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  status(`Downloading yt-dlp ${RELEASE} (first use)…`);
  try {
    const response = await fetch(`${RELEASE_URL}/${asset}`, { signal: downloadSignal });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`yt-dlp download failed: HTTP ${response.status}.`);
    }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body.cancel();
      throw new Error('yt-dlp download exceeds the size limit.');
    }
    let bytes = 0;
    const hash = createHash('sha256');
    const verifier = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) return callback(new Error('yt-dlp download exceeds the size limit.'));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), verifier,
      createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal: downloadSignal });
    if (hash.digest('hex') !== expected) throw new Error('yt-dlp SHA-256 verification failed. The download was discarded.');
    await publish(temp, destination, expected, downloadSignal);
    return destination;
  } catch (cause) {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new Error('yt-dlp download timed out after 3 minutes. Please retry.', { cause });
    throw new Error(`Unable to prepare yt-dlp: ${cause.message} You can set VEO_YT_DLP_PATH to a trusted local executable.`, { cause });
  } finally {
    await rm(temp, { force: true });
  }
}

async function stage(source, destination, signal) {
  const expected = await sha256(source, signal);
  if (await matches(destination, expected, signal)) {
    if (process.platform !== 'win32') await chmod(destination, 0o755);
    return;
  }
  const temp = `${destination}.${randomUUID()}.tmp`;
  try {
    signal?.throwIfAborted();
    await copyFile(source, temp, constants.COPYFILE_EXCL);
    if (!await matches(temp, expected, signal)) throw new Error(`Backend copy verification failed: ${source}`);
    await publish(temp, destination, expected, signal);
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Resolve native tools without executing them or using a shell.
 * VEO_YT_DLP_PATH: trusted executable file; bypasses acquisition/pinned hash checks.
 * VEO_FFMPEG_PATH: directory containing both ffmpeg[.exe] and ffprobe[.exe].
 * Relative overrides resolve against cwd; no PATH search or install-time custom hook.
 * ffmpeg-static's own FFMPEG_BIN override is honored by its normal module API.
 * onStatus receives plain strings. Throws on cancellation or acquisition failure.
 */
export async function resolveBackend({ signal, onStatus } = {}) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
  if (onStatus !== undefined && typeof onStatus !== 'function') throw new TypeError('onStatus must be a function.');
  signal?.throwIfAborted();
  const status = onStatus || (() => {});
  const ytOverride = envPath('VEO_YT_DLP_PATH');
  const ffOverride = envPath('VEO_FFMPEG_PATH');
  // Diagnostic reports expose glibc when linked against it; no shell probe needed.
  const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
  const asset = ytOverride ? undefined : selectAsset(process.platform, process.arch, musl);
  if (!ytOverride && !asset) throw new Error(`No standalone yt-dlp is available for ${process.platform}/${process.arch}. Set VEO_YT_DLP_PATH to a trusted executable.`);
  // Validate overrides and dependencies before doing any network work.
  let ytDlp = ytOverride ? await executable(ytOverride, 'VEO_YT_DLP_PATH') : undefined;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  let ffmpeg;
  let ffprobe;
  if (ffOverride) {
    await executable(path.join(ffOverride, `ffmpeg${suffix}`), 'VEO_FFMPEG_PATH ffmpeg');
    await executable(path.join(ffOverride, `ffprobe${suffix}`), 'VEO_FFMPEG_PATH ffprobe');
  } else {
    // ffprobe-static exits the process on unsupported OSes/arches: guard before require.
    if (!['win32', 'darwin', 'linux'].includes(process.platform)
      || (process.platform === 'darwin' && !['x64', 'arm64'].includes(process.arch))
      || (process.platform === 'win32' && process.arch === 'arm64')) {
      throw new Error('Static media tools do not support this platform. Set VEO_FFMPEG_PATH to a directory containing ffmpeg and ffprobe.');
    }
    try {
      ffmpeg = await executable(require('ffmpeg-static'), 'ffmpeg-static');
      ffprobe = await executable(require('ffprobe-static').path, 'ffprobe-static');
    } catch (cause) {
      throw new Error(`Cannot load media tools: ${cause.message} Install ffmpeg-static and ffprobe-static, or set VEO_FFMPEG_PATH to a directory containing both binaries.`, { cause });
    }
  }
  const directory = cacheDirectory(asset);
  if (!ytOverride || !ffOverride) await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!ytDlp) ytDlp = await acquire(asset, directory, signal, status);
  else status('Using VEO_YT_DLP_PATH override.');
  if (!ffOverride) {
    status('Preparing ffmpeg and ffprobe…');
    await stage(ffmpeg, path.join(directory, `ffmpeg${suffix}`), signal);
    await stage(ffprobe, path.join(directory, `ffprobe${suffix}`), signal);
  } else status('Using VEO_FFMPEG_PATH override.');
  signal?.throwIfAborted();
  return { ytDlp, ffmpegLocation: ffOverride || directory };
}
