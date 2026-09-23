import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { browserCandidates, captureBrowserMedia, discoverSources, formatSource, mediaUrlsFromText, parseSourceTimeout, shouldOfferSourceDiscovery } from '../src/source-discovery.js';
import { parseCli, resolvePageSource } from '../src/cli.js';
import { fetchMetadata, listFormats, prepareBackend, runBackend } from '../src/downloader.js';
import { interactiveArgs } from '../src/interactive.js';
import { publicOptions } from '../src/state.js';
import { backendCacheDirectory } from '../src/backend.js';

const execFileAsync = promisify(execFile);
const backendExe = path.join(backendCacheDirectory(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

test('XHR response parsing retains signed media URLs and ignores ordinary API requests', () => {
  const urls = mediaUrlsFromText('{"stream":"https:\\/\\/media.example.test\\/master.m3u8?token=abc&quality=hd","api":"https://media.example.test/movie/12"}');
  assert.deepEqual(urls, ['https://media.example.test/master.m3u8?token=abc&quality=hd']);
});

test('source discovery verifies candidates, removes duplicate media and does not expose URLs in summaries', async () => {
  const page = 'https://example.test/movie/12';
  const urls = ['https://cdn.test/one.m3u8?token=secret', 'https://cdn.test/one.m3u8?token=secret', 'https://cdn.test/bad.mpd'];
  const result = await discoverSources(page, {
    capture: async () => urls,
    inspect: async url => {
      if (url.endsWith('bad.mpd')) throw new Error('Unavailable');
      return { id: 'same', extractor_key: 'generic', title: 'A title', formats: [{ height: 1080 }, { height: 720 }], filesize_approx: 100 * 1048576 };
    },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].estimatedMiB, 100);
  assert.deepEqual(result[0].quality, ['1080p', '720p']);
  assert.match(formatSource(result[0]), /A title.*1080p.*100 MiB/);
  assert.doesNotMatch(formatSource(result[0]), /secret/);
});

test('CLI accepts numbered source selection and rejects ambiguous batch use', () => {
  assert.equal(parseCli(['https://example.test/movie/12', '--source', '2']).source, '2');
  assert.equal(parseCli(['https://example.test/movie/12', '--list-sources']).listSources, true);
  assert.throws(() => parseCli(['https://example.test/movie/12', '--source', '0']), /positive source number/);
  assert.throws(() => parseCli(['https://example.test/movie/12', 'https://example.test/movie/13', '--source', '1']), /one URL/);
});

test('deep scan checks candidates beyond the ordinary limit and timeout syntax is validated', async () => {
  assert.equal(parseSourceTimeout('30'), 30000);
  assert.equal(parseSourceTimeout('2m'), 120000);
  assert.equal(parseCli(['https://site.test/movie/12', '--list-sources', '--deep-scan', '--timeout', '30s']).timeoutMs, 30000);
  assert.throws(() => parseCli(['https://site.test/movie/12', '--timeout', '4s']), /between 5 seconds/);
  const urls = Array.from({ length: 31 }, (_, index) => `https://cdn.test/${index}.mp4`);
  const options = { capture: async () => urls, inspect: async url => ({ id: url, title: 'Video', formats: [{ height: 720 }] }) };
  assert.equal((await discoverSources('https://site.test/movie/12', options)).length, 30);
  assert.equal((await discoverSources('https://site.test/movie/12', { ...options, deepScan: true })).length, 31);
});

test('scan timeout keeps candidates verified before the deadline', async () => {
  const urls = ['https://cdn.test/one.mp4', 'https://cdn.test/two.mp4'];
  const sources = await discoverSources('https://site.test/movie/12', {
    capture: async () => urls, timeoutMs: 20, deepScan: true,
    inspect: async url => {
      if (url.endsWith('two.mp4')) await new Promise(() => {});
      return { id: url, title: 'Video', formats: [{ height: 720 }] };
    },
  });
  assert.equal(sources.length, 1);
  assert.equal(sources.timedOut, true);
});

test('a missing media result asks before source discovery and skips it when declined', async () => {
  const page = 'https://site.test/movie/12';
  const media = 'https://cdn.test/master.m3u8';
  const source = { index: 1, title: 'Movie', source: 'cdn.test', type: 'HLS', quality: ['720p'], estimatedMiB: null, bitrateMbps: null, url: media };
  const questions = [];
  const answers = ['yes', '1'];
  const options = { url: page, json: false };
  const result = await resolvePageSource(options, {
    stderr: { write() {} }, interactive: true,
    ask: async prompt => { questions.push(prompt); return answers.shift(); },
    inspect: async request => { if (!request.mediaUrl) throw new Error('No video formats found'); return { formats: [{ height: 720 }] }; },
    discover: async (_page, { inspect }) => { await inspect(media); return [source]; },
  });
  assert.deepEqual(result, { mediaUrl: media, source: 1 });
  assert.match(questions[0], /Search this page.*\(y\/N\)/);
  assert.match(questions[1], /Source number/);
  let discovered = false;
  await assert.rejects(resolvePageSource(options, {
    stderr: { write() {} }, interactive: true, ask: async () => 'n',
    inspect: async () => { throw new Error('No video formats found'); },
    discover: async () => { discovered = true; return []; },
  }), /No video formats found/);
  assert.equal(discovered, false);
});

test('scripts never receive a prompt and explicit list mode discovers directly', async () => {
  const page = 'https://site.test/movie/12';
  const source = { index: 1, title: 'Movie', source: 'cdn.test', type: 'HLS', quality: [], estimatedMiB: null, bitrateMbps: null, url: 'https://cdn.test/master.m3u8' };
  let asked = false;
  const common = { stderr: { write() {} }, interactive: false, ask: async () => { asked = true; return 'yes'; },
    inspect: async () => { throw new Error('No video formats found'); }, discover: async () => [source] };
  await assert.rejects(resolvePageSource({ url: page, json: true }, common), /Use --list-sources/);
  assert.equal(asked, false);
  const result = await resolvePageSource({ url: page, listSources: true, json: true }, common);
  assert.equal(result.sources.length, 1);
  assert.equal(asked, false);
  assert.equal(shouldOfferSourceDiscovery(new Error('No video formats found')), true);
  assert.equal(shouldOfferSourceDiscovery(new Error('HTTP Error 403')), false);
  const automatic = await resolvePageSource({ url: page, autoListSources: true, json: true }, common);
  assert.equal(automatic.needsSelection, true);
  assert.equal(automatic.sources.length, 1);
  assert.equal(asked, false);
});

test('selected media URL reaches metadata and format listing with the original page as referer', async () => {
  const options = { url: 'https://site.test/movie/12', mediaUrl: 'https://cdn.test/master.m3u8?token=temporary', output: '.', playlist: false };
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    return JSON.stringify({ id: 'stream', title: 'A title', formats: [{ height: 720 }] });
  };
  const backend = { ytDlp: 'yt-dlp', ffmpegLocation: '.' };
  await fetchMetadata(options, { backend, runner });
  await listFormats(options, { backendResolver: async () => backend, runner });
  for (const args of calls) {
    assert.equal(args.at(-1), options.mediaUrl);
    assert.equal(args[args.indexOf('--referer') + 1], options.url);
  }
});

test('interactive wizard chooses a discovered source while keeping the page URL for retry', async () => {
  const page = 'https://site.test/movie/12';
  const media = 'https://cdn.test/master.m3u8?token=temporary';
  const answers = [page, 'video', 'y', '1', '', '', 'y', 'y'];
  const output = { write() {} };
  const args = await interactiveArgs({}, {
    output, ask: async () => answers.shift(),
    inspect: async options => {
      if (!options.mediaUrl) throw new Error('No media on page');
      return { title: 'Movie', formats: [{ height: 720 }] };
    },
    discover: async (_page, { inspect }) => {
      await inspect(media);
      return [{ index: 1, title: 'Movie', source: 'cdn.test', type: 'HLS', quality: ['720p'], estimatedMiB: null, url: media }];
    },
  });
  assert.equal(parseCli(args).url, page);
  assert.equal(parseCli(args).source, '1');
  assert.equal(publicOptions({ ...parseCli(args), mediaUrl: media }).mediaUrl, undefined);
});

test('interactive wizard honors stored source-listing and automatic search defaults', async () => {
  const page = 'https://site.test/movie/12';
  const listing = await interactiveArgs({ listSources: true, deepScan: true, timeout: '2m' }, {
    output: { write() {} }, ask: async () => page,
    inspect: async () => { throw new Error('Listing should not inspect before the CLI starts.'); },
  });
  const parsed = parseCli(listing, { config: { listSources: true, deepScan: true, timeout: '2m' } });
  assert.equal(parsed.listSources, true);
  assert.equal(parsed.deepScan, true);
  assert.equal(parsed.timeoutMs, 120000);

  const media = 'https://cdn.test/master.m3u8';
  const answers = [page, 'video', '1', '', '', 'y', 'y'];
  const prompts = [];
  const downloadArgs = await interactiveArgs({ autoListSources: true }, {
    output: { write() {} }, ask: async prompt => { prompts.push(prompt); return answers.shift(); },
    inspect: async options => {
      if (!options.mediaUrl) throw new Error('No video formats found');
      return { title: 'Movie', formats: [{ height: 720 }] };
    },
    discover: async () => [{ index: 1, title: 'Movie', source: 'cdn.test', type: 'HLS', quality: ['720p'], estimatedMiB: null, bitrateMbps: null, url: media }],
  });
  assert.equal(parseCli(downloadArgs, { config: { autoListSources: true } }).source, '1');
  assert.equal(prompts.some(prompt => prompt.includes('Search this page')), false);
});

test('browser capture sees an XHR media URL after pressing Play', { skip: !browserCandidates().some(existsSync) }, async () => {
  const server = createServer((request, response) => {
    if (request.url === '/movie/12') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<button aria-label="Play">Play</button><script>document.querySelector("button").onclick = () => fetch("/api/source").then(r => r.json())</script>');
    } else if (request.url === '/api/source') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ stream: `http://127.0.0.1:${server.address().port}/stream/master.m3u8?token=fixture` }));
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const urls = await captureBrowserMedia(`http://127.0.0.1:${server.address().port}/movie/12`, { observeMs: 2400 });
    assert.ok(urls.some(url => url.includes('/stream/master.m3u8?token=fixture')));
  } finally { server.close(); }
});

