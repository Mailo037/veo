import { lstat, mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cacheBase } from './paths.js';
import { listRuns, waitForExit } from './runs.js';

const exists = file => lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const ID = '[a-f0-9-]{36}';

async function children(root, name) {
  const directory = path.resolve(root, name);
  const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing to clean a redirected cache directory: ${directory}`);
  return (await readdir(directory, { withFileTypes: true })).map(entry => ({ entry, file: path.join(directory, entry.name) }));
}

export async function flush({ root = cacheBase(), timeoutMs = 30000, status = () => {}, stats = false } = {}) {
  root = path.resolve(root);
  await mkdir(root, { recursive: true });
  const gate = path.join(root, '.flush');
  try { await mkdir(gate); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another flush is active, or an interrupted flush left ${gate}. Remove this empty lock directory only when no flush is running.`); throw error; }
  let stopped = 0, downloads = 0, jobs = 0, skipped = 0;
  try {
    const runs = await listRuns(root);
    const live = runs.filter(run => run.alive);
    for (const run of live) { await writeFile(`${run.file}.cancel`, 'flush'); stopped++; }
    status(`Stopping ${stopped} active veo run(s)…`);
    if (!await waitForExit(live, timeoutMs)) {
      throw new Error('Some veo runs did not stop in time. No download or job files were removed. Try veo flush again after they stop.');
    }
    for (const { entry, file } of await children(root, 'downloads')) {
      if (!entry.isDirectory() || !/^\.veo-part-[a-f0-9]{24}$/.test(entry.name)) continue;
      // Unregistered older versions might still own these locks.
      if (await exists(path.join(file, '.lock'))) { skipped++; continue; }
      await rm(file, { recursive: true, force: true });
      downloads++;
    }
    for (const { entry, file } of await children(root, 'jobs')) {
      if (skipped) continue; // Older runs may still be updating their retry jobs.
      if (!entry.isFile() || !new RegExp(`^\\d+-${ID}\\.json(?:\\.${ID}\\.tmp)?$`).test(entry.name)) continue;
      await rm(file, { force: true }); jobs++;
    }
    for (const run of runs) {
      await rm(run.file, { force: true });
      await rm(`${run.file}.cancel`, { force: true });
    }
    if (stats) await (await import('./stats.js')).resetStats(root);
    return { stopped, downloads, jobs, skipped };
  } finally { await rmdir(gate); }
}

export async function flushMain(args = [], { stdout = process.stdout, ...options } = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    stdout.write('veo flush [--stats]\n\nStop registered veo runs and remove local downloads (including retained and resume data)\nand retry job JSON files. Saved media, config, history and backend tools are kept.\nStatistics are kept unless --stats is supplied to reset them.\nLocked downloads from older or interrupted processes are skipped.\n');
    return 0;
  }
  if (args.length && (args.length !== 1 || args[0] !== '--stats')) throw new Error('Usage: veo flush [--stats] (or veo flush --help)');
  const result = await flush({ ...options, stats: args.includes('--stats'), status: text => stdout.write(`${text}\n`) });
  if (args.includes('--stats')) stdout.write('Statistics reset.\n');
  stdout.write(`Flushed: ${result.downloads} local download folder(s), ${result.jobs} job file(s); ${result.stopped} run(s) stopped.\n`);
  if (result.skipped) stdout.write(`Skipped ${result.skipped} locked folder(s) and kept retry jobs; check older veo processes before removing their locks.\n`);
  return result.skipped ? 1 : 0;
}
