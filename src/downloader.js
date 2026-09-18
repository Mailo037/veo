import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { lstat, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveBackend } from './backend.js';
import { availableHeights, cappedHeight, closestHeight, saveUnique, sanitizeTitle } from './utils.js';

const STAGING_PREFIX = '.veo-';
const PARTIAL_PREFIX = '.veo-part-';
const STAGED_MEDIA = /^media(?:-(\d+))?\.([A-Za-z0-9]{1,8})$/;
// Only real media extensions may count as the downloaded file, so a thumbnail
// or a subtitle that the backend leaves behind is never mistaken for it.
const MEDIA_EXTENSIONS = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', '3gp', 'ts', 'flv', 'mpg', 'mpeg', 'ogv',
  'mp3', 'm4a', 'aac', 'opus', 'flac', 'wav', 'ogg', 'oga', 'wma', 'mka', 'aiff']);

export function isStagedMedia(name) {
  const match = STAGED_MEDIA.exec(name);
  return Boolean(match) && MEDIA_EXTENSIONS.has(match[2].toLowerCase());
}

export function runBackend(executable, args, { signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = '';
    let errors = '';
    let failure;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (onLine) {
        try { onLine(line); } catch (error) { failure = error; child.kill(); }
      } else if (output.length < 32 * 1024 * 1024) output += `${line}\n`;
      else { failure = new Error('Video metadata exceeded the supported size.'); child.kill(); }
    });
    child.stderr.on('data', data => { errors = (errors + data).slice(-16000); });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      lines.close();
      if (failure) reject(failure);
      else if (signal?.aborted) reject(new DOMException('Cancelled', 'AbortError'));
      else if (code !== 0) reject(new Error(errors || `Downloading backend exited with code ${code}.`));
      else resolve(output);
    });
  });
}

export function formatSelector(height) {
  const filter = height ? `[height=${height}]` : '';
  return `bv${filter}+ba/b${filter}/bv${filter}`;
}

/**
 * Turn a requested quality into backend arguments and a user-facing label.
 *
 * Default (upper bound): the best resolution at or below the request, so
 * `-q 720p` on a phone plan can never silently fetch 2160p. A source that
 * offers nothing at or below the request fails before anything is downloaded,
 * naming the resolutions that do exist.
 * `--closest-quality` keeps the historical "nearest available height" rule.
 * Sources without resolution metadata fall back to the best available stream,
 * and collections use the backend's own resolution preference per entry.
 */
export function selectQuality({ quality = 'best', audio = false, closest = false, formats, playlist = false } = {}) {
  if (audio || quality === 'best') return { format: null, sort: null, label: null };
  const target = Number.parseInt(quality, 10);
  if (playlist) {
    // Entries differ in resolution, so cap them inside the backend instead.
    return {
      format: null,
      sort: `res:${target}`,
      label: closest ? `Quality: closest to ${target}p per entry` : `Quality: up to ${target}p per entry`,
    };
  }
  const heights = availableHeights(formats);
  if (!heights.length) return { format: null, sort: null, label: 'Resolution unknown; using the best available stream.' };
  if (closest) {
    const height = closestHeight(formats, quality);
    return {
      format: formatSelector(height),
      sort: null,
      label: `Quality: ${height}p${height === target ? '' : ` (closest to ${quality})`}`,
    };
  }
  const height = cappedHeight(formats, quality);
  if (!height) {
    const offered = [...heights].sort((a, b) => a - b).map(value => `${value}p`).join(', ');
    return {
      format: null,
      sort: null,
      label: null,
      error: `No stream at or below ${target}p is available (offered: ${offered}). Use a higher --quality or "best".`,
    };
  }
  return {
    format: formatSelector(height),
    sort: null,
    label: `Quality: ${height}p${height === target ? '' : ` (highest at or below ${quality})`}`,
  };
}

/**
 * A stable, filesystem-safe key for one video, so a re-run with --resume finds
 * the same staging directory. Site ids are untrusted input and never used raw.
 */
