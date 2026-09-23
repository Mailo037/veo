import path from 'node:path';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { commandOutput } from './output.js';
import { findOnPath } from './backend.js';
import { cleanText, readableError } from './utils.js';

export const BUILTIN_ALIASES = ['veo', 'veodl'];
export const ALIAS_MARKER = 'veo-alias';

export const ALIAS_HELP = `veo alias - manage extra command names for veo

Usage:
  veo alias                    List command names (same as: veo alias list)
  veo alias list [--json]      Show veo, veodl plus custom wrappers
  veo alias add <name> [--force] [--json]
                               Create <name> as a wrapper that calls veo
  veo alias remove <name> [--json]   Delete a wrapper (also: veo alias rm)
  veo alias --help             Show this help

Names use 2-31 lowercase letters, digits or hyphens and start with a letter,
e.g. veo-dl. The wrapper is created next to the veo command found on PATH and
simply forwards to veo, so it survives veo updates. Removing veodl only
removes that shortcut; veo update recreates the shipped names. veo itself can
never be removed. Use --bin-dir <path> to override the target directory.
`;

export function validateAliasName(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('An alias name is required. Use: veo alias add <name>');
  if (cleanText(raw) !== raw) throw new Error(`Invalid alias name: ${raw}. Use plain text without escapes.`);
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(raw)) {
    throw new Error(`Invalid alias name "${raw}". Use 2-31 lowercase letters, digits or hyphens, starting with a letter (e.g. veo-dl).`);
  }
  return raw;
}

export function aliasFiles(binDir, name, platform = process.platform) {
  if (platform === 'win32') {
    return [path.join(binDir, name), path.join(binDir, `${name}.cmd`), path.join(binDir, `${name}.ps1`)];
  }
  return [path.join(binDir, name)];
}

function posixWrapper(name) {
  return `#!/bin/sh\n# ${ALIAS_MARKER}: ${name}\nexec veo "$@"\n`;
}

function windowsCmdWrapper(name) {
  return `@echo off\r\nREM ${ALIAS_MARKER}: ${name}\r\nveo %*\r\n`;
}

function windowsShWrapper(name) {
  return `#!/bin/sh\n# ${ALIAS_MARKER}: ${name}\nexec veo "$@"\n`;
}

function windowsPsWrapper(name) {
  return `# ${ALIAS_MARKER}: ${name}\nveo @args\n`;
}

