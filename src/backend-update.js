import { commandOutput } from './output.js';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import {
  RELEASE, activeOverride, backendCacheDirectory, clearBackendOverride, installBackend,
  isValidRelease, readBackendOverride, releaseUrl, selectAsset, writeBackendOverride,
} from './backend.js';
import { compareVersions } from './version.js';
import { readableError, cleanText } from './utils.js';

const API_LATEST = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const CHECKSUMS = 'SHA2-256SUMS';

export const BACKEND_HELP = `veo backend - manage the yt-dlp backend

Usage:
  veo backend update          Install the newest yt-dlp release
  veo backend update --check  Only report whether a newer release exists
  veo backend reset           Forget the installed release and use the pinned one
  veo backend reset --keep-files
                              Remove the pointer but keep the downloaded files
  veo backend --help          Show this help

veo ships a pinned, hash-verified yt-dlp release. \`veo backend update\` is an
opt-in escape hatch for when a website changed and the pinned release is too old:
it installs the newest official release after verifying its SHA-256 against that
release's own SHA2-256SUMS file over HTTPS.

That checksum does not ship with veo, so this weakens the pinned-hash guarantee:
it then rests on HTTPS and GitHub alone. \`veo backend reset\` returns to the
release veo was built and tested against. VEO_YT_DLP_PATH always wins over both.
`;

export async function fetchLatestBackendRelease({ fetchImpl = fetch, timeoutMs = 10_000, signal } = {}) {
  const response = await fetchImpl(API_LATEST, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'veo' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Could not query the latest yt-dlp release: HTTP ${response.status}.`);
  }
  const data = await response.json();
  const tag = data?.tag_name;
  if (!isValidRelease(tag)) throw new Error(`The release host returned an unexpected version: ${cleanText(String(tag))}`);
  return tag;
}

/** Parse an official SHA2-256SUMS file into a name -> hash map. */
export function parseChecksums(text) {
  const hashes = new Map();
  for (const line of String(text).split('\n')) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (match) hashes.set(path.basename(match[2]), match[1].toLowerCase());
  }
  if (!hashes.size) throw new Error('The release checksum list could not be parsed.');
  return hashes;
}

export async function fetchReleaseChecksum({ release, asset, fetchImpl = fetch, timeoutMs = 15_000, signal }) {
  if (!isValidRelease(release)) throw new Error(`Invalid yt-dlp release: ${release}`);
  const response = await fetchImpl(releaseUrl(release, CHECKSUMS), {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Could not download ${CHECKSUMS} for yt-dlp ${release}: HTTP ${response.status}.`);
  }
  const hash = parseChecksums(await response.text()).get(asset);
  if (!hash) throw new Error(`yt-dlp ${release} does not publish a checksum for ${asset}.`);
  return hash;
}

export function muslDetected() {
  return process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
}

export async function checkBackend({
  platform = process.platform,
  arch = process.arch,
  musl = muslDetected(),
  signal,
  stateFile,
  fetchImpl = fetch,
  installed,
  latest,
} = {}) {
  const asset = selectAsset(platform, arch, musl);
  const active = installed !== undefined ? installed : await activeOverride(asset, { signal, stateFile });
  return {
    asset,
    active,
    current: active?.release ?? RELEASE,
    latest: latest ?? await fetchLatestBackendRelease({ fetchImpl, signal }),
  };
}

export async function backendUpdateMain(args = [], {
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  signal,
  stateFile,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
  check = checkBackend,
  install = installBackend,
  reset = clearBackendOverride,
  removeFiles = directory => rm(directory, { recursive: true, force: true }),
} = {}) {
  [args, stdout, stderr] = commandOutput(args, stdout, stderr);
  const [command, ...rest] = args;
  if (command === undefined || command === '-h' || command === '--help' || rest.includes('-h') || rest.includes('--help')) {
    stdout.write(BACKEND_HELP);
    return 0;
  }
  if (command === 'reset') {
    const unknown = rest.filter(token => token !== '--keep-files');
    if (unknown.length) throw new Error(`Unknown option for veo backend reset: ${unknown.join(' ')}. Use: veo backend reset [--keep-files]`);
    const state = await readBackendOverride(stateFile);
    if (!await reset(stateFile)) {
      stdout.write(`No installed backend to remove. veo uses the pinned release ${RELEASE}.\n`);
      return 0;
    }
    if (state?.release && !rest.includes('--keep-files')) await removeFiles(backendCacheDirectory(state.release)).catch(() => {});
    const removed = state?.release ? ` yt-dlp ${state.release}` : ' the installed backend';
    stdout.write(`Removed${removed}. veo uses the pinned release ${RELEASE} again.\n`);
    return 0;
  }
  if (command !== 'update') {
    throw new Error(`Unknown backend command: ${cleanText(command)}. Use: veo backend update [--check] | veo backend reset`);
  }
  const checkOnly = rest.includes('--check');
  const unknown = rest.filter(token => token !== '--check');
  if (unknown.length) throw new Error(`Unknown option for veo backend update: ${unknown.join(' ')}. Use: veo backend update [--check]`);
  if (env.VEO_YT_DLP_PATH) stderr.write('veo: VEO_YT_DLP_PATH is set and always takes precedence over the managed backend.\n');

  let info;
  try {
    info = await check({ platform, arch, signal, stateFile, fetchImpl });
  } catch (error) {
    stderr.write(`veo: ${readableError(error)}\n`);
    return 1;
  }
  const { asset, current, latest } = info;
  if (!asset) {
    stderr.write(`veo: no standalone yt-dlp is published for ${platform}/${arch}. Set VEO_YT_DLP_PATH to a trusted executable.\n`);
    return 1;
  }
  if (compareVersions(latest, current) <= 0) {
    stdout.write(`yt-dlp ${current} is up to date${current === RELEASE ? ' (pinned release, hash verified at build time)' : ' (installed release)'}.\n`);
    return 0;
  }
  if (checkOnly) {
    stdout.write(`Newer yt-dlp release available: ${latest} (using ${current}). Run: veo backend update\n`);
    return 0;
  }

  let sha256;
  try {
    sha256 = await fetchReleaseChecksum({ release: latest, asset, fetchImpl, signal });
  } catch (error) {
    stderr.write(`veo: ${readableError(error)}\nNothing was installed. The pinned release ${RELEASE} is still in use.\n`);
    return 1;
  }
  stdout.write(`Installing yt-dlp ${latest} for ${platform}/${asset}…\n`);
  try {
    await install({ release: latest, asset, sha256, signal, status: message => stdout.write(`${message}\n`) });
  } catch (error) {
    stderr.write(`veo: ${readableError(error)}\nThe pinned release ${RELEASE} is still in use.\n`);
    return 1;
  }
  try {
    await writeBackendOverride({ release: latest, asset, sha256, platform, arch, installed: new Date().toISOString() }, stateFile);
  } catch (error) {
    stderr.write(`veo: ${readableError(error)}\nThe download succeeded, but veo could not record it; the pinned release stays in use.\n`);
    return 1;
  }
  stdout.write(`yt-dlp ${latest} installed and will be used for the next download.\n`);
  stderr.write(`veo: note: yt-dlp ${latest} was verified against the checksum published with that release over HTTPS, not against a hash shipped with veo. Run "veo backend reset" to return to the pinned release.\n`);
  return 0;
}
