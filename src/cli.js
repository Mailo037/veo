import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createReporter } from './progress.js';
import { openFile } from './open-file.js';
import { maybeUpdateNotice, updateMain, UPDATE_HELP, defaultRegistry, packageVersion } from './updater.js';
import { loadConfig } from './config.js';
import { QUALITIES, VIDEO_FORMATS, AUDIO_FORMATS, validateUrl, readableError, cleanText, validateCookieFile, validateBrowserSpec, cookieFileWarning } from './utils.js';

export const HELP = `veo - simple video downloader

Usage:
  veo <url> [<url>...] [options]

Options:
  -q, --quality <quality>   Video quality (best, 2160p, 1440p, 1080p, 720p, 480p, 360p)
                           Numeric qualities are an upper bound: -q 720p never
                           downloads 2160p. Use --closest-quality for the nearest
                           available resolution instead.
  -o, --output <path>       Output directory (default: current directory)
  -r, --rename <name>       Custom filename without extension (also used in tab title)
  --closest-quality         Pick the nearest available resolution, above or below
  --open                   Open the saved file with your default app
  --audio                  Download audio only (default: mp3)
  --format <format>        Video: mp4, mkv, webm, mov; audio: mp3, m4a, aac, opus, flac, wav
  --playlist               Download every entry of a playlist or channel URL
  -N, --concurrent-fragments <n>
                           Download this many fragments in parallel (1-16)
  --subs                   Download subtitles (default languages: en)
  --sub-langs <langs>      Subtitle languages, e.g. "de,en" (implies --subs)
  --embed-subs             Embed subtitles into the video file
  --embed-metadata         Embed title, date and other metadata
  --embed-thumbnail        Embed the thumbnail
  --sponsorblock-remove <categories>
                           Remove sponsor segments, e.g. "sponsor,selfpromo"
  --section <range>        Download only a time range, e.g. "*10:00-12:00"
  --cookies <file>         Netscape cookie file, for content you may access
  --cookies-from-browser <browser[:profile]>
                           Read cookies from an installed browser
  --resume                 Keep partial data and continue an interrupted download
  --list-formats           Show the available formats and exit
  --dry-run                Show what would be downloaded and exit
  --json                   Print one JSON object per URL instead of prose
  -v, --version            Show installed version (also: veo version)
  -h, --help               Show help

Commands:
  veo update [--check]     Update veo itself with npm
  veo backend update       Install a newer yt-dlp release (see veo backend --help)
  veo doctor               Diagnose the local setup
  veo version              Show the installed version

Defaults can be stored in the veo config file; veo doctor prints its location.

Examples:
  veo "https://youtube.com/watch?v=..."
  veo <url> -q 1080p
  veo <url> --audio
  veo <url> -o ./downloads
  veo <url> -r "My Video" --open
  veo <url1> <url2> --subs --embed-metadata
  veo update --check

Only download content you are authorized or legally permitted to download.
`;

const STRING_OPTIONS = {
  quality: { short: 'q' },
  output: { short: 'o' },
  rename: { short: 'r' },
  format: {},
  cookies: {},
  'cookies-from-browser': {},
  'concurrent-fragments': { short: 'N' },
  'sub-langs': {},
  'sponsorblock-remove': {},
  section: {},
};

const BOOLEAN_OPTIONS = {
  open: {},
  audio: {},
  resume: {},
  playlist: {},
  subs: {},
  'embed-subs': {},
  'embed-metadata': {},
  'embed-thumbnail': {},
  'closest-quality': {},
  'list-formats': {},
  'dry-run': {},
  json: {},
  help: { short: 'h' },
  version: { short: 'v' },
};

// Config defaults, so an explicit flag always wins but a stored preference does not.
export function optionDefaults(config = {}) {
  return {
    quality: config.quality ?? 'best',
    output: config.output ?? process.cwd(),
    rename: config.rename,
    format: config.format,
    cookies: config.cookies,
    'cookies-from-browser': config.cookiesFromBrowser,
    'concurrent-fragments': config.concurrentFragments === undefined ? undefined : String(config.concurrentFragments),
    'sub-langs': config.subLangs,
    'sponsorblock-remove': config.sponsorblockRemove,
    section: config.section,
    open: config.open ?? false,
    audio: config.audio ?? false,
    resume: config.resume ?? false,
    playlist: config.playlist ?? false,
    subs: config.subs ?? false,
    'embed-subs': config.embedSubs ?? false,
    'embed-metadata': config.embedMetadata ?? false,
    'embed-thumbnail': config.embedThumbnail ?? false,
    'closest-quality': config.closestQuality ?? false,
    json: config.json ?? false,
  };
}

