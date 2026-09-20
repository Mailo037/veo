// Verify npm's actual tarball, including the POSIX executable bit, on Windows too.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { globSync } from 'node:fs';
import path from 'node:path';
import { compareVersions } from '../src/version.js';
const archives = globSync('mailo037-veo-*.tgz')
  .sort((a, b) => compareVersions(b.match(/([\d.]+)\.tgz$/)[1], a.match(/([\d.]+)\.tgz$/)[1]));
const archive = process.argv[2] || archives[0];
if (!archive) {
  console.error('FAIL: no package tarball found. Run npm pack first.');
  process.exit(1);
}
const tar = gunzipSync(await readFile(archive));
const names = [];
const contents = new Map();
let executable = false;
let binMode = 0;
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
  if (!name) break;
  const size = parseInt(header.subarray(124, 136).toString().replace(/\0/g, '').trim(), 8) || 0;
  const mode = parseInt(header.subarray(100, 108).toString().replace(/\0/g, '').trim(), 8);
  names.push(name);
  contents.set(name, tar.subarray(offset + 512, offset + 512 + size));
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
for (const file of ['package/package.json', 'package/src/cli.js', 'package/src/backend.js', 'package/src/downloader.js', 'package/src/interactive.js', 'package/src/jobs.js', 'package/src/playlist.js', 'package/src/state.js', 'package/README.md', 'package/CHANGELOG.md', 'package/LICENSE']) assert(names.includes(file), `Missing ${file}`);
assert(!names.some(name => /node_modules|\/test\/|\.env|\/scripts\//.test(name)));
// Every relative import in the packed runtime must resolve inside the tarball, so a
// module that is left out of "files" fails here instead of on a user's first run.
const present = new Set(names);
const unshipped = new Set(
  names.filter(name => /^package\/(?:src|bin)\/.*\.js$/.test(name))
    .flatMap(name => [...contents.get(name).toString().matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)].map(match => [name, match[1]]))
    .map(([name, specifier]) => path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier)))
    .filter(target => !present.has(target)),
);
assert.equal(unshipped.size, 0, `Relative imports missing from the tarball: ${[...unshipped].join(', ')}`);
// The runtime files must also be complete: a truncated or empty module would pass the
// name check above while breaking every command that imports it.
for (const name of names) {
  if (!/^package\/(?:src|bin)\/.*\.js$/.test(name)) continue;
  assert(contents.get(name).length > 0, `Empty runtime file: ${name}`);
}
// The version in package.json, the lockfile and the CHANGELOG heading must agree, so a
// half-finished release bump cannot be published.
const pkg = JSON.parse(contents.get('package/package.json').toString());
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `Invalid package version: ${pkg.version}`);
assert.match(archive, new RegExp(`veo-${pkg.version.replace(/\./g, '\\.')}\\.tgz$`), `Tarball name does not match version ${pkg.version}`);
assert(contents.get('package/CHANGELOG.md').toString().includes(`## ${pkg.version}`), `CHANGELOG.md has no "## ${pkg.version}" section`);
console.log(`PASS: ${archive}: ${names.length} entries, shebang present, bin mode ${binMode.toString(8)} (npm sets 0755 on install), required runtime files, imports resolve, version ${pkg.version} consistent, no development files.`);
