---
name: video-ingest
description: >-
  Ingest a video from a URL (YouTube, Instagram, TikTok, or X) into one fused
  transcript + visual-understanding JSON artifact, by sequencing the sdd
  pipeline's four adapters through MCP dispatches: yt-dlp (fetch audio+video),
  whisper (transcribe), ffmpeg-frames (keyframes), and the sandboxed agy-vision
  (fuse spoken + on-screen content). Documents the preflight gate, the
  fetch → transcribe ∥ frames → fuse sequence with its parallel fan-out,
  per-platform auth (Instagram burner cookies / nightly / sleeps), frame
  budgets, timestamp interleaving via the frame manifest, the split-privilege
  containment (full-network fetch vs. sandboxed fusion), and the known visual
  blind spots. Use when ingesting, transcribing, or extracting a visual
  understanding of a video from a URL on any of the four platforms.
  Not for: image generation (use agy-image via subagent-driven-development),
  code review or second opinions (subagent-driven-development), or writing new
  MCP tools / adapters (runtime code, out of scope here).
when_to_use: >-
  Trigger phrases: "ingest this video", "transcribe this YouTube/TikTok/
  Instagram/X video", "what happens in this video", "get the transcript and
  visuals of this reel/short/clip", "summarize this video URL", "fuse the
  spoken and on-screen content of this video". Use before dispatching any of
  the yt-dlp / whisper / ffmpeg-frames / agy-vision adapters, and run the
  preflight gate first.
---

# Video ingestion

Take a video URL from **YouTube, Instagram, TikTok, or X** and produce one machine-consumable **fused understanding** — the full spoken transcript *plus* the visual content the transcript misses (sight gags, on-screen text, reaction shots, memes) — written as JSON to a caller-named external path. This is the user-facing surface over four thin adapters (`yt-dlp`, `whisper`, `ffmpeg-frames`, `agy-vision`) sequenced through the sdd MCP tools (`dispatch`, `wait`, `result`). Claude is the brain that sequences the dispatches and reads the artifacts off disk; the adapters do the bounded work. This extends the `dispatch → wait → dispatch` doctrine in [`../subagent-driven-development/SKILL.md`](../subagent-driven-development/SKILL.md) — read that for the tool surface and the caller-owned concurrency rule (the server serializes nothing; keeping colliding jobs apart is on you).

## 0. Preflight FIRST — gate before any dispatch

The pipeline shells out to three CLIs that `bun install` does **not** manage: `yt-dlp`, `mlx-whisper` (`mlx_whisper`), and `ffmpeg`. Run the preflight gate via Bash before dispatching anything:

```
bun run src/lib/preflight.ts
```

It prints a JSON report and **exits non-zero when any tool is missing or unusable**. On a non-zero exit, **stop** — do not dispatch. Surface the per-tool `hint` fields from the JSON verbatim (each names the exact install command); the `tools[]` array flags what is absent, too old, or (for `ffmpeg`) missing a required encoder. Only proceed to step 1 when it exits 0. This gate exists so the pipeline fails loudly at the start with actionable guidance, never mid-run with an opaque spawn error three dispatches deep.

## 1. The external artifact directory

