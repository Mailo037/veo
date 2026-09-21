import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EditorBuffer, colorLine, editConfig, validateEditorText } from '../src/config-editor.js';
import { editorCompletions } from '../src/config-diagnostics.js';

test('semantic errors locate properties and values without matching comments or other profiles', async () => {
  for (const [text, span, message, line] of [
    ['{\n "Quality": "best"\n}', '"Quality"', /Did you mean "quality"/, 2],
    ['{\n "quality": "super"\n}', '"super"', /unsupported value "super".*Choose:.*best/, 2],
    ['{"audio":"ja"}', '"ja"', /boolean.*true, false/, 1],
    ['// "quality": "super"\n{"quality":"best",\n"profiles":{"bad":{"quality":"super"}}}', '"super"', /Profile "bad"/, 3],
    ['\uFEFF{/*comment*/"Qual\\u0069ty":"best"}', '"Qual\\u0069ty"', /Did you mean "quality"/, 1],
    ['{"profiles":{"profiles":{"audio":"yes"}}}', '"yes"', /boolean/, 1],
    ['{"profiles":[]}', '[]', /must be an object/, 1],
    ['{"concurrentFragments":17}', '17', /between 1 and 16/, 1],
    ['{"quality":"best","quality":"bad"}', '"bad"', /Invalid quality/, 1],
  ]) {
    const issue = await validateEditorText(text);
    assert.ok(issue, text);
    assert.equal(text.slice(issue.start, issue.end), span);
    assert.equal(issue.line, line);
    assert.match(issue.message, message);
  }
  assert.equal(await validateEditorText('{"quality":"900p"}'), null);
  assert.equal(await validateEditorText('{"audio":true,"format":"flac"}'), null);
  const inherited = '{"format":"mp4","profiles":{"music":{"audio":true}}}';
  const issue = await validateEditorText(inherited);
  assert.equal(inherited.slice(issue.start, issue.end), '"mp4"');
  assert.ok(issue.choices.includes('flac'));
  assert.ok(!issue.choices.includes('mp4'));
});

test('completion offers contextual values and spelling corrections without restricting free text', () => {
  const text = '{"audio":true,"profiles":{"music":{"format":"mp3"}}}';
  const options = editorCompletions(text, text.indexOf('mp3'));
  assert.ok(options.choices.includes('flac'));
  assert.ok(!options.choices.includes('mp4'));
  assert.equal(text.slice(options.start, options.end), '"mp3"');
  assert.equal(editorCompletions('{"Quality":"best"}', 3).choices[0], 'quality');
  assert.equal(editorCompletions('{"output":"folder"}', 13), null);
  assert.equal(editorCompletions('{"quality":', 11), null);
});

test('buffer joins and splits lines and clamps vertical movement', () => {
  const buffer = new EditorBuffer('abc\nx');
  buffer.key('end'); buffer.key('return'); buffer.insert('z');
  assert.equal(buffer.text, 'abc\nz\nx');
  buffer.key('home'); buffer.key('backspace');
  assert.equal(buffer.text, 'abcz\nx');
  buffer.key('down'); assert.deepEqual(buffer.position, { row: 1, col: 1 });
  buffer.key('home'); buffer.key('delete'); assert.equal(buffer.text, 'abcz\n');
});

test('validation catches syntax locations, types, unknown keys and CLI constraints', async () => {
  assert.equal(await validateEditorText('// note\n{"audio":true}'), null);
  assert.equal((await validateEditorText('{\n"audio": true,\n}')).line, 3);
  assert.match((await validateEditorText('{"audio":"yes"}')).message, /boolean/);
  assert.match((await validateEditorText('{"typo":true}')).message, /Unknown/);
  assert.ok(await validateEditorText('{"concurrentDownloads":-1}'));
  assert.ok(await validateEditorText('{"profiles":{"bad":{"concurrentDownloads":-1}}}'));
  assert.equal(colorLine('\x1b[2J', false), ' [2J');
});

test('mouse selections support reverse and multiline deletion and replacement', () => {
  const buffer = new EditorBuffer('abc\ndef\nghi');
  buffer.point(2, 2); buffer.point(0, 1, true);
  assert.deepEqual(buffer.selection, [1, 10]);
  buffer.key('backspace'); assert.equal(buffer.text, 'ai');
  buffer.point(0, 0); buffer.point(0, 2, true); buffer.insert('new');
  assert.equal(buffer.text, 'new');
  buffer.point(0, 0); buffer.point(0, 2, true); buffer.key('delete');
  assert.equal(buffer.text, 'w');
  buffer.point(0, 999); assert.equal(buffer.cursor, 1);
});

test('terminal session saves, blocks invalid writes, confirms discard and restores terminal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veo-editor-'));
  const file = path.join(dir, 'config.json');
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  output.columns = 90; output.rows = 20;
  let screen = ''; output.on('data', chunk => { screen += chunk; });
  const waitFor = async condition => {
    for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error('Editor did not reach expected state');
  };
  const key = (name, text = '', ctrl = false) => input.emit('keypress', text, { name, ctrl });
  try {
    await writeFile(file, '{}\r\n');
    const session = editConfig(file, { input, output });
    await waitFor(() => screen.includes('Ctrl+S'));
    key('right'); key(undefined, '"audio":true'); key('s', '', true);
    await waitFor(() => screen.includes('Saved'));
    assert.equal(await readFile(file, 'utf8'), '{"audio":true}\r\n');
    // Real input path: fragmented press, drag and release select true, then replace it.
    screen = '';
    input.write('\x1b[<0;'); input.write('13;2M');
    input.write('\x1b[<32;17;2M\x1b[<0;17;2m');
    assert.ok(screen.includes('\x1b[7mtrue\x1b[0m'));
    input.write('false'); screen = ''; input.write('\x13');
    await waitFor(() => screen.includes('Saved'));
    assert.equal(await readFile(file, 'utf8'), '{"audio":false}\r\n');
    key('f2'); assert.match(screen, /Options \(1\/2\): true/);
    screen = ''; key('return'); await waitFor(() => screen.includes('Config OK'));
    screen = ''; key('s', '', true);
    await waitFor(() => screen.includes('Saved'));
    assert.equal(await readFile(file, 'utf8'), '{"audio":true}\r\n');
    key(undefined, ','); key('s', '', true);
    await waitFor(() => screen.includes('Trailing commas'));
    assert.equal(await readFile(file, 'utf8'), '{"audio":true}\r\n');
    key('escape'); assert.match(screen, /Discard unsaved/);
    key('y', 'y'); await session;
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('keypress'), 0);
    assert.equal(input.listenerCount('data'), 0);
    assert.ok(screen.includes('\x1b[?1002l\x1b[?1006l'));
    assert.ok(screen.endsWith('\x1b[?1049l'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
