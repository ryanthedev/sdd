# sdd: Subagent-Driven Development

sdd lets Claude hand a scoped, one-off job to an outside CLI agent and get a clean result back. It's an MCP server plus a Skills layer, shipped as one Claude Code plugin.

Here's the idea. Claude stays the brain and owns the diff. When there's a bounded task that a fresh set of eyes does better (a code review, a second opinion, an implementation, an image, a video to pull apart) sdd spins up a harness like `codex`, `agy`, or `grok` as a child process right in your working tree. The harness does the one thing, then reports back a structured `{status, summary, artifacts, raw}`. No context pollution, no handing over the wheel.

So basically: Claude decides, a harness does the grunt work, and you keep a tidy diff.

## Install

```
/plugin install sdd
```

That wires up the `sdd` MCP server (`.claude-plugin/plugin.json` → `mcpServers.sdd`, running `bun run src/server.ts`) and auto-discovers the `subagent-driven-development` and `video-ingest` skills under `skills/`. You'll need `bun >= 1.3.0` (it's pinned in `package.json` under `engines`). The two deps, `@modelcontextprotocol/sdk` and `zod`, come in with `bun install`.

Want to run the server on its own to poke at it?

```
bun run src/server.ts
```

It talks over stdio, logs `sdd <version> connected (7 tools)` to stderr, and shuts down clean on `SIGINT`/`SIGTERM`.

## The seven tools

One thing to know up front: all job state lives in memory and only lasts the session. Restart the server and the job map is gone. That's on purpose for v1. No disk persistence yet.

