# sdd — Subagent-Driven Development

An MCP server + Skills layer, shipped as one Claude Code plugin, for delegating scoped work units to CLI agent harnesses (`codex`, `agy`, `grok`, …) and media tools (`yt-dlp`, `whisper`, …) that run as child processes in the current working tree. Claude stays the brain and owns the diff; a harness does one bounded task — review, second opinion, implementation, image generation, video ingestion — and reports back a structured `{status, summary, artifacts, raw}` result.

## Install

```
/plugin install sdd
```

This wires the `sdd` MCP server (`.claude-plugin/plugin.json` → `mcpServers.sdd`, running `bun run src/server.ts`) and auto-discovers the `subagent-driven-development` and `video-ingest` skills under `skills/`. Requires `bun >= 1.3.0` (see `package.json` `engines`); dependencies (`@modelcontextprotocol/sdk`, `zod`) install via `bun install` in this repo.

To run the server standalone (e.g. for manual testing):

```
bun run src/server.ts
```

It connects over stdio, logs `sdd <version> connected (7 tools)` to stderr, and exits cleanly on `SIGINT`/`SIGTERM`.

## The seven tools

All state is in-memory and session-scoped — restarting the server loses the job map (accepted for v1, no disk persistence).

| Tool | Signature | What it does |
|---|---|---|
| `dispatch` | `(adapter, prompt, cwd?, timeoutMs?, …adapter-specific opts) → jobId` | Spawns a work unit on a named adapter as a child process in `cwd` (defaults to the server's cwd). Returns immediately — never blocks. Never refused for concurrency reasons: every dispatch runs in parallel, so keeping two jobs that write the same tree apart is the caller's responsibility. The remaining inputs are adapter-specific and ignored by adapters that don't read them: `model`, `effort`, `outputPath`, `outputDir`, `addDir`, `cookies`, `subLangs`, `frameCount`, `sceneThreshold`, `sleepRequests`. |
| `status` | `(jobId) → {state, adapter, exitCode?}` | Snapshot of a job's lifecycle: `running`, `done`, or `failed`. `done`/`failed` reflects the exit code **and** the adapter's contract-marker validation — never pid-liveness alone. |
| `result` | `(jobId) → {status, summary, artifacts, raw}` | Collects a terminal job's structured result. A still-running job returns `{status:"running"}` with no `summary`/`artifacts`/`raw` — never a partial result. |
| `wait` | `(jobIds[], timeoutMs?) → {done, stillRunning, unknown}` | Blocks until every job in `jobIds` is terminal or `timeoutMs` elapses, whichever is first — never blocks past the timeout. Defaults to a short ~30s poll; pass a larger `timeoutMs` (clamped at a 10-minute cap) for a long block instead of repolling. |
| `list_adapters` | `() → [{name, binaryPresent}]` | Lists every adapter discovered under `src/adapters/`, with whether its underlying CLI is present on `PATH`. Call this before `dispatch` to confirm the harness is actually installed. |
| `cancel` | `(jobId) → {cancelled}` | Terminates a running job's entire process group. No-op (`cancelled:false`) for an unknown or already-terminal job id — never throws. |
| `check_adapter` | `(adapter, timeoutMs?, cwd?) → {status, binaryPresent, jobId?}` | Health-checks whether an adapter is not just installed but actually usable — logged in, with an active subscription — by running a minimal live probe through the normal dispatch path. `status` is one of `ok`, `failed`, `timeout`, `present_unverified`, or `missing`. Use it before relying on a harness you haven't exercised this session. |

See `skills/subagent-driven-development/SKILL.md` for the orchestration doctrine on when to fan out, when the caller must serialize jobs sharing a working tree, and how to use `wait`.

## The fourteen adapters

Every agent harness runs unconditionally permissive (codex `--sandbox workspace-write`, agy `--dangerously-skip-permissions`, grok `--always-approve`, kimi/qwen `--yolo`, mistral `--auto-approve`), so a dispatched harness may edit the tree it is given.

### Agent harnesses

| Adapter | Job | Gotcha |
|---|---|---|
| `codex` | Review / second opinion / implement (`codex exec`) | stdout carries the final answer, stderr carries progress — `summary`/`raw` come from stdout only. Output contract: a `VERDICT:` line + `## Findings` section; missing either (or non-zero exit) → `failed`. `opts.model`/`opts.effort` are an allowlist, not a passthrough: `effort` maps to the one hardcoded `model_reasoning_effort` key, so no caller can smuggle `-c sandbox_mode=danger-full-access` past the `--sandbox` barricade. |
| `codex-high` | codex at maximum reasoning depth | Pinned to `model_reasoning_effort=high`; `binary` is `codex`. Per-call `model`/`effort` are **ignored** — the pin is the point. Use the base `codex` adapter to vary them. |
| `codex-low` | Cheap/fast codex work | Pinned to `model_reasoning_effort=low`; same pin-ignores-`opts` rule as `codex-high`. |
| `codex-sol` | Hard coding / deep reasoning on the flagship tier | Pinned to `-m gpt-5.6-sol` at effort `high`; same pin-ignores-`opts` rule. |
| `agy` | Review / implement | All flags before `--print`, prompt immediately after — a flag placed after `--print` is silently absorbed into the prompt and agy still exits 0. `buildArgs` enforces the order structurally. Output contract: last line `AGY_RESULT: DONE`/`FAILED`, parsed by **last** occurrence (not first) to survive an echoed instruction. |
| `grok` | Second opinion (xAI Grok Build CLI) | `grok -p <prompt>`; needs `XAI_API_KEY` in the env. `opts.model` (e.g. `grok-4.5`) passes through as `-m` — omit it and you get the CLI's default non-reasoning model, which is not what you want for a real review. Shares the `VERDICT:`/`## Findings` contract. |
| `kimi` | Second opinion (Moonshot Kimi CLI) | `kimi -p <prompt>`; needs `MOONSHOT_API_KEY`. The installed CLI has no `--print`/`--quiet` despite what older notes claim — `-p` alone is the headless one-shot flag. Shares the `VERDICT:`/`## Findings` contract. |
| `qwen` | Second opinion (Alibaba Qwen Code CLI) | `qwen -p <prompt>`; needs `DASHSCOPE_API_KEY`. Shares the `VERDICT:`/`## Findings` contract. No adapter-specific landmine beyond that. |
| `mistral` | Second opinion (Mistral Vibe CLI) | name ≠ binary: the CLI is **`vibe`**, not `mistral` — the adapter sets `binary: "vibe"` so `list_adapters` probes the right thing on PATH. Needs `MISTRAL_API_KEY`. Shares the `VERDICT:`/`## Findings` contract. |

The four review CLIs (`grok`, `kimi`, `qwen`, `mistral`) share one output contract, defined once in `src/lib/review-contract.ts`. Review is the job they are *asked* to do, not a limit on what they can do — like every harness here, they run headlessly permissive.

### Artifact producers

| Adapter | Job | Gotcha |
|---|---|---|
| `agy-image` | Image generation (Nano Banana) → one PNG | `outputPath` must end in `.png` and, if relative, resolve **inside** the job `cwd` (a `../` escape is rejected before spawn) — agy resolves a bare relative filename by searching all of `/Users`, so `buildArgs` makes the path absolute itself. agy has no `--out` flag: the path is embedded in the prompt tail and echoed back as `AGY_IMAGE_SAVED:`. Success requires both the marker (last occurrence) **and** the file actually existing on disk. |
| `agy-vision` | Fuse a transcript + keyframes into one understanding JSON | Runs under agy's `--sandbox` — that sandbox, not the prompt fencing, is the real control against injection from on-screen text in a frame. `addDir` (the read-only grant) and `outputPath` (must end in `.json`) are both required and both traversal-barricaded. Defaults to `Gemini 3.1 Pro (High)`; a weak/fast tier loops on the frame set and times out. Marker: `AGY_VISION_SAVED:`, plus an on-disk existence check. |

### Video pipeline

Orchestrated by `skills/video-ingest/`. These wrap real CLIs, not instructable agents, so the "prompt" **is** the URL or file path — `injectContract` is the identity function, and anything else would corrupt that argv element.

| Adapter | Job | Gotcha |
|---|---|---|
| `yt-dlp` | Fetch one video (YouTube, Instagram, TikTok, X) → WAV + the 720p-capped video + best-effort VTT subs | yt-dlp parses its own options, so a "URL" of `--exec=<cmd>` would be option-parsed into command execution even with `shell: false`. Two independent layers: the URL must be a single whitespace-free `http(s)` URL, **and** a literal `--` end-of-options separator always immediately precedes it in argv. The WAV path rides `--print after_move:filepath`; the retained video path rides a labelled `SDD_VIDEO_PATH:` line that yt-dlp emits as a *basename*, re-absolutized against the WAV's directory. Requires `opts.outputDir`. |
| `whisper` | Transcribe an audio file → `transcript.srt` + `transcript.txt` | name ≠ binary: the CLI is **`mlx_whisper`** (underscore), not `whisper` — set via the `binary` export. mlx-whisper has no scripting-friendly print flag, so the adapter passes `--verbose True` and scrapes `output_dir` out of the CLI's own `Args: {...}` argparse debug line — the only channel available, and not a documented stable contract. `--output-name transcript` pins the basename so `parseResult` never reconstructs a filename. Requires `opts.outputDir`. |
| `ffmpeg-frames` | Scene-cut keyframe extraction → PTS-named frames + `manifest.json` | ffmpeg has no print flag either: `parseResult` recovers the output directory from ffmpeg's own unconditional `Output #0, <format>, to '<path>':` console line. Frame filenames carry raw stream-timebase pts (monotonic, *not* seconds), so they're used only to recover chronological order — the real timestamps come from zipping the sorted files against the `showinfo` `pts_time:` lines. The filter chain OR's in a periodic term (`not(mod(n,150))`, always true at `n=0`) so a cut-free clip still yields frames. Requires `opts.outputDir`. |

Every adapter in the last two tables sets `probeable = false`: a live probe would bill a real image generation, download from the network, or run a slow transcode, and a generic health-check prompt cannot supply the `outputPath`/`outputDir`/`addDir` their `buildArgs` demand. For those, `check_adapter` reports binary presence only — `present_unverified` rather than `ok`. Every agent harness is probeable and gets the real liveness+auth probe.

## Adding an adapter

Drop a file in `src/adapters/` exporting the `Adapter` port shape — there is no central registry to edit:

```ts
export const name = "my-adapter";

/** Optional. The CLI to probe on PATH when it differs from `name`
 *  (the "mistral" adapter's binary is `vibe`). Defaults to `name`. */
export const binary = "my-cli";

/** Optional. `false` opts out of check_adapter's live probe when a probe would
 *  cost real money, hit the network, or need opts a health check can't supply. */
export const probeable = false;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  // Return an argv array (never a shell string) — this is spawned with no shell.
  // Put every flag BEFORE any positional prompt arg: some harnesses absorb a
  // trailing flag into the prompt text and still exit 0.
  return ["my-cli", "--flag", prompt];
}

export function injectContract(prompt: string): string {
  // Append instructions asking the harness to emit a parseable, validatable marker.
  // (For a non-instructable CLI whose "prompt" is really a path or URL, this must
  // be the identity function — anything else corrupts that argv element.)
  return `${prompt}\n\nEnd with: MY_RESULT: DONE|FAILED`;
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  // Extract + validate the marker, scanning for its LAST occurrence — a harness
  // that echoes the injected instruction makes the first match the echo.
  // Missing marker → failed, regardless of exitCode (the backstop for a harness
  // that exits 0 without doing the work).
}
```

`src/adapters/discover.ts` scans `src/adapters/*.ts`, validates each file exports `name`, `buildArgs`, `injectContract`, and `parseResult` (plus well-formed `binary`/`probeable` if present), and skips — with a stderr warning, never a crash — anything malformed, missing an export, or claiming a duplicate adapter name. Files starting with `_` or `.`, `*.test.ts`, `*.d.ts`, and `discover.ts`/`types.ts` themselves are treated as infrastructure and never loaded as adapters. That's what lets shared helpers (`_codex-shared.ts`, `_codex-factory.ts`, `_agy-shared.ts`) sit right next to the adapters that use them.

## Video ingestion setup

The video-ingestion pipeline (added in later phases, orchestrated by `skills/video-ingest/`) shells out to three external CLIs that are **not** managed by `bun install` — install them yourself, then run the preflight check below.

| Tool | Install | Notes |
|---|---|---|
| `yt-dlp` | `brew install yt-dlp` (or `pip install -U yt-dlp` / `uv tool install yt-dlp`) | Fetches audio (+ opportunistic captions) from YouTube, Instagram, TikTok, and X. |
| `ffmpeg` | `brew install ffmpeg` | Used for audio extraction and scene-cut keyframe capture. |
| `mlx-whisper` | `pip install -U mlx-whisper` (or `uv tool install mlx-whisper`) | Apple Silicon (MLX) speech-to-text; requires a Mac with Apple Silicon and Python 3.9+. |

Run the preflight check before using the pipeline:

```
bun run src/lib/preflight.ts
```

It prints a JSON report naming what's present, what's missing, and the exact install command for anything missing, then exits non-zero if anything needs attention.

### Instagram caveat

Instagram frequently rate-limits or requires login for reels/stories, unlike the other three platforms. Two things help:

- **Cookies:** export a logged-in session's cookies (e.g. via a browser extension like "Get cookies.txt") and pass the file to `yt-dlp --cookies <path>`. Use a burner/throwaway account — never your primary credentials, and never commit or log the cookies file.
- **Nightly build:** Instagram's extractor breaks often as Instagram changes its site; `yt-dlp`'s nightly channel ships extractor fixes faster than the stable release (`pip install -U --pre "yt-dlp[default]"`). Pair this with `--sleep-requests` to throttle and avoid tripping rate limits.

## Development

```
bun install
bun test           # full suite
bunx tsc --noEmit   # strict typecheck
```

`plugin.json`'s `version` field is the single version source, read at server startup (`src/register.ts:readVersion`).
