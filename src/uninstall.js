import path from 'node:path';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { commandOutput } from './output.js';
import { cacheBase, configBase } from './paths.js';
import { cleanText, readableError } from './utils.js';
import { removeAlias, validateAliasName, listAliases } from './alias.js';

const PACKAGE = 'veodl';

export const UNINSTALL_HELP = `veo uninstall - remove veo completely or one command alias

Usage:
  veo uninstall [-p|--prefix <name>] [--json]
                               Remove one alias (e.g. veo uninstall -p veodl)
  veo uninstall [--yes] [--keep-cache] [--keep-config] [--keep-aliases] [--json]
                               Remove everything: aliases, package, cache, config
  veo uninstall --help         Show this help

With -p/--prefix, only that alias is deleted; veo itself stays installed.
Without -p, veo prints what would be removed. Add --yes to delete everything:
custom wrappers created with veo alias add, the ${PACKAGE} package itself
(commands veo, veodl) with npm, veo's cache directory (downloads, jobs,
backend tools, history, statistics) and the config file. Use --keep-cache,
--keep-config or --keep-aliases to preserve one part. The config file is
deleted by default; its path is shown before and after.
`;

export function npmUninstallCommand({ platform = process.platform } = {}) {
  const args = ['uninstall', '-g', PACKAGE];
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `npm ${args.join(' ')}`],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }
  return { command: 'npm', args, shell: false };
}

export function runNpmUninstall({ spawnImpl = spawn, platform = process.platform, signal, timeoutMs = 600_000 } = {}) {
  const { command, args, ...spawnOptions } = npmUninstallCommand({ platform });
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { ...spawnOptions, stdio: 'inherit', windowsHide: true, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    child.once('error', reject);
    child.once('close', resolve);
  });
}

function parseUninstallArgs(args) {
  let prefix;
  let yes = false;
  let keepCache = false;
  let keepConfig = false;
  let keepAliases = false;
  let json = false;
  let binDir;
  const rest = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '-p' || token === '--prefix') {
      prefix = args[++index];
      if (!prefix) throw new Error('--prefix requires an alias name. Use: veo uninstall -p veodl');
    } else if (token.startsWith('-p=')) {
      prefix = token.slice(3) || undefined;
      if (!prefix) throw new Error('--prefix requires an alias name. Use: veo uninstall -p veodl');
    } else if (token.startsWith('--prefix=')) {
      prefix = token.slice(9) || undefined;
      if (!prefix) throw new Error('--prefix requires an alias name. Use: veo uninstall -p veodl');
    } else if (token === '--yes') yes = true;
    else if (token === '--purge') {
      // Deprecated: full cleanup is now the default. Kept so older commands keep working.
    } else if (token === '--keep-cache') keepCache = true;
    else if (token === '--keep-config') keepConfig = true;
    else if (token === '--keep-aliases') keepAliases = true;
    else if (token === '--json') json = true;
    else if (token === '--bin-dir') {
      binDir = args[++index];
      if (!binDir) throw new Error('--bin-dir requires a directory.');
    } else if (token.startsWith('--bin-dir=')) {
      binDir = token.slice(10) || undefined;
      if (!binDir) throw new Error('--bin-dir requires a directory.');
    } else rest.push(token);
  }
  return { prefix, yes, keepCache, keepConfig, keepAliases, json, binDir, rest };
}

