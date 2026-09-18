import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createReporter } from './progress.js';
import { openFile } from './open-file.js';
import { maybeUpdateNotice, updateMain, UPDATE_HELP, defaultRegistry, packageVersion } from './updater.js';
import { QUALITIES, VIDEO_FORMATS, AUDIO_FORMATS, validateUrl, readableError, cleanText } from './utils.js';

export const HELP = `veo - simple video downloader

Usage:
  veo <url> [options]

Options:
  -q, --quality <quality>   Video quality (best, 2160p, 1440p, 1080p, 720p, 480p, 360p)
  -o, --output <path>       Output directory (default: current directory)
  -r, --rename <name>       Custom filename without extension (also used in tab title)
  --open                   Open the saved file with your default app
  --audio                  Download audio only (default: mp3)
  --format <format>        Video: mp4, mkv, webm, mov; audio: mp3, m4a, aac, opus, flac, wav
  -v, --version            Show installed version (also: veo version)
  -h, --help               Show help

Examples:
  veo "https://youtube.com/watch?v=..."
  veo <url> -q 1080p
  veo <url> --audio
  veo <url> -o ./downloads
  veo <url> -r "My Video" --open
  veo update --check

Only download content you are authorized or legally permitted to download.
`;

export function parseCli(args) {
  if (args[0] === 'version') {
    if (args.length !== 1) throw new Error('Usage: veo version');
    return { version: true };
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    quality: { type: 'string', short: 'q', default: 'best' },
    output: { type: 'string', short: 'o', default: process.cwd() },
    rename: { type: 'string', short: 'r' },
    open: { type: 'boolean' },
    audio: { type: 'boolean', default: false },
    format: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  } });
  if (values.help || values.version) return values;
  if (positionals.length !== 1) throw new Error('Provide exactly one video URL. Run veo --help for usage.');
  if (!QUALITIES.includes(values.quality)) throw new Error(`Invalid quality. Choose: ${QUALITIES.join(', ')}.`);
  if (!values.output.trim()) throw new Error('The output directory cannot be empty.');
  if (values.rename !== undefined && !cleanText(values.rename)) throw new Error('The custom filename cannot be empty.');
  if (values.audio && values.quality !== 'best') throw new Error('--quality is for video; omit it when using --audio.');
  const formats = values.audio ? AUDIO_FORMATS : VIDEO_FORMATS;
  if (values.format && !formats.includes(values.format)) throw new Error(`Invalid ${values.audio ? 'audio' : 'video'} format. Choose: ${formats.join(', ')}.${!values.audio && AUDIO_FORMATS.includes(values.format) ? ' Use --audio for audio formats.' : ''}`);
  return { ...values, url: validateUrl(positionals[0]) };
}

export async function main(args = process.argv.slice(2)) {
  // update/upgrade/check subcommands are handled before URL validation.
  if (['update', 'upgrade', 'check'].includes(args[0])) {
    if (args[0] === 'check' && args[1] !== 'update') {
      process.stdout.write(UPDATE_HELP);
      return 0;
    }
    return updateMain(args, { registry: defaultRegistry() });
  }
  const reporter = createReporter();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const options = parseCli(args);
    if (options.help) { process.stdout.write(HELP); return 0; }
    if (options.version) {
      const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      process.stdout.write(`${pkg.version}\n`);
      return 0;
    }
    reporter.start(options.rename);
    const { download } = await import('./downloader.js');
    const saved = await download(options, { signal: controller.signal, reporter });
    reporter.complete();
    process.stdout.write(`Saved: ${cleanText(saved)}\n`);
    if (options.open) {
      try { await openFile(saved); }
      catch (error) {
        process.stderr.write(`veo: File saved, but could not launch the default app: ${readableError(error)}\n`);
      }
    }
    const notice = await maybeUpdateNotice({ currentVersion: await packageVersion() });
    if (notice) process.stderr.write(`${notice}\n`);
    return 0;
  } catch (error) {
    reporter.fail(controller.signal.aborted);
    process.stderr.write(`veo: ${readableError(error)}\n`);
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