async function exists(file, { statImpl = stat } = {}) {
  try {
    const info = await statImpl(file);
    return info.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function isManaged(file, { readFileImpl = readFile } = {}) {
  try {
    const text = await readFileImpl(file, 'utf8');
    return text.slice(0, 4096).includes(ALIAS_MARKER);
  } catch {
    return false;
  }
}

export async function resolveBinDir({ binDir, platform = process.platform, env = process.env, find = findOnPath } = {}) {
  if (binDir) return path.resolve(binDir);
  const found = await find(['veo'], { platform, env });
  if (!found) {
    throw new Error('Could not locate the veo command on PATH. Install veo globally (npm install -g veodl) or pass --bin-dir <path>.');
  }
  return path.dirname(found);
}

export async function aliasStatus(name, { binDir, platform = process.platform, ...fs } = {}) {
  const files = aliasFiles(binDir, name, platform);
  const present = [];
  let managed = false;
  for (const file of files) {
    if (await exists(file, fs)) {
      present.push(file);
      if (await isManaged(file, fs)) managed = true;
    }
  }
  return { name, builtin: BUILTIN_ALIASES.includes(name), present: present.length > 0, managed, paths: present };
}

function baseNameOf(file, platform) {
  const base = path.basename(file);
  if (platform === 'win32') {
    if (base.toLowerCase().endsWith('.cmd')) return base.slice(0, -4);
    if (base.toLowerCase().endsWith('.ps1')) return base.slice(0, -4);
  }
  return base;
}

export async function listAliases({ binDir, platform = process.platform, builtins = BUILTIN_ALIASES, readdirImpl = readdir, readFileImpl = readFile, statImpl = stat } = {}) {
  const resolved = await resolveBinDir({ binDir, platform });
  const entries = [];
  for (const name of builtins) {
    entries.push(await aliasStatus(name, { binDir: resolved, platform, readFileImpl, statImpl }));
  }
  const known = new Set(entries.map(entry => entry.name));
  let files = [];
  try {
    files = await readdirImpl(resolved, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot list the command directory ${resolved}: ${readableError(error)}`);
  }
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const full = path.join(resolved, entry.name);
    let text = '';
    try {
      text = String(await readFileImpl(full, 'utf8')).slice(0, 4096);
    } catch {
      continue;
    }
    if (!text.includes(ALIAS_MARKER)) continue;
    const base = baseNameOf(entry.name, platform);
    try {
      validateAliasName(base);
    } catch {
      continue;
    }
    if (known.has(base)) {
      const existing = entries.find(item => item.name === base);
      if (existing) existing.managed = true;
      continue;
    }
    known.add(base);
    entries.push({ name: base, builtin: false, present: true, managed: true, paths: [full] });
  }
  return { binDir: resolved, aliases: entries.sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function addAlias(name, { binDir, platform = process.platform, force = false, writeFileImpl = writeFile, statImpl = stat, chmodImpl = chmod, mkdirImpl = mkdir } = {}) {
  const valid = validateAliasName(name);
  if (valid === 'veo') throw new Error('veo is already the main command.');
  const resolved = await resolveBinDir({ binDir, platform });
  await mkdirImpl(resolved, { recursive: true });
  const files = aliasFiles(resolved, valid, platform);
  const present = [];
  for (const file of files) {
    if (await exists(file, { statImpl })) present.push(file);
  }
  if (present.length && !force) {
    throw new Error(`${valid} already exists (${present.map(file => path.basename(file)).join(', ')}). Use --force to replace it.`);
  }
  for (const file of present) await rm(file, { force: true });
  if (platform === 'win32') {
    await writeFileImpl(files[0], windowsShWrapper(valid), { mode: 0o755 });
    await writeFileImpl(files[1], windowsCmdWrapper(valid));
    await writeFileImpl(files[2], windowsPsWrapper(valid));
  } else {
    await writeFileImpl(files[0], posixWrapper(valid), { mode: 0o755 });
    try {
      await chmodImpl(files[0], 0o755);
    } catch {
      // Non-POSIX filesystems may ignore modes; the shebang still works.
    }
  }
  return { name: valid, binDir: resolved, paths: aliasFiles(resolved, valid, platform) };
}

export async function removeAlias(name, { binDir, platform = process.platform, statImpl = stat, rmImpl = rm } = {}) {
  const valid = validateAliasName(name);
  if (valid === 'veo') throw new Error('Refusing to remove veo itself. Remove veodl or a custom wrapper instead.');
  const resolved = await resolveBinDir({ binDir, platform });
  const status = await aliasStatus(valid, { binDir: resolved, platform, statImpl });
  if (!status.present) throw new Error(`${valid} is not installed in ${resolved}.`);
  for (const file of status.paths) await rmImpl(file, { force: true });
  return { name: valid, binDir: resolved, removed: status.paths, builtin: status.builtin };
}

function parseAliasArgs(args) {
  let binDir;
  let force = false;
  let json = false;
  const rest = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--force') force = true;
    else if (token === '--json') json = true;
    else if (token === '--bin-dir') {
      binDir = args[++index];
      if (!binDir) throw new Error('--bin-dir requires a directory. Run veo alias --help for usage.');
    } else if (token.startsWith('--bin-dir=')) {
      binDir = token.slice(10) || undefined;
      if (!binDir) throw new Error('--bin-dir requires a directory. Run veo alias --help for usage.');
    } else rest.push(token);
  }
  return { binDir, force, json, rest };
}

export async function aliasMain(args = [], { stdout = process.stdout, stderr = process.stderr, ...options } = {}) {
  [args, stdout, stderr] = commandOutput(args, stdout, stderr);
  const { binDir, force, json, rest } = parseAliasArgs(args);
  const [command, name, ...extra] = rest;
  if (!command || command === 'list') {
    if (name || extra.length) throw new Error('Usage: veo alias list [--json] (or veo alias --help)');
    if (command === 'list' && extra.length) throw new Error('Usage: veo alias list [--json] (or veo alias --help)');
    const result = await listAliases({ ...options, binDir });
    if (json) {
      stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    stdout.write(`Command directory: ${result.binDir}\n`);
    for (const entry of result.aliases) {
      const kind = entry.builtin ? 'shipped' : 'custom';
      const state = entry.present ? (entry.managed ? 'wrapper -> veo' : 'installed') : 'missing';
      stdout.write(`  ${entry.name} (${kind}, ${state})\n`);
    }
    const missing = result.aliases.filter(entry => !entry.present).map(entry => entry.name);
    if (missing.length) stdout.write(`Missing: ${missing.join(', ')} (veo update recreates shipped names).\n`);
    return 0;
  }
  if (command === '-h' || command === '--help') {
    stdout.write(ALIAS_HELP);
    return 0;
  }
  if (command === 'add') {
    if (!name || extra.length) throw new Error('Usage: veo alias add <name> [--force] (or veo alias --help)');
    const created = await addAlias(name, { ...options, binDir, force });
    if (json) {
      stdout.write(`${JSON.stringify({ status: 'added', ...created })}\n`);
      return 0;
    }
    stdout.write(`Alias installed: ${created.name} -> veo (${created.binDir})\n`);
    stdout.write(`Run "${created.name} --help" to use it. Remove it with: veo alias remove ${created.name}\n`);
    return 0;
  }
  if (command === 'remove' || command === 'rm' || command === 'uninstall') {
    if (!name || extra.length) throw new Error('Usage: veo alias remove <name> (or veo alias --help)');
    const removed = await removeAlias(name, { ...options, binDir });
    if (json) {
      stdout.write(`${JSON.stringify({ status: 'removed', ...removed })}\n`);
      return 0;
    }
    stdout.write(`Alias removed: ${removed.name} (${removed.removed.length} file(s) in ${removed.binDir})\n`);
    if (removed.builtin) stdout.write('Note: veo update recreates the shipped veodl name.\n');
    return 0;
  }
  throw new Error(`Unknown alias command: ${cleanText(command)}. Use: veo alias list | veo alias add <name> | veo alias remove <name>`);
}
