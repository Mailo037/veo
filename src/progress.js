import { cleanText } from './utils.js';
import { createTerminalTitle } from './terminal-title.js';

function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatProgress(data) {
  const done = Number.isFinite(data.downloaded_bytes) ? data.downloaded_bytes : 0;
  const total = data.total_bytes || data.total_bytes_estimate;
  const percent = total > 0 ? Math.min(100, done / total * 100) : null;
  const filled = percent === null ? 0 : Math.round(percent / 5);
  const eta = Number.isFinite(data.eta) ? `${Math.floor(data.eta / 60)}:${String(Math.floor(data.eta % 60)).padStart(2, '0')}` : '?';
  return `[${'='.repeat(filled)}${'-'.repeat(20 - filled)}] ${percent === null ? '  ?' : percent.toFixed(0).padStart(3)}%  ${bytes(data.speed)}/s  ${bytes(done)} / ${bytes(total)}  ETA ${eta}`;
}

export function createReporter(stream = process.stderr, { setTitle = createTerminalTitle(stream) } = {}) {
  let active = false;
  let lastLog = 0;
  let name = '';
  let phase = 'Starting…';
  let started = false;
  const updateTitle = () => setTitle(`veo | ${phase}${name ? ` | ${name}` : ''}`);
  function clear() {
    if (active && stream.isTTY) stream.write('\r\x1b[2K');
    active = false;
  }
  return {
    start(title = '') { started = true; name = cleanText(title); phase = 'Starting…'; updateTitle(); },
    name(title) { name = cleanText(title); if (started) updateTitle(); },
    status(message) {
      clear();
      phase = cleanText(message);
      if (started) updateTitle();
      stream.write(`${phase}\n`);
    },
    complete() { clear(); phase = 'Done'; if (started) updateTitle(); },
    fail(cancelled = false) { clear(); phase = cancelled ? 'Cancelled' : 'Failed'; if (started) updateTitle(); },
    progress(data) {
      const total = data.total_bytes || data.total_bytes_estimate;
      const percent = Number.isFinite(total) && total > 0 && Number.isFinite(data.downloaded_bytes)
        ? Math.max(0, Math.min(100, Math.round(data.downloaded_bytes / total * 100))) : null;
      phase = data.status === 'finished' ? 'Processing…' : percent === null ? 'Downloading…' : `${percent}%`;
      if (started) updateTitle();
      if (stream.isTTY) {
        stream.write(`\r\x1b[2K${formatProgress(data)}`);
        active = true;
      } else if (Date.now() - lastLog >= 5000 || data.status === 'finished') {
        stream.write(`${formatProgress(data)}\n`);
        lastLog = Date.now();
      }
    },
    finish: clear,
  };
}
