import { cleanText } from './utils.js';
import { createTerminalTitle } from './terminal-title.js';

const PROCESSING_LABELS = { Merger: 'Merging audio/video', VideoRemuxer: 'Changing video container', VideoConvertor: 'Converting video', ExtractAudio: 'Converting audio', EmbedSubtitle: 'Embedding subtitles', Metadata: 'Writing metadata', EmbedThumbnail: 'Embedding thumbnail', MoveFiles: 'Preparing saved file' };

export function styleText(stream, text, role = 'muted', enabled = true, env = process.env) {
  if (!enabled || !stream.isTTY || Object.hasOwn(env, 'NO_COLOR') || env.TERM === 'dumb') return text;
  const codes = { muted: 90, title: 1, success: 32, error: 31 };
  return '\x1b[' + (codes[role] || 90) + 'm' + text + '\x1b[0m';
}

function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
}

// Count terminal cells conservatively, including wide titles and emoji.
function cells(text) {
  return [...text].reduce((width, char) => width + (/\p{Mark}|\u200d/u.test(char) ? 0 : /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1), 0);
}

function fit(text, width) {
  if (cells(text) <= width) return text;
  let result = '';
  for (const char of text) {
    if (cells(result + char) > width - 1) break;
    result += char;
  }
  return width > 0 ? result + '…' : '';
}

export function formatProgress(data, { columns = Infinity, prefix = '' } = {}) {
  const done = Number.isFinite(data.downloaded_bytes) ? data.downloaded_bytes : 0;
  const total = data.total_bytes || data.total_bytes_estimate;
  const estimated = !data.total_bytes && Boolean(data.total_bytes_estimate);
  const percent = total > 0 ? Math.max(0, Math.min(estimated && data.status !== 'finished' ? 99 : 100, done / total * 100)) : null;
  const filled = percent === null ? 0 : Math.round(percent / 5);
  const eta = Number.isFinite(data.eta) ? `${Math.floor(data.eta / 60)}:${String(Math.floor(data.eta % 60)).padStart(2, '0')}` : '?';
  const pct = `${estimated && data.status !== 'finished' ? '~' : ''}${percent === null ? '?' : percent.toFixed(0)}%`;
  const size = `${estimated ? '~' : ''}${bytes(total)}`;
  const compact = value => bytes(value).replace(' ', '');
  const label = prefix ? fit(cleanText(prefix), Math.max(0, Math.floor(columns / 3))) + ' ' : '';
  const variants = data.status === 'finished'
    ? [`${bytes(done)} received; processing…`, `${compact(done)} received`, 'Received']
    : [
      `[${'='.repeat(filled)}${'-'.repeat(20 - filled)}] ${pct.padStart(4)}  ${bytes(data.speed)}/s  ${bytes(done)} / ${size}  ETA ${eta}`,
      `${pct} ${compact(data.speed)}/s ${compact(done)}/${estimated ? '~' : ''}${compact(total)} ETA ${eta}`,
      `${pct} ${compact(data.speed)}/s ETA ${eta}`,
      `${pct} ${compact(done)}`,
      pct,
    ];
  for (const variant of variants) if (cells(label + variant) <= columns) return label + variant;
  return fit(variants.at(-1), columns);
}

export function createReporter(stream = process.stderr, { setTitle = createTerminalTitle(stream) } = {}) {
  let color = true;
  const muted = text => styleText(stream, text, 'muted', color);
  const heading = text => styleText(stream, text, 'title', color);
  let active = false;
  let lastLog = 0;
  let name = '';
  let phase = 'Starting…';
  let started = false;
  let position = '';
  let hasItem = false;
  let streamName = '';
  const line = (data, prefix) => formatProgress(data, { prefix, columns: stream.isTTY ? Math.max(1, (stream.columns || 80) - 1) : Infinity });
  const draw = (data, prefix) => { stream.write(`\r\x1b[2K${line(data, prefix)}`); active = true; };
  const updateTitle = () => setTitle(`veo | ${phase}${name ? ` | ${name}` : ''}`);
  function clear() {
    if (active && stream.isTTY) stream.write('\r\x1b[2K');
    active = false;
  }
  const scoped = (index, total, title, parent = '') => {
    let childName = cleanText(title), lastProgress = 0;
    const prefix = parent + '[' + index + '/' + total + '] ';
    const log = (message, quiet = true) => {
      clear();
      const line = prefix + childName + ': ' + cleanText(message);
      stream.write((quiet ? muted(line) : line) + '\n');
      phase = cleanText(message); name = childName;
      if (started) updateTitle();
    };
    return {
      scoped: (index, total, title) => scoped(index, total, title, prefix),
      name(value) { childName = cleanText(value); },
      status: log,
      progress(data) {
        if (stream.isTTY) {
          draw(data, prefix + childName + ': ' + (data.stream || 'Media'));
        } else if (Date.now() - lastProgress >= 5000 || data.status === 'finished') {
          log((data.stream || 'Media') + ' ' + formatProgress(data), false);
          lastProgress = Date.now();
        }
      },
      processing(data) { log((PROCESSING_LABELS[data.postprocessor] || 'Processing media') + (data.status === 'finished' ? ': done' : '…')); },
      finish() {},
    };
  };
  return {
    configure(options) { color = options.color !== false; },
    scoped,
    item(index, total, title) {
      clear(); position = total > 1 ? `[${index}/${total}] ` : ''; hasItem = true; name = cleanText(title); streamName = ''; lastLog = 0;
      stream.write(heading(`${position}${name}`) + '\n');
      phase = 'Starting…'; if (started) updateTitle();
    },
    processing(data) {
      const processor = cleanText(data.postprocessor || 'Processing');
      const label = PROCESSING_LABELS[processor] || 'Processing media';
      clear(); phase = `${label}${data.status === 'finished' ? ': done' : '…'}`;
      if (started) updateTitle();
      stream.write(muted(`${position}${phase}`) + '\n');
    },
    start(title = '') { started = true; name = cleanText(title); phase = 'Starting…'; updateTitle(); },
    name(title) {
      const next = cleanText(title);
      if (hasItem && next !== name) { clear(); stream.write(heading(`${position}${next}`) + '\n'); }
      name = next; if (started) updateTitle();
    },
    status(message) {
      clear();
      phase = cleanText(message);
      if (started) updateTitle();
      stream.write(muted(phase) + '\n');
    },
    complete() { clear(); phase = 'Done'; if (started) updateTitle(); },
    fail(cancelled = false) { clear(); phase = cancelled ? 'Cancelled' : 'Failed'; if (started) updateTitle(); },
    progress(data) {
      if (data.stream && data.stream !== streamName) {
        clear(); streamName = data.stream; lastLog = 0;
        stream.write(muted(`${position}${streamName} download`) + '\n');
      }
      const total = data.total_bytes;
      const percent = Number.isFinite(total) && total > 0 && Number.isFinite(data.downloaded_bytes)
        ? Math.max(0, Math.min(100, Math.round(data.downloaded_bytes / total * 100))) : null;
      phase = data.status === 'finished' ? 'Processing…' : percent === null ? 'Downloading…' : `${percent}%`;
      if (started) updateTitle();
      if (stream.isTTY) {
        draw(data, `${position}${streamName}`);
      } else if (Date.now() - lastLog >= 5000 || data.status === 'finished') {
        stream.write(`${position}${streamName ? `${streamName} ` : ''}${formatProgress(data)}\n`);
        lastLog = Date.now();
      }
    },
    finish: clear,
  };
}