export function partialKey(metadata, url) {
  const id = String(metadata?.id ?? '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  if (id) return id;
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 16);
}

/**
 * Resuming reuses a predictable directory name, so it must not follow a
 * symlink or a file that another process placed there.
 */
async function prepareStaging(directory, partials) {
  if (!partials) return mkdtemp(path.join(directory, STAGING_PREFIX));
  try {
    await mkdir(partials);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = await lstat(partials).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`The partial download path is not a plain directory: ${partials}`);
  return partials;
}

/**
 * A finished download whose save step failed earlier is already complete; using
 * it avoids relying on the backend's "--no-overwrites" skip behaviour.
 * Returns the largest staged media file, ignoring fragments and .part files.
 */
export async function findFinishedMedia(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isStagedMedia(entry.name)) continue;
    const file = path.join(directory, entry.name);
    candidates.push({ file, size: (await stat(file).catch(() => ({ size: 0 }))).size });
  }
  return candidates.sort((a, b) => b.size - a.size)[0]?.file;
}

// Formats the backend may leave beside the media file. An allowlist keeps
// merge fragments such as media.f137.mp4 out, since they are never deliverables.
const SIDECAR_EXTENSIONS = new Set(['vtt', 'srt', 'ass', 'lrc', 'ttml', 'srv1', 'srv2', 'srv3', 'json', 'jpg', 'jpeg', 'png', 'webp']);

/** Files a download may leave beside the media file (subtitles, thumbnails). */
export function isSidecar(name) {
  if (name.startsWith('.') || isStagedMedia(name)) return false;
  return SIDECAR_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase());
}

/**
 * Title of one staged file. An explicit --rename wins, and collections use the
 * matching entry title so every entry keeps its own name.
 */
export function stagedTitle(file, metadata, rename) {
  const index = isStagedMedia(path.basename(file)) ? STAGED_MEDIA.exec(path.basename(file))[1] : undefined;
  if (rename) return index ? `${rename} - ${index}` : rename;
  const fallback = metadata?.title || metadata?.id || 'video';
  if (!index) return fallback;
  return metadata?.entries?.[Number(index) - 1]?.title || `${fallback} - ${index}`;
}

function backendArgs(options, backend) {
  const common = ['--ignore-config', '--no-plugin-dirs', '--no-colors', '--no-warnings',
    '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3',
    '--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`,
    '--ffmpeg-location', backend.ffmpegLocation];
  if (!options.playlist) common.push('--no-playlist');
  if (options.concurrentFragments) common.push('--concurrent-fragments', String(options.concurrentFragments));
  // Credentials are opt-in per invocation and only ever forwarded to the backend,
  // which never bypasses access controls on its own.
  if (options.cookies) common.push('--cookies', options.cookies);
  if (options.cookiesFromBrowser) common.push('--cookies-from-browser', options.cookiesFromBrowser);
  return common;
}

function mediaArgs(options, quality) {
  const args = ['--no-overwrites', options.resume ? '--continue' : '--no-continue', '--newline',
    '--progress', '--progress-delta', '0.2',
    '--progress-template', 'download:veo-progress:%(progress)j',
    '--print', 'after_move:veo-file:%(filepath)j', '--no-simulate'];
  if (options.audio) args.push('-f', 'ba/b', '--extract-audio', '--audio-format', options.format || 'mp3', '--audio-quality', '0');
  else {
    if (quality.format) args.push('-f', quality.format);
    // Merge into a permissive container first; e.g. H.264 cannot be merged
    // straight into WebM before the requested codec conversion runs.
    if (options.format) args.push('--merge-output-format', 'mkv', '--recode-video', options.format);
    else args.push('--merge-output-format', 'mp4/mkv');
  }
  const sort = ['vcodec:h264,acodec:aac', quality.sort].filter(Boolean).join(',');
  // Codec preference only applies when the source container is kept; a
  // deliberate conversion should start from the best source available.
  if (!options.audio && sort) args.push('-S', options.format ? quality.sort : sort);
  if (options.subs || options.subLangs || options.embedSubs) {
    args.push('--write-subs', '--sub-langs', options.subLangs || 'en.*,en');
  }
  if (options.embedSubs) args.push('--embed-subs');
  if (options.embedMetadata) args.push('--embed-metadata');
  if (options.embedThumbnail) args.push('--embed-thumbnail');
  if (options.sponsorblockRemove) args.push('--sponsorblock-remove', options.sponsorblockRemove);
  if (options.section) args.push('--download-sections', options.section, '--force-keyframes-at-cuts');
  return args;
}