test('CLI lists and previews a player source discovered through XHR', {
  skip: process.env.VEO_REAL_BROWSER_TEST !== '1' || !browserCandidates().some(existsSync) || !existsSync(backendExe),
}, async () => {
  const server = createServer((request, response) => {
    if (request.url === '/movie/12') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<button aria-label="Play">Play</button><script>document.querySelector("button").onclick=()=>fetch("/api/source")</script>');
    } else if (request.url === '/api/source') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ stream: `http://127.0.0.1:${server.address().port}/stream.mp4` }));
    } else if (request.url === '/stream.mp4') {
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '4' });
      response.end('test');
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = `http://127.0.0.1:${server.address().port}/movie/12`;
    const cli = new URL('../bin/veo.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
    const env = { ...process.env, VEO_NO_UPDATE_CHECK: '1' };
    const direct = await execFileAsync(backendExe, ['--dump-single-json', '--skip-download', `${page.replace('/movie/12', '/stream.mp4')}`], { env, timeout: 30000 });
    assert.ok(JSON.parse(direct.stdout).formats?.length);
    const captured = await captureBrowserMedia(page, { observeMs: 2400 });
    assert.ok(captured.some(url => url.endsWith('/stream.mp4')), JSON.stringify(captured));
    const backend = await prepareBackend({ url: page });
    const inspected = await fetchMetadata({ url: page, mediaUrl: captured[0], playlist: false }, { backend, runner: runBackend });
    assert.ok(inspected.formats?.length);
    const listed = await execFileAsync(process.execPath, [cli, page, '--list-sources', '--json'], { env, timeout: 30000 });
    const sources = JSON.parse(listed.stdout).sources;
    assert.equal(sources.length, 1);
    assert.equal(sources[0].source, '127.0.0.1');
    const planned = await execFileAsync(process.execPath, [cli, page, '--source', '1', '--dry-run', '--json'], { env, timeout: 30000 });
    assert.equal(JSON.parse(planned.stdout).status, 'planned');
  } finally { server.close(); }
});