export function cliOptions(config = {}) {
  const defaults = optionDefaults(config);
  const options = {};
  for (const [name, extra] of Object.entries(STRING_OPTIONS)) {
    options[name] = { type: 'string', ...extra };
    if (defaults[name] !== undefined) options[name].default = defaults[name];
  }
  for (const [name, extra] of Object.entries(BOOLEAN_OPTIONS)) {
    options[name] = { type: 'boolean', ...extra };
    if (defaults[name] !== undefined) options[name].default = defaults[name];
  }
  return options;
}

export function parseCli(args, { config = {} } = {}) {
  if (args[0] === 'version') {
    if (args.length !== 1) throw new Error('Usage: veo version');
    return { version: true };
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: cliOptions(config) });
  if (values.help || values.version) return values;
  const defaults = optionDefaults(config);
  // A stored default conflicting with a flag typed right now is a user error;
  // a stored default merely ignored by another flag is not.
  const typed = {
    quality: values.quality !== defaults.quality,
    closest: values['closest-quality'] !== defaults['closest-quality'],
    audio: values.audio !== defaults.audio,
  };
  // An explicit numeric --quality states video intent, so it overrides an
  // audio-only default instead of turning into a confusing conflict error.
  if (typed.quality && values.quality !== 'best' && values.audio && !typed.audio) values.audio = false;
  if (!positionals.length) throw new Error('Provide at least one video URL. Run veo --help for usage.');
  if (!QUALITIES.includes(values.quality)) throw new Error(`Invalid quality. Choose: ${QUALITIES.join(', ')}.`);
  if (!values.output.trim()) throw new Error('The output directory cannot be empty.');
  if (values.rename !== undefined && !cleanText(values.rename)) throw new Error('The custom filename cannot be empty.');
  if (positionals.length > 1 && values.rename !== undefined) throw new Error('--rename only applies to a single URL.');
  if (values.audio && values.quality !== 'best' && typed.quality) throw new Error('--quality is for video; omit it when using --audio.');
  if (values.audio && values['closest-quality'] && typed.closest) throw new Error('--closest-quality is for video; omit it when using --audio.');
  if (values['closest-quality'] && values.quality === 'best' && typed.closest) throw new Error('--closest-quality requires a numeric --quality such as 1080p.');
  if (values['list-formats'] && (values.audio || values.format)) throw new Error('--list-formats cannot be combined with --audio or --format.');
  if (values['list-formats'] && positionals.length > 1) throw new Error('--list-formats accepts exactly one URL.');
  if (values['concurrent-fragments'] !== undefined) {
    const fragments = Number(values['concurrent-fragments']);
    if (!Number.isInteger(fragments) || fragments < 1 || fragments > 16) throw new Error('--concurrent-fragments must be a whole number between 1 and 16.');
  }
  if (values.section && !/^[*\d]/.test(values.section.trim())) throw new Error('--section requires a range such as "*10:00-12:00" or "10:00-12:00".');
  if (values['sponsorblock-remove'] && !/^[a-z_,-]+$/i.test(values['sponsorblock-remove'].trim())) throw new Error('--sponsorblock-remove takes comma-separated category names, e.g. "sponsor,selfpromo".');
  const formats = values.audio ? AUDIO_FORMATS : VIDEO_FORMATS;
  if (values.format && !formats.includes(values.format)) throw new Error(`Invalid ${values.audio ? 'audio' : 'video'} format. Choose: ${formats.join(', ')}.${!values.audio && AUDIO_FORMATS.includes(values.format) ? ' Use --audio for audio formats.' : ''}`);

  const options = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    options[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  options.urls = positionals.map(validateUrl);
  options.url = options.urls[0];
  if (values.cookies !== undefined) options.cookies = validateCookieFile(values.cookies);
  if (values['cookies-from-browser'] !== undefined) options.cookiesFromBrowser = validateBrowserSpec(values['cookies-from-browser']);
  if (options.section) options.section = options.section.trim();
  if (options.sponsorblockRemove) options.sponsorblockRemove = options.sponsorblockRemove.trim();
  if (options.concurrentFragments !== undefined) options.concurrentFragments = Number(options.concurrentFragments);
  if (options.subLangs) options.subs = true;
  return options;
}

