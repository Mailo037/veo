import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveBackend } from './backend.js';
import { closestHeight, saveUnique } from './utils.js';

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

export async function download(options, { signal, reporter, backendResolver = resolveBackend } = {}) {
  const directory = path.resolve(options.output);
  await mkdir(directory, { recursive: true });
  const backend = await backendResolver({ signal, onStatus: message => reporter?.status(message) });
  const common = ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-colors', '--no-warnings',
    '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3',
    '--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`,
    '--ffmpeg-location', backend.ffmpegLocation];
  reporter?.status('Reading video…');
  const metadata = JSON.parse(await runBackend(backend.ytDlp,
    [...common, '--dump-single-json', '--skip-download', '--', options.url], { signal }));
  if (metadata._type === 'playlist' || metadata.entries) throw new Error('This URL is a collection. Please provide a single video URL.');
  if (metadata.is_live) throw new Error('Live streams are not supported. Please use a finished video.');
  if (metadata.has_drm) throw new Error('This content is DRM-protected.');
  const title = options.rename ?? (metadata.title || metadata.id || 'video');
  reporter?.name?.(title);
  const height = options.audio ? null : closestHeight(metadata.formats || [metadata], options.quality);
  if (!options.audio && options.quality !== 'best') {
    reporter?.status(height ? `Quality: ${height}p${height !== parseInt(options.quality, 10) ? ` (closest to ${options.quality})` : ''}` : 'Resolution unknown; using the best available stream.');
  }
  const temporary = await mkdtemp(path.join(directory, '.veo-'));
  try {
    // A private staging directory keeps titles out of yt-dlp templates and isolates partial files.
    const template = path.join(temporary, 'media.%(ext)s').replaceAll('%', '%%').replace('%%(ext)s', '%(ext)s');
    const args = [...common, '--no-overwrites', '--no-continue', '--newline', '--progress', '--progress-delta', '0.2',
      '--progress-template', 'download:veo-progress:%(progress)j',
      '--print', 'after_move:veo-file:%(filepath)j', '--no-simulate', '-o', template];
    if (options.audio) args.push('-f', 'ba/b', '--extract-audio', '--audio-format', options.format || 'mp3', '--audio-quality', '0');
    else {
      args.push('-f', formatSelector(height));
      // Merge into a permissive container first; e.g. H.264 cannot be merged
      // straight into WebM before the requested codec conversion runs.
      if (options.format) args.push('--merge-output-format', 'mkv', '--recode-video', options.format);
      else args.push('-S', 'vcodec:h264,acodec:aac', '--merge-output-format', 'mp4/mkv');
    }
    args.push('--', options.url);
    let saved;
    reporter?.status(options.audio ? 'Downloading audio…' : 'Downloading…');
    await runBackend(backend.ytDlp, args, { signal, onLine(line) {
      if (line.startsWith('veo-progress:')) reporter?.progress(JSON.parse(line.slice('veo-progress:'.length)));
      if (line.startsWith('veo-file:')) saved = JSON.parse(line.slice('veo-file:'.length));
    } });
    if (!saved) throw new Error('The backend finished without producing a file.');
    saved = path.resolve(saved);
    if (path.dirname(saved) !== temporary || !(await stat(saved)).isFile()) throw new Error('The backend returned an invalid saved file path.');
    signal?.throwIfAborted();
    return await saveUnique(saved, directory, title);
  } finally {
    reporter?.finish();
    await rm(temporary, { recursive: true, force: true });
  }
}
