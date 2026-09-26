import path from 'node:path';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function supportsPathLinks(stream, env = process.env) {
  return Boolean(stream.isTTY && env.TERM !== 'dumb' &&
    (env.WT_SESSION || env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' ||
      env.TERM_PROGRAM === 'vscode' || env.KITTY_WINDOW_ID || Number(env.VTE_VERSION) >= 5000));
}

// File links target their containing folder so clicking does not play the media.
export function folderLink(stream, target, label = target, env = process.env) {
  const safeLabel = String(label).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  if (!supportsPathLinks(stream, env)) return safeLabel;
  try {
    const absolute = path.resolve(target);
    const folder = statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
    const url = pathToFileURL(folder + path.sep).href;
    return `\x1b]8;;${url}\x1b\\${safeLabel}\x1b]8;;\x1b\\`;
  } catch { return safeLabel; }
}
