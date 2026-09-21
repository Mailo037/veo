import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { CONFIG_TEMPLATE } from './config-template.js';

export async function resetConfig(file, { input = process.stdin, output = process.stdout, confirm } = {}) {
  file = path.resolve(file);
  output.write(`Reset configuration and all profiles: ${file}\n`);
  output.write('The existing file will be backed up. Downloads, history and statistics are preserved.\n');
  if (!confirm && !input.isTTY) throw new Error('Config reset requires an interactive terminal for confirmation.');
  let answer;
  if (confirm) answer = await confirm('Reset configuration? [y/N] ');
  else {
    const rl = createInterface({ input, output: process.stdout });
    try { answer = await rl.question('Reset configuration? [y/N] '); }
    finally { rl.close(); }
  }
  if (!/^y(?:es)?$/i.test(String(answer).trim())) {
    output.write('Config reset cancelled.\n');
    return 0;
  }
  let original;
  try { original = await readFile(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(file), { recursive: true });
  if (original !== undefined) {
    const backup = `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID()}.bak`;
    await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
    output.write(`Backup: ${backup}\n`);
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, CONFIG_TEMPLATE, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  output.write(`Config reset: ${file}\n`);
  return 0;
}