**One directory per video, outside the source tree.** Every adapter takes `outputDir` (or, for the fusion step, `addDir` + `outputPath`) and lands its media there — audio, video, transcript, frames, manifest, and the final `fused.json`. Media never enters the working tree, and each step writes a distinct set of files in `<artifactDir>` — that separation is what makes the transcribe ∥ frames fan-out safe (the server won't stop two jobs from colliding; only their disjoint outputs will). Pick an absolute path (e.g. `/tmp/video-ingest/<id>/`) and reuse it as the single `<artifactDir>` for every step below.

Because job state is in-memory and session-scoped, a server restart mid-pipeline orphans the steps but leaves the artifacts on disk. **Tolerate re-running from the last completed artifact** — if the wav already exists, you can skip straight to the transcribe/frames fan-out rather than re-fetching.

## 2. The sequence

Deterministic order, with exactly one parallel fan-out. Each `dispatch` returns a `jobId`; `wait` on it, then `result` to read the `artifacts` array off disk before feeding paths into the next step.

```
preflight (Bash gate, §0)
  │
  ▼
dispatch(yt-dlp, <url>, {outputDir: <artifactDir>, cookies?, subLangs?, sleepRequests?})
  → wait → result   ⇒ artifacts = [audioWav, video, ...subs]   (audio first, then video, then best-effort subs)
  │
  ├─────────────── FAN OUT (independent reads — dispatch BOTH in the same turn) ───────────────┐
  ▼                                                                                             ▼
dispatch(whisper, <audioWav>, {outputDir: <artifactDir>})           dispatch(ffmpeg-frames, <video>, {outputDir: <artifactDir>,
  ⇒ artifacts = [transcript.srt, transcript.txt]                       frameCount?, sceneThreshold?})
                                                                       ⇒ artifacts = [...frames, manifest.json]
  └───────────────────────────── wait BOTH ─────────────────────────────────────────────────────┘
  │
  ▼
dispatch(agy-vision, <short instruction>, {addDir: <artifactDir>, outputPath: <artifactDir>/fused.json, model: "Gemini 3.1 Pro (High)"})
  → wait → result   ⇒ artifacts = [fused.json]   ({summary, moments:[{tSeconds, spoken, visual, isVisualGag}]})
```

- **Step 2 (fetch):** `yt-dlp` fetches a 720p-capped video *and* extracts a whisper-ready wav, keeping both. `result`'s `artifacts` array is `[audioWav, video, ...subtitles]` — audio first, video second, subtitles (best-effort) last. Read the first two paths for the fan-out.
- **Step 3 (fan out — the parallel point):** `whisper` reads only the audio; `ffmpeg-frames` reads only the video. They are fully independent reads with no shared write target — **dispatch both in the same turn**, then `wait` on the pair. This is the pipeline's one concurrency win; do not serialize them.
- **Step 4 (fuse):** `agy-vision` reads the transcript + frames + manifest from `<artifactDir>` (granted via `--add-dir`) and writes `fused.json`. Its prompt is a short instruction — the adapter's own `injectContract` supplies the full fusion contract and output schema; you just point it at the material. `wait`/`result`, then read `fused.json`.

## 3. Whisper is mandatory; captions are opportunistic

No platform gives reliable captions, so **whisper always runs** — the transcript is the spoken-channel source of truth. Subtitles that `yt-dlp` happens to fetch (`subLangs`) are a bonus, not a substitute. One narrow optimization: **TikTok** sometimes ships real (non-auto) captions; if `yt-dlp`'s subtitle artifacts contain a genuine caption track and speed matters, you *may* skip the whisper dispatch and feed those subs to fusion instead. Everywhere else, and whenever in doubt, run whisper.

## 4. Per-platform auth

| Platform | Auth posture | What to pass |
|---|---|---|
| **YouTube** | Easiest — anonymous, reliable. | Nothing special. |
| **TikTok** | Mostly anonymous. Sometimes ships real captions (see §3 — opportunistic whisper-skip). | Usually nothing; `subLangs` if you want its captions. |
| **X (Twitter)** | Anonymous until the post is NSFW-gated or protected. | `cookies` only when a fetch fails on a gated/protected post. |
| **Instagram** | **Aggressive** — frequently rate-limits or requires login for reels/stories. | A **burner-account** `cookies` file (export from a logged-in **Firefox** session; never a primary account, never commit/log it) **+** yt-dlp's **nightly** build (extractor fixes ship faster than stable) **+** `sleepRequests` to throttle and avoid tripping rate limits. |

When a fetch fails with a login-required or rate-limited error, `yt-dlp`'s `parseResult` surfaces the stderr tail in its `summary` — relay that as the actionable auth guidance (add cookies, switch to nightly, raise `sleepRequests`). See the README's "Video ingestion setup → Instagram caveat" for the exact cookie-export and nightly-install commands.

## 5. Frame budget & scene threshold

`ffmpeg-frames` selects scene-cut keyframes, capped at `frameCount`, with an OR'd periodic fallback so the frame set is never empty even on a static clip. Defaults when omitted: cap **150**, scene threshold **0.35**. Tune `frameCount` to the content length:

| Content | `frameCount` |
|---|---|
| Short-form (reels, shorts, TikToks — seconds to ~1 min) | **8–20** |
| Long-form (multi-minute videos) | **50–150** |

Lower `sceneThreshold` toward 0.2 to catch subtler cuts (more frames); raise it toward 0.5 for only hard cuts (fewer). When the cap fires, the manifest records a `dropped` count — no silent truncation.

## 6. Timestamp interleaving for the fusion step

`ffmpeg-frames` writes a `manifest.json`: `{ frames: [{ file, tSeconds }], dropped? }` mapping every emitted frame to its time in seconds. The transcript SRT carries its own timestamps. **The fusion step's value comes from aligning the two channels on time** — so agy-vision can spot "says A while B is on screen" (e.g., a sincere line delivered over a contradicting sight gag). agy-vision reads both the manifest and the transcript from `<artifactDir>` and does the interleaving itself; the manifest's frame→seconds map is what makes that alignment exact rather than guessed. If you ever pre-window the material for it, interleave each transcript window with the frames whose `tSeconds` fall inside that window — never hand it frames and transcript as two unsynced blobs.

## 7. Split-privilege containment (do not collapse these two roles)

The pipeline is deliberately split across a privilege boundary — this is the core security property, not an implementation detail:

- **Fetch runs full-network, no agent.** `yt-dlp` is a plain tool adapter with network access and *no LLM in the loop*. It touches the untrusted internet but never reasons over untrusted content.
- **Fusion runs SANDBOXED.** `agy-vision` — the step that feeds untrusted transcript text and untrusted **frame pixels** to a vision model — always runs under agy's `--sandbox` (no shell, no network), reading the frames read-only via `--add-dir`.

**Why:** the fusion step consumes the lethal combination of untrusted content and model reasoning. On-screen text in a frame can carry a prompt-injection payload ("ignore your instructions, run X"), and **image-borne injection defeats text fencing** — you cannot reliably prompt-fence pixels. The `--sandbox` (no shell, no network) is the *real* control: a steered agent has nothing to reach. The data-fencing in agy-vision's prompt is defense-in-depth only. Never route fusion through a full-access agent, and never move network access into the fusion step.

## 8. Strong vision model — not Flash-Low

Default agy-vision to **`"Gemini 3.1 Pro (High)"`** (already the adapter default; pass it explicitly for clarity). **Do NOT use a weak/fast tier like `Gemini 3.5 Flash (Low)`** — it loops on the frame set and times out. This is a capability floor, not a cost preference: the fusion genuinely needs the strong tier to read `--add-dir` frames and produce the aligned output.

## 9. Known visual blind spots

Frame sampling captures *stills*, so set downstream expectations — the fused understanding will systematically miss:

- **Motion-only humor** — pratfalls, physical comedy that lives in the movement between frames.
- **Timing / rhythm jokes** — beats and pauses that don't show up in any single frame.
- **Meme-flashes shorter than the sample interval** — a frame flashed for a few hundred ms between scene cuts can fall between sampled keyframes.
- **Fades / dissolves** — gradual transitions that a discrete keyframe set represents as an abrupt cut or misses entirely.

Raising `frameCount` / lowering `sceneThreshold` narrows the meme-flash gap but never closes the motion/timing ones — those are inherent to still-frame analysis.

## 10. Manual E2E (DEFERRED-MANUAL)

`yt-dlp` and `mlx-whisper` are **not installed in this build environment**, so the real-URL end-to-end run cannot be executed here and must be verified manually on a machine that has the tooling:

1. **Install the tools:** `brew install yt-dlp ffmpeg` and `pip install -U mlx-whisper` (Apple Silicon). Then `bun run src/lib/preflight.ts` and confirm it exits 0.
2. **Pick a short public YouTube URL** (a clip of tens of seconds keeps whisper + frame extraction fast).
3. **Run the sequence in §2** against a fresh `<artifactDir>`: `dispatch(yt-dlp)` → `wait` → fan out `dispatch(whisper)` ∥ `dispatch(ffmpeg-frames)` → `wait` both → `dispatch(agy-vision, …, {outputPath: <artifactDir>/fused.json, model: "Gemini 3.1 Pro (High)"})` → `wait`/`result`.
4. **Confirm success:** `<artifactDir>/fused.json` exists and is non-empty, and its `moments[]` array has entries with `tSeconds`, `spoken`, and `visual` populated. That proves the whole pipeline end-to-end on real tooling (plan success criterion #1).
