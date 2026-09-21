// Explicit network smoke: exercises fresh desktop media installation in an
// isolated temporary cache, including real npm download and binary execution.
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findOnPath } from '../src/backend.js';
import { installMediaTools, runSetup } from '../src/tool-setup.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'veo-setup-smoke-'));
try {
  await installMediaTools({ directory, find: findOnPath,
    stage: copyFile, status: message => console.log(message),
  });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['ffmpeg', 'ffprobe']) {
    const result = await runSetup(path.join(directory, `${name}${suffix}`), ['-version']);
    if (!result.includes(`${name} version`)) throw new Error(`Unexpected ${name} output`);
  }
  console.log('PASS: fresh media tools downloaded, staged and executed.');
} finally { await rm(directory, { recursive: true, force: true }); }
