import { commandOutput } from './output.js';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { configBase } from './paths.js';
import { configSyntaxError } from './config-errors.js';
import { CONFIG_TEMPLATE, stripConfigComments, withConfigTemplate } from './config-template.js';

/**
 * Keys accepted in the config file, with the CLI flag they act as a default for.
 * Everything here is a default only: an explicit command-line flag always wins.
 */
export const CONFIG_KEYS = Object.freeze({
  concurrentDownloads: 'number',
  adaptiveConcurrency: 'boolean',
  filenameTemplate: 'string',
  folderTemplate: 'string',
  checkSpace: 'boolean',
  timings: 'boolean',
  color: 'boolean',
  output: 'string',
  quality: 'string',
  format: 'string',
  compatible: 'boolean',
  recode: 'boolean',
  playlistConcurrency: 'number',
  rename: 'string',
  audio: 'boolean',
  open: 'boolean',
  resume: 'boolean',
  closestQuality: 'boolean',
  cookies: 'string',
  cookiesFromBrowser: 'string',
  playlist: 'boolean',
  concurrentFragments: 'number',
  subs: 'boolean',
  subLangs: 'string',
  embedSubs: 'boolean',
  embedMetadata: 'boolean',
  embedThumbnail: 'boolean',
  sponsorblockRemove: 'string',
  section: 'string',
  json: 'boolean',
  skipExisting: 'boolean',
  playlistItems: 'string',
});

export function configFile({ env = process.env, platform = process.platform } = {}) {
  const override = env.VEO_CONFIG;
  if (typeof override === 'string' && override.trim()) {
    if (override.includes('\0')) throw new Error('VEO_CONFIG must be a filesystem path.');
    return path.resolve(override.trim());
  }
  return path.join(configBase({ env, platform }), 'config.json');
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Read optional user defaults. A missing file is not an error; a malformed one
 * is reported loudly, because silently ignoring a typo would be worse.
 */
export async function loadConfig({ env = process.env, file } = {}) {
  const target = file || configFile({ env });
  let text;
  try {
    text = await readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { file: target, exists: false, config: {}, warnings: [] };
    throw new Error(`Cannot read the veo config file ${target}: ${error.message}`);
  }
  return parseConfigText(text, target);
}

export function parseConfigText(text, target = 'config') {
  let data;
  let clean = text.replace(/^\uFEFF/, '');
  try {
    clean = stripConfigComments(text);
    data = JSON.parse(clean);
  } catch (error) {
    throw configSyntaxError(clean, target, error);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`The veo config file must contain a JSON object: ${target}`);
  }
  const warnings = [];
  const config = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === '$schema') continue;
    if (key === 'profiles') {
      if (!value || typeOf(value) !== 'object') throw new Error('Config profiles must be an object.');
      config.profiles = Object.create(null);
      for (const [name, profile] of Object.entries(value)) {
        if (!profile || typeOf(profile) !== 'object') throw new Error(`Profile "${name}" must be an object.`);
        const checked = {};
        for (const [setting, item] of Object.entries(profile)) {
          if (!Object.hasOwn(CONFIG_KEYS, setting)) throw new Error(`Unknown setting "${setting}" in profile "${name}".`);
          if (typeOf(item) !== CONFIG_KEYS[setting]) throw new Error(`Profile "${name}": "${setting}" must be a ${CONFIG_KEYS[setting]}.`);
          checked[setting] = item;
        }
        config.profiles[name] = checked;
      }
      continue;
    }
    const expected = CONFIG_KEYS[key];
    if (!expected) {
      warnings.push(`Unknown config key "${key}" in ${target} was ignored.`);
      continue;
    }
    if (typeOf(value) !== expected) {
      throw new Error(`Config key "${key}" must be a ${expected}, not a ${typeOf(value)} (${target}).`);
    }
    config[key] = value;
  }
  return { file: target, exists: true, config, warnings };
}

export function applyProfile(config, name) {
  const { profiles, ...defaults } = config;
  if (!name) {
    if (!profiles || !Object.hasOwn(profiles, 'default')) return defaults;
    name = 'default';
  }
  if (!profiles || !Object.hasOwn(profiles, name)) throw new Error(`Unknown profile "${name}". Available: ${Object.keys(profiles || {}).join(', ') || 'none'}. Use veo config edit.`);
  return { ...defaults, ...profiles[name] };
}

