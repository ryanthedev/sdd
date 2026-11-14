# Harness roster — capabilities & auth

A *harness* here is an external CLI (`codex`, `agy`, and friends) that `sdd` spawns as a child process in the current working tree to do one bounded task — review, second opinion, implementation, image generation, or a step of the video pipeline — and report back a structured `{status, summary, artifacts, raw}` result. Each harness is wrapped by an adapter in `src/adapters/`; `list_adapters` enumerates all twelve, and reports a `kinds` list for any harness that does more than one thing.

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
| `agy` + `kind:"image"` | Nano Banana image generation (built into agy), `agy --print` | `agy` | Text prompt → exactly one PNG saved to an explicit absolute path | agy's own login flow (same as `agy`) |
| `codex` + `kind:"image"` | codex's `imagegen` system skill → built-in `image_gen` tool, `codex exec` | `codex` | Text prompt → exactly one PNG saved to an explicit absolute path | codex's own login flow (same as `codex`) |
| `grok` + `kind:"image"` | grok's `imagine` skill → built-in `image_gen`/`image_edit`, `grok -p` | `grok` | Text prompt → exactly one PNG saved to an explicit absolute path | same env key as `grok` |
| `agy` + `kind:"vision"` | agy's vision model (default `Gemini 4 Argon (High)`), `agy --print --sandbox` | `agy` | Transcript + keyframes (`addDir`, read-only) → one fused-understanding JSON at `outputPath` | agy's own login flow (same as `agy`) |
| `gemini` + `kind:"vision"` | Gemini API `generateContent` (default `gemini-3.1-flash-lite`), through the bundled `assets/gemini-vision.ts` | `bun` (name ≠ binary) | The API-key fallback for agy's vision: same `addDir` + `outputPath`, same output JSON. One call, no tools, frames at low media resolution | `GEMINI_API_KEY`, from the server's env or else `~/.config/sdd/.env` |

### Video pipeline

Orchestrated by the [`video-ingest`](../../video-ingest/SKILL.md) skill — read it before dispatching these. They wrap real CLIs, not instructable agents: the "prompt" **is** the URL or file path, `injectContract` is the identity function, and none of them is an agent that can edit your tree. `bun run src/lib/preflight.ts` gates the first three (none is managed by `bun install`); `shazam` is optional and reported but not gated.

| Adapter | Provider / CLI | PATH binary | What it's for | Auth requirement |
|---|---|---|---|---|
| `yt-dlp` | `yt-dlp` | `yt-dlp` | One video URL (YouTube, Instagram, TikTok, X) → WAV + the 720p-capped video + best-effort subs, in `outputDir` | None for YouTube/TikTok; a burner-account `cookies` file for gated X / Instagram (see the video-ingest skill) |
| `whisper` | mlx-whisper (large-v3-turbo) | `mlx_whisper` (name ≠ binary) | One audio file → `transcript.srt` + `transcript.txt` in `outputDir` | None — runs locally |
| `ffmpeg-frames` | `ffmpeg` | `ffmpeg` | One video file → scene-cut keyframes + `manifest.json` (frame → seconds) in `outputDir` | None — runs locally |
| `shazam` | shazamio, via the bundled `assets/shazam-recognize.py` | `uv` (name ≠ binary) | One audio **or** video file → a track-identity JSON at `outputPath` (`matched`, title, artist, album, label, ISRC, Shazam + Apple Music links) | None — but `uv` must be on PATH; it provisions the recognizer from the script's inline metadata on first run |

`shazam` is the one video-pipeline adapter preflight does **not** gate: `uv` is reported under `optional[]`, because the fetch → transcribe → frames → fuse sequence is complete without it. Two things about it that will otherwise bite:

- **A no-match is `done`, not `failed`.** "Not in the catalog" is a real answer to the question. Read `matched` in the JSON; never read an empty title as a broken job.
- **Hand it the media file, not a pre-made wav, if you like** — it transcodes with `ffmpeg` before fingerprinting. That transcode is load-bearing, not a convenience: fed an `.mp4` directly, the underlying library sniffs it as raw mpeg audio and produces a fingerprint that fails to match while looking exactly like an honest negative.

