import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cliOptions, parseCli } from '../src/cli.js';
import { optionSpellings, suggestOption } from '../src/option-suggestions.js';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/veo.js', import.meta.url));

test('misspelled download options suggest the actual CLI spelling', () => {
  const url = 'https://example.test/video';
  for (const [typed, expected] of [
    ['--deepscan', '--deep-scan'],
    ['--no-deepscan', '--no-deep-scan'],
    ['--list-sorce', '--list-sources'],
    ['--timeot', '--timeout'],
    ['--qulity', '--quality'],
    ['--plylist-items', '--playlist-items'],
  ]) {
    assert.throws(() => parseCli([url, typed]), error => error.message.includes(`Unknown option "${typed}".`)
      && error.message.includes(`Did you mean "${expected}"?`));
  }
  assert.throws(() => parseCli([url, '--unlikely-flag']), /Unknown option "--unlikely-flag".*veo --help/);
});

test('suggestions cover every declared long option and boolean negative', () => {
  const options = optionSpellings(cliOptions());
  for (const option of options.filter(value => value.startsWith('--'))) {
    if (!option.slice(2).includes('-')) continue;
    assert.equal(suggestOption(`--${option.slice(2).replace('-', '')}`, options), option);
  }
});

test('command-specific flags also get a spelling hint', async () => {
  for (const [args, expected] of [
    [['history', '--limt', '5'], '--limit'],
    [['config', 'edit', '--termnal'], '--terminal'],
    [['doctor', '--offlne'], '--offline'],
    [['alias', 'add', 'extra', '--froce'], '--force'],
  ]) {
    await assert.rejects(execFileAsync(process.execPath, [cli, ...args], { env: { ...process.env, VEO_NO_UPDATE_CHECK: '1' } }),
      error => error.stderr.includes(`Did you mean "${expected}"?`));
  }
  await assert.rejects(execFileAsync(process.execPath, [cli, 'histroy'], { env: { ...process.env, VEO_NO_UPDATE_CHECK: '1' } }),
    error => error.stderr.includes('Did you mean "history"?'));
});
