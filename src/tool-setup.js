import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { cleanText } from './utils.js';

// Only fixed package names and arguments are passed to these installers.
export function runSetup(command, args, {
  signal, env = process.env, cwd, status = () => {}, timeoutMs = 600_000,
} = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], env, cwd,
    });
    let output = '';
    let stopped;
    const stop = error => {
      if (stopped) return;
      stopped = error;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const abort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new Error('Tool installation timed out. Retry with veo doctor fix.')), timeoutMs);
    const receive = chunk => {
      const text = cleanText(String(chunk));
      output = (output + text).slice(-8192);
      // Surface package-manager progress without taking over stdin or stdout.
      for (const line of text.split(/[\r\n]+/)) if (line.trim()) status(line.slice(0, 500));
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { cleanup(); reject(stopped || error); });
    child.once('close', code => {
      cleanup();
      if (stopped) reject(stopped);
      else if (code !== 0) reject(new Error(`${path.basename(command)} exited with code ${code}: ${output.trim()}`));
      else resolve(output);
    });
  });
}

export async function hasTermuxEjs({ find, run = runSetup, signal }) {
  const python = await find(['python', 'python3']);
  if (!python) return false;
  try {
    await run(python, ['-B', '-c', 'import yt_dlp_ejs'], { signal, timeoutMs: 15_000 });
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

let termuxInstall;
export async function installTermuxTools({ find, signal, status, run = runSetup, env = process.env }) {
  if (termuxInstall) {
    await termuxInstall;
    signal?.throwIfAborted();
    return;
  }
  termuxInstall = (async () => {
    const pkg = await find(['pkg']);
    if (!pkg) throw new Error('Automatic Android setup requires Termux with pkg on PATH. Install python-yt-dlp, yt-dlp-ejs and ffmpeg in Termux.');
    signal?.throwIfAborted();
    status('Installing yt-dlp, JavaScript support and FFmpeg with Termux pkg (first use)…');
    // pkg refreshes mirrors/package lists itself. No full system upgrade or sudo.
    await run(pkg, ['install', env.TERMUX_APP_PACKAGE_MANAGER === 'pacman' ? '--noconfirm' : '-y', 'python-yt-dlp', 'yt-dlp-ejs', 'ffmpeg'], {
      signal, status, env: { ...env, DEBIAN_FRONTEND: 'noninteractive' },
    });
  })();
  try { await termuxInstall; }
  catch (cause) {
    signal?.throwIfAborted();
    throw new Error(`Automatic Termux setup failed: ${cause.message}. Retry with veo doctor fix; if the repository needs repair, run pkg update in Termux.`, { cause });
  } finally { termuxInstall = undefined; }
}

export function mediaPackagePlan(platform = process.platform, arch = process.arch) {
  // Windows 11 ARM runs the upstream x64 media tools via OS emulation.
  const binaryArch = platform === 'win32' && arch === 'arm64' ? 'x64' : arch;
  const versions = {
    'win32-x64': '5.1.0', 'win32-ia32': '5.1.0',
    'darwin-x64': '5.1.0', 'darwin-arm64': '5.0.1',
    'linux-x64': '5.2.0', 'linux-ia32': '5.2.0', 'linux-arm64': '5.2.0', 'linux-arm': '5.2.0',
  };
  const target = `${platform}-${binaryArch}`;
  if (!versions[target]) return undefined;
  return { binaryArch, probePackage: `@ffprobe-installer/${target}`, probeVersion: versions[target] };
}

async function npmCli(find, env) {
  const npm = await find(['npm']);
  const candidates = [
    env.npm_execpath,
    npm && await realpath(npm).catch(() => undefined),
    npm && path.join(path.dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate) !== 'npm-cli.js') continue;
    if (await stat(candidate).then(info => info.isFile(), () => false)) return candidate;
  }
  throw new Error('npm was not found. Install Node.js with npm, then run veo doctor fix.');
}

export async function installMediaTools({
  directory, find, stage, signal, status, platform = process.platform, arch = process.arch,
  env = process.env, run = runSetup, locateNpm = npmCli,
}) {
  const plan = mediaPackagePlan(platform, arch);
  if (!plan) throw new Error(`Automatic FFmpeg setup is unavailable for ${platform}/${arch}. Set VEO_FFMPEG_PATH to a directory containing ffmpeg and ffprobe.`);
  const cli = await locateNpm(find, env);
  const temporary = await mkdtemp(path.join(directory, '.media-setup-'));
  const suffix = platform === 'win32' ? '.exe' : '';
  try {
    status('Downloading FFmpeg and FFprobe into the veo cache (first use)…');
    // This is a private throwaway project, never the global package or cwd.
    // Ignore dependency scripts; invoke the pinned ffmpeg installer explicitly.
    const args = [cli, 'install', '--prefix', temporary, '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', '--global=false', 'ffmpeg-static@5.3.0', `${plan.probePackage}@${plan.probeVersion}`];
    if (platform === 'win32' && arch === 'arm64') args.push('--force');
    await run(process.execPath, args, { signal, status, cwd: temporary, env });
    const modules = path.join(temporary, 'node_modules');
    await run(process.execPath, [path.join(modules, 'ffmpeg-static', 'install.js')], {
      signal, status, cwd: temporary,
      env: { ...env, npm_config_platform: platform, npm_config_arch: plan.binaryArch, FFMPEG_BIN: '', FFMPEG_BINARY_RELEASE: 'b6.1.1' },
    });
    const ffmpeg = path.join(modules, 'ffmpeg-static', `ffmpeg${suffix}`);
    const ffprobe = path.join(modules, ...plan.probePackage.split('/'), `ffprobe${suffix}`);
    for (const file of [ffmpeg, ffprobe]) {
      await access(file);
      if (process.platform !== 'win32') await chmod(file, 0o755);
      await run(file, ['-version'], { signal, timeoutMs: 15_000 });
    }
    await stage(ffmpeg, path.join(directory, `ffmpeg${suffix}`), signal);
    await stage(ffprobe, path.join(directory, `ffprobe${suffix}`), signal);
    return directory;
  } catch (cause) {
    signal?.throwIfAborted();
    throw new Error(`Automatic FFmpeg setup failed: ${cause.message}. Retry with veo doctor fix or set VEO_FFMPEG_PATH to installed tools.`, { cause });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