### Decision model

| Adapter | Provider / CLI | PATH binary | What it's for | Auth requirement |
|---|---|---|---|---|
| `gemini` (default kind) | Gemini Decisions API (`POST /v1beta/decisions`, model `gemini-decision-1`), through the bundled `assets/gemini-decide.ts` | `bun` (name ≠ binary) | A request (a `.json` path or inline JSON: `questions` + `items[{id, input}]`) → one results JSON (at `outputPath`, or a fresh temp dir when omitted), with a headline answer per item in the `result` summary. Inputs may be text OR local images, video, audio, PDFs. Ranks, routes, classifies; never writes text, never touches the tree | `GEMINI_API_KEY`, from the server's env or else a `GEMINI_API_KEY=` line in `~/.config/sdd/.env` (read on every job, so no restart). Billed to the AI Studio project the key belongs to |

`gemini` is the decision model: it ranks, routes, and classifies over text and media. Verified live 2026-11-13. Things to know before dispatching it:

- **The prompt is a request, not a question:** either a path to a `.json` file, or the request JSON itself (first non-space character `{`, up to ~100 KB; relative media paths then resolve against the job `cwd`). A natural-language prompt is rejected at dispatch with the request shape. `{"questions": {"<name>": {"type": "noul"|"choice"|"score", "instructions", "criteria"}}, "items": [{"id", "input"}]}`. A `score` question's `criteria` is a string rubric. An `input` is a string, or blocks: `{"type":"text","text"}` or `{"type":"image"|"video"|"audio"|"document","path"|"uri"|"data"}`. `path` is a local file, resolved against the request file's directory; it must resolve (realpath) inside that directory or the job `cwd` unless the request sets `"allowOutsidePaths": true`. An item whose inline media totals up to 14 MB goes inline; above that its largest files are uploaded once through the Files API. Up to 1,000 questions per item, 262,144 tokens of input. Other request fields: `resolution` (`low` default, `medium`, `high`, `ultra_high`; also per block), `concurrency`, `maxItems`, `maxCostUsd` (below), `dryRun`.
- **`outputPath` is optional.** Without it the script writes a fresh temp dir and the result's `artifacts` names it. `model` in the dispatch opts overrides the request's `model`; `timeoutMs` becomes an overall deadline (90% of it) after which no new item is started and what finished is flushed.
- **Answers are in the `summary`.** Besides the results file, `result` carries `answers={"<id>": {"<question>": <headline>}}` (when it fits 8 KB): the headline is P(yes) for `noul`, `{"choice", "p"}` for `choice`, `{"score", "p"}` for `score`, or `{"error"}` for an item that failed. No file read is needed for a small batch. In the results JSON every answer also has a uniform `p`, and top-level `requestedModel`, `questionTypes`, and a per-item `costUsd`.
- **Legacy fields are accepted.** An item's `state` is read as the text input, `type:"boolean"` is sent as `noul`, and boolean `criteria: {true, false}` become `{true_description, false_description}`. A question written as `boolean` gets `probability` (= `noul`) next to `{noul, confidence, p}`. Native shapes: `noul` → `{noul, confidence}`, `choice` (criteria is an object `{label: description}`) → `{choice, probabilities, confidence}`, `score` (criteria is a string rubric) → `{score, probabilities, legend, confidence}`.
- **Spend is capped three ways.** `maxCostUsd` (default `1.00`) stops scheduling new items once the job's accumulated cost reaches it; the rest are recorded as `{id, error:"skipped: maxCostUsd reached"}` and the summary says `stopped=budget`. A request that fails the same way for every item fails fast: the first item runs alone, and an HTTP 400/401/403 on it aborts the job (exit 1, results file still written); 5 identical non-retryable errors in a row abort it too. And before the first API call the script refuses (exit 1, `budget exceeded: …`) when the gemini spend in the sdd ledger already reaches the daily (rolling 24 h, default $5) or monthly (calendar month, default $50) limit in `~/.config/sdd/budget.json`. That is the decision pool; the `vision` kind has its own pool (nested `gemini.vision` block, default $15 / $150) with its own spend, so video work and decision work can't use each other up. Only the user edits that file. `"dryRun": true` validates, stats the media, and prints a rough token and cost estimate without calling the API.
- **Cost reporting is honest.** The job's usage is a cumulative `SDD_GEMINI_USAGE` line (it survives a cancel and a failed job). Cost is priced only for `gemini-decision-1`; any other model, or a reply with no `total_input_tokens`, reports `cost_usd=unknown` and null tokens, never `$0`. The summary adds `failed_ids=` (first 5) and `first_error=` when anything failed, and each finished item is appended to `<outputPath>.partial.jsonl` until the final file is written, so a killed job leaves partial results.
- **YouTube URLs are refused by the API.** Download with `yt-dlp` first and pass the file `path`.
- **Cost and speed:** $0.10 per million input tokens, $0 output, about 1 s per item. A 19-second 720p clip with four questions was 2,192 tokens ($0.0002). Default media resolution is `low`; set `"resolution"` in the request (or per block) for fine detail.
- **Every input leaves the machine,** including any local file it names. Never put secrets in one.
- **Calibration is unmeasured.** Google reports a `confidence` per answer, but it has not been measured, so rank by the probabilities and don't threshold them.

