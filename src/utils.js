import path from 'node:path';
import { copyFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';

export const QUALITIES = ['best', '2160p', '1440p', '1080p', '720p', '480p', '360p'];
export const VIDEO_FORMATS = ['mp4', 'mkv', 'webm', 'mov'];
export const AUDIO_FORMATS = ['mp3', 'm4a', 'aac', 'opus', 'flac', 'wav'];

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

export function closestHeight(formats, quality) {
  if (quality === 'best') return null;
  const target = Number.parseInt(quality, 10);
  const heights = [...new Set(formats.filter(f => f.vcodec !== 'none' && !f.has_drm && Number.isFinite(f.height) && f.height > 0).map(f => f.height))];
  // Equidistant alternatives prefer the smaller download.
  return heights.sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b)[0] ?? null;
}

// COPYFILE_EXCL makes name allocation race-safe, including concurrent veo processes.
export async function saveUnique(source, directory, title) {
  const extension = path.extname(source).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) throw new Error('The backend returned an invalid output extension.');
  const name = sanitizeTitle(title);
  for (let number = 0; ; number++) {
    const destination = path.join(directory, `${name}${number ? ` (${number})` : ''}${extension}`);
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    await unlink(source);
    return destination;
  }
}

export function readableError(error) {
  if (error.name === 'AbortError') return 'Cancelled.';
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'Permission denied. Choose a writable output directory or check executable permissions.';
  if (error.code === 'ENOSPC') return 'Not enough disk space to save the download.';
  const text = cleanText(error.message || error);
  if (/unsupported url|no suitable extractor/i.test(text)) return 'This URL or website is not supported by the downloading backend.';
  if (/private|login required|sign in|log in|authentication|members.only|not a bot|cookies/i.test(text)) return 'This content is private or requires authentication. veo does not bypass access controls; use a publicly accessible video you are allowed to download.';
  if (/deleted|removed|no longer available|404|not found|does not exist/i.test(text)) return 'The content was deleted, removed, or could not be found.';
  if (/requested format|no video formats|no suitable formats|conversion failed|error opening encoder|could not find tag/i.test(text)) return 'The requested format is unavailable or could not be converted. Try -q best or another --format.';
  if (/drm.protected|digital rights/i.test(text)) return 'This content is DRM-protected. veo does not remove DRM.';
  if (/network|timed? ?out|connection|resolve|ENOTFOUND|ECONN|fetch failed|HTTP Error (403|429|5\d\d)/i.test(text)) return 'Network request failed or the site blocked the request. Check your connection and URL, then try again later.';
  if (/not available|unavailable|geo.?restrict|country/i.test(text)) return 'This content is unavailable or restricted in your region.';
  return text.slice(-1200) || 'Download failed. Please try again.';
}
