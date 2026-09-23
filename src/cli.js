import { outputOptions, outputStream, withOutputSettings } from './output.js';
import { validateTemplate } from './naming.js';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createReporter } from './progress.js';
import { openFile } from './open-file.js';
import { maybeUpdateNotice, updateMain, UPDATE_HELP, defaultRegistry, packageVersion } from './updater.js';
import { applyProfile, configMain, loadConfig } from './config.js';
import { validateItems, describeEstimate } from './playlist.js';
import { retryOptions, runJob, jobFilePath } from './jobs.js';
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
  -r, --rename <name>       Filename without extension; * inserts the original title
  --closest-quality         Pick the nearest available resolution, above or below
  --open                   Open the saved file with your default app
  --audio                  Download audio only (default: mp3)
  --format <format>        Video: mp4, mkv, webm, mov; audio: mp3, m4a, aac, opus, flac, wav
                           Video uses lossless remux; incompatible codecs fail.
  --compatible             Ensure MP4 H.264/AAC; converts only when needed (may lose quality)
  --recode                 Allow video conversion (requires --format; may lose quality)
  --concurrent-downloads <n>  Parallel URLs/batch entries (1-4; default: 2)
  --adaptive-concurrency   Reduce connections and retry temporary failures (default: on)
  --filename-template <s>  Filename without extension, e.g. {index} - {title}
  --folder-template <s>    Relative folders, e.g. {channel}/{year}
  --check-space            Estimate cache/output space before downloading (default: on)
  --timings                Show phase timings (default: on; --no-timings disables)
  --no-color               Disable terminal colors (also respects NO_COLOR)
  --playlist-concurrency <n>  Simultaneous playlist downloads (1-4; default: 2)
  --playlist               Download every entry of a playlist or channel URL
  -N, --concurrent-fragments <n>
                           Download this many fragments in parallel (1-16; default: 8)
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
  --profile <name>         Apply a named config profile
  --batch-file <file>      Read URLs from a file (one per line; # comments)
  --retry-failed <file>    Retry failed/unfinished items from a saved job
  --playlist-items <list>  Select playlist entries, e.g. 1,3-5 (implies --playlist)
  --skip-existing         Skip matching downloads still present on disk
  --no-<boolean-option>   Disable a stored boolean default, e.g. --no-open
  -v, --version            Show installed version (also: veo version)
  -h, --help               Show help (also: veo help)

Commands:
  veo update [--check]     Update veo itself with npm
  veo backend update       Install a newer yt-dlp release (see veo backend --help)
  veo doctor               Diagnose the local setup
  veo flush                Stop veo runs and clear temporary downloads and jobs
  veo stats                Show persistent download statistics
  veo history              Show the last 5 downloads (--json for scripting)
  veo retry --last         Retry the newest failed or unfinished job
  veo history --failed --limit 20  Filter and extend download history
  veo runs [id]            List active runs; add --json for metadata and progress
  veo inspect <file>        Read media metadata; --check-audio measures audio signal
  veo inspect run <id>     Inspect saved files from a finished run by its id
  veo stop [id]            Stop one run, or every active run
  veo version              Show the installed version
  veo config edit|path|profiles|check|show|reset  Manage defaults and named profiles
  veo config edit [--external|--terminal]      Choose the configuration editor

Run veo without arguments in a terminal for interactive setup.
Agent workflow: see docs/AGENT_GUIDE.md in the repository or installed package.

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
  'playlist-concurrency': {},
  'concurrent-downloads': {},
  'filename-template': {},
  'folder-template': {},
  cookies: {},
  'cookies-from-browser': {},
  'concurrent-fragments': { short: 'N' },
  'sub-langs': {},
  'sponsorblock-remove': {},
  section: {},
  profile: {},
  'batch-file': {},
  'retry-failed': {},
  'playlist-items': {},
};

const BOOLEAN_OPTIONS = {
  compatible: {},
  recode: {},
  'adaptive-concurrency': {},
  'check-space': {},
  timings: {},
  color: {},
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
  'skip-existing': {},
};

