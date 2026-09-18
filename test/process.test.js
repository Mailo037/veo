import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/veo.js', import.meta.url));
function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VEO_YT_DLP_PATH: '/missing/backend' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
test('help and version run without acquiring or resolving a backend', async () => {
  const help = await invoke(['--help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /veo - simple video downloader/); assert.equal(help.stderr, '');
  assert.match(help.stdout, /-r, --rename <name>/);
  assert.match(help.stdout, /veo update --check/);
  for (const arg of ['--version', '-v', 'version']) {
    const version = await invoke([arg]);
    assert.equal(version.code, 0);
    assert.equal(version.stdout, '1.0.2\n');
    assert.equal(version.stderr, '');
  }
});
test('validation produces nonzero exit and readable stderr, not a stack trace', async () => {
  const result = await invoke(['invalid-url']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^veo: Invalid URL\./);
  assert.doesNotMatch(result.stderr, /at .*\(/);
});
