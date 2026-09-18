import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RELEASE } from './backend.js';
import { readableError } from './utils.js';

const PACKAGE = '@mailo037/veo';
const DAY_MS = 24 * 60 * 60 * 1000;

export const UPDATE_HELP = `veo update - keep veo current

Usage:
  veo update               Install the latest version with npm
  veo update --check       Only check whether a newer version exists
  veo upgrade              Alias for veo update
  veo check update         Alias for veo update --check

The registry can be overridden with VEO_REGISTRY (or npm_config_registry).
Set VEO_NO_UPDATE_CHECK=1 to disable the automatic post-download check.
`;

export function defaultRegistry(env = process.env) {
  const registry = env.VEO_REGISTRY || env.npm_config_registry;
  if (typeof registry === 'string' && /^https?:\/\//.test(registry.trim())) return registry.trim().replace(/\/+$/, '');
  return 'https://registry.npmjs.org';
}

export function compareVersions(a, b) {
  const parse = value => {
    const [core, pre = ''] = String(value).trim().replace(/^v/, '').split('-');
    if (!/^\d+(\.\d+)*$/.test(core)) throw new Error(`Invalid version: ${value}`);
    // Semver prerelease identifiers compare per segment, numerically when numeric.
    return { parts: core.split('.').map(Number), pre: pre === '' ? [] : pre.split('.') };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index++) {
    const difference = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (difference) return Math.sign(difference);
  }
  // A release outranks any prerelease of the same core version.
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const l = left.pre[index];
    const r = right.pre[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) {
      const difference = Number(l) - Number(r);
      if (difference) return Math.sign(difference);
    } else if (lNumeric) return -1; // Numeric identifiers rank below alphanumerics.
    else if (rNumeric) return 1;
    else if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export async function fetchLatestVersion({ registry = defaultRegistry(), fetchImpl = fetch, timeoutMs = 8000, signal } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const url = `${registry}/${encodeURIComponent(PACKAGE)}`;
  const response = await fetchImpl(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Update check failed: HTTP ${response.status}.`);
  }
  const data = await response.json();
  // Full packument: pick the highest version instead of trusting the "latest" tag.
  const versions = data?.versions ? Object.keys(data.versions) : [data?.version].filter(Boolean);
  if (!versions.length) throw new Error('Update check returned no versions.');
  const [latest] = versions.sort((a, b) => compareVersions(b, a));
  const version = typeof latest === 'string' ? latest : '';
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('Update check returned an invalid version.');
  return version;
}

// Same OS cache base as the yt-dlp backend cache (see src/backend.js).
export function veoCacheBase({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  let base;
  if (platform === 'win32') base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  else if (platform === 'darwin') base = path.join(home, 'Library', 'Caches');
  else base = env.XDG_CACHE_HOME || path.join(home, '.cache');
  if (!path.isAbsolute(base)) base = path.join(home, '.cache');
  return path.join(base, 'veo');
}

export async function readState(stateFile) {
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    return Number.isFinite(state?.lastCheck) ? state : null;
  } catch {
    return null;
  }
}

async function writeState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
}

// Throttled (once per day) post-download check. Purely informational; every
// failure is silent so downloads are never delayed or marked as failed.
export async function maybeUpdateNotice({
  currentVersion,
  env = process.env,
  stateFile,
  fetchImpl = fetch,
  registry,
  now = Date.now(),
  ttlMs = DAY_MS,
  timeoutMs = 4000,
} = {}) {
  if (env.VEO_NO_UPDATE_CHECK) return null;
  try {
    if (!stateFile) stateFile = path.join(veoCacheBase({ env }), 'update-check.json');
    const state = await readState(stateFile);
    if (state && now - state.lastCheck < ttlMs) return null;
  } catch {
    return null; // No usable cache location: never turn a notice into noise.
  }
  let latest = null;
  let message = null;
  try {
    latest = await fetchLatestVersion({ fetchImpl, registry, timeoutMs });
    if (compareVersions(latest, currentVersion) > 0) {
      message = `Update available: veo ${latest} (you have ${currentVersion}). Run: veo update`;
    }
  } catch {
    latest = null; // Unreachable registry still consumes the throttle interval.
  }
  await writeState(stateFile, { lastCheck: now, latest }).catch(() => {});
  return message;
}

// Removes yt-dlp caches from older pinned releases; only the current one stays.
export async function pruneBackendCaches({ keep, root, platform = process.platform, env = process.env } = {}) {
  const base = root || path.join(veoCacheBase({ platform, env }), 'backends');
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep) continue;
    await rm(path.join(base, entry.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

export function npmSpawnCommand({ platform = process.platform } = {}) {
  // Fixed arguments only (no user input), so cmd.exe on Windows is safe here.
  return {
    command: 'npm',
    args: ['install', '-g', '--no-fund', '--no-audit', `${PACKAGE}@latest`],
    shell: platform === 'win32',
  };
}

export function runNpmUpdate({ spawnImpl = spawn, platform = process.platform, signal, timeoutMs = 600_000 } = {}) {
  const { command, args, shell } = npmSpawnCommand({ platform });
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { shell, stdio: 'inherit', windowsHide: true, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    child.once('error', reject);
    child.once('close', resolve);
  });
}

export async function packageVersion() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

/**
 * Implements `veo update [--check]`, `veo upgrade`, and `veo check update`.
 * Returns the process exit code. Deps are injectable for tests.
 */
export async function updateMain(args, {
  registry = defaultRegistry(),
  fetchImpl = fetch,
  spawnImpl = spawn,
  platform = process.platform,
  stdout = process.stdout,
  stderr = process.stderr,
  current,
  keep = RELEASE,
  pruneRoot = undefined,
} = {}) {
  current = current ?? await packageVersion();
  const isCheckCommand = args[0] === 'check';
  const rest = isCheckCommand ? args.slice(2) : args.slice(1);
  if (rest.includes('-h') || rest.includes('--help')) {
    stdout.write(UPDATE_HELP);
    return 0;
  }
  const checkOnly = isCheckCommand || rest.includes('--check') || (rest.length === 1 && rest[0] === 'check');
  const unknown = rest.filter(token => token !== '--check' && !(checkOnly && token === 'check'));
  if (unknown.length) throw new Error(`Unknown option for veo update: ${unknown.join(' ')}. Use: veo update [--check]`);
  const currentText = `veo ${current}`;
  let latest;
  try {
    latest = await fetchLatestVersion({ registry, fetchImpl, timeoutMs: 10_000 });
  } catch (error) {
    stderr.write(`veo: ${readableError(error)}\nUpdate manually with: npm install -g ${PACKAGE}@latest\n`);
    return 1;
  }
  const newer = compareVersions(latest, current) > 0;
  if (checkOnly) {
    stdout.write(newer ? `Update available: veo ${latest} (you have ${current}). Run: veo update\n` : `${currentText} is up to date.\n`);
    return 0;
  }
  if (newer) {
    stdout.write(`Updating ${currentText} → ${latest} with npm…\n`);
    let code;
    try {
      code = await runNpmUpdate({ spawnImpl, platform, signal: AbortSignal.timeout(600_000) });
    } catch (error) {
      const reason = error.code === 'ENOENT' ? 'npm was not found. Install Node.js/npm, or update manually.' : `Could not run npm: ${readableError(error)}`;
      stderr.write(`veo: ${reason}\nManual command: npm install -g ${PACKAGE}@latest\n`);
      return 1;
    }
    if (code !== 0) {
      stderr.write(`veo: npm exited with code ${code}. Update manually with: npm install -g ${PACKAGE}@latest\n`);
      return 1;
    }
    stdout.write(`veo updated to ${latest}. The next veo call uses the new version.\n`);
  } else {
    stdout.write(`${currentText} is up to date.\n`);
  }
  try {
    const removed = await pruneBackendCaches({ keep, root: pruneRoot });
    if (removed) stdout.write(`Removed ${removed} old backend cache${removed === 1 ? '' : 's'}.\n`);
  } catch {
    // Cosmetic housekeeping must never fail the update.
  }
  return 0;
}
