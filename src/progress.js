import { cleanText } from './utils.js';
import { createTerminalTitle } from './terminal-title.js';

const PROCESSING_LABELS = { Merger: 'Merging audio/video', VideoRemuxer: 'Changing video container', VideoConvertor: 'Converting video', ExtractAudio: 'Converting audio', EmbedSubtitle: 'Embedding subtitles', Metadata: 'Writing metadata', EmbedThumbnail: 'Embedding thumbnail', MoveFiles: 'Preparing saved file' };

export function styleText(stream, text, role = 'muted', enabled = true, env = process.env) {
  if (!enabled || !stream.isTTY || Object.hasOwn(env, 'NO_COLOR') || env.TERM === 'dumb') return text;
  const codes = { muted: 90, title: 1, profile: 97, success: 32, error: 31 };
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

export function terminalText(stream, text) {
  return fit(cleanText(text), stream.isTTY ? Math.max(1, (stream.columns || 80) - 1) : Infinity);
}

export function terminalTitle(stream, text) {
  const safe = cleanText(text);
  if (!stream.isTTY) return safe;
  const width = Math.max(1, (stream.columns || 80) - 1);
  const lines = [];
  let line = '';
  for (const char of safe) {
    if (cells(line + char) > width) {
      if (lines.length === 2) return [...lines, fit(line + char + '…', width)].join('\n');
      lines.push(line);
      line = '';
    }
    line += char;
  }
  return [...lines, line].join('\n');
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
  const label = prefix ? cleanText(prefix) + ' ' : '';
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
  if (prefix) {
    const variant = variants[Math.min(2, variants.length - 1)];
    const available = columns - cells(variant) - 1;
    if (available > 0) return fit(cleanText(prefix), available) + ' ' + variant;
  }
  return fit(variants.at(-1), columns);
}

export function createReporter(stream = process.stderr, { setTitle = createTerminalTitle(stream), env = process.env } = {}) {
  let color = true;
  const muted = text => styleText(stream, text, 'muted', color, env);
  const heading = text => styleText(stream, text, 'title', color, env);
  let active = false;
  let lastLog = 0;
  let name = '';
  let phase = 'Starting…';
  let started = false;
  let position = '';
  let hasItem = false;
  let streamName = '';
  let animation;
  let animationLabel = '';
  let animationOwner;
  let animationFrame = 0;
  let redraw;
  let listening = false;
  const onResize = () => { if (active) redraw?.(); };
  const watchResize = render => {
    redraw = render;
    if (!listening && stream.isTTY && stream.on) {
      stream.on('resize', onResize);
      listening = true;
    }
  };
  const stopAnimation = () => { if (animation) clearInterval(animation); animation = undefined; };
  const display = value => terminalText(stream, value);
  const animate = (label, owner) => {
    clear();
    if (!stream.isTTY) { stream.write(muted(label + '…') + '\n'); return; }
    animationLabel = label;
    animationOwner = owner;
    animationFrame = 0;
    const tick = () => { stream.write(`\r\x1b[2K${muted(display(animationLabel + '.'.repeat(animationFrame % 3 + 1)))}`); active = true; animationFrame++; };
    watchResize(tick);
    tick();
    animation = setInterval(tick, 350);
    animation.unref?.();
  };
  const processingResult = (label, status) => {
    clear();
    const failed = status === 'failed' || status === 'error';
    const suffix = failed ? 'failed' : 'done';
    const width = stream.isTTY ? Math.max(1, (stream.columns || 80) - 1) : Infinity;
    const result = `${fit(label, Math.max(0, width - suffix.length - 2))}: `;
    stream.write(muted(result) + styleText(stream, suffix, failed ? 'error' : 'success', color, env) + '\n');
  };
  const finishStatus = (message, owner, prefix = '', outcome) => {
    const label = prefix + cleanText(message);
    if (!animation || animationOwner !== owner || animationLabel !== label.slice(0, -1)) return;
    if (outcome) { processingResult(label.slice(0, -1), outcome); return; }
    clear();
    stream.write(muted(display(label)) + '\n');
  };
  const line = (data, prefix) => formatProgress(data, { prefix, columns: stream.isTTY ? Math.max(1, (stream.columns || 80) - 1) : Infinity });
  const draw = (data, prefix) => {
    const render = () => { stream.write(`\r\x1b[2K${line(data, prefix)}`); active = true; };
    watchResize(render);
    render();
  };
  const updateTitle = () => setTitle(`veo | ${phase}${name ? ` | ${name}` : ''}`);
  function clear() {
    stopAnimation();
    if (listening) stream.removeListener?.('resize', onResize);
    listening = false;
    redraw = undefined;
    if (active && stream.isTTY) stream.write('\r\x1b[2K');
    active = false;
    animationLabel = '';
    animationOwner = undefined;
  }
  const scoped = (index, total, title, parent = '') => {
    let childName = cleanText(title), lastProgress = 0;
    const owner = Symbol('scoped reporter');
    const prefix = parent + '[' + index + '/' + total + '] ';
    const log = (message, quiet = true) => {
      phase = cleanText(message); name = childName;
      const line = prefix + childName + ': ' + phase;
      if (phase.endsWith('…')) animate(line.slice(0, -1), owner);
      else { clear(); stream.write((quiet ? muted(display(line)) : display(line)) + '\n'); }
      if (started) updateTitle();
    };
    return {
      scoped: (index, total, title) => scoped(index, total, title, prefix),
      name(value) { childName = cleanText(value); },
      status: log,
      finishStatus(message, outcome) { finishStatus(message, owner, prefix + childName + ': ', outcome); },
      progress(data) {
        if (stream.isTTY) {
          draw(data, prefix + childName + ': ' + (data.stream || 'Media'));
        } else if (Date.now() - lastProgress >= 5000 || data.status === 'finished') {
          log((data.stream || 'Media') + ' ' + formatProgress(data), false);
          lastProgress = Date.now();
        }
      },
      processing(data) {
        const label = prefix + childName + ': ' + (PROCESSING_LABELS[data.postprocessor] || 'Processing media');
        if (['finished', 'failed', 'error'].includes(data.status)) processingResult(label, data.status);
        else animate(label, owner);
        phase = `${PROCESSING_LABELS[data.postprocessor] || 'Processing media'}${data.status === 'finished' ? ': done' : '…'}`;
        name = childName; if (started) updateTitle();
      },
      finish() {},
      failStep() { if (animation && animationOwner === owner) processingResult(animationLabel, 'failed'); },
    };
  };
  return {
    configure(options) { color = options.color !== false; },
    scoped,
    item(index, total, title) {
      clear(); position = total > 1 ? `[${index}/${total}] ` : ''; hasItem = true; name = cleanText(title); streamName = ''; lastLog = 0;
      stream.write(heading(terminalTitle(stream, `${position}${name}`)) + '\n');
      phase = 'Starting…'; if (started) updateTitle();
    },
    processing(data) {
      const processor = cleanText(data.postprocessor || 'Processing');
      const label = PROCESSING_LABELS[processor] || 'Processing media';
      phase = `${label}${data.status === 'finished' ? ': done' : '…'}`;
      if (started) updateTitle();
      if (['finished', 'failed', 'error'].includes(data.status)) processingResult(`${position}${label}`, data.status);
      else animate(`${position}${label}`);
    },
    start(title = '') { started = true; name = cleanText(title); phase = 'Starting…'; updateTitle(); },
    name(title) {
      const next = cleanText(title);
      if (hasItem && next !== name) { clear(); stream.write(heading(terminalTitle(stream, `${position}${next}`)) + '\n'); }
      name = next; if (started) updateTitle();
    },
    status(message) {
      phase = cleanText(message);
      if (started) updateTitle();
      if (phase.endsWith('…')) animate(phase.slice(0, -1));
      else { clear(); stream.write(muted(display(phase)) + '\n'); }
    },
    profile(value) {
      const selected = value ? cleanText(value) : 'global (no profile)';
      phase = `Profile: ${selected}`;
      if (started) updateTitle();
      clear();
      stream.write(value && value !== 'default'
        ? muted('Profile: ') + styleText(stream, fit(selected, stream.isTTY ? Math.max(0, (stream.columns || 80) - 10) : Infinity), 'profile', color, env) + '\n'
        : muted(display(phase)) + '\n');
    },
    finishStatus(message, outcome) { finishStatus(message, undefined, '', outcome); },
    failStep() { if (animation && animationOwner === undefined) processingResult(animationLabel, 'failed'); },
    complete() { clear(); phase = 'Done'; if (started) updateTitle(); },
    fail(cancelled = false) { clear(); phase = cancelled ? 'Cancelled' : 'Failed'; if (started) updateTitle(); },
    progress(data) {
      if (data.stream && data.stream !== streamName) {
        clear(); streamName = data.stream; lastLog = 0;
        stream.write(muted(display(`${position}${streamName} download`)) + '\n');
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
