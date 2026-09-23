import { createHash } from 'node:crypto';
import { translateLegacyConfigComments } from './legacy-config-comments.js';

export const TEMPLATE_MARKER = '// veo: commented configuration template';

export const SOURCE_OPTIONS_GUIDE = String.raw`// veo: source discovery options v1
// Copy these settings into the global object or a named profile if desired.
// "deepScan": true,          // Verify every observed media candidate instead of the first 30
// "timeout": "2m",          // Discovery deadline: 5s to 10m; plain numbers mean seconds
// "listSources": false,     // true = list sources and exit for single-URL calls
// "autoListSources": false, // true = search after extraction fails, without a yes/no prompt
// Command-line flags override these values, including --no-deep-scan and --no-list-sources.
`;

const PROFILE_OPTIONS_MARKER = '// veo: profile download options v4';
export const PROFILE_OPTIONS_GUIDE = String.raw`${PROFILE_OPTIONS_MARKER}
// Any global option can also be placed inside a profile.
// Copy the settings you want into "profiles" > "default" or a named profile.
// Remove the leading // on copied settings; separate entries with commas.
// Speed without reducing the selected video quality:
// "quality": "best",
// "concurrentDownloads": 2,    // Parallel URLs/batch items: 1-4; default 2
// "adaptiveConcurrency": true, // Reduce parallelism and retry transient errors
// "concurrentFragments": 8,    // DASH/HLS fragments: 1-16; default 8
// "deepScan": true,           // Check every observed source candidate
// "timeout": "2m",           // Source-search deadline, 5s to 10m
// "listSources": false,      // List sources and exit for one URL
// "autoListSources": true,   // Search after extraction fails, without asking
// "playlist": true,            // Enable only for playlist downloads
// "playlistConcurrency": 2,    // Simultaneous entries: 1-4; default 2
// "checkSpace": true,          // Estimate free cache/output space first
// "timings": true,             // Show time spent in each phase
// "color": true,               // Gray details and colored results; false = plain text
// Applies to veo's own terminal output, including stats/history/doctor.
// Each profile can set color independently; NO_COLOR always disables styling.
// Example inside profiles: "plain": { "color": false }
// Use: veo stats --profile plain or veo URL --profile plain
// "folderTemplate": "{channel}/{year}",
// "filenameTemplate": "{index} - {title}", // Without extension; do not combine with rename
// "resume": true,
// "skipExisting": true
// Lossless container change (the selected codecs must fit the container):
// "format": "mkv",
// "compatible": false,        // Opt-in H.264/AAC MP4; converts only when needed
// "recode": false
// Compatibility profile to add inside profiles:
// "kompatibel": { "audio": false, "format": "mp4", "compatible": true, "recode": false }
// Use: veo URL --profile kompatibel (or simply veo URL --compatible).
// Optional conversion instead: "format": "webm", "recode": true
// Conversion can be slower and lose quality; recode is for video only.
// Sequential downloads: "concurrentDownloads": 1, "concurrentFragments": 1, "playlistConcurrency": 1
// Example named profile inside the profiles object:
// "fast": { "quality": "best", "concurrentFragments": 8, "playlistConcurrency": 2, "resume": true }
// Use with: veo URL --profile fast (add --playlist for a playlist URL).
// Inspect: veo config show --profile fast | Validate: veo config check
// Template fields: {title}, {id}, {channel}, {year}, {playlist}, {index}.
// Missing values use Unknown channel/year, No playlist, unknown ID, index 001.
`;

