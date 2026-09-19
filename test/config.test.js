import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configFile, loadConfig, prepareConfigEdit, CONFIG_KEYS } from '../src/config.js';
import { CONFIG_TEMPLATE, stripConfigComments, withConfigTemplate } from '../src/config-template.js';

test('the config location follows each platform convention and VEO_CONFIG', () => {
  assert.equal(configFile({ env: { VEO_CONFIG: './custom.json' } }), path.resolve('./custom.json'));
  assert.match(configFile({ env: {} }), /config\.json$/);
  assert.throws(() => configFile({ env: { VEO_CONFIG: 'bad\0path' } }), /filesystem path/);
  assert.ok(configFile({ env: { VEO_CONFIG: '   ' } }).endsWith(path.join('veo', 'config.json')));
});

test('a missing config file is not an error', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-config-'));
  try {
    const loaded = await loadConfig({ file: path.join(directory, 'absent.json') });
    assert.equal(loaded.exists, false);
    assert.deepEqual(loaded.config, {});
    assert.deepEqual(loaded.warnings, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('valid defaults load while unknown keys warn and are ignored', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-config-'));
  const file = path.join(directory, 'config.json');
  try {
    await writeFile(file, JSON.stringify({
      $schema: 'https://example.com/veo.json',
      quality: '720p',
      output: './videos',
      audio: false,
      concurrentFragments: 4,
      subLangs: 'de,en',
      nope: true,
    }));
    const loaded = await loadConfig({ file });
    assert.equal(loaded.exists, true);
    assert.equal(loaded.config.quality, '720p');
    assert.equal(loaded.config.output, './videos');
    assert.equal(loaded.config.concurrentFragments, 4);
    assert.equal(loaded.config.subLangs, 'de,en');
    assert.equal(Object.hasOwn(loaded.config, 'nope'), false);
    assert.equal(Object.hasOwn(loaded.config, '$schema'), false);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /Unknown config key "nope"/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a malformed or mistyped config file fails loudly', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-config-'));
  const file = path.join(directory, 'config.json');
  try {
    await writeFile(file, '{ not json');
    await assert.rejects(loadConfig({ file }), /not valid JSON/);
    await writeFile(file, '"a string"');
    await assert.rejects(loadConfig({ file }), /must contain a JSON object/);
    await writeFile(file, '["a"]');
    await assert.rejects(loadConfig({ file }), /must contain a JSON object/);
    await writeFile(file, JSON.stringify({ quality: 720 }));
    await assert.rejects(loadConfig({ file }), /"quality" must be a string, not a number/);
    await writeFile(file, JSON.stringify({ audio: 'yes' }));
    await assert.rejects(loadConfig({ file }), /"audio" must be a boolean/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('every documented key maps to a supported type', () => {
  for (const [key, type] of Object.entries(CONFIG_KEYS)) {
    assert.ok(['string', 'boolean', 'number'].includes(type), key);
  }
  assert.ok(Object.keys(CONFIG_KEYS).length >= 15);
});

test('config edit fills new and empty files and preserves existing settings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-template-'));
  const file = path.join(directory, 'config.json');
  try {
    await prepareConfigEdit(file);
    assert.equal(await readFile(file, 'utf8'), CONFIG_TEMPLATE);
    assert.equal((await loadConfig({ file })).config.profiles.music.audio, true);
    await writeFile(file, '\uFEFF  \r\n');
    await prepareConfigEdit(file);
    assert.equal(await readFile(file, 'utf8'), CONFIG_TEMPLATE);
    const original = '{\n  "quality": "480p",\n  "open": true // keep my comment\n}\n';
    await writeFile(file, original);
    await prepareConfigEdit(file);
    const annotated = await readFile(file, 'utf8');
    assert.ok(annotated.endsWith(original));
    assert.match(annotated, /commented configuration template/);
    assert.deepEqual((await loadConfig({ file })).config, { quality: '480p', open: true });
    await prepareConfigEdit(file);
    assert.equal(await readFile(file, 'utf8'), annotated, 'do not duplicate the guide');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('comment parsing preserves URLs, escaped quotes and Windows paths', () => {
  const data = { output: 'C:\\Videos\\', rename: 'https://example.test/a//b/*text*/ "quoted"', quality: '720p' };
  const text = `\uFEFF/* settings */\n${JSON.stringify(data, null, 2)} // end\n`;
  assert.deepEqual(JSON.parse(stripConfigComments(text)), data);
  assert.deepEqual(JSON.parse(stripConfigComments('{"audio": /* disabled */ false}')), { audio: false });
  assert.throws(() => stripConfigComments('{} /* unfinished'), /Unterminated/);
  assert.throws(() => JSON.parse(stripConfigComments('{"audio": tr/* comment */ue}')));
  assert.throws(() => JSON.parse(stripConfigComments('{"audio": false,}')));
});

test('legacy generated comments become English without changing user settings or notes', () => {
  // German literals here are migration inputs, not text emitted by the app.
  const legacy = '// veo: kommentierte Konfigurationsvorlage\n// Untertitel und Zusatzinformationen:\n//   // Fertige Datei automatisch oeffnen\n//     "musik": {\n{\n  // My custom note\n  "profiles": {"musik": {"audio": true}},\n  "output": "D:/Meine Videos"\n}\n';
  const translated = withConfigTemplate(legacy);
  assert.match(translated, /^\/\/ veo: commented configuration template/);
  assert.match(translated, /Subtitles and additional information/);
  assert.match(translated, /"music":/);
  assert.match(translated, /My custom note/);
  assert.deepEqual(JSON.parse(stripConfigComments(translated)), JSON.parse(stripConfigComments(legacy)));
  assert.equal(withConfigTemplate(translated), translated);
});
