import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { selectAsset, staticToolsSupported, findOnPath, wellKnownMediaDirectories, backendCacheDirectory, exeSuffix, inspectBackend, RELEASE } from '../src/backend.js';

test('standalone asset selection covers every published combination', () => {
  assert.equal(selectAsset('win32', 'x64'), 'yt-dlp.exe');
  assert.equal(selectAsset('win32', 'arm64'), 'yt-dlp_arm64.exe');
  assert.equal(selectAsset('win32', 'ia32'), 'yt-dlp_x86.exe');
  assert.equal(selectAsset('darwin', 'arm64'), 'yt-dlp_macos');
  assert.equal(selectAsset('linux', 'x64'), 'yt-dlp_linux');
  assert.equal(selectAsset('linux', 'x64', true), 'yt-dlp_musllinux');
  assert.equal(selectAsset('linux', 'arm64'), 'yt-dlp_linux_aarch64');
  assert.equal(selectAsset('linux', 'arm64', true), 'yt-dlp_musllinux_aarch64');
  // Unsupported combinations must stay undefined instead of guessing.
  for (const [platform, arch] of [['darwin', 'ia32'], ['linux', 'ia32'], ['freebsd', 'x64'], ['win32', 'mips']]) {
    assert.equal(selectAsset(platform, arch), undefined, `${platform}/${arch}`);
  }
});

test('static tools are only required where ffprobe-static does not abort the process', () => {
  // ffprobe-static calls process.exit() for platforms outside its matrix.
  for (const [platform, arch, expected] of [
    ['win32', 'x64', true],
    // Windows on ARM has no static binaries, but requiring the package is safe,
    // so the PATH fallback in resolveBackend can take over.
    ['win32', 'arm64', true],
    ['linux', 'arm64', true],
    ['darwin', 'arm64', true],
    ['darwin', 'ia32', false],
    ['freebsd', 'x64', false],
  ]) assert.equal(staticToolsSupported(platform, arch), expected, `${platform}/${arch}`);
});

test('PATH discovery finds executables and ignores non-absolute entries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veo-path-'));
  try {
    const fake = path.join(dir, `veo-ffmpeg-probe${exeSuffix()}`);
    await writeFile(fake, '#!/bin/sh\n');
    await chmod(fake, 0o755);
    const env = { PATH: ['relative/dir', dir, path.join(dir, 'missing')].join(path.delimiter) };
    assert.equal(await findOnPath(['veo-ffmpeg-probe'], { platform: process.platform, env }), fake);
    assert.equal(await findOnPath(['veo-ffmpeg-probe'], { platform: process.platform, env, directories: [dir] }), fake);
    assert.equal(await findOnPath(['veo-ffmpeg-probe'], { platform: process.platform, env: { PATH: path.join(dir, 'missing') }, directories: [] }), undefined);
    assert.equal(await findOnPath(['veo-absent-tool'], { platform: process.platform, env, directories: [dir] }), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('well-known media directories are absolute and platform-appropriate', () => {
  // Windows-style candidates must be judged with the Windows path rules, not
  // with those of whatever host happens to run the tests.
  for (const directory of wellKnownMediaDirectories({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', ProgramFiles: 'C:\\Program Files' } })) {
    assert.ok(path.win32.isAbsolute(directory), directory);
  }
  // Without LOCALAPPDATA or ProgramFiles the list must still hold no broken entries.
  for (const directory of wellKnownMediaDirectories({ platform: 'win32', env: {} })) {
    assert.ok(path.win32.isAbsolute(directory), directory);
  }
  for (const directory of wellKnownMediaDirectories({ platform: 'linux', env: {} })) {
    assert.ok(path.posix.isAbsolute(directory), directory);
  }
  assert.ok(wellKnownMediaDirectories({ platform: 'linux', env: {} }).includes('/usr/bin'));
});

test('the backend cache is versioned and platform-specific', () => {
  const directory = backendCacheDirectory(RELEASE);
  assert.ok(directory.includes(path.join('veo', 'backends', RELEASE)));
  assert.ok(directory.endsWith(`${process.platform}-${process.arch}`));
  assert.notEqual(backendCacheDirectory('2099.01.01'), directory);
});

test('inspection reports state without downloading or executing anything', async () => {
  const report = await inspectBackend();
  assert.equal(report.release, RELEASE);
  assert.equal(report.directory, backendCacheDirectory(RELEASE));
  assert.ok(['managed', 'override', 'none', 'invalid'].includes(report.ytDlp.source));
  assert.equal(typeof report.ytDlp.present, 'boolean');
  for (const name of ['ffmpeg', 'ffprobe']) {
    assert.ok(['cache', 'override', 'path', 'missing'].includes(report[name].source));
    if (report[name].path) assert.ok(path.isAbsolute(report[name].path));
  }
});
