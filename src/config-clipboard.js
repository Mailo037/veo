import { spawn } from 'node:child_process';

const MAX_TEXT = 2 * 1024 * 1024;

// Prefer the clipboard for the active display server, then try the other common
// Linux tools. A terminal reached over SSH may have neither display available.
export function clipboardCommands(operation, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const setup = 'Add-Type -AssemblyName System.Windows.Forms; [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
    return [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-Command', setup + (operation === 'copy'
      ? '[System.Windows.Forms.Clipboard]::SetText([Console]::In.ReadToEnd())'
      : '[Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText())')]]];
  }
  if (platform === 'darwin') return [[operation === 'copy' ? 'pbcopy' : 'pbpaste', []]];
  if (platform === 'android') return [[operation === 'copy' ? 'termux-clipboard-set' : 'termux-clipboard-get', []]];
  const wayland = [operation === 'copy' ? 'wl-copy' : 'wl-paste', operation === 'copy' ? [] : ['--no-newline']];
  const xclip = ['xclip', ['-selection', 'clipboard', operation === 'copy' ? '-in' : '-out']];
  const xsel = ['xsel', ['--clipboard', operation === 'copy' ? '--input' : '--output']];
  const x11 = [xclip, xsel];
  return env.WAYLAND_DISPLAY ? [wayland, ...x11] : env.DISPLAY ? [...x11, wayland] : [wayland, ...x11];
}

function runCommand([program, args], operation, value) {
  return new Promise((resolve, reject) => {
    // Clipboard owners such as xclip and wl-copy may continue in the background.
    // Do not keep their inherited output pipes open after the command exits.
    const child = spawn(program, args, {
      shell: false, windowsHide: true,
      stdio: operation === 'copy' ? ['pipe', 'ignore', 'ignore'] : ['ignore', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => child.kill(), 5000);
    const chunks = [];
    let size = 0, failed = false;
    child.stdout?.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_TEXT) child.kill();
      else chunks.push(chunk);
    });
    child.stdin?.on('error', () => {});
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0 || size > MAX_TEXT) reject(new Error('Clipboard command failed.'));
      else resolve(operation === 'paste' ? Buffer.concat(chunks).toString('utf8') : undefined);
    });
    child.stdin?.end(value);
  });
}

export async function clipboardText(operation, value = '', options = {}) {
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT) throw new Error('Selection is too large for the editor clipboard.');
  const candidates = clipboardCommands(operation, options);
  for (const candidate of candidates) {
    try { return await (options.run || runCommand)(candidate, operation, value); }
    catch { /* Try the next available display-server clipboard. */ }
  }
  const platform = options.platform || process.platform;
  const hint = platform === 'linux'
    ? ' Install wl-clipboard, xclip or xsel and use a graphical session.'
    : platform === 'android' ? ' Install the Termux:API app and pkg install termux-api.' : '';
  throw new Error(`System clipboard is unavailable.${hint}`);
}

export const configClipboard = {
  copy: value => clipboardText('copy', value),
  paste: () => clipboardText('paste'),
};
