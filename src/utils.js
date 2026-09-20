import path from 'node:path';
import { copyFile, link, lstat, unlink } from 'node:fs/promises';
import { accessSync, constants, statSync } from 'node:fs';

export const QUALITIES = ['best', '2160p', '1440p', '1080p', '720p', '480p', '360p'];
export const VIDEO_FORMATS = ['mp4', 'mkv', 'webm', 'mov'];
export const AUDIO_FORMATS = ['mp3', 'm4a', 'aac', 'opus', 'flac', 'wav'];
// Browsers yt-dlp can read cookies from. veo only forwards the choice; it never
// decrypts or copies cookie stores itself.
export const COOKIE_BROWSERS = ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale'];
const COOKIE_KEYRINGS = ['gnomekeyring', 'kwallet', 'basic'];

export function validateUrl(input) {
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw new Error('Invalid URL. Use a complete http:// or https:// video URL without embedded credentials.');
  }
}

// Untrusted site titles must never become paths, terminal escapes, or device names.
export function sanitizeTitle(title) {
  let name = String(title || 'video').normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '_')
    .trim().replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  let shortened = '';
  for (const char of name) {
    if (Buffer.byteLength(shortened + char) > 180) break;
    shortened += char;
  }
  return shortened.replace(/[. ]+$/g, '') || 'video';
}

export function cleanText(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
}

/** Locale-independent local timestamp for CLI output, e.g. "2026-02-03 14:22". */
export function localStamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Validate a Netscape-format cookie file before any network work starts, so a
 * typo fails immediately instead of after backend acquisition. The file is only
 * read by the backend; veo never parses or stores its contents.
 */
export function validateCookieFile(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('--cookies requires the path to a Netscape-format cookie file.');
  if (raw.includes('\0')) throw new Error('The cookie file path contains an invalid character.');
  const file = path.resolve(raw);
  let info;
  try {
    info = statSync(file);
  } catch {
    throw new Error(`The cookie file does not exist: ${file}`);
  }
  if (!info.isFile()) throw new Error(`The cookie file is not a regular file: ${file}`);
  try {
    accessSync(file, constants.R_OK);
  } catch {
    throw new Error(`The cookie file is not readable: ${file}`);
  }
  return file;
}

// yt-dlp syntax: BROWSER[+KEYRING][:PROFILE][::CONTAINER]
export function validateBrowserSpec(input) {
  const value = cleanText(input).trim();
  if (!value) throw new Error('--cookies-from-browser requires a browser name.');
  const [head, container, ...extraContainers] = value.split('::');
  if (extraContainers.length) throw new Error('--cookies-from-browser accepts at most BROWSER[:PROFILE][::CONTAINER].');
  const [browserPart, profile, ...extraProfiles] = head.split(':');
  if (extraProfiles.length) throw new Error('--cookies-from-browser accepts at most BROWSER[:PROFILE][::CONTAINER].');
  const [name, keyring, ...extraKeyrings] = browserPart.split('+');
  if (!COOKIE_BROWSERS.includes(name.toLowerCase())) {
    throw new Error(`Unsupported browser for --cookies-from-browser. Choose: ${COOKIE_BROWSERS.join(', ')}.`);
  }
  if (extraKeyrings.length) throw new Error('At most one keyring may follow "+" in --cookies-from-browser.');
  if (keyring && !COOKIE_KEYRINGS.includes(keyring.toLowerCase())) {
    throw new Error(`Unsupported keyring for --cookies-from-browser. Choose: ${COOKIE_KEYRINGS.join(', ')}.`);
  }
  for (const [label, part] of [['profile', profile], ['container', container]]) {
    if (part === undefined) continue;
    if (!part.trim() || cleanText(part) !== part.trim() || part.trim().startsWith('-')) {
      throw new Error(`The --cookies-from-browser ${label} is empty or contains invalid characters.`);
    }
  }
  return value;
}

// A cookie file readable by other accounts is a credential leak worth one line.
export function cookieFileWarning(file, { platform = process.platform, stat = statSync } = {}) {
  if (!file || platform === 'win32') return null;
  try {
    if ((stat(file).mode & 0o077) !== 0) return `Warning: ${file} is readable by other users. Restrict it with: chmod 600 "${file}"`;
  } catch { /* The file was validated earlier; a race here is not worth reporting. */ }
  return null;
}

