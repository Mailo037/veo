import { translateLegacyConfigComments } from './legacy-config-comments.js';

export const TEMPLATE_MARKER = '// veo: commented configuration template';

export const CONFIG_TEMPLATE = String.raw`${TEMPLATE_MARKER}
// Save and close the editor. Settings apply the next time you run veo.
// Comments using // or /* ... */ are supported. Command-line options take priority.
// To enable an option, remove its leading // and adjust the value.
// Separate active entries with commas. Do not add a comma after the last entry.
{
  // Output directory: use / or double backslashes, for example "D:\\Videos".
  // Without output, downloads are saved in the current working directory.
  // "output": "D:/Videos",

  // Maximum video resolution: best, 2160p, 1440p, 1080p, 720p, ...
  // "quality": "1080p",
  // Video format: mp4, mkv, webm, mov. Conversion can take time.
  // "format": "mp4",
  // "open": false,              // Open the completed file automatically
  // "resume": true,             // Resume interrupted downloads
  // "skipExisting": true,       // Skip previously saved downloads
  // "concurrentFragments": 4,   // Concurrent fragments: 1 to 16

  // Subtitles and additional information:
  // "subLangs": "de,en",        // Enable subtitles for these languages
  // "embedSubs": true,          // Embed subtitles in the video
  // "embedMetadata": true,      // Embed the title, date and other metadata
  // "embedThumbnail": true,     // Embed the thumbnail

  // Profiles are activated only with --profile NAME or in the interactive wizard.
  // Example: veo "https://example.com/video.mp4" --profile music
  "profiles": {
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
      result += '  '; i++;
      let closed = false;
      while (++i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') { result += '  '; i++; closed = true; break; }
        result += '\r\n'.includes(text[i]) ? text[i] : ' ';
      }
      if (!closed) throw new Error('Unterminated config comment.');
    } else result += char;
  }
  return result;
}

export function withConfigTemplate(text) {
  text = translateLegacyConfigComments(text);
  if (!text.replace(/^\uFEFF/, '').trim()) return CONFIG_TEMPLATE;
  if (text.replace(/^\uFEFF/, '').startsWith(TEMPLATE_MARKER)) return text;
  // Keep existing settings and formatting byte-for-byte after a commented guide.
  return `${TEMPLATE_MARKER}\n// Reference: copy any examples you need into your existing configuration below.\n${CONFIG_TEMPLATE.split('\n').slice(1).map(line => `// ${line}`).join('\n')}\n// Your existing settings:\n${text.replace(/^\uFEFF/, '')}`;
}
