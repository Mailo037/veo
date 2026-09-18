# veo

A small, clean video-downloading CLI powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp). No banners, just progress and the saved file path.

**Only download content you own or are authorized or legally permitted to download.** Respect copyright, website terms, and access restrictions. veo does not bypass DRM, private-content access controls, or paywalls.

## Install and run

Requires **Node.js 22+** and npm. Internet access is needed for installation and first-use backend setup.

The npm package is `@mailo037/veo`; the installed command is `veo`.

```bash
npx @mailo037/veo "https://example.com/video.mp4"
```

Or install globally:

```bash
npm install -g @mailo037/veo
veo "https://example.com/video.mp4"
```

From this checkout, without publishing:

```bash
npm install
node bin/veo.js --help
npm link
veo "https://example.com/video.mp4"
```

`package.json` maps `"veo": "./bin/veo.js"`; npm creates the executable/shim automatically. No custom command prefix is needed. Use only trusted URLs, and quote URLs to protect query strings from your shell.

If something does not work, run `veo doctor` first: it inspects the whole local setup and prints one line per check.

## Usage

```text
veo <url> [<url>...] [options]

Options:
  -q, --quality <quality>   best, 2160p, 1440p, 1080p, 720p, 480p, 360p
  -o, --output <path>       Output directory (default: current working directory)
  -r, --rename <name>       Custom filename without extension (also used in tab title)
  --closest-quality         Nearest available resolution instead of an upper bound
  --open                    Open the saved file with your default app
  --audio                   Audio only (MP3 by default)
  --format <format>         Video: mp4, mkv, webm, mov
                            Audio: mp3, m4a, aac, opus, flac, wav
  --playlist                Download every entry of a playlist or channel URL
  -N, --concurrent-fragments <n>   Parallel fragments, 1-16
  --subs                    Download subtitles (default languages: en)
  --sub-langs <langs>       Subtitle languages, e.g. "de,en" (implies --subs)
  --embed-subs              Embed subtitles into the video file
  --embed-metadata          Embed title, date and other metadata
  --embed-thumbnail         Embed the thumbnail
  --sponsorblock-remove <categories>   e.g. "sponsor,selfpromo"
  --section <range>         Only a time range, e.g. "*10:00-12:00"
  --cookies <file>          Netscape cookie file, for content you may access
  --cookies-from-browser <browser[:profile]>
  --resume                  Keep partial data and continue an interrupted download
  --list-formats            Show available formats and exit
  --dry-run                 Show what would be downloaded and exit
  --json                    One JSON object per URL instead of prose
  -v, --version             Show installed version (also: veo version)
  -h, --help                Show help
```

```bash
veo "https://youtube.com/watch?v=VIDEO_ID" -q 1080p
veo "https://x.com/USER/status/STATUS_ID" -q best
veo "https://example.com/video.mp4" --audio
veo "https://example.com/video.mp4" --audio --format flac
veo "https://example.com/video.mp4" --format webm -o ./videos
veo "https://example.com/video.mp4" -r "Mein Video" --format mp4 --open
veo "https://example.com/video.mp4" --audio -r "Meine Musik"
veo <url1> <url2> <url3> --embed-metadata --subs
veo "https://youtube.com/playlist?list=LIST_ID" --playlist -q 720p
veo "https://example.com/video.mp4" --resume
npx @mailo037/veo "https://example.com/video.mp4" --output ./downloads
```

### Several URLs and playlists

- Pass any number of URLs; they are downloaded one after another. A failure is reported
  with its URL and does not stop the remaining URLs; the exit status is `1` if anything
  failed.
- Playlists, channels and other collections are refused by default with a hint. Add
  `--playlist` to download every entry. Each entry keeps its own title; `--rename` applies
  a name prefix per entry (`My Name - 001`).

### Quality

- Numeric qualities are an **upper bound**: `-q 720p` downloads the best resolution at or
  below 720p, so a metered connection can never accidentally receive a 2160p file. If a
  source offers nothing at or below the request, veo stops before downloading and lists
  the resolutions that do exist.
