import { spawn } from 'node:child_process';
import path from 'node:path';

// Pass the absolute filename as one argument, never through a shell. Detach so
// a media player that stays running does not keep the CLI alive.
export function openFile(filename, { platform = process.platform, spawnProcess = spawn } = {}) {
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const absolute = path.resolve(filename);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, [absolute], { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
