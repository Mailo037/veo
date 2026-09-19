import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { configBase } from './paths.js';
import { CONFIG_TEMPLATE, stripConfigComments, withConfigTemplate } from './config-template.js';

/**
 * Keys accepted in the config file, with the CLI flag they act as a default for.
 * Everything here is a default only: an explicit command-line flag always wins.
 */
export const CONFIG_KEYS = Object.freeze({
  output: 'string',
  quality: 'string',
  format: 'string',
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

export function configFile({ env = process.env } = {}) {
  const override = env.VEO_CONFIG;
  if (typeof override === 'string' && override.trim()) {
    if (override.includes('\0')) throw new Error('VEO_CONFIG must be a filesystem path.');
    return path.resolve(override.trim());
  }
  return path.join(configBase({ env }), 'config.json');
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
  let data;
  try {
    data = JSON.parse(stripConfigComments(text));
  } catch {
    throw new Error(`The veo config file is not valid JSON: ${target}`);
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
  if (!name) return defaults;
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
  const file = configFile();
  if (args.length !== 1 || !['edit', 'path', 'profiles'].includes(args[0])) throw new Error('Usage: veo config edit|path|profiles');
  if (args[0] === 'path') { process.stdout.write(`${file}\n`); return 0; }
  if (args[0] === 'profiles') {
    const loaded = await loadConfig();
    process.stdout.write(`${Object.keys(loaded.config.profiles || {}).join('\n') || 'No profiles configured. Use veo config edit.'}\n`);
    return 0;
  }
  await prepareConfigEdit(file);
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