- `--closest-quality` restores the former "nearest available resolution" rule, which may
  pick a resolution *above* the request. It needs a numeric `--quality`.
- Sources that report no resolution metadata fall back to the best available stream.
  Collections select per entry with the backend's own resolution preference.
- `--quality` does not apply to audio.
- MP4-compatible codecs are preferred at the selected resolution; merged video prefers MP4
  with MKV fallback. A single-file source may retain its original container. Use
  `--format mp4` to explicitly require MP4 (conversion may be slow or lossy).
- `--format` on video enables conversion when necessary. Audio formats require `--audio`.

### Files, names and resume

- Original titles are preserved by default. Use `-r "My Video"` or `--rename "My Video"`
  for video or audio. Supply the name **without an extension**; the actual media extension
  is appended automatically. Use `-o` for the directory. Invalid filename characters are
  sanitized and overly long names shortened. Existing files are never intentionally
  overwritten: duplicates get ` (1)`, ` (2)`, etc.
- Subtitles and thumbnails are saved beside the media file under the same base name
  (`My Video.mp4` → `My Video.en.vtt`).
- Downloads use a private staging directory inside the output directory. The finished file
  is linked (or, on filesystems without hard links, copied) to a collision-safe final name.
  Staging is removed on ordinary failure or Ctrl+C; force-killing the process may leave
  `.veo-*` directories to remove manually, and `veo doctor` reports leftovers.
- `--resume` keeps partial data in `.veo-part-<video id>` instead, and continues it on a
  later run. The folder survives a failure or Ctrl+C and is removed after a successful save.
  A staged file that was already complete is finished without re-downloading. Partial
  downloads are never resumed without `--resume`.

### Metadata and subtitles

- `--subs` writes subtitle files, `--sub-langs de,en` selects languages, and `--embed-subs`
  embeds them into the video container instead.
- `--embed-metadata` and `--embed-thumbnail` use FFmpeg to write metadata and cover art.
- `--sponsorblock-remove sponsor,selfpromo` cuts sponsor segments (YouTube) and requires
  FFmpeg; the cut re-encodes the affected parts.
- `--section "*10:00-12:00"` downloads only a time range.
- `-N 8` downloads several fragments in parallel, which is noticeably faster on HLS/DASH
  sources and heavier on the network.

### Access and credentials

veo downloads publicly accessible content. It does not bypass access controls, and it does
not expose options that defeat them. If you need your own session for content you are
authorized to view:

- `--cookies ./cookies.txt` passes a Netscape-format cookie file. The file is validated
  before any network work, and on Unix a file readable by other users produces a warning.
- `--cookies-from-browser firefox:Work` reads cookies from an installed browser: `brave`,
  `chrome`, `chromium`, `edge`, `firefox`, `opera`, `safari`, `vivaldi`, `whale`, optionally
  with `+gnomekeyring`/`+kwallet`/`+basic` and a profile or container.

Credentials are used for that single invocation only and are never stored by veo. When a
download fails because a login is required, the error message points at these flags.

### Inspection and scripting

- `--list-formats` prints the backend's own format table for one URL and exits.
- `--dry-run` prints the title, the resolved quality and the destination path that would be
  used — without creating the output directory or downloading anything.
- `--json` prints one JSON object per line on stdout:
  `{"url":…,"status":"saved","title":…,"files":[…]}` or
  `{"url":…,"status":"failed","error":…}`. Progress and status still go to stderr. Without
  `--json`, every saved file is printed as `Saved: <path>` on stdout.

### Config file

Defaults can be stored in a config file, so a long list of flags is not needed for every
call. `veo doctor` prints the exact path; `VEO_CONFIG` overrides it.

- Windows: `%APPDATA%\veo\config.json`
- macOS: `~/Library/Application Support/veo/config.json`
- Linux: `$XDG_CONFIG_HOME/veo/config.json` (or `~/.config/veo/config.json`)

