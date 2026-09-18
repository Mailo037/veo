# Changelog

All notable changes to veo. This project follows [Semantic Versioning](https://semver.org/).

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