| Tool | Signature | What it does |
|---|---|---|
| `dispatch` | `(adapter, prompt, cwd?, timeoutMs?, …adapter-specific opts) → jobId` | Spawns a work unit on a named adapter as a child process in `cwd` (defaults to the server's cwd). Returns right away, never blocks. It's also never refused for concurrency reasons: every dispatch runs in parallel, so keeping two jobs that write the same tree apart is on you, the caller. The rest of the inputs are adapter-specific and just ignored by adapters that don't read them: `model`, `effort`, `outputPath`, `outputDir`, `addDir`, `cookies`, `subLangs`, `frameCount`, `sceneThreshold`, `sleepRequests`. |
| `status` | `(jobId) → {state, adapter, exitCode?}` | A snapshot of where a job is: `running`, `done`, or `failed`. The `done`/`failed` call reflects the exit code AND the adapter's contract-marker check, never pid-liveness on its own. |
| `result` | `(jobId) → {status, summary, artifacts, raw}` | Pulls a finished job's structured result. Ask too early and a still-running job hands back `{status:"running"}` with no `summary`/`artifacts`/`raw`. You never get a half-baked result. |
| `wait` | `(jobIds[], timeoutMs?) → {done, stillRunning, unknown}` | Blocks until every job in `jobIds` is done or `timeoutMs` runs out, whichever comes first. It won't block past the timeout. Defaults to a short ~30s poll. Pass a bigger `timeoutMs` (capped at 10 minutes) when you actually want to sit and wait instead of re-polling. |
| `list_adapters` | `() → [{name, binaryPresent}]` | Lists every adapter found under `src/adapters/`, with whether its CLI is on `PATH`. Run it before `dispatch` to confirm the harness is even installed. |
| `cancel` | `(jobId) → {cancelled}` | Kills a running job's whole process group. For an unknown or already-finished job it's a no-op (`cancelled:false`) and never throws. |
| `check_adapter` | `(adapter, timeoutMs?, cwd?) → {status, binaryPresent, jobId?}` | Goes past "installed" and checks whether an adapter is actually usable: logged in, subscription active. It runs a tiny real probe through the normal dispatch path. `status` comes back as `ok`, `failed`, `timeout`, `present_unverified`, or `missing`. Use it before you lean on a harness you haven't touched this session. |

For the orchestration doctrine (when to fan out, when you have to serialize jobs sharing a tree, how to use `wait`) see `skills/subagent-driven-development/SKILL.md`.

## The fourteen adapters

Heads up: every agent harness runs wide open (codex `--sandbox workspace-write`, agy `--dangerously-skip-permissions`, grok `--always-approve`, kimi/qwen `--yolo`, mistral `--auto-approve`). So a dispatched harness can edit the tree you hand it. That's the point, but it's your call whether a given tree is safe to hand over.

### Agent harnesses

| Adapter | Job | Gotcha |
|---|---|---|
| `codex` | Review / second opinion / implement (`codex exec`) | stdout carries the final answer, stderr carries progress, so `summary`/`raw` come from stdout only. The output contract is a `VERDICT:` line plus a `## Findings` section. Miss either one (or exit non-zero) and it's `failed`. Two more things: `opts.model`/`opts.effort` are an allowlist, not a passthrough (`effort` maps to the one hardcoded `model_reasoning_effort` key, so nobody can smuggle `-c sandbox_mode=danger-full-access` past the `--sandbox` barricade), and codex refuses to run outside a git repo. A non-git cwd fails before it ever reaches the model, and `parseResult` now calls that out by name instead of letting it look like an auth failure. |
| `codex-high` | codex at max reasoning depth | Pinned to `model_reasoning_effort=high`, `binary` is `codex`. Per-call `model`/`effort` are ignored on purpose. The pin is the whole point. Reach for the base `codex` adapter when you want to vary them. |
| `codex-low` | Cheap, fast codex work | Pinned to `model_reasoning_effort=low`. Same "pin ignores `opts`" rule as `codex-high`. |
| `codex-sol` | Hard coding / deep reasoning on the flagship tier | Pinned to `-m gpt-5.6-sol` at effort `high`. Same pin-ignores-`opts` rule. |
| `agy` | Review / implement | Every flag goes before `--print`, prompt right after. A flag placed after `--print` gets swallowed into the prompt and agy still exits 0, so `buildArgs` locks the order in structurally. Output contract: a last line of `AGY_RESULT: DONE`/`FAILED`, parsed by the LAST occurrence (not the first) so an echoed instruction can't fool it. |
| `grok` | Second opinion (xAI Grok Build CLI) | `grok -p <prompt>`, needs `XAI_API_KEY` in the env. `opts.model` (say `grok-4.5`) passes through as `-m`. Leave it off and you get the CLI's default non-reasoning model, which isn't what you want for a real review. Shares the `VERDICT:`/`## Findings` contract. |
| `kimi` | Second opinion (Moonshot Kimi CLI) | `kimi -p <prompt>`, needs `MOONSHOT_API_KEY`. The installed CLI has no `--print`/`--quiet` whatever the older notes say. `-p` on its own is the headless one-shot flag. Shares the `VERDICT:`/`## Findings` contract. |
| `qwen` | Second opinion (Alibaba Qwen Code CLI) | `qwen -p <prompt>`, needs `DASHSCOPE_API_KEY`. Shares the `VERDICT:`/`## Findings` contract. No landmine beyond that one. |
| `mistral` | Second opinion (Mistral Vibe CLI) | name isn't the binary here: the CLI is `vibe`, not `mistral`, so the adapter sets `binary: "vibe"` and `list_adapters` probes the right thing on PATH. Needs `MISTRAL_API_KEY`. Shares the `VERDICT:`/`## Findings` contract. |

The four review CLIs (`grok`, `kimi`, `qwen`, `mistral`) share one output contract, written once in `src/lib/review-contract.ts`. Review is the job they're asked to do, not a cage. Like every harness here, they run headlessly permissive.

### Artifact producers

| Adapter | Job | Gotcha |
|---|---|---|
| `agy-image` | Image generation (Nano Banana) → one PNG | `outputPath` has to end in `.png`, and if it's relative it has to resolve inside the job `cwd` (a `../` escape gets rejected before spawn). agy resolves a bare relative filename by searching all of `/Users`, so `buildArgs` makes the path absolute itself. agy has no `--out` flag either: the path rides in the prompt tail and comes back as `AGY_IMAGE_SAVED:`. Success needs both the marker (last occurrence) AND the file really sitting on disk. |
| `agy-vision` | Fuse a transcript + keyframes into one understanding JSON | Runs under agy's `--sandbox`, and that sandbox (not the prompt fencing) is the real guard against injection from text on screen in a frame. `addDir` (the read-only grant) and `outputPath` (must end in `.json`) are both required and both traversal-barricaded. Defaults to `Gemini 3.1 Pro (High)`. Drop to a weak, fast tier and it loops on the frame set and times out. Marker: `AGY_VISION_SAVED:`, plus an on-disk existence check. |

### Video pipeline

Driven by `skills/video-ingest/`. These wrap real CLIs, not agents you can talk to, so the "prompt" IS the URL or file path. `injectContract` is the identity function here. Anything else would corrupt that argv element.

| Adapter | Job | Gotcha |
|---|---|---|
| `yt-dlp` | Fetch one video (YouTube, Instagram, TikTok, X) → WAV + the 720p-capped video + best-effort VTT subs | yt-dlp parses its own options, so a "URL" of `--exec=<cmd>` would get option-parsed into command execution even with `shell: false`. Two independent guards cover it: the URL has to be a single whitespace-free `http(s)` URL, AND a literal `--` end-of-options separator always sits right before it in argv. The WAV path rides `--print after_move:filepath`. The retained video path rides a labelled `SDD_VIDEO_PATH:` line that yt-dlp emits as a basename, then gets re-absolutized against the WAV's directory. Needs `opts.outputDir`. |
| `whisper` | Transcribe an audio file → `transcript.srt` + `transcript.txt` | name isn't the binary: the CLI is `mlx_whisper` (underscore), not `whisper`, set via the `binary` export. mlx-whisper has no scripting-friendly print flag, so the adapter passes `--verbose True` and scrapes `output_dir` out of the CLI's own `Args: {...}` argparse debug line. That's the only channel there is, and it isn't a documented stable contract. `--output-name transcript` pins the basename so `parseResult` never has to rebuild a filename. Needs `opts.outputDir`. |
| `ffmpeg-frames` | Scene-cut keyframe extraction → PTS-named frames + `manifest.json` | ffmpeg has no print flag either, so `parseResult` recovers the output dir from ffmpeg's own unconditional `Output #0, <format>, to '<path>':` console line. Frame filenames carry raw stream-timebase pts (monotonic, NOT seconds), so they only recover chronological order. The real timestamps come from zipping the sorted files against the `showinfo` `pts_time:` lines. The filter chain OR's in a periodic term (`not(mod(n,150))`, always true at `n=0`) so a cut-free clip still gives you frames. Needs `opts.outputDir`. |

Every adapter in those last two tables sets `probeable = false`. A live probe would bill a real image generation, hit the network, or run a slow transcode, and a generic health-check prompt can't supply the `outputPath`/`outputDir`/`addDir` their `buildArgs` need. So for those, `check_adapter` reports binary presence only (`present_unverified` instead of `ok`). Every agent harness is probeable and gets the real liveness + auth probe.

## Adding an adapter

Drop a file in `src/adapters/` that exports the `Adapter` port shape. There's no central registry to edit.

```ts
export const name = "my-adapter";

/** Optional. The CLI to probe on PATH when it differs from `name`
 *  (the "mistral" adapter's binary is `vibe`). Defaults to `name`. */
export const binary = "my-cli";

/** Optional. `false` opts out of check_adapter's live probe when a probe would
 *  cost real money, hit the network, or need opts a health check can't supply. */
export const probeable = false;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  // Return an argv array (never a shell string). This gets spawned with no shell.
  // Put every flag BEFORE any positional prompt arg: some harnesses swallow a
  // trailing flag into the prompt text and still exit 0.
  return ["my-cli", "--flag", prompt];
}

export function injectContract(prompt: string): string {
  // Append instructions asking the harness to emit a parseable, validatable marker.
  // (For a non-instructable CLI whose "prompt" is really a path or URL, this has to
  // be the identity function. Anything else corrupts that argv element.)
  return `${prompt}\n\nEnd with: MY_RESULT: DONE|FAILED`;
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  // Extract + validate the marker, scanning for its LAST occurrence. A harness
  // that echoes the injected instruction makes the first match the echo.
  // Missing marker → failed, whatever the exitCode (the backstop for a harness
  // that exits 0 without doing the work).
}
```

`src/adapters/discover.ts` scans `src/adapters/*.ts`, checks each file exports `name`, `buildArgs`, `injectContract`, and `parseResult` (plus a well-formed `binary`/`probeable` if present), and skips anything malformed, missing an export, or claiming a duplicate name. It skips with a stderr warning, never a crash. Files starting with `_` or `.`, `*.test.ts`, `*.d.ts`, and `discover.ts`/`types.ts` themselves are treated as infrastructure and never loaded as adapters. That's what lets shared helpers (`_codex-shared.ts`, `_codex-factory.ts`, `_agy-shared.ts`) sit right next to the adapters that use them.

## Video ingestion setup

The video pipeline (orchestrated by `skills/video-ingest/`) shells out to three external CLIs that `bun install` does NOT manage. Install them yourself, then run the preflight below.

| Tool | Install | Notes |
|---|---|---|
| `yt-dlp` | `brew install yt-dlp` (or `pip install -U yt-dlp` / `uv tool install yt-dlp`) | Fetches audio (plus opportunistic captions) from YouTube, Instagram, TikTok, and X. |
| `ffmpeg` | `brew install ffmpeg` | Audio extraction and scene-cut keyframe capture. |
| `mlx-whisper` | `pip install -U mlx-whisper` (or `uv tool install mlx-whisper`) | Apple Silicon (MLX) speech-to-text. Needs a Mac with Apple Silicon and Python 3.9+. |

Run the preflight before you use the pipeline:

```
bun run src/lib/preflight.ts
```

It prints a JSON report of what's present, what's missing, and the exact install command for anything missing, then exits non-zero if something needs attention.

### Instagram caveat

Instagram is the fussy one. It rate-limits or wants a login for reels and stories a lot more than the other three platforms. Two things help:

- **Cookies:** export a logged-in session's cookies (a browser extension like "Get cookies.txt" works) and hand the file to `yt-dlp --cookies <path>`. Use a burner or throwaway account, never your real credentials, and never commit or log the cookies file.
- **Nightly build:** Instagram's extractor breaks a lot as Instagram changes its site. `yt-dlp`'s nightly channel ships extractor fixes faster than stable (`pip install -U --pre "yt-dlp[default]"`). Pair it with `--sleep-requests` to throttle and stay under the rate limits.

## Development

```
bun install
bun test           # full suite
bunx tsc --noEmit   # strict typecheck
```

One rule to remember: `plugin.json`'s `version` field is the single version source, read at server startup (`src/register.ts:readVersion`). Bump it there and nowhere else.

Found a rough edge or want to add an adapter? Open an issue or a PR. Happy to help.