const TEMPLATE_SOURCE = String.raw`${TEMPLATE_MARKER}
// Save and close the editor. Settings apply the next time you run veo.
// Comments using // or /* ... */ are supported. Command-line options take priority.
// To enable an option, remove its leading // and adjust the value.
// Separate active entries with commas. Do not add a comma after the last entry.
{
  // Output directory: use / or double backslashes, for example "D:\\Videos".
  // Without output, downloads are saved in the current working directory.
  // "output": "D:/Videos",
  // Filename without extension. Every * inserts the original video title.
  // "rename": "movie_*",

  // Maximum video resolution: best, 2160p, 1440p, 1080p, 720p, ...
  // "quality": "1080p",
  // "closestQuality": false, // Allow the nearest available resolution
  // Video format: mp4, mkv, webm, mov. Lossless remux; codecs must fit the container.
  // "format": "mp4",
  // "recode": false,           // Explicit video conversion; may lose quality
  // "playlistConcurrency": 2, // Concurrent playlist entries: 1 to 4
  // "playlistItems": "1-5",  // Download only these playlist entries
  // "section": "*10:00-12:00", // Download only a time range
  // "open": false,              // Open the completed file automatically
  // "resume": true,             // Resume interrupted downloads
  // "skipExisting": true,       // Skip previously saved downloads
  // "concurrentFragments": 8,   // Concurrent fragments: 1 to 16; default 8
  // "cookies": "D:/cookies.txt", // Netscape-format cookies file
  // "cookiesFromBrowser": "firefox", // Use your browser's cookies
  // "sponsorblockRemove": "sponsor", // Remove matching SponsorBlock segments
  // "json": false,            // Print machine-readable output for downloads

${SOURCE_OPTIONS_GUIDE}

  // Subtitles and additional information:
  // "subs": true,              // Download subtitles; defaults to English
  // "subLangs": "de,en",        // Enable subtitles for these languages
  // "embedSubs": true,          // Embed subtitles in the video
  // "embedMetadata": true,      // Embed the title, date and other metadata
  // "embedThumbnail": true,     // Embed the thumbnail

  // The default profile is used automatically unless you select another profile.
${PROFILE_OPTIONS_GUIDE}
  // Select other profiles with --profile NAME or in the interactive wizard.
  // Example: veo "https://example.com/video.mp4" --profile music
  "profiles": {
    "default": {
      // "color": true, // Set false to disable terminal styling for this profile.
      // Add everyday defaults here, for example: "quality": "1080p"
      // Empty means use the global settings above and veo's built-in defaults.
    },
    "kompatibel": {
      "audio": false,
      "format": "mp4",
      "compatible": true,
      "recode": false
    },
    "music": {
      // Audio only. Formats: mp3, m4a, aac, opus, flac, wav.
      "audio": true,
      "format": "mp3"
    },
    "archive": {
      "quality": "1080p",
      "embedMetadata": true,
      "subLangs": "de,en"
    }
  }
}
`;

// The revision follows the template content, so future examples refresh without
// maintaining a separate version number.
const TEMPLATE_REVISION = createHash('sha256').update(TEMPLATE_SOURCE).digest('hex').slice(0, 12);
const REVISION_LINE = `// veo: template revision ${TEMPLATE_REVISION}`;
const REFERENCE_BEGIN = '// veo: template reference begin';
const REFERENCE_END = '// veo: template reference end';
export const CONFIG_TEMPLATE = TEMPLATE_SOURCE.replace(TEMPLATE_MARKER, `${TEMPLATE_MARKER}\n${REVISION_LINE}`);

function currentReference() {
  const examples = CONFIG_TEMPLATE.split('\n').slice(2).map(line => `// ${line}`).join('\n');
  return `${REFERENCE_BEGIN} ${TEMPLATE_REVISION}\n// This generated reference is refreshed when the template changes. Keep personal notes below it.\n// Current veo options: copy the settings you need below.\n${examples}\n${REFERENCE_END}`;
}

