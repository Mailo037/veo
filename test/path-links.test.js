import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { folderLink, supportsPathLinks } from '../src/path-links.js';

test('existing files link to their folder with encoded paths and a shortened label', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo links '));
  try {
    const file = path.join(root, 'media #1.mp4');
    await writeFile(file, 'fixture');
    const env = { WT_SESSION: 'test' };
    const linked = folderLink({ isTTY: true }, file, 'media…', env);
    assert.equal(linked, `\x1b]8;;${pathToFileURL(root + path.sep).href}\x1b\\media…\x1b]8;;\x1b\\`);
    assert.equal(folderLink({ isTTY: true }, root, root, env).includes(pathToFileURL(root + path.sep).href), true);
    assert.equal(folderLink({ isTTY: false }, file, file, env), file);
    assert.equal(folderLink({ isTTY: true }, file, file, { TERM: 'dumb', ...env }), file);
    assert.equal(folderLink({ isTTY: true }, path.join(root, 'missing'), 'missing', env), 'missing');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('links require a recognized terminal and labels cannot inject controls', () => {
  for (const env of [{ TERM_PROGRAM: 'iTerm.app' }, { TERM_PROGRAM: 'WezTerm' }, { KITTY_WINDOW_ID: '1' }, { VTE_VERSION: '6000' }]) {
    assert.equal(supportsPathLinks({ isTTY: true }, env), true);
  }
  assert.equal(supportsPathLinks({ isTTY: true }, {}), false);
  assert.equal(folderLink({ isTTY: false }, '.', 'bad\x1b\nlabel'), 'bad  label');
});