// Video heights a site actually offers, ignoring audio-only and DRM entries.
export function availableHeights(formats) {
  return [...new Set((formats || [])
    .filter(format => format && format.vcodec !== 'none' && !format.has_drm && Number.isFinite(format.height) && format.height > 0)
    .map(format => format.height))];
}

export function closestHeight(formats, quality) {
  if (quality === 'best') return null;
  const target = Number.parseInt(quality, 10);
  // Equidistant alternatives prefer the smaller download.
  return availableHeights(formats).sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b)[0] ?? null;
}

/** The highest offered resolution at or below the request, or undefined. */
export function cappedHeight(formats, quality) {
  const target = Number.parseInt(quality, 10);
  return availableHeights(formats).filter(height => height <= target).sort((a, b) => b - a)[0];
}

// Filesystems without hard links (FAT/exFAT, some SMB and container mounts)
// report one of these; anything else is a real error and must surface.
const NO_HARDLINK = new Set(['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EINVAL']);

/**
 * Occupy `destination` without ever replacing an existing file. Returns false
 * when the name is taken. Local staging can be on another drive, so a hard
 * link is an O(1) metadata operation when supported; cross-drive saves and
 * filesystems that cannot link fall back to copying. Both paths are race-safe
 * against concurrent veo processes.
 */
export async function allocate(source, destination, { linkImpl = link, copyImpl = copyFile } = {}) {
  try {
    await linkImpl(source, destination);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    if (error.code === 'EISDIR') {
      // Some virtual drives report EISDIR for unsupported hard links even when
      // the source is a regular file. Do not mistake a real directory for media.
      if (!(await lstat(source)).isFile()) throw error;
      const existing = await lstat(destination).catch(problem => {
        if (problem.code === 'ENOENT') return null;
        throw problem;
      });
      if (existing) return false;
    } else if (!NO_HARDLINK.has(error.code)) throw error;
  }
  try {
    await copyImpl(source, destination, constants.COPYFILE_EXCL);
    const [sourceInfo, destinationInfo] = await Promise.all([lstat(source), lstat(destination)]);
    if (sourceInfo.size !== destinationInfo.size) {
      await unlink(destination);
      throw new Error('The saved copy has an unexpected size. The local original has been preserved.');
    }
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export async function saveUnique(source, directory, title, { signal, keepSource = false } = {}) {
  const extension = path.extname(source).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) throw new Error('The backend returned an invalid output extension.');
  const name = sanitizeTitle(title);
  for (let number = 0; ; number++) {
    signal?.throwIfAborted();
    const destination = path.join(directory, `${name}${number ? ` (${number})` : ''}${extension}`);
    if (!await allocate(source, destination)) continue;
    // The destination keeps the content, so a failing unlink only leaves a
    // second name that the caller's staging cleanup removes.
    if (!keepSource) await unlink(source).catch(() => {});
    return destination;
  }
}

export function readableError(error) {
  if (error.name === 'AbortError') return 'Cancelled.';
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'Permission denied. Choose a writable output directory or check executable permissions.';
  if (error.code === 'ENOSPC') return 'Not enough disk space to save the download.';
  const text = cleanText(error.message || error);
  if (/unsupported url|no suitable extractor/i.test(text)) return 'This URL or website is not supported by the downloading backend.';
  if (/private|login required|sign in|log in|authentication|members.only|not a bot|cookies/i.test(text)) return 'This content is private or requires authentication. veo does not bypass access controls. If you are authorized to view it, pass your own session with --cookies <file> or --cookies-from-browser <browser>.';
  if (/deleted|removed|no longer available|404|not found|does not exist/i.test(text)) return 'The content was deleted, removed, or could not be found.';
  if (/requested format|no video formats|no suitable formats|conversion failed|error opening encoder|could not find tag/i.test(text)) return 'The requested format is unavailable or could not be converted. Try -q best or another --format.';
  if (/drm.protected|digital rights/i.test(text)) return 'This content is DRM-protected. veo does not remove DRM.';
  if (/network|timed? ?out|connection|resolve|ENOTFOUND|ECONN|fetch failed|HTTP Error (403|429|5\d\d)/i.test(text)) return 'Network request failed or the site blocked the request. Check your connection and URL, then try again later.';
  if (/not available|unavailable|geo.?restrict|country/i.test(text)) return 'This content is unavailable or restricted in your region.';
  return text.slice(-1200) || 'Download failed. Please try again.';
}
