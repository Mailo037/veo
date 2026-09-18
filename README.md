# veo

A small, clean video-downloading CLI powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp). No banners, just progress and the saved file path.

**Only download content you own or are authorized or legally permitted to download.** Respect copyright, website terms, and access restrictions. veo does not bypass DRM, private-content access controls, or paywalls.

## Install and run

Requires **Node.js 22+** and npm. Internet access is needed for installation and first-use backend setup.

The npm package is `@mailo037/veo`; the installed command is `veo`.
Once this package has been published:

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

## Usage

```text
veo <url> [options]

-q, --quality <quality>   best, 2160p, 1440p, 1080p, 720p, 480p, 360p
-o, --output <path>       Output directory (default: current working directory)
-r, --rename <name>       Custom filename without extension (also used in tab title)
--open                   Open the saved file with your default app
--audio                  Audio only (MP3 by default)
--format <format>        Video: mp4, mkv, webm, mov
                         Audio: mp3, m4a, aac, opus, flac, wav
-v, --version            Show installed version (also: veo version)
-h, --help               Show help
```

```bash
veo "https://youtube.com/watch?v=VIDEO_ID" -q 1080p
veo "https://x.com/USER/status/STATUS_ID" -q best
veo "https://example.com/video.mp4" --audio
veo "https://example.com/video.mp4" --audio --format flac
veo "https://example.com/video.mp4" --format webm -o ./videos
veo "https://example.com/video.mp4" -r "Mein Video" --format mp4 --open
veo "https://example.com/video.mp4" --audio -r "Meine Musik"
npx @mailo037/veo "https://example.com/video.mp4" --output ./downloads
```

- One video per invocation; playlists and live streams are not supported.
- Numeric quality selects the nearest **available video height**, not just a maximum. Ties choose the lower height. Unknown heights fall back to best. `--quality` does not apply to audio.
- MP4-compatible codecs are preferred at the selected resolution; merged video prefers MP4 with MKV fallback. A single-file source may retain its original container. Use `--format mp4` to explicitly require MP4 (conversion may be slow or lossy).
- `--format` on video enables conversion when necessary. Audio formats require `--audio`.
- Original titles are preserved by default. Use `-r "My Video"` or `--rename "My Video"` to choose a filename for video or audio. Supply the name **without an extension**; the actual media extension is appended automatically. Use `-o` for the directory. Invalid filename characters are sanitized and overly long names shortened. Existing files are never intentionally overwritten: duplicates get ` (1)`, ` (2)`, etc.
- During a download, the terminal/tab title shows `veo | 50% | My Video` (original title or your `-r` name), plus setup/processing status. It ends with `Done`, `Failed`, or `Cancelled`; the shell may replace it at the next prompt. This uses the native console title on Windows (including PowerShell/Windows Terminal) and OSC title sequences on compatible Linux/macOS terminals. Titles are not changed when stderr is redirected or `TERM=dumb`. Terminal settings that enforce a fixed tab title can override this feature.
- Downloads and conversion use a private temporary directory inside the output directory. The completed file is copied to a collision-safe final name, so allow extra disk space. Temporary files are removed on ordinary failure or Ctrl+C; force-killing the process may leave `.veo-*` directories to remove manually. Partial downloads are not resumed between invocations.
- Progress shows percentage, speed, downloaded/total size and ETA on stderr; unknown values appear as `?`. Separate audio/video streams each have their own progress. Non-interactive output is throttled. The final path is printed on stdout as `Saved: ...`.
- `--open` launches the completed file in your default app, including renamed files and audio. Uses `explorer.exe` on Windows, `open` on macOS, and `xdg-open` on Linux (requires a graphical desktop, xdg-utils and a file association). The CLI does not wait for the player to close. If the opener cannot be launched, a warning is printed and the successful download still exits with `0`; later errors inside the detached opener/player are not monitored.
- After each successful download, veo checks the npm registry at most once per day for a newer version and prints a one-line notice on stderr (never on failure). Disable it with `VEO_NO_UPDATE_CHECK=1`; `VEO_REGISTRY`/`npm_config_registry` are respected.
- Exit status is `0` on success, `1` on errors, and `130` on cancellation.

## Installed version

```bash
veo version
# Alternatively: veo --version or veo -v
```

Prints the installed version (currently `1.0.2`) without accessing the network or downloading a backend.

## Updating veo

```bash
veo update            # install the latest version with npm (global)
veo update --check    # only check for a newer version
veo upgrade           # alias for veo update
veo check update      # alias for veo update --check
veo update --help     # update usage
```

`veo update` runs `npm install -g @mailo037/veo@latest` and then removes yt-dlp backend caches from older pinned releases. It never uses a shell on Linux/macOS, passes fixed arguments only, and prints the manual npm command on any failure. The registry can be overridden with `VEO_REGISTRY` (or npm's `npm_config_registry`) for mirrors and proxies.

## Supported sites and backend

YouTube, X/Twitter, TikTok, Vimeo, Reddit, Instagram, and [many other yt-dlp sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) are supported **when publicly accessible and technically available**. Support changes with websites, regions, rate limits, and backend versions; it is not a guarantee that every URL will work. Authentication/cookie flags are not exposed in this initial version.

Official standalone yt-dlp is acquired on first download and cached outside the package directory; help/version never download it. The release is pinned and SHA-256 verified against hashes shipped with this package. FFmpeg and FFprobe are supplied by the `ffmpeg-static` and `ffprobe-static` dependencies during npm installation. These binaries have their own licenses; see their upstream packages. Normal installs must allow dependency install scripts. No Python installation is needed on supported standalone platforms.

The existing Node executable is explicitly enabled as yt-dlp's JavaScript runtime for YouTube. Local yt-dlp configuration and plugins are disabled for predictable execution. Arguments are passed without a shell.

Advanced overrides for managed installations:

- `VEO_YT_DLP_PATH`: absolute path to a trusted, current yt-dlp executable.
- `VEO_FFMPEG_PATH`: directory containing both `ffmpeg` and `ffprobe` executables (with `.exe` on Windows).

Automatic yt-dlp acquisition covers mainstream Windows, macOS and Linux architectures; FFmpeg/FFprobe platform availability may be narrower. Unsupported systems should supply trusted native binaries. A blocked GitHub request, proxy, disabled install scripts, or unsupported native binary can prevent setup; errors include guidance. Maintainers should update the pinned yt-dlp release and hashes as websites change, or users can supply an up-to-date executable override.

## Develop and publish

```bash
npm install
npm test
npm run test:open
npm run test:smoke
npm pack --dry-run
npm link
veo --version
# Then, authenticated as the account that owns the name:
npm publish
```

The smoke test generates a two-second synthetic video with FFmpeg, serves it on loopback, and runs real yt-dlp downloads. It checks default output, duplicate names, quality fallback, audio extraction, conversion and nonzero failures. It needs network access once for yt-dlp acquisition; it downloads no third-party video. Unit tests require no network.

The published tarball only includes `bin/`, `src/`, package metadata, README and LICENSE. The lockfile is kept for reproducible development. There is no build step. npm makes the shebang-bearing bin executable on installation (on Unix, `chmod +x bin/veo.js` also enables direct checkout execution).

Modules separate argument parsing (`src/cli.js`), backend setup (`src/backend.js`), download orchestration (`src/downloader.js`), progress (`src/progress.js`), and filename/error helpers (`src/utils.js`) so new options and providers can be added without replacing the CLI.

## License

MIT for this CLI. yt-dlp and FFmpeg/FFprobe retain their respective upstream licenses.