```json
{
  "output": "D:\\Videos",
  "quality": "1080p",
  "embedMetadata": true,
  "subLangs": "de,en",
  "concurrentFragments": 4
}
```

Supported keys: `output`, `quality`, `format`, `rename`, `audio`, `open`, `resume`,
`closestQuality`, `cookies`, `cookiesFromBrowser`, `playlist`, `concurrentFragments`,
`subs`, `subLangs`, `embedSubs`, `embedMetadata`, `embedThumbnail`, `sponsorblockRemove`,
`section`, `json`. An explicit command-line flag always wins over a stored default. An
unknown key produces a warning; invalid JSON or a wrong value type is an error, because
silently ignoring a typo would be worse.

### Terminal output

- During a download, the terminal/tab title shows `veo | 50% | My Video` (original title or
  your `-r` name), plus setup/processing status. It ends with `Done`, `Failed`, or
  `Cancelled`; the shell may replace it at the next prompt. This uses the native console
  title on Windows (including PowerShell/Windows Terminal) and OSC title sequences on
  compatible Linux/macOS terminals. Titles are not changed when stderr is redirected or
  `TERM=dumb`. Terminal settings that enforce a fixed tab title can override this feature.
- Progress shows percentage, speed, downloaded/total size and ETA on stderr; unknown values
  appear as `?`. Separate audio/video streams each have their own progress. Non-interactive
  output is throttled.
- `--open` launches the completed file in your default app, including renamed files and
  audio. With several URLs, the primary file of each URL is opened. Uses `explorer.exe` on
  Windows, `open` on macOS, and `xdg-open` on Linux (requires a graphical desktop,
  xdg-utils and a file association). The CLI does not wait for the player to close. If the
  opener cannot be launched, a warning is printed and the successful download still exits
  with `0`; later errors inside the detached opener/player are not monitored.
- After each successful download, veo checks the npm registry at most once per day for a
  newer version and prints a one-line notice on stderr (never on failure). Disable it with
  `VEO_NO_UPDATE_CHECK=1`; `VEO_REGISTRY`/`npm_config_registry` are respected.
- Exit status is `0` on success, `1` on errors, and `130` on cancellation. With several
  URLs, `1` means at least one URL failed.

## Commands

```bash
veo version           # installed version (also: veo --version or veo -v)
veo doctor            # diagnose the local setup; exit 1 if a check fails
veo doctor --offline  # skip the network checks
veo update            # install the latest veo with npm
veo update --check    # only check for a newer veo
veo upgrade           # alias for veo update
veo check update      # alias for veo update --check
veo backend update    # install the newest yt-dlp release
veo backend reset     # back to the release pinned in this veo version
```

`veo update` runs `npm install -g @mailo037/veo@latest` and then removes yt-dlp backend
caches from older pinned releases, keeping an explicitly installed backend release. It
never uses a shell on Linux/macOS, passes fixed arguments only, and prints the manual npm
command on any failure. The registry can be overridden with `VEO_REGISTRY` (or npm's
`npm_config_registry`) for mirrors and proxies.

### `veo doctor`

Prints one line per check: `ok`, `warn` or `fail`. It inspects Node.js, the platform, the
output directory, the backend cache, yt-dlp (including the SHA-256 of the cached binary and
the version it reports), FFmpeg/FFprobe, a system FFmpeg fallback, the config file, leftover
partial downloads, the npm registry and the yt-dlp release host. It downloads no backend and
only creates its own probe files plus the backend cache directory. Exit status is `1` when
at least one check fails.

## Supported sites and backend

YouTube, X/Twitter, TikTok, Vimeo, Reddit, Instagram, and [many other yt-dlp sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) are supported **when publicly accessible and technically available**. Support changes with websites, regions, rate limits, and backend versions; it is not a guarantee that every URL will work.