export async function prepareConfigEdit(file) {
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, CONFIG_TEMPLATE, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const original = await readFile(file, 'utf8');
    const annotated = withConfigTemplate(original);
    if (annotated !== original) await writeFile(file, annotated, 'utf8');
  }
}

export async function configMain(args) {
  const editorColor = !args.includes('--no-color') && !Object.hasOwn(process.env, 'NO_COLOR');
  let stdout;
  [args, stdout] = commandOutput(args, process.stdout);
  if (args[0] === 'show') stdout = process.stdout;
  const file = configFile();
  if (args[0] === 'reset') {
    if (args.length !== 1) throw new Error('Usage: veo config reset');
    return (await import('./config-reset.js')).resetConfig(file, { output: stdout });
  }
  if (['check', 'show'].includes(args[0])) {
    const { parseArgs } = await import('node:util');
    const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { profile: { type: 'string' } } });
    if (positionals.length) throw new Error('Usage: veo config check|show [--profile NAME]');
    const loaded = await loadConfig({ file });
    if (loaded.warnings.length) throw new Error(loaded.warnings.join('\n'));
    if (args[0] === 'show') {
      const effective = await effectiveConfig(loaded.config, values.profile);
      stdout.write(`${JSON.stringify(effective, null, 2)}\n`);
    } else {
      const names = values.profile ? [values.profile] : [undefined, ...Object.keys(loaded.config.profiles || {})];
      for (const name of names) {
        try { await effectiveConfig(loaded.config, name); }
        catch (error) { throw new Error(`Profile ${name || 'default/global'}: ${error.message}`); }
      }
      stdout.write(`Config OK: ${file} (${names.length} effective configurations checked).\n`);
    }
    return 0;
  }
  let editorMode;
  if (args[0] === 'edit') {
    if (args.length > 2 || (args[1] && !['--external', '--terminal'].includes(args[1]))) throw new Error('Usage: veo config edit [--external|--terminal]');
    editorMode = args[1]?.slice(2) || process.env.VEO_CONFIG_EDITOR || 'auto';
    if (!['auto', 'external', 'terminal'].includes(editorMode)) throw new Error('VEO_CONFIG_EDITOR must be auto, external or terminal.');
  } else if (args.length !== 1 || !['path', 'profiles'].includes(args[0])) throw new Error('Usage: veo config edit|path|profiles|check|show|reset');
  if (args[0] === 'path') { stdout.write(`${file}\n`); return 0; }
  if (args[0] === 'profiles') {
    const loaded = await loadConfig();
    stdout.write(`${Object.keys(loaded.config.profiles || {}).join('\n') || 'No profiles configured. Use veo config edit.'}\n`);
    return 0;
  }
  await prepareConfigEdit(file);
  if (editorMode === 'terminal' || (editorMode === 'auto' && !process.env.VISUAL && !process.env.EDITOR && process.stdin.isTTY && process.stdout.isTTY)) {
    const { editConfig } = await import('./config-editor.js');
    await editConfig(file, { color: editorColor });
    return 0;
  }
  // Treat the editor as an executable path, never as shell code.
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad.exe' : 'vi');
  await new Promise((resolve, reject) => {
    const child = spawn(editor, [file], { shell: false, stdio: 'inherit', windowsHide: true });
    child.on('error', () => reject(new Error(`Could not launch editor. Set EDITOR to an executable path or edit ${file}.`)));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Editor exited with ${code}. Config: ${file}`)));
  });
  await loadConfig();
  return 0;
}

export async function effectiveConfig(config, profile) {
  const { parseCli } = await import('./cli.js');
  const selected = applyProfile(config, profile);
  // Inspection is offline and never prints credential file paths or browser profiles.
  const { cookies, cookiesFromBrowser, ...safe } = selected;
  const parsed = parseCli(['https://example.invalid/config-check'], { config: safe });
  const result = Object.fromEntries(Object.keys(CONFIG_KEYS).filter(key => parsed[key] !== undefined).map(key => [key, parsed[key]]));
  result.output = path.resolve(result.output);
  if (cookies !== undefined) result.cookies = '[configured]';
  if (cookiesFromBrowser !== undefined) result.cookiesFromBrowser = '[configured]';
  return result;
}