## The review roster

`codex`, `grok`, `kimi`, `qwen`, and `mistral` are **interchangeable second-opinion harnesses**. They share the same output contract — a `VERDICT:` line plus a `## Findings` section — so any one of them can stand in for another, and they fan out cleanly in parallel for an *ensemble* review: dispatch several against the same target in one turn, then `wait` on the batch and compare their findings.

Review is what you *ask* them for, not what they are *limited to*: each still runs permissively and could write to the tree. Fanning them out at the same target is fine — none of them is supposed to edit anything — but don't overlap them with an implementation job in the same `cwd`.

They differ along two axes:

- **Provider / model.** Each speaks to a different vendor's model, so their blind spots and strengths differ — the reason an ensemble is worth more than one call repeated.
- **Auth style.** `grok` / `kimi` / `qwen` / `mistral` are **API-key-auth** (a single env var), while `codex` uses **its own login flow** (an account/subscription). This matters for fan-out: an env-key harness fails instantly at spawn if the key is unset, whereas a login-flow harness fails only if the session isn't active.

`agy` can also serve as a second opinion, but it is not part of this contract-sharing roster — its output contract is the `AGY_RESULT:` marker, not `VERDICT:`/`## Findings`.

## Auth is not presence

`binaryPresent` answers exactly one question: is the CLI binary on `PATH`? It says nothing about whether a dispatch will succeed, because every harness has a second gate that PATH can't see:

- **Env-key adapters** (`grok`, `kimi`, `qwen`, `mistral`, `gemini`) fail at spawn time if their key (`XAI_API_KEY`/`GROK_API_KEY`/`GROK_DEPLOYMENT_KEY`, `MOONSHOT_API_KEY`, `DASHSCOPE_API_KEY`, `MISTRAL_API_KEY`, `GEMINI_API_KEY`) is unset in the environment the server inherited. `gemini` also reads `~/.config/sdd/.env` when the variable is unset, and report the missing key by name in their `failed` summary.
- **Login-flow harnesses** (`codex`, `agy` — including their `image`/`vision` kinds, which share the same binary and account) fail if the underlying CLI isn't logged in or the subscription/quota is inactive.
- **The video-pipeline adapters** (`yt-dlp`, `whisper`, `ffmpeg-frames`, `shazam`) have no auth gate at all — but they are also not managed by `bun install`, so their gate is the preflight check (`bun run src/lib/preflight.ts`), not `check_adapter`.

None of this is visible to `list_adapters`. The honest verification is **`check_adapter(name)`** — it runs a minimal live probe through the normal dispatch path and reports what actually happened, surfacing the CLI's own auth/quota error text on failure. Because the probe runs a real (permissive) harness, it defaults to a **fresh throwaway temp cwd** when the caller names no `cwd`, so any write it makes lands off-tree; a caller-supplied `cwd` is honored as-is. Its status ladder:

