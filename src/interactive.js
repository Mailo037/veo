import { createInterface } from 'node:readline/promises';
import { availableHeights, cleanText, validateUrl } from './utils.js';
import { applyProfile } from './config.js';
import { fetchMetadata, prepareBackend, runBackend } from './downloader.js';
import { describeEstimate, selectedEntries, sizeEstimate, validateItems } from './playlist.js';

export async function interactiveArgs(config, { signal, input = process.stdin, output = process.stderr, ask, inspect } = {}) {
  const rl = ask ? null : createInterface({ input, output });
  const controller = new AbortController();
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  rl?.on('SIGINT', () => controller.abort());
  const question = ask || (prompt => rl.question(prompt, { signal }));
  const choose = async (prompt, allowed, fallback) => {
    while (true) {
      const answer = (await question(prompt)).trim() || fallback;
      if (allowed.includes(answer)) return answer;
      output.write(`Choose: ${allowed.join(', ')}\n`);
    }
  };
  try {
    const args = [];
    const profiles = Object.keys(config.profiles || {});
    let defaults = applyProfile(config);
    if (profiles.length) {
      const profile = await choose(`Profile (${profiles.join(', ')}, none) [none]: `, [...profiles, 'none'], 'none');
      if (profile !== 'none') { args.push('--profile', profile); defaults = applyProfile(config, profile); }
    }
    const url = validateUrl((await question('Video or playlist URL: ')).trim());
    args.push(url);
    const type = await choose(`Download (video/audio) [${defaults.audio ? 'audio' : 'video'}]: `, ['video', 'audio'], defaults.audio ? 'audio' : 'video');
    args.push(type === 'audio' ? '--audio' : '--no-audio');
    const collection = await choose('Download a playlist? (y/n) [n]: ', ['y', 'n'], 'n');
    args.push(collection === 'y' ? '--playlist' : '--no-playlist');
    output.write('Reading available media…\n');
    const inspectionOptions = { ...defaults, url, playlist: collection === 'y' };
    const metadata = inspect ? await inspect(inspectionOptions) : await fetchMetadata(inspectionOptions, {
      signal, backend: await prepareBackend(inspectionOptions, { signal }), runner: runBackend,
    });
    output.write(`${cleanText(metadata.title || metadata.id || 'Media')}\n`);
    if (collection === 'y' && metadata.entries) {
      for (const { entry, index } of selectedEntries(metadata)) output.write(`${index}. ${cleanText(entry?.title || 'Unavailable entry')}\n`);
      let selection;
      while (true) {
        selection = (await question('Entries (e.g. 1,3-5; Enter = all): ')).trim();
        try { if (selection) validateItems(selection); selectedEntries(metadata, selection); break; }
        catch (error) { output.write(`${error.message}\n`); }
      }
      if (selection) args.push('--playlist-items', selection);
      output.write(`${describeEstimate(sizeEstimate(selectedEntries(metadata, selection)))}\n`);
    }
    if (type === 'video') {
      const heights = availableHeights(metadata.formats).sort((a, b) => b - a).map(height => `${height}p`);
      const choices = ['best', ...heights];
      if (!heights.length) output.write('Resolution metadata unavailable; using best. Set a quality cap with -q in command mode.\n');
      const fallback = choices.includes(defaults.quality) ? defaults.quality : 'best';
      args.push('-q', await choose(`Quality (${choices.join(', ')}) [${fallback}]: `, choices, fallback));
    }
    // Switching the media type must not leave an incompatible format from a profile.
    if (type === 'video' && ['mp3', 'm4a', 'aac', 'opus', 'flac', 'wav'].includes(defaults.format)) args.push('--format', 'mp4');
    if (type === 'audio' && ['mp4', 'mkv', 'webm', 'mov'].includes(defaults.format)) args.push('--format', 'mp3');
    const directory = (await question(`Output directory [${defaults.output || process.cwd()}]: `)).trim() || defaults.output || process.cwd();
    args.push('-o', directory, '--resume');
    const skip = await choose('Skip previously downloaded videos? (y/n) [y]: ', ['y', 'n'], 'y');
    args.push(skip === 'y' ? '--skip-existing' : '--no-skip-existing');
    output.write(`Ready: ${type}, ${directory}\n`);
    if (await choose('Start download? (y/n) [y]: ', ['y', 'n'], 'y') === 'n') return null;
    return args;
  } finally { rl?.close(); }
}
