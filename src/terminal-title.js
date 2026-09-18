import { cleanText } from './utils.js';

// PowerShell's console title API on Windows; OSC 0 on xterm-compatible Unix
// terminals. Never put escape sequences into redirected output or dumb terminals.
export function createTerminalTitle(stream, { platform = process.platform, env = process.env, processInfo = process } = {}) {
  let previous;
  return title => {
    if (!stream.isTTY || env.TERM === 'dumb') return;
    const safe = cleanText(title).slice(0, 240);
    if (safe === previous) return;
    try {
      if (platform === 'win32') processInfo.title = safe;
      else stream.write(`\x1b]0;${safe}\x07`);
      previous = safe;
    } catch {
      // Cosmetic only: a terminal that rejects titles must not break downloads.
    }
  };
}
