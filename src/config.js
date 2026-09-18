import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { configBase } from './paths.js';

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
    data = JSON.parse(text);
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
