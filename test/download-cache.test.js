import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupDownloadCache, TRANSFER_RETENTION_MS } from '../src/download-cache.js';
import { download, localRequestKey } from '../src/downloader.js';
import { allocate } from '../src/utils.js';

test('a failed transfer keeps the completed local file and retries without any backend access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-local-transfer-'));
  const localRoot = path.join(root, 'local-cache'), output = path.join(root, 'destination');
  const options = { url: 'https://example.test/video', quality: 'best', output, resume: false };
  let downloads = 0;
  try {
    await writeFile(output, 'destination unavailable');
    const dependencies = {
      localRoot,
      backendResolver: async () => ({ ytDlp: 'fake', ffmpegLocation: 'fake' }),
      runner: async (_, args, { onLine } = {}) => {
        if (args.includes('--dump-single-json')) return JSON.stringify({ id: 'v', title: 'Saved locally' });
        downloads++;
        const staging = path.dirname(args[args.indexOf('-o') + 1]);
        assert.equal(path.dirname(staging), localRoot);
        const file = path.join(staging, 'media.mp4');
        await writeFile(file, 'complete media');
        onLine(`veo-file:${JSON.stringify(file)}`);
      },
    };
    await assert.rejects(download(options, dependencies));
    const staging = path.join(localRoot, `.veo-part-${localRequestKey(options)}`);
    const manifest = JSON.parse(await readFile(path.join(staging, 'job.json'), 'utf8'));
    assert.ok(manifest.expiresAt > Date.now());
    assert.ok(manifest.expiresAt <= Date.now() + TRANSFER_RETENTION_MS);
    assert.equal(await readFile(path.join(staging, 'media.mp4'), 'utf8'), 'complete media');
    await rm(output);
    const result = await download(options, { localRoot, backendResolver: async () => assert.fail('retry must not resolve the backend'), runner: async () => assert.fail('retry must not fetch metadata or download') });
    assert.equal(downloads, 1);
    assert.equal(await readFile(result.files[0], 'utf8'), 'complete media');
    assert.deepEqual(await readdir(localRoot), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cleanup removes expired completed downloads but keeps active, fresh and indefinite resume state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-cache-ttl-'));
  const now = Date.now();
  const make = async (letter, expiresAt) => {
    const directory = path.join(root, `.veo-part-${letter.repeat(24)}`);
    await mkdir(directory);
    await writeFile(path.join(directory, 'job.json'), JSON.stringify({ version: 1, expiresAt }));
    await writeFile(path.join(directory, 'media.mp4'), 'media');
    return directory;
  };
  try {
    const expired = await make('a', now - 1);
    const fresh = await make('b', now + 1000);
    const partial = await make('c', undefined);
    const active = await make('d', now - 1);
    const lock = await open(path.join(active, '.lock'), 'wx');
    try { await cleanupDownloadCache(root, now); }
    finally { await lock.close(); }
    await assert.rejects(stat(expired), { code: 'ENOENT' });
    for (const directory of [fresh, partial, active]) assert.ok((await stat(path.join(directory, 'media.mp4'))).isFile());
    await Promise.all([cleanupDownloadCache(root, now + 2000), cleanupDownloadCache(root, now + 2000)]);
    await assert.rejects(stat(fresh), { code: 'ENOENT' });
    assert.ok((await stat(partial)).isDirectory());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an incomplete copy is rejected and the local original survives', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-copy-size-'));
  const source = path.join(root, 'source.mp4'), destination = path.join(root, 'copy.mp4');
  try {
    await writeFile(source, 'complete content');
    await assert.rejects(allocate(source, destination, {
      linkImpl: async () => { throw Object.assign(new Error(), { code: 'EXDEV' }); },
      copyImpl: async (_, target) => writeFile(target, 'short'),
    }), /unexpected size/);
    assert.equal(await readFile(source, 'utf8'), 'complete content');
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
