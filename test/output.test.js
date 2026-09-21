import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { statsMain } from '../src/stats.js';
import { formatOutput, outputOptions, withOutputSettings } from '../src/output.js';
import { main, parseCli } from '../src/cli.js';
const stream = isTTY => ({ isTTY, text: '', write(value) { this.text += value; } });

test('profile display settings apply to reports and download options', async () => {
  const config = { profiles: { default: { color: true }, plain: { color: false } } };
  assert.equal(parseCli(['https://example.com/video', '--profile', 'plain'], { config }).color, false);
  assert.equal(parseCli(['https://example.com/video', '--profile', 'plain', '--color'], { config }).color, true);
  assert.equal(await main(['stats', '--help', '--profile', 'plain'], { config: { config } }), 0);
  assert.equal(await main(['stats', '--help', '--profile=missing'], { config: { config } }), 1);
  assert.deepEqual(outputOptions(['stats', '--profile=plain', '--no-color', '--color']), {
    profile: 'plain', color: true, remaining: ['stats', '--no-color', '--color'],
  });
  assert.deepEqual(outputOptions(['--', '--profile']), { profile: undefined, color: undefined, remaining: ['--', '--profile'] });
  assert.throws(() => outputOptions(['stats', '--profile']), /requires a profile name/);
});

test('stats separates headings, counters and details while JSON and pipes stay plain', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veo-stats-color-'));
  try {
    const terminal = stream(true);
    await statsMain([], { root, stdout: terminal });
    if (!Object.hasOwn(process.env, 'NO_COLOR') && process.env.TERM !== 'dumb') {
      assert.match(terminal.text, /\x1b\[1mveo stats/);
      assert.match(terminal.text, /\x1b\[90mTracking since:/);
    }
    for (const args of [['--json'], ['--no-color']]) {
      const output = stream(true);
      await statsMain(args, { root, stdout: output });
      assert.ok(!output.text.includes('\x1b'));
      if (args[0] === '--json') assert.equal(JSON.parse(output.text).videos, 0);
    }
    const pipe = stream(false);
    await statsMain([], { root, stdout: pipe });
    assert.ok(!pipe.text.includes('\x1b'));
    const disabled = stream(true);
    await withOutputSettings(false, () => statsMain([], { root, stdout: disabled }));
    assert.ok(!disabled.text.includes('\x1b'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('formatter preserves content, line breaks and existing ANSI sequences', () => {
  const original = 'veo 1.5.0 doctor\n  ok    Node ready\n  fail  Backend missing\n1 problem found.\n';
  const result = formatOutput(original, stream(true));
  assert.equal(result.replace(/\x1b\[[0-9;]*m/g, ''), original);
  const styled = '\x1b[32mSaved: video.mp4\x1b[0m\n';
  assert.equal(formatOutput(styled, stream(true)), styled);
});