export async function uninstallMain(args = [], {
  stdout = process.stdout,
  stderr = process.stderr,
  platform = process.platform,
  env = process.env,
  spawnImpl = spawn,
  rmImpl = rm,
  cacheRoot,
  configFile,
  listImpl = listAliases,
  removeImpl = removeAlias,
} = {}) {
  [args, stdout, stderr] = commandOutput(args, stdout, stderr);
  const { prefix, yes, keepCache, keepConfig, keepAliases, json, binDir, rest } = parseUninstallArgs(args);
  if (rest.includes('-h') || rest.includes('--help')) {
    stdout.write(UNINSTALL_HELP);
    return 0;
  }
  if (rest.length) throw new Error(`Unknown option for veo uninstall: ${rest.join(' ')}. Use: veo uninstall --help`);

  if (prefix) {
    if (keepCache || keepConfig || keepAliases) throw new Error('--keep-* cannot be combined with --prefix. Remove one alias or uninstall veo itself.');
    const valid = validateAliasName(prefix);
    const removed = await removeImpl(valid, { binDir, platform, env });
    if (json) {
      stdout.write(`${JSON.stringify({ status: 'removed', ...removed })}\n`);
      return 0;
    }
    stdout.write(`Alias removed: ${removed.name} (${removed.removed.length} file(s) in ${removed.binDir})\n`);
    if (removed.builtin) stdout.write('Note: veo update recreates the shipped veodl name.\n');
    return 0;
  }

  const cache = cacheRoot || cacheBase({ platform, env });
  const config = configFile || path.join(configBase({ platform, env }), 'config.json');
  const manual = `npm uninstall -g ${PACKAGE}`;

  // Custom wrappers first so the plan names them; npm removes veo/veodl itself.
  let customAliases = [];
  let aliasDir = binDir ? path.resolve(binDir) : null;
  try {
    const listed = await listImpl({ binDir: binDir || undefined, platform, env });
    aliasDir = listed.binDir;
    customAliases = listed.aliases.filter(entry => entry.present && entry.managed && !entry.builtin).map(entry => entry.name);
  } catch {
    // No bin directory (e.g. running from source without a global install):
    // npm uninstall still works, alias cleanup is reported as skipped.
  }

  if (!yes) {
    if (json) {
      stdout.write(`${JSON.stringify({ status: 'planned', package: PACKAGE, manual, aliases: customAliases, binDir: aliasDir, cache, config })}\n`);
      return 0;
    }
    stdout.write(`This removes everything: the ${PACKAGE} package with npm (commands veo, veodl).\n`);
    if (!keepAliases) {
      stdout.write(customAliases.length
        ? `Custom wrappers to delete: ${customAliases.join(', ')} (${aliasDir})\n`
        : `Custom wrappers: none found${aliasDir ? ` (${aliasDir})` : ''}.\n`);
    }
    if (!keepCache) stdout.write(`Cache to delete: ${cache}\n`);
    if (!keepConfig) stdout.write(`Config to delete: ${config}\n`);
    if (keepCache || keepConfig || keepAliases) {
      const kept = [
        keepAliases && 'aliases',
        keepCache && 'cache',
        keepConfig && 'config',
      ].filter(Boolean).join(', ');
      stdout.write(`Kept: ${kept}.\n`);
    }
    const keepFlags = `${keepAliases ? ' --keep-aliases' : ''}${keepCache ? ' --keep-cache' : ''}${keepConfig ? ' --keep-config' : ''}`;
    stdout.write(`Run with --yes to proceed: veo uninstall --yes${keepFlags}\n`);
    stdout.write(`Manual command: ${manual}\n`);
    return 0;
  }

  let code;
  try {
    stdout.write(`Uninstalling ${PACKAGE} with npm…\n`);
    code = await runNpmUninstall({ spawnImpl, platform, signal: AbortSignal.timeout(600_000) });
  } catch (error) {
    const reason = error.code === 'ENOENT' ? 'npm was not found. Install Node.js/npm, or uninstall manually.' : `Could not run npm: ${readableError(error)}`;
    stderr.write(`veo: ${reason}\nManual command: ${manual}\n`);
    return 1;
  }
  if (code !== 0) {
    stderr.write(`veo: npm exited with code ${code}. Uninstall manually with: ${manual}\n`);
    return 1;
  }

  const removedAliases = [];
  if (!keepAliases) {
    for (const name of customAliases) {
      try {
        await removeImpl(name, { binDir: aliasDir, platform, env });
        removedAliases.push(name);
      } catch (error) {
        stderr.write(`veo: removed the package but could not delete alias ${name}: ${readableError(error)}\n`);
        return 1;
      }
    }
  }
  let cacheDeleted = false;
  if (!keepCache) {
    try {
      await rmImpl(cache, { recursive: true, force: true });
      cacheDeleted = true;
    } catch (error) {
      stderr.write(`veo: removed the package but could not delete the cache ${cache}: ${readableError(error)}\n`);
      return 1;
    }
  }
  let configDeleted = false;
  if (!keepConfig) {
    try {
      await rmImpl(config, { force: true });
      configDeleted = true;
    } catch (error) {
      stderr.write(`veo: removed the package but could not delete the config ${config}: ${readableError(error)}\n`);
      return 1;
    }
  }
  if (json) {
    stdout.write(`${JSON.stringify({ status: 'uninstalled', package: PACKAGE, aliases: removedAliases, binDir: aliasDir, cacheDeleted, cache, configDeleted, config })}\n`);
    return 0;
  }
  stdout.write(`veo uninstalled (${PACKAGE}).`);
  if (!keepAliases) stdout.write(removedAliases.length ? ` Aliases deleted: ${removedAliases.join(', ')}.` : ' No custom wrappers found.');
  stdout.write(cacheDeleted ? ` Cache deleted: ${cache}.` : ` Cache kept: ${cache}.`);
  stdout.write(configDeleted ? ` Config deleted: ${config}.` : ` Config kept: ${config}.`);
  stdout.write('\n');
  return 0;
}