async function jsonMain(options, { reporter, signal }) {
  const { download } = await import('./downloader.js');
  const results = [];
  let failed = false;
  for (const url of options.urls) {
    try {
      const result = await download({ ...options, url }, { signal, reporter });
      results.push({ url, status: 'saved', title: result.title, files: result.files });
      if (options.open && result.files.length) {
        try { await openFile(result.files[0]); }
        catch (error) { process.stderr.write(`veo: File saved, but could not launch the default app: ${readableError(error)}\n`); }
      }
    } catch (error) {
      if (signal.aborted) {
        results.push({ url, status: 'cancelled' });
        failed = true;
        break;
      }
      results.push({ url, status: 'failed', error: readableError(error) });
      failed = true;
    }
  }
  for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
  return failed ? 1 : 0;
}

export async function main(args = process.argv.slice(2), { config } = {}) {
  // update/upgrade/check subcommands are handled before URL validation.
  if (['update', 'upgrade', 'check'].includes(args[0])) {
    if (args[0] === 'check' && args[1] !== 'update') {
      process.stdout.write(UPDATE_HELP);
      return 0;
    }
    return updateMain(args, { registry: defaultRegistry() });
  }
  if (args[0] === 'doctor') {
    try {
      const { doctorMain } = await import('./doctor.js');
      return await doctorMain(args.slice(1));
    } catch (error) {
      process.stderr.write(`veo: ${readableError(error)}\n`);
      return 1;
    }
  }
  if (args[0] === 'backend') {
    try {
      const { backendUpdateMain } = await import('./backend-update.js');
      return await backendUpdateMain(args.slice(1));
    } catch (error) {
      process.stderr.write(`veo: ${readableError(error)}\n`);
      return 1;
    }
  }
  const reporter = createReporter();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const loaded = config ?? await loadConfig();
    for (const warning of loaded.warnings || []) process.stderr.write(`veo: ${warning}\n`);
    const options = parseCli(args, { config: loaded.config });
    if (options.help) { process.stdout.write(HELP); return 0; }
    if (options.version) {
      const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      process.stdout.write(`${pkg.version}\n`);
      return 0;
    }
    reporter.start(options.rename);
    const cookieWarning = cookieFileWarning(options.cookies);
    if (cookieWarning) process.stderr.write(`veo: ${cookieWarning}\n`);

    if (options.listFormats) {
      const { listFormats } = await import('./downloader.js');
      process.stdout.write(await listFormats(options, { signal: controller.signal, reporter }));
      return 0;
    }
    if (options.dryRun) {
      const { planDownload } = await import('./downloader.js');
      for (const url of options.urls) {
        const plan = await planDownload({ ...options, url }, { signal: controller.signal, reporter });
        if (options.json) process.stdout.write(`${JSON.stringify({ url, status: 'planned', ...plan })}\n`);
        else {
          process.stdout.write(`URL: ${url}\n`);
          if (plan.quality) process.stdout.write(`${plan.quality}\n`);
          for (const entry of plan.entries) process.stdout.write(`Would save: ${cleanText(entry.path)}\n`);
        }
      }
      return 0;
    }
    if (options.json) return await jsonMain(options, { reporter, signal: controller.signal });

    const { download } = await import('./downloader.js');
    let failed = 0;
    const primaryFiles = [];
    for (const url of options.urls) {
      try {
        const result = await download({ ...options, url }, { signal: controller.signal, reporter });
        reporter.complete();
        for (const file of result.files) process.stdout.write(`Saved: ${cleanText(file)}\n`);
        if (result.files.length) primaryFiles.push(result.files[0]);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        failed++;
        const prefix = options.urls.length > 1 ? `${cleanText(url)}: ` : '';
        process.stderr.write(`veo: ${prefix}${readableError(error)}\n`);
      }
    }
    if (failed) {
      reporter.fail();
      return 1;
    }
    if (options.open) {
      for (const file of primaryFiles) {
        try { await openFile(file); }
        catch (error) {
          process.stderr.write(`veo: File saved, but could not launch the default app: ${readableError(error)}\n`);
          break;
        }
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
