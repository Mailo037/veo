# Changelog

All notable changes to veo. This project follows [Semantic Versioning](https://semver.org/).

## 1.3.0

### Added

- **Interactive wizard**: run `veo` without arguments in a terminal to be guided through a
  download — profile, link, video or audio, available resolution, output directory, and
  playlist entry selection. It enables resume and offers to skip already downloaded files.
  Redirected input never starts a prompt.
- **Named profiles** in the config file (`"profiles": { "music": {...} }`) plus
  `veo config edit|path|profiles`. Global defaults are merged first, then the profile
  selected with `--profile`, then explicit flags.
- **Negated boolean flags** such as `--no-open`, `--no-audio` or `--no-resume` switch off a
  stored default for one invocation; `--no-subs` also disables stored subtitle languages
  and subtitle embedding.
- **URL list files** with `--batch-file <file>` (one URL per line, blank lines and `#`
  comments ignored), combinable with URLs on the command line.
- **Durable batch jobs and `--retry-failed <file>`**: failed or cancelled runs print a
  ready-to-use retry command, and retries keep the resolved output directory and settings
  even from another working directory. Completed playlist jobs retry only failed indices.
- **A final summary** per run, counting saved, skipped and failed items. With `--open`,
  successful files are opened even when another URL or playlist entry fails.
- **Playlist entries one at a time**: a failed entry keeps previously saved files and does
  not stop the remaining entries. `--playlist-items 1,3-5` selects entries by original
  one-based index, and the selection count plus available size estimates are shown first.
- **`--skip-existing`** reuses the recorded source and settings history and re-checks that
  the files are still on disk. A different quality or format, or a deleted output, is
  downloaded again.
- **Resume by source and settings hash**: partial data lives in
  `.veo-part-<hash>`, guarded by a lock and a manifest that records backend-confirmed
  completion, so an unprocessed file is never mistaken for a finished video. Each playlist
  entry has its own state; completed entries are skipped on a later run and unfinished ones
  are preserved independently.
- **Labelled phases** in the terminal title and progress output: current item, source title,
  video/audio/media stream, conversion or merge, and saving.
- **Workflow regression tests** and real-backend smoke coverage for URL lists, profiles,
  retry, duplicate detection and playlist selection.

### Changed

- Generated configuration comments, the example profiles (`music`, `archive`),
  documentation and sample filenames are English throughout. Previously generated German
  template comments are translated by the next `veo config edit`, preserving existing
  settings, paths and custom profile names.
- `veo config edit` fills new or empty files with a commented template and gives existing
  files a one-time commented reference guide, without changing stored settings. Config
  files accept `//` line and `/* ... */` block comments.
- Ambiguous "resume folders" are replaced by the source/settings hash layout; only
  backend-confirmed postprocessed media is reused.
- Other positive numeric resolutions, such as `-q 540p`, are accepted instead of only the
  documented list.

## 1.2.0

Everything below ships together: `1.1.0` was prepared but never published, so this
release is the first to contain these changes.

### Changed

- **`--quality` is now an upper bound.** `-q 720p` downloads the best resolution at or
  below 720p and never fetches 2160p instead. If a source offers nothing at or below the
  request, veo stops before downloading and names the resolutions that do exist. The
  historical "nearest available height" rule is still available as `--closest-quality`
  and may pick a resolution above the request. Sources without resolution metadata fall
  back to the best available stream, as before.
- A finished download is now linked into place instead of copied. Staging lives inside
  the output directory, so a hard link is enough; filesystems without hard links still
  fall back to a copy. This removes a full extra read and write per download, roughly
  halves the peak disk usage, and makes saving cancellable.
- Fewer duplicated downloads in `veo update`: an explicitly installed backend release
  is no longer pruned.
- Metadata and media tools are prepared before any network work, so an unusable local
  setup fails before a backend download starts.

### Added

- **Multiple URLs** in one invocation: `veo <url1> <url2> ...`. Downloads run
  sequentially, a failure does not stop the remaining URLs, and the exit status is `1`
  if any URL failed.
- **`--playlist`** to download every entry of a playlist or channel URL. Each entry keeps
  its own title, and `--no-playlist` remains the default.
- **Subtitles**: `--subs`, `--sub-langs <langs>`, `--embed-subs`.
- **Metadata**: `--embed-metadata`, `--embed-thumbnail`, `--sponsorblock-remove <categories>`,
  `--section <range>`, and `-N/--concurrent-fragments <n>` for faster fragmented downloads.
- **`--resume`** keeps partial data in `.veo-part-<video id>` and continues an interrupted
  download, including one that was cancelled with Ctrl+C.
- **`--cookies <file>` and `--cookies-from-browser <browser[:profile]>`** for content you
  are authorized to access. Cookie files are validated before any network work and a
  world-readable file produces a warning.
- **`--dry-run`** reports the title, quality and destination path without downloading.
- **`--list-formats`** prints the backend's own format table.
- **`--json`** prints one JSON object per URL for scripting.
- **`veo doctor`** checks Node.js, the output directory, the backend cache, yt-dlp,
  FFmpeg/FFprobe, the config file, leftover partial downloads and network reachability.
  It downloads nothing and exits `1` when a check fails.
- **`veo backend update [--check]`** installs a newer yt-dlp release without waiting for a
  new veo release, verified against that release's own `SHA2-256SUMS`. `veo backend reset`
  returns to the release pinned and hash-verified at build time.
- **Config file** for defaults (output directory, quality, format, subtitle preferences,
  and so on). Explicit command-line flags always win.
- **Windows on ARM** is no longer rejected: when the bundled static media tools are
  unavailable, veo uses a system FFmpeg installation found on `PATH`.

### Fixed

- `--rename` is applied again; it had stopped affecting the saved filename.

## 1.0.2

- Initial published release.