export function stagingTemplate(directory, playlist) {
  const name = playlist ? 'media-%(playlist_index)03d.%(ext)s' : 'media.%(ext)s';
  return path.join(directory, name).replaceAll('%', '%%').replace('%%(playlist_index)03d', '%(playlist_index)03d').replace('%%(ext)s', '%(ext)s');
}

/** Read video metadata once, with the same vetted arguments as a download. */
export async function fetchMetadata(options, { signal, backend, runner, reporter } = {}) {
  const common = backendArgs(options, backend);
  reporter?.status('Reading video…');
  const args = [...common, '--dump-single-json', '--skip-download'];
  if (options.playlist) args.push('--flat-playlist');
  args.push('--', options.url);
  const metadata = JSON.parse(await runner(backend.ytDlp, args, { signal }));
  if (!options.playlist && (metadata._type === 'playlist' || metadata.entries)) {
    throw new Error('This URL is a collection. Add --playlist to download every entry.');
  }
  if (!options.playlist && metadata.is_live) throw new Error('Live streams are not supported. Please use a finished video.');
  if (metadata.has_drm) throw new Error('This content is DRM-protected.');
  return metadata;
}

export async function prepareBackend(options, { signal, backendResolver = resolveBackend, reporter } = {}) {
  return backendResolver({ signal, onStatus: message => reporter?.status(message) });
}

/** The extension the finished file will most likely have, for previews. */
export function predictedExtension(options) {
  if (options.audio) return options.format || 'mp3';
  return options.format || 'mp4';
}

/** First free destination name, without creating anything (preview only). */
export async function previewPath(directory, title, extension, { exists = async () => false } = {}) {
  const name = sanitizeTitle(title);
  for (let number = 0; ; number++) {
    const candidate = path.join(directory, `${name}${number ? ` (${number})` : ''}.${extension}`);
    if (!await exists(candidate)) return candidate;
  }
}

/** `veo --list-formats`: print the backend's own format table and stop. */
export async function listFormats(options, { signal, backendResolver = resolveBackend, runner = runBackend, reporter } = {}) {
  const backend = await prepareBackend(options, { signal, backendResolver, reporter });
  reporter?.status('Reading available formats…');
  return runner(backend.ytDlp, [...backendArgs(options, backend), '-F', '--', options.url], { signal });
}

/**
 * `veo --dry-run`: inspect the video and report what would happen without
 * downloading or writing anything.
 */
export async function planDownload(options, { signal, backendResolver = resolveBackend, runner = runBackend, reporter } = {}) {
  const directory = path.resolve(options.output);
  const backend = await prepareBackend(options, { signal, backendResolver, reporter });
  const metadata = await fetchMetadata(options, { signal, backend, runner, reporter });
  const quality = selectQuality({ quality: options.quality, audio: options.audio, closest: options.closestQuality, formats: metadata.formats, playlist: options.playlist });
  if (quality.error) throw new Error(quality.error);
  const titles = options.playlist && metadata.entries?.length
    ? metadata.entries.map((entry, index) => entry.title || `${metadata.title || 'video'} - ${index + 1}`)
    : [options.rename ?? (metadata.title || metadata.id || 'video')];
  const extension = predictedExtension(options);
  const exists = async candidate => Boolean(await stat(candidate).catch(() => undefined));
  const planned = [];
  for (const title of titles) planned.push({ title, path: await previewPath(directory, title, extension, { exists }) });
  return { url: options.url, playlist: Boolean(options.playlist), quality: quality.label, entries: planned };
}