// Config defaults, so an explicit flag always wins but a stored preference does not.
export function optionDefaults(config = {}) {
  return {
    quality: config.quality ?? 'best',
    output: config.output ?? process.cwd(),
    rename: config.rename,
    format: config.format,
    compatible: config.compatible ?? false,
    recode: config.recode ?? false,
    'concurrent-downloads': String(config.concurrentDownloads ?? 2),
    'filename-template': config.filenameTemplate,
    'folder-template': config.folderTemplate,
    'adaptive-concurrency': config.adaptiveConcurrency ?? true,
    'check-space': config.checkSpace ?? true,
    timings: config.timings ?? true,
    color: config.color ?? true,
    'playlist-concurrency': String(config.playlistConcurrency ?? 2),
    cookies: config.cookies,
    'cookies-from-browser': config.cookiesFromBrowser,
    'concurrent-fragments': String(config.concurrentFragments ?? 8),
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
    'skip-existing': config.skipExisting ?? false,
    'playlist-items': config.playlistItems,
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
  if (args[0] === 'help') args = ['--help', ...args.slice(1)];
  if (args[0] === 'version') {
    if (args.length !== 1) throw new Error('Usage: veo version');
    return { version: true };
  }
  const preliminary = parseArgs({ args, allowPositionals: true, strict: true, allowNegative: true, options: cliOptions() });
  config = applyProfile(config, preliminary.values.profile);
  const { values, positionals, tokens } = parseArgs({ args, tokens: true, allowNegative: true, allowPositionals: true, strict: true, options: cliOptions(config) });
  if (values.help || values.version) return values;
  // A stored default conflicting with a flag typed right now is a user error;
  // a stored default merely ignored by another flag is not.
  const typed = {
    quality: tokens.some(token => token.name === 'quality'),
    closest: tokens.some(token => token.name === 'closest-quality'),
    audio: tokens.some(token => ['audio', 'no-audio'].includes(token.name)),
  };
  // An explicit numeric --quality states video intent, so it overrides an
  // audio-only default instead of turning into a confusing conflict error.
  if (typed.quality && values.quality !== 'best' && values.audio && !typed.audio) values.audio = false;
  if (!positionals.length && !values['batch-file'] && !values['retry-failed']) throw new Error('Provide at least one video URL. Run veo --help for usage.');
  if (!QUALITIES.includes(values.quality) && !/^[1-9]\d{1,4}p$/.test(values.quality)) throw new Error(`Invalid quality. Choose: ${QUALITIES.join(', ')} or a numeric resolution.`);
  if (values['playlist-items']) {
    if (values.playlist === false && tokens.some(token => token.name === 'playlist')) {
      if (tokens.some(token => token.name === 'playlist-items')) throw new Error('--playlist-items cannot be combined with --no-playlist.');
      values['playlist-items'] = undefined;
    } else { validateItems(values['playlist-items']); values.playlist = true; }
  }
  if (values['retry-failed'] && (positionals.length || values['batch-file'])) throw new Error('--retry-failed cannot be combined with URLs or --batch-file.');
  if (!values.output.trim()) throw new Error('The output directory cannot be empty.');
  if (values.rename !== undefined && !cleanText(values.rename)) throw new Error('The custom filename cannot be empty.');
  if (positionals.length > 1 && values.rename !== undefined && !values.rename.includes('*')) throw new Error('--rename only applies to a single URL unless the name contains * for the original title.');
  if (values.audio && values.quality !== 'best' && typed.quality) throw new Error('--quality is for video; omit it when using --audio.');
  if (values.audio && values['closest-quality'] && typed.closest) throw new Error('--closest-quality is for video; omit it when using --audio.');
  if (values['closest-quality'] && values.quality === 'best' && typed.closest) throw new Error('--closest-quality requires a numeric --quality such as 1080p.');
  if (values['list-formats'] && (values.audio || values.format)) throw new Error('--list-formats cannot be combined with --audio or --format.');
  if (values['list-formats'] && positionals.length > 1) throw new Error('--list-formats accepts exactly one URL.');
  if (values['concurrent-fragments'] !== undefined) {
    const fragments = Number(values['concurrent-fragments']);
    if (!Number.isInteger(fragments) || fragments < 1 || fragments > 16) throw new Error('--concurrent-fragments must be a whole number between 1 and 16.');
  }
  const concurrency = Number(values['playlist-concurrency']);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('--playlist-concurrency must be a whole number between 1 and 4.');
  if (values.compatible && (values.audio || (values.format && values.format !== 'mp4') || values.recode || values['embed-subs'] || values['embed-thumbnail'])) throw new Error('--compatible requires video MP4 without --recode, --embed-subs or --embed-thumbnail.');
  if (values.compatible) values.format = 'mp4';
  if (values.recode && (!values.format || values.audio)) throw new Error('--recode requires --format and video mode.');
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
  options.playlistConcurrency = concurrency;
  options.concurrentDownloads = Number(values['concurrent-downloads']);
  if (!Number.isInteger(options.concurrentDownloads) || options.concurrentDownloads < 1 || options.concurrentDownloads > 4) throw new Error('--concurrent-downloads must be a whole number between 1 and 4.');
  if (options.filenameTemplate !== undefined) validateTemplate(options.filenameTemplate);
  if (options.folderTemplate !== undefined) validateTemplate(options.folderTemplate, { folders: true });
  if (options.rename && options.filenameTemplate) throw new Error('--rename and --filename-template cannot be combined.');
  const disableSubs = values.subs === false && tokens.some(token => token.name === 'subs');
  if (options.subLangs && !disableSubs) options.subs = true;
  if (disableSubs) {
    options.subLangs = undefined;
    options.embedSubs = false;
  }
  return options;
}

export async function main(args = process.argv.slice(2), { config } = {}) {
  if (args[0] === 'help') args = ['--help', ...args.slice(1)];
  let color = !args.includes('--no-color') && !args.includes('--json');
  let display;
  try {
    display = outputOptions(args);
    const loaded = config ?? await loadConfig();
    color = !args.includes('--json') && (display.color ?? applyProfile(loaded.config || {}, display.profile).color ?? true);
    // Validate explicit profiles even when a color flag overrides their setting.
    if (display.profile) applyProfile(loaded.config || {}, display.profile);
  } catch (error) {
    if (!display || display.profile) {
      process.stderr.write(`veo: ${readableError(error)}\n`);
      return 1;
    }
    // The command's own validation reports configuration errors.
  }
  if (['stats', 'history', 'flush', 'runs', 'inspect', 'stop', 'update', 'upgrade', 'check', 'doctor', 'backend'].includes(args[0])) args = display.remaining;
  return withOutputSettings(color, () => runMain(args, { config }));
}

async function runMain(args, { config }) {
  const stdout = outputStream(process.stdout, { plain: args.includes('--json') });
  const stderr = outputStream(process.stderr, { plain: args.includes('--json') });
  if (args[0] === 'stats') {
    try { return await (await import('./stats.js')).statsMain(args.slice(1)); }
    catch (error) { stderr.write(`veo: ${readableError(error)}\n`); return 1; }
  }
  if (args[0] === 'history') {
    try { return await (await import('./history.js')).historyMain(args.slice(1)); }
    catch (error) { stderr.write(`veo: ${readableError(error)}\n`); return 1; }
  }
  if (args[0] === 'flush') {
    try { return await (await import('./flush.js')).flushMain(args.slice(1)); }
    catch (error) { stderr.write(`veo: ${readableError(error)}\n`); return 1; }
  }
  if (args[0] === 'runs') {
    try { return await (await import('./runs.js')).runsMain(args.slice(1)); }
    catch (error) { stderr.write(`veo: ${readableError(error)}\n`); return 1; }
  }
  if (args[0] === 'inspect') {
    try { return await (await import('./inspect-media.js')).inspectMain(args.slice(1)); }
    catch (error) { stderr.write(`veo: ${readableError(error)}\n`); return error.name === 'AbortError' ? 130 : 1; }
  }
  if (args[0] === 'stop') {
    try { return await (await import('./runs.js')).stopMain(args.slice(1)); }
    catch (error) { stderr.write(`veo: ${readableError(error)}\n`); return 1; }
  }
  if (args[0] === 'retry') {
    if (args[1] !== '--last') {
      stderr.write('veo: Usage: veo retry --last [download options]\n');
      return 1;
    }
    try {
      const { latestFailedJob } = await import('./jobs.js');
      args = ['--retry-failed', await latestFailedJob(), ...args.slice(2)];
    } catch (error) { stderr.write(`veo: ${readableError(error)}\n`); return 1; }
  }
  const { cleanupDownloadCache } = await import('./download-cache.js');
  await cleanupDownloadCache().catch(error => stderr.write(`veo: Could not clean expired local downloads: ${readableError(error)}\n`));
  // update/upgrade/check subcommands are handled before URL validation.
  if (['update', 'upgrade', 'check'].includes(args[0])) {
    if (args[0] === 'check' && args[1] !== 'update') {
      stdout.write(UPDATE_HELP);
      return 0;
    }
    return updateMain(args, { registry: defaultRegistry() });
  }
  if (args[0] === 'config') {
    try { return await configMain(args.slice(1)); }
    catch (error) { stderr.write(`veo: ${readableError(error)}\n`); return 1; }
  }
  if (args[0] === 'doctor') {
    try {
      const { doctorMain } = await import('./doctor.js');
      return await doctorMain(args.slice(1));
    } catch (error) {
      stderr.write(`veo: ${readableError(error)}\n`);
      return 1;
    }
  }
  if (args[0] === 'backend') {
    try {
      const { backendUpdateMain } = await import('./backend-update.js');
      return await backendUpdateMain(args.slice(1));
    } catch (error) {
      stderr.write(`veo: ${readableError(error)}\n`);
      return 1;
    }
  }
  const reporter = createReporter();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let run;
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (!args.includes('--help') && !args.includes('-h') && !args.includes('--version')) {
      run = await (await import('./runs.js')).registerRun(cancel);
    }
    const loaded = config ?? await loadConfig();
    for (const warning of loaded.warnings || []) stderr.write(`veo: ${warning}\n`);
    if (!args.length && process.stdin.isTTY && process.stderr.isTTY) {
      const { interactiveArgs } = await import('./interactive.js');
      args = await interactiveArgs(loaded.config || {}, { signal: controller.signal });
      if (!args) return 0;
    }
    let options = parseCli(args, { config: loaded.config });
    if (options.help) { stdout.write(HELP); return 0; }
    if (options.version) {
      const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      stdout.write(`${pkg.version}\n`);
      return 0;
    }
    let retryItems;
    if (options.retryFailed) {
      retryItems = await retryOptions(options.retryFailed);
      // Revalidate stored options and apply only flags explicitly supplied now.
      const retryArgs = args.filter((arg, index) => arg !== '--retry-failed' && args[index - 1] !== '--retry-failed' && !arg.startsWith('--retry-failed='));
      retryItems = retryItems.map(item => parseCli([item.url, ...retryArgs], { config: { ...item, profiles: loaded.config?.profiles } }));
      options = { ...retryItems[0], urls: retryItems.map(item => item.url) };
    }
    if (options.batchFile) {
      const lines = (await readFile(options.batchFile, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
      options.urls.push(...lines.map(validateUrl));
      options.url = options.urls[0];
      if (!options.urls.length) throw new Error('The URL list is empty.');
      if (options.rename && options.urls.length > 1 && !options.rename.includes('*')) throw new Error('--rename only applies to a single URL unless the name contains * for the original title.');
      if (options.listFormats && options.urls.length > 1) throw new Error('--list-formats accepts exactly one URL.');
    }
    // The job file is created before the first download, so another terminal can
    // follow this run's per-item progress with `veo runs <id>`.
    const jobFile = options.listFormats || options.dryRun ? null : jobFilePath();
    await run?.describe({ urls: options.urls, output: options.output ? path.resolve(options.output) : null,
      audio: options.audio, quality: options.quality, format: options.format, playlist: options.playlist, job: jobFile });
    reporter.configure?.({ color: options.color && !options.json });
    reporter.start(options.rename);
    const cookieWarning = cookieFileWarning(options.cookies);
    if (cookieWarning) stderr.write(`veo: ${cookieWarning}\n`);

    if (options.listFormats) {
      const { listFormats } = await import('./downloader.js');
      stdout.write(await listFormats(options, { signal: controller.signal, reporter }));
      return 0;
    }
    if (options.dryRun) {
      const { planDownload } = await import('./downloader.js');
      for (const request of retryItems || options.urls.map(url => ({ ...options, url }))) {
        const { url } = request;
        const plan = await planDownload(request, { signal: controller.signal, reporter });
        if (options.json) stdout.write(`${JSON.stringify({ url, status: 'planned', ...plan })}\n`);
        else {
          stdout.write(`URL: ${url}\n`);
          stdout.write(`${describeEstimate(plan)}\n`);
          if (plan.quality) stdout.write(`${plan.quality}\n`);
          for (const entry of plan.entries) stdout.write(`Would save: ${cleanText(entry.path)}\n`);
        }
      }
      return 0;
    }
    const { download } = await import('./downloader.js');
    const { createStatsRecorder } = await import('./stats.js');
    const { createHistoryRecorder } = await import('./history.js');
    const result = await runJob(options, { download, reporter, signal: controller.signal, openFile, items: retryItems, jobFile: jobFile || undefined, runId: run?.id, recordStats: createStatsRecorder(), recordHistory: createHistoryRecorder() });
    if (result !== 0) return result;
    const notice = await maybeUpdateNotice({ currentVersion: await packageVersion() });
    if (notice) stderr.write(`${notice}\n`);
    return 0;
  } catch (error) {
    reporter.fail(controller.signal.aborted);
    stderr.write(`veo: ${readableError(error)}\n`);
    return controller.signal.aborted || error.name === 'AbortError' ? 130 : 1;
  } finally {
    await run?.unregister();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
