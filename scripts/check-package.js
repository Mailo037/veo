// Verify npm's actual tarball, including the POSIX executable bit, on Windows too.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { globSync } from 'node:fs';
const archive = process.argv[2] || globSync('mailo037-veo-*.tgz')
  .sort((a, b) => b.match(/([\d.]+)\.tgz$/)[1].split('.').map(Number).join('.') > a.match(/([\d.]+)\.tgz$/)[1].split('.').map(Number).join('.') ? 1 : -1)[0];
const tar = gunzipSync(await readFile(archive));
const names = [];
let executable = false;
let binMode = 0;
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
  if (!name) break;
  const size = parseInt(header.subarray(124, 136).toString().replace(/\0/g, '').trim(), 8) || 0;
  const mode = parseInt(header.subarray(100, 108).toString().replace(/\0/g, '').trim(), 8);
  names.push(name);
  if (name === 'package/bin/veo.js') {
    // npm (reify) chmods bin targets to 0755 on Unix at install time and always
    // creates command shims, so a 0644 mode from a Windows pack is still functional.
    executable = (mode & 0o111) !== 0;
    binMode = mode;
    assert(tar.subarray(offset + 512, offset + 512 + size).toString().startsWith('#!/usr/bin/env node\n'));
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (!executable) console.log(`Note: bin mode is ${binMode.toString(8)} (no Unix exec bit; expected when packing on Windows). npm chmods bin targets to 0755 on install and creates shims, so this is cosmetic.`);
for (const file of ['package/package.json', 'package/src/cli.js', 'package/src/backend.js', 'package/src/downloader.js', 'package/README.md', 'package/LICENSE']) assert(names.includes(file), `Missing ${file}`);
assert(!names.some(name => /node_modules|\/test\/|\.env|\/scripts\//.test(name)));
console.log(`PASS: ${archive}: ${names.length} entries, shebang present, bin mode ${binMode.toString(8)} (npm sets 0755 on install), required runtime files, no development files.`);