Official standalone yt-dlp is acquired on first download and cached outside the package directory; help, version and doctor never download the backend. The release is pinned and SHA-256 verified against hashes shipped with this package. FFmpeg and FFprobe are supplied by the `ffmpeg-static` and `ffprobe-static` dependencies during npm installation. These binaries have their own licenses; see their upstream packages. Normal installs must allow dependency install scripts. No Python installation is needed on supported standalone platforms.

The existing Node executable is explicitly enabled as yt-dlp's JavaScript runtime for YouTube. Local yt-dlp configuration and plugins are disabled for predictable execution. Arguments are passed without a shell.

`ffmpeg-static` and `ffprobe-static` publish no Windows ARM64 binaries. veo no longer refuses
that platform: it falls back to an FFmpeg/FFprobe pair found on `PATH`, including the usual
WinGet, Chocolatey and `C:\ffmpeg\bin` locations.

Advanced overrides:

- `VEO_YT_DLP_PATH`: absolute path to a trusted, current yt-dlp executable. It always takes
  precedence over the managed backend, including one installed by `veo backend update`.
- `VEO_FFMPEG_PATH`: directory containing both `ffmpeg` and `ffprobe` executables (with
  `.exe` on Windows).
- `VEO_CONFIG`: path to the config file.

Automatic yt-dlp acquisition covers mainstream Windows, macOS and Linux architectures.
Unsupported systems should supply trusted native binaries. A blocked GitHub request, proxy,
disabled install scripts, or unsupported native binary can prevent setup; errors include
guidance. Maintainers should update the pinned yt-dlp release and hashes as websites change,
or users can install a newer release themselves.

### Installing a newer backend

```bash
veo backend update --check   # is a newer yt-dlp release available?
veo backend update           # install it
veo backend reset            # forget it, use the pinned release again
```

The pinned backend is hash-verified against values compiled into this veo version. That
guarantee cannot cover a release that did not exist when this version was built, so
`veo backend update` verifies the download against the `SHA2-256SUMS` file published with
that release over HTTPS: the trust anchor becomes HTTPS and GitHub instead of the npm
package. It is opt-in, it says so on stderr when it runs, and `veo backend reset` (plus the
next `veo update`) returns to the pinned release. An installed release is used only while it
is newer than the pinned one and its bytes still match the recorded hash; anything else
silently falls back to the pinned release.

## Develop and publish

```bash
npm install
npm test                 # unit tests, no network
npm run test:smoke       # real downloads: local HTTP server, real yt-dlp, real FFmpeg
npm run test:open        # real download plus a controlled desktop-opener replacement
npm pack
npm run check:package    # inspect the packed tarball
npm link
veo --version
# Then, authenticated as the account that owns the name:
npm publish
```

The smoke test generates a two-second synthetic video with FFmpeg, serves it on loopback,
and runs real yt-dlp downloads. It checks default output, the quality cap, duplicate names,
audio extraction, conversion, dry-run, format listing, JSON output, metadata embedding,
resume, batch behaviour and nonzero failures. It needs network access once for yt-dlp
acquisition; it downloads no third-party video. Unit tests require no network.

The published tarball only includes `bin/`, `src/`, package metadata, README and LICENSE.
The lockfile is kept for reproducible development. There is no build step. npm makes the
shebang-bearing bin executable on installation (on Unix, `chmod +x bin/veo.js` also enables
direct checkout execution).

Continuous integration runs the unit tests on Windows, macOS and Linux for Node 22 and 24,
runs the end-to-end smoke test on Node 22, and verifies the packed tarball.

Modules separate argument parsing (`src/cli.js`), configuration (`src/config.js`), backend
setup (`src/backend.js`), backend updates (`src/backend-update.js`), download orchestration
(`src/downloader.js`), diagnostics (`src/doctor.js`), progress (`src/progress.js`), and
helpers (`src/utils.js`, `src/paths.js`, `src/version.js`) so new options and providers can
be added without replacing the CLI.

## License

MIT for this CLI. yt-dlp and FFmpeg/FFprobe retain their respective upstream licenses.
