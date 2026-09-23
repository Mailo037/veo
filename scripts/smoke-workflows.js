// Authorized local media fixture for parallel URLs, templates, config inspection and timings.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveBackend } from '../src/backend.js';

const backend = await resolveBackend();
const ffmpeg = path.join(backend.ffmpegLocation, `ffmpeg${process.platform === 'win32' ? '.exe' : ''}`);
const root = await mkdtemp(path.join(os.tmpdir(), 'veo-feature-smoke-'));
const cli = fileURLToPath(new URL('../bin/veo.js', import.meta.url));
const env = { ...process.env, VEO_CONFIG: path.join(root, 'config.json'), LOCALAPPDATA: root,
  XDG_CACHE_HOME: root, VEO_NO_UPDATE_CHECK: '1', VEO_YT_DLP_PATH: backend.ytDlp, VEO_FFMPEG_PATH: backend.ffmpegLocation };
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
});
let server;
try {
  const source = path.join(root, 'source.mp4');
  const generated = await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24', '-t', '1', '-c:v', 'libx264', source]);
  assert.equal(generated.code, 0, generated.stderr);
  const media = await readFile(source);
  let requests = 0, active = 0, peak = 0;
  server = createServer((request, response) => {
    requests++;
    if (request.url === '/list.html') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html><head><title>Playlist</title></head><body><video src="/one.mp4"></video><video src="/two.mp4"></video></body></html>');
      return;
    }
    peak = Math.max(peak, ++active);
    setTimeout(() => {
      active--;
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': media.length });
      response.end(request.method === 'HEAD' ? undefined : media);
    }, 450);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = { profiles: { fast: { concurrentDownloads: 2, folderTemplate: '{year}', filenameTemplate: '{title}', timings: true } } };
  await writeFile(env.VEO_CONFIG, JSON.stringify(config));
  const check = await run(process.execPath, [cli, 'config', 'check']);
  assert.equal(check.code, 0, check.stderr);
  const shown = await run(process.execPath, [cli, 'config', 'show', '--profile', 'fast']);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).concurrentDownloads, 2);
  assert.equal(requests, 0, 'config commands must remain offline');
  await writeFile(env.VEO_CONFIG, JSON.stringify({ concurrentDownloads: 9 }));
  const invalid = await run(process.execPath, [cli, 'config', 'check']);
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /between 1 and 4/);
  await writeFile(env.VEO_CONFIG, JSON.stringify(config));
  console.log('PASS: offline config check/show and invalid-range reporting');
  const batch = await run(process.execPath, [cli, `${base}/one.mp4`, `${base}/two.mp4`, '--profile', 'fast', '--json', '-o', path.join(root, 'batch')]);
  assert.equal(batch.code, 0, batch.stderr);
  assert.ok(!/\x1b\[/.test(batch.stdout + batch.stderr), 'JSON and redirected output must not contain ANSI');
  const results = batch.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.ok(result.timings.download >= 0 && result.timings.saving >= 0);
    assert.equal(path.basename(path.dirname(result.files[0])), 'Unknown year');
    assert.deepEqual(await readFile(result.files[0]), media, 'parallel download must preserve original media bytes');
  }
  assert.ok(peak >= 2, 'real source requests should overlap');
  console.log('PASS: real parallel URLs, filename/folder templates, identical media bytes, timings and plain JSON');
  const playlist = await run(process.execPath, [cli, `${base}/list.html`, '--playlist', '--filename-template', '{index} - {title}', '--folder-template', '{playlist}', '--json', '-o', path.join(root, 'playlist')]);
  assert.equal(playlist.code, 0, playlist.stderr);
  const result = JSON.parse(playlist.stdout.trim());
  assert.equal(result.files.length, 2);
  assert.match(path.basename(result.files[0]), /^001 - /);
  assert.match(path.basename(result.files[1]), /^002 - /);
  assert.equal(result.entryTimings.length, 2);
  for (const file of result.files) assert.deepEqual(await readFile(file), media);
  console.log('PASS: real parallel playlist, stable index naming, per-entry timings and identical media bytes');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