/**
 * Download one URL. Returns every file that was saved, in the order the
 * backend produced them, so collections and subtitle sidecars are reported.
 */
export async function download(options, { signal, reporter, backendResolver = resolveBackend, runner = runBackend } = {}) {
  const directory = path.resolve(options.output);
  await mkdir(directory, { recursive: true });
  const backend = await prepareBackend(options, { signal, backendResolver, reporter });
  const metadata = await fetchMetadata(options, { signal, backend, runner, reporter });
  const playlist = Boolean(options.playlist);
  reporter?.name?.(options.rename ?? (metadata.title || metadata.id || 'video'));
  const quality = selectQuality({ quality: options.quality, audio: options.audio, closest: options.closestQuality, formats: metadata.formats, playlist });
  if (quality.error) throw new Error(quality.error);
  if (quality.label) reporter?.status(quality.label);

  const staging = await prepareStaging(directory, options.resume ? path.join(directory, `${PARTIAL_PREFIX}${partialKey(metadata, options.url)}`) : undefined);
  let keepPartial = false;
  try {
    let staged = [];
    if (options.resume) {
      const finished = await findFinishedMedia(staging);
      if (finished) {
        staged = [finished];
        reporter?.status('Saving the finished partial download…');
      }
    }
    if (!staged.length) {
      const args = [...backendArgs(options, backend), ...mediaArgs(options, quality), '-o', stagingTemplate(staging, playlist), '--', options.url];
      reporter?.status(options.audio ? 'Downloading audio…' : 'Downloading…');
      await runner(backend.ytDlp, args, { signal, onLine(line) {
        if (line.startsWith('veo-progress:')) reporter?.progress(JSON.parse(line.slice('veo-progress:'.length)));
        if (line.startsWith('veo-file:')) staged.push(JSON.parse(line.slice('veo-file:'.length)));
      } });
    }
    // Cancellation must win over any follow-up error so the caller can report
    // "Cancelled." instead of a confusing backend message.
    signal?.throwIfAborted();
    if (!staged.length) throw new Error('The backend finished without producing a file.');

    const files = [];
    for (const stagedFile of staged) {
      const resolved = path.resolve(stagedFile);
      // The backend must only ever hand back a file inside our staging directory.
      if (path.dirname(resolved) !== staging || !(await stat(resolved)).isFile()) throw new Error('The backend returned an invalid saved file path.');
      const saved = await saveUnique(resolved, directory, stagedTitle(resolved, metadata, options.rename), { signal });
      files.push(saved);
      files.push(...await saveSidecars(staging, resolved, saved, { signal }));
    }
    return { url: options.url, title: metadata.title || metadata.id || 'video', files };
  } catch (error) {
    // A kept staging directory is the whole point of --resume, and cancellation
    // is the most common reason to want one.
    keepPartial = Boolean(options.resume);
    throw error;
  } finally {
    reporter?.finish();
    if (keepPartial) reporter?.status(`Partial download kept in ${staging}. Re-run with --resume to continue it, or delete the folder.`);
    else await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Move subtitle and thumbnail files beside the saved media file, keeping the
 * media name as the prefix (Title.mp4 -> Title.en.vtt). Collections pair each
 * file with the sidecars that share its index.
 */
async function saveSidecars(staging, stagedMedia, savedMedia, { signal } = {}) {
  const written = [];
  const stem = path.basename(stagedMedia, path.extname(stagedMedia));
  const base = path.basename(savedMedia, path.extname(savedMedia));
  const entries = await readdir(staging, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !isSidecar(entry.name) || !entry.name.startsWith(`${stem}.`)) continue;
    const suffix = path.basename(entry.name, path.extname(entry.name)).slice(stem.length);
    written.push(await saveUnique(path.join(staging, entry.name), path.dirname(savedMedia), `${base}${suffix}`, { signal }));
  }
  return written;
}
