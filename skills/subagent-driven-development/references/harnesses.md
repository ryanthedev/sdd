# Harness roster — capabilities & auth

A *harness* here is an external CLI (`codex`, `agy`, and friends) that `sdd` spawns as a child process in the current working tree to do one bounded task — review, second opinion, implementation, image generation, or a step of the video pipeline — and report back a structured `{status, summary, artifacts, raw}` result. Each harness is wrapped by an adapter in `src/adapters/`; `list_adapters` enumerates all eleven.

The load-bearing distinction: **a harness that shows up in `list_adapters` with `binaryPresent: true` is INSTALLED, not necessarily USABLE.** `binaryPresent` is a `Bun.which` PATH check and nothing more — it cannot see whether the CLI is logged in, has an active subscription, or has an API key in the environment. The honest way to tell whether a harness will actually run is `check_adapter(name)`, which runs a real minimal probe through the dispatch path and reports what happened. See [Auth is not presence](#auth-is-not-presence) below.

## Capability table

Every agent harness here runs **unconditionally permissive** — the adapter always emits the harness's own act-headlessly flag (codex `--sandbox workspace-write`, agy `--dangerously-skip-permissions`, grok `--always-approve`, qwen `--yolo`, mistral `--auto-approve`). kimi is the lone exception, and not a safer one: kimi-code *rejects* an approval flag alongside `-p` ("Cannot combine --prompt with --yolo") precisely because `-p` already forces one — its prompt-mode runner sets permission mode to `auto` for the run, which kimi defines as "tool actions are approved automatically, and agent questions are skipped". In kimi that is *more* autonomous than `yolo`, which can still stop to ask. So kimi emits no flag and is permissive anyway. sdd offers no read-only or review-only dispatch: **any agent harness you dispatch may edit the tree you hand it**, whatever the prompt asks of it. Note this is a property of sdd, not of the harnesses — agy 1.1.5 does expose `--mode plan`, a genuine non-writing mode, which no adapter emits today. "The harness can't be made read-only" would be false; "sdd doesn't make it read-only" is the true statement. Whether two jobs can safely share a `cwd` is the caller's call — the server serializes nothing.

### Agent harnesses

| Adapter | Provider / CLI | PATH binary | What it's for | Auth requirement |
|---|---|---|---|---|
| `codex` | OpenAI Codex, `codex exec` | `codex` | Review / second opinion / implement; runs `--sandbox workspace-write`; does its own web verification when a review needs it. Tier is chosen PER CALL via `model` + `effort` — there are no pinned variants | codex's own login flow (a ChatGPT/OpenAI account or key) — not documented in the adapter source; verify with `check_adapter`, don't assert specifics |
| `grok` | xAI Grok Build CLI 0.2.93, `grok -p` | `grok` | Review / second opinion | `XAI_API_KEY` (or `GROK_API_KEY` / `GROK_DEPLOYMENT_KEY`) env var |
| `kimi` | Moonshot Kimi (kimi-code 0.22.3), `kimi -p` | `kimi` | Review / second opinion | `MOONSHOT_API_KEY` env var |
| `qwen` | Alibaba Qwen Code (gemini-cli lineage), `qwen -p` | `qwen` | Review / second opinion | `DASHSCOPE_API_KEY` env var |
| `mistral` | Mistral Vibe, `vibe -p` | `vibe` (name ≠ binary) | Review / second opinion | `MISTRAL_API_KEY` env var |
| `agy` | General review/implement harness, `agy --print` | `agy` | Review AND implement — edits the working tree | agy's own login flow — not documented in the adapter source; verify with `check_adapter` |

### Artifact producers

| Adapter | Provider / CLI | PATH binary | What it's for | Auth requirement |
|---|---|---|---|---|
| `agy-image` | Nano Banana image generation (built into agy), `agy --print` | `agy` | Text prompt → exactly one PNG saved to an explicit absolute path | agy's own login flow (same as `agy`) |
| `agy-vision` | agy's vision model (default `Gemini 3.1 Pro (High)`), `agy --print --sandbox` | `agy` | Transcript + keyframes (`addDir`, read-only) → one fused-understanding JSON at `outputPath` | agy's own login flow (same as `agy`) |

### Video pipeline

Orchestrated by the [`video-ingest`](../../video-ingest/SKILL.md) skill — read it before dispatching these. They wrap real CLIs, not instructable agents: the "prompt" **is** the URL or file path, `injectContract` is the identity function, and none of them is an agent that can edit your tree. `bun run src/lib/preflight.ts` gates all three (none is managed by `bun install`).

| Adapter | Provider / CLI | PATH binary | What it's for | Auth requirement |
|---|---|---|---|---|
| `yt-dlp` | `yt-dlp` | `yt-dlp` | One video URL (YouTube, Instagram, TikTok, X) → WAV + the 720p-capped video + best-effort subs, in `outputDir` | None for YouTube/TikTok; a burner-account `cookies` file for gated X / Instagram (see the video-ingest skill) |
| `whisper` | mlx-whisper (large-v3-turbo) | `mlx_whisper` (name ≠ binary) | One audio file → `transcript.srt` + `transcript.txt` in `outputDir` | None — runs locally |
| `ffmpeg-frames` | `ffmpeg` | `ffmpeg` | One video file → scene-cut keyframes + `manifest.json` (frame → seconds) in `outputDir` | None — runs locally |

## The review roster

`codex`, `grok`, `kimi`, `qwen`, and `mistral` are **interchangeable second-opinion harnesses**. They share the same output contract — a `VERDICT:` line plus a `## Findings` section — so any one of them can stand in for another, and they fan out cleanly in parallel for an *ensemble* review: dispatch several against the same target in one turn, then `wait` on the batch and compare their findings.

Review is what you *ask* them for, not what they are *limited to*: each still runs permissively and could write to the tree. Fanning them out at the same target is fine — none of them is supposed to edit anything — but don't overlap them with an implementation job in the same `cwd`.

They differ along two axes:

- **Provider / model.** Each speaks to a different vendor's model, so their blind spots and strengths differ — the reason an ensemble is worth more than one call repeated.
- **Auth style.** `grok` / `kimi` / `qwen` / `mistral` are **API-key-auth** (a single env var), while `codex` uses **its own login flow** (an account/subscription). This matters for fan-out: an env-key harness fails instantly at spawn if the key is unset, whereas a login-flow harness fails only if the session isn't active.

`agy` can also serve as a second opinion, but it is not part of this contract-sharing roster — its output contract is the `AGY_RESULT:` marker, not `VERDICT:`/`## Findings`.

## Auth is not presence

`binaryPresent` answers exactly one question: is the CLI binary on `PATH`? It says nothing about whether a dispatch will succeed, because every harness has a second gate that PATH can't see:

- **Env-key adapters** (`grok`, `kimi`, `qwen`, `mistral`) fail at spawn time if their key (`XAI_API_KEY`/`GROK_API_KEY`/`GROK_DEPLOYMENT_KEY`, `MOONSHOT_API_KEY`, `DASHSCOPE_API_KEY`, `MISTRAL_API_KEY`) is unset in the environment the server inherited.
- **Login-flow adapters** (`codex` and its pinned variants, `agy`, and by extension `agy-image` / `agy-vision`) fail if the underlying CLI isn't logged in or the subscription/quota is inactive.
- **The video-pipeline adapters** (`yt-dlp`, `whisper`, `ffmpeg-frames`) have no auth gate at all — but they are also not managed by `bun install`, so their gate is the preflight check (`bun run src/lib/preflight.ts`), not `check_adapter`.

None of this is visible to `list_adapters`. The honest verification is **`check_adapter(name)`** — it runs a minimal live probe through the normal dispatch path and reports what actually happened, surfacing the CLI's own auth/quota error text on failure. Because the probe runs a real (permissive) harness, it defaults to a **fresh throwaway temp cwd** when the caller names no `cwd`, so any write it makes lands off-tree; a caller-supplied `cwd` is honored as-is. Its status ladder:

| Status | Meaning |
|---|---|
| `ok` | Binary present **and** the live probe completed — the harness ran and is authenticated. The reliable signal. |
| `failed` | Binary present but the probe failed; `detail` carries the CLI's own error text (typically an auth / subscription / quota message, tailed from the job log where stderr lands). |
| `timeout` | Probe still running at the timeout — inconclusive (slow model, network, or a hang); the probe job is cancelled. Retry with a larger `timeoutMs`. |
| `present_unverified` | Binary present but the adapter opts out of automatic probing (`probeable: false`): `agy-image`, `agy-vision`, `yt-dlp`, `whisper`, `ffmpeg-frames` — a probe would bill a real generation, hit the network, or run a slow transcode, and a generic health-check prompt can't supply the `outputPath`/`outputDir`/`addDir` their `buildArgs` demand. Dispatch a real job to confirm. Every agent harness is probeable. |
| `missing` | Binary not on `PATH` — not installed. |

`check_adapter(adapter, timeoutMs?, cwd?)` defaults to a 60s probe timeout (clamped to the JobStore wait cap). Before you rely on a harness you have **not** already exercised this session, check it.

## Output contracts — what "done" means per harness

A job's terminal state is decided by exit code **and** the adapter's `parseResult` marker check: a missing contract marker is `failed` even on a clean exit 0. What each harness must emit:

| Harness(es) | Required output contract |
|---|---|
| `codex`, `grok`, `kimi`, `qwen`, `mistral` | A `VERDICT:` line **plus** a `## Findings` section. Missing either → `failed`. |
| `agy` | Last line of output exactly `AGY_RESULT: DONE` or `AGY_RESULT: FAILED`. Parsed by **last** match (the harness may echo the injected instruction first). |
| `agy-image` | `AGY_IMAGE_SAVED: <absolute path>` **and** the file must exist on disk. A marker with no file on disk → `failed`. |
| `agy-vision` | `AGY_VISION_SAVED: <absolute path>` **and** the JSON must exist on disk. Same last-match rule; a marker with no file → `failed`. |
| `yt-dlp` | An absolute `.wav` path on yt-dlp's own `--print after_move:filepath` line (plus a labelled `SDD_VIDEO_PATH:` line for the retained video), and the file must exist on disk. No path line → `failed` even on exit 0. |
| `whisper` | An `output_dir` scraped from mlx-whisper's `Args: {...}` line, with **both** `transcript.srt` and `transcript.txt` present on disk. Missing either → `failed`. |
| `ffmpeg-frames` | An output dir recovered from ffmpeg's own `Output #0, …, to '<path>':` line, with the frames + `manifest.json` present on disk. |