// Remove comments only outside JSON strings. Whitespace replacement preserves
// token boundaries, so malformed input cannot become valid by joining tokens.
export function stripConfigComments(text) {
  text = text.replace(/^\uFEFF/, '');
  let result = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      result += char;
      if (char === '\\' && i + 1 < text.length) result += text[++i];
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; result += char; }
    else if (char === '/' && text[i + 1] === '/') {
      result += '  '; i++;
      while (i + 1 < text.length && !'\r\n'.includes(text[i + 1])) { result += ' '; i++; }
    } else if (char === '/' && text[i + 1] === '*') {
      const commentStart = i;
      result += '  '; i++;
      let closed = false;
      while (++i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') { result += '  '; i++; closed = true; break; }
        result += '\r\n'.includes(text[i]) ? text[i] : ' ';
      }
      if (!closed) throw Object.assign(new Error('Unterminated block comment; add */ to close it.'), { position: commentStart });
    } else result += char;
  }
  return result;
}

export function withConfigTemplate(text) {
  text = translateLegacyConfigComments(text);
  text = addDefaultProfile(text);
  if (!text.replace(/^\uFEFF/, '').trim()) return CONFIG_TEMPLATE;
  text = text.replace(/^\uFEFF/, '');
  const reference = currentReference();
  const begin = text.indexOf(REFERENCE_BEGIN);
  const end = begin < 0 ? -1 : text.indexOf(REFERENCE_END, begin);
  if (begin >= 0 && end < 0) return text; // Never replace an incomplete user-edited block.
  if (begin >= 0 && end >= 0) {
    if (text.slice(begin, end).startsWith(`${REFERENCE_BEGIN} ${TEMPLATE_REVISION}\n`)) return text;
    const endOfLine = text.indexOf('\n', end);
    const after = endOfLine < 0 ? text.length : endOfLine;
    return text.slice(0, begin) + reference + text.slice(after);
  }
  if (text.startsWith(TEMPLATE_MARKER) && text.slice(0, 200).includes(REVISION_LINE)) return text;
  if (text.startsWith(TEMPLATE_MARKER)) {
    // Replace the older generated reference prefix, if present. Everything
    // below the user's settings marker stays exactly as it was.
    const settingsMarker = '// Your existing settings:';
    const settingsAt = text.indexOf(settingsMarker);
    if (text.includes('// Reference: copy any examples') && settingsAt >= 0) {
      return `${TEMPLATE_MARKER}\n${reference}\n${text.slice(settingsAt)}`;
    }
    return text.replace(TEMPLATE_MARKER, `${TEMPLATE_MARKER}\n${reference}`);
  }
  return `${TEMPLATE_MARKER}\n${reference}\n// Your existing settings:\n${text}`;
}

function addDefaultProfile(text) {
  // Insert only the missing profile, preserving user comments and formatting.
  let clean, config;
  try { clean = stripConfigComments(text); config = JSON.parse(clean); } catch { return text; }
  if (!config || Array.isArray(config) || typeof config !== 'object') return text;
  if (config.profiles && Object.hasOwn(config.profiles, 'default')) return text;
  if (config.profiles !== undefined && (!config.profiles || Array.isArray(config.profiles) || typeof config.profiles !== 'object')) return text;
  text = text.replace(/^\uFEFF/, '');
  // Track depth to find the top-level profiles object, never a profile named profiles.
  let depth = 0;
  const tokens = /"(?:\\.|[^"\\])*"|[{}]/g;
  for (const token of clean.matchAll(tokens)) {
    if (token[0] === '{') depth++;
    else if (token[0] === '}') depth--;
    else if (depth === 1 && token[0] === '"profiles"') {
      const after = token.index + token[0].length;
      const match = /^\s*:\s*\{/.exec(clean.slice(after));
      if (!match) continue;
      const index = after + match[0].length;
      return text.slice(0, index) + '\n    // Used automatically when no other profile is selected.\n    "default": {}' + (Object.keys(config.profiles).length ? ',' : '') + '\n' + text.slice(index);
    }
  }
  const index = clean.indexOf('{') + 1;
  return text.slice(0, index) + '\n  // Used automatically when no other profile is selected.\n  "profiles": { "default": {} }' + (Object.keys(config).length ? ',' : '') + '\n' + text.slice(index);
}