| Status | Meaning |
|---|---|
| `ok` | Binary present **and** the live probe completed — the harness ran and is authenticated. The reliable signal. |
| `failed` | Binary present but the probe failed; `detail` carries the CLI's own error text (typically an auth / subscription / quota message, tailed from the job log where stderr lands). |
| `timeout` | Probe still running at the timeout — inconclusive (slow model, network, or a hang); the probe job is cancelled. Retry with a larger `timeoutMs`. |
| `present_unverified` | Binary present but the adapter opts out of automatic probing (`probeable: false`): `yt-dlp`, `whisper`, `ffmpeg-frames`, `shazam`, `gemini` — a probe would bill a real generation, hit the network, or run a slow transcode, and a generic health-check prompt can't supply the `outputPath`/`outputDir`/`addDir` their `buildArgs` demand. Dispatch a real job to confirm. Every agent harness is probeable. |
| `missing` | Binary not on `PATH` — not installed. |

`check_adapter(adapter, timeoutMs?, cwd?)` defaults to a 60s probe timeout (clamped to the JobStore wait cap). Before you rely on a harness you have **not** already exercised this session, check it.

## Output contracts — what "done" means per harness

A job's terminal state is decided by exit code **and** the adapter's `parseResult` marker check: a missing contract marker is `failed` even on a clean exit 0. What each harness must emit:

| Harness(es) | Required output contract |
|---|---|
| `codex`, `grok`, `kimi`, `qwen`, `mistral` | A `VERDICT:` line **plus** a `## Findings` section. Missing either → `failed`. |
| `agy` | Last line of output exactly `AGY_RESULT: DONE` or `AGY_RESULT: FAILED`. Parsed by **last** match (the harness may echo the injected instruction first). |
| `agy` `kind:"image"` | `AGY_IMAGE_SAVED: <absolute path>` **and** the file must exist on disk. A marker with no file on disk → `failed`. |
| `codex` `kind:"image"` | `CODEX_IMAGE_SAVED: <absolute path>` **and** the file must exist on disk. Same shared contract (`src/lib/image-contract.ts`), same on-disk proof. |
| `agy` `kind:"vision"` | `AGY_VISION_SAVED: <absolute path>` **and** the JSON must exist on disk. Same last-match rule; a marker with no file → `failed`. |
| `yt-dlp` | An absolute `.wav` path on yt-dlp's own `--print after_move:filepath` line (plus a labelled `SDD_VIDEO_PATH:` line for the retained video), and the file must exist on disk. No path line → `failed` even on exit 0. |
| `whisper` | An `output_dir` scraped from mlx-whisper's `Args: {...}` line, with **both** `transcript.srt` and `transcript.txt` present on disk. Missing either → `failed`. |
| `ffmpeg-frames` | An output dir recovered from ffmpeg's own `Output #0, …, to '<path>':` line, with the frames + `manifest.json` present on disk. |
| `shazam` | A `SDD_SHAZAM_RESULT:<path>` line from the bundled script, the JSON present on disk, and either a title/artist pair or an explicit `SDD_SHAZAM_NOMATCH` — a result marker with neither is a broken run, not a negative. |
| `gemini` | Default kind: `SDD_GEMINI_RESULT:<path>` (plus an `SDD_GEMINI_SUMMARY:` line with counts, token count and cost, an optional `SDD_GEMINI_ANSWERS:` headline line, and cumulative `SDD_GEMINI_USAGE:` lines) and the results JSON on disk; per-item errors (a safety block, an unreadable file) stay in the JSON, and only an all-items failure exits 1 (the results file is still written and reported in `artifacts`). `vision`: `SDD_GEMINI_VISION_SAVED:<path>` and the fused JSON on disk; the script validates the response parses and has `summary` + `moments` before writing it, and prints its `SDD_GEMINI_USAGE:` line before that validation (a cut-off reply was still billed). Both kinds refuse (exit 1) when the daily or monthly gemini budget is already spent. |
