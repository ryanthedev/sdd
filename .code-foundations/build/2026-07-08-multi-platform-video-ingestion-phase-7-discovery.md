# Discovery + Design: Phase 7 - `video-ingest` skill (the single surface)

## Files Found
- `skills/subagent-driven-development/SKILL.md` — house skill format precedent (frontmatter shape, `dispatch → wait → dispatch` doctrine, references sub-dir pattern).
- `skills/video-ingest/` — does not exist yet (this phase creates it).
- `src/lib/preflight.ts` — Phase 1's CLI gate. `bun run src/lib/preflight.ts` prints `{ ok, tools: [{name, found, version?, hint?}] }` as JSON and exits non-zero when `ok:false`.
- `src/adapters/yt-dlp.ts` — Phase 4's fetch adapter. **Audio-only.**
- `src/adapters/whisper.ts` — Phase 5's transcription adapter (`mlx_whisper`, audio in → SRT+TXT out).
- `src/adapters/ffmpeg-frames.ts` — Phase 5's keyframe adapter. **Requires a local video file as input** (validated as a path, not a URL).
- `src/adapters/agy-vision.ts` — Phase 6's sandboxed fusion adapter (`--sandbox --add-dir <dir> --model "Gemini 3.1 Pro (High)"`, JSON output with `AGY_VISION_SAVED:` marker).
- `src/tools/dispatch.ts` — the opts schema (`outputDir`, `cookies`, `subLangs`, `frameCount`, `sceneThreshold`, `addDir`, `sleepRequests`, plus `outputPath`, `model`, `mode`).
- `README.md` — "Video ingestion setup" section (install steps, Instagram cookies/nightly caveat) already written in Phase 1.

## Current State
Phases 1-6 are built, reviewed, and committed. All adapters are unit-tested in isolation (fed synthetic stdout/stderr/exitCode) — none has been exercised end-to-end, and nothing in the codebase wires the adapters' outputs to each other. Phase 7's job is to write that wiring as doctrine (a skill), which is the first point in the plan where the *sequence* — not just each adapter individually — gets scrutinized.

## Gaps

### Blocking: `ffmpeg-frames` has no video source anywhere in the built pipeline
Verified by reading the actual code (not just the plan's prose), cross-checked against yt-dlp's documented `-x`/`-f` semantics:

- `yt-dlp.ts buildArgs` is hardcoded: `-x --audio-format wav -f bestaudio --no-playlist -o <dir>/%(id)s.%(ext)s ...`. `-f bestaudio` selects an **audio-only** format at download time — no video stream is ever fetched, not "fetched then stripped." Even where a platform lacks a standalone audio-only stream and yt-dlp must fall back to a combined download, `-x` (extract-audio post-processor) deletes the original video file by default; there is no `-k`/`--keep-video` flag in `buildArgs`.
- `yt-dlp.ts parseResult` / `Produces` (plan Phase 4) confirms this is intentional, not an oversight: `artifacts = [audioWavPath, ...subtitlePaths]` — no video path field exists anywhere in the contract.
- `ffmpeg-frames.ts`'s own header states its contract: *"Single contract: one video file in"* — `buildArgs` passes the prompt straight to `-i <inputPath>`, and its docstring/validation assume a real local video file, not a URL and not an audio file.
- No opt in Phase 3's schema (`outputDir, cookies, subLangs, frameCount, sceneThreshold, addDir, sleepRequests`) toggles video retention, and no adapter accepts a raw platform URL as an `ffmpeg-frames` input (its validator rejects nothing that looks like a path, but the plan's own design — sandboxed/thin-tool split — never intended `ffmpeg-frames` to hit the network or replicate yt-dlp's site-specific extraction, and pasting a page URL into `ffmpeg -i` would not work for any of the four platforms — none exposes a directly fetchable media URL without yt-dlp's own extractor logic, cookies, and signed-URL handling).
- Checked `test/adapter-yt-dlp.test.ts`, `test/adapter-ffmpeg-frames.test.ts`, `README.md`, and `test/tools.test.ts` for any hint of an intended video-artifact channel I might have missed — none exists.

**Net effect:** following the plan's own Phase 7 goal ("sequences fetch → (transcribe ∥ frames) → fusion") exactly as specified, the `frames` half of the fan-out has no input on any of the four platforms, on every run, not just an edge case. This isn't a wart to accept-and-note (like the plan's existing accepted SSRF/DispatchOpts-switchboard items) — it's a required input that structurally cannot exist yet. Writing a SKILL.md that presents `dispatch(ffmpeg-frames, <path from yt-dlp>, ...)` as a working step would document a pipeline that cannot produce a single frame, which fails the "never lie" bar and cannot honestly satisfy DW-7.1 ("documents the full sequence with the fan-out point... explicit") or the plan's own success criterion #1 (a fused transcript **+visual** artifact).

### Non-blocking gaps (would proceed once the above is resolved)
- No other gaps found. Preflight CLI, all four adapters' opts, and the house skill's frontmatter/reference conventions are all consistent and sufficient to write the rest of the doctrine once `ffmpeg-frames` has a real input.

## Code Standards
No `docs/code-standards.md` found in this repo. Followed `CLAUDE.md` + the house skill (`skills/subagent-driven-development/SKILL.md`) as the applicable conventions for skill authoring (frontmatter shape, doctrine tone, references/ subdirectory pattern, no runtime code in a skill).

## Test Infrastructure
Not applicable in the traditional sense — Phase 7 produces a Markdown skill, not code. Its "test" is `validate_skill` (skill-eval MCP) for lint/frontmatter/structure (DW-7.5), plus a documented manual E2E procedure (DW-7.6, since `yt-dlp`/`mlx-whisper` are not installed in this environment and DW-7.6 is explicitly marked DEFERRED-MANUAL in the dispatch prompt). `bun test` + `bunx tsc --noEmit` are run only to confirm this docs-only phase didn't regress the existing suite.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-7.1 | SKILL.md documents the full sequence with the fan-out point (transcribe ∥ frames) explicit | **CANNOT_MEET as specified** | N/A — the `frames` leg of the documented fan-out has no valid input from the fetch step as currently built (see Gaps); documenting it as working would be false |
| DW-7.2 | SKILL.md runs `bun run src/lib/preflight.ts` first and states the failure behavior | COVERED (independent of the gap above) | Manual: SKILL.md step 0 section, `validate_skill` structure check |
| DW-7.3 | per-platform auth notes cover all four (Instagram cookies/nightly/sleeps called out) | COVERED (independent of the gap above) | Manual: SKILL.md auth-notes section |
| DW-7.4 | split-privilege rule + strong-vision-model rule both stated | COVERED (independent of the gap above) | Manual: SKILL.md security section |
| DW-7.5 | the skill validates cleanly (frontmatter + structure) and is discoverable | COVERED once the file exists | `validate_skill(skills/video-ingest)` zero errors |
| DW-7.6 | E2E — documented manual procedure, reported DEFERRED-MANUAL | COVERED as documentation-only per dispatch prompt | `skills/video-ingest/E2E.md` procedure |

**All items COVERED:** NO — DW-7.1 is CANNOT_MEET as the plan currently specifies the sequence, because the `yt-dlp` adapter it depends on (already built and committed in Phase 4) never fetches or reports a video file, and `ffmpeg-frames` (already built and committed in Phase 5) requires one. This is a cross-phase contract gap between two already-shipped adapters, not something fixable inside Phase 7's file scope (`skills/video-ingest/**` only, runtime code explicitly OUT of scope).

## Design Decisions
Deferred — no SKILL.md content decisions are load-bearing until the video-source gap is resolved. The rest of the design (preflight-first gate via Bash, `dispatch → wait → dispatch(2x parallel) → wait → dispatch → wait/result` sequencing per the house skill's doctrine style, `references/` subfile for per-platform detail if the body would exceed ~200 lines) is otherwise straightforward and was sketched but not written, pending the plan update.

## Prerequisites
- [x] Phase 1 (preflight), Phase 4 (yt-dlp), Phase 5 (whisper + ffmpeg-frames), Phase 6 (agy-vision) all exist and are committed.
- [ ] A working video-source channel for `ffmpeg-frames` — missing. `yt-dlp.ts` needs to additionally retain a video file and report its path (e.g., via a second `--print`-style marker and a `-k`/`--keep-video` flag, or a `bestvideo+bestaudio/best` format selector paired with `-x -k`), and `ffmpeg-frames`'s consumer (the skill) needs a known artifact key to read that path from.

## Recommendation
**UPDATE_PLAN.**

**What actually needs to happen:** amend Phase 4 (`src/adapters/yt-dlp.ts` + `test/adapter-yt-dlp.test.ts`) — outside Phase 7's `skills/video-ingest/**` file scope — so the fetch adapter also retains the source video and reports its path in `artifacts` (e.g., alongside `audioWavPath`). Concrete shape to consider: change the format selector to something that actually downloads video (`-f "bv*+ba/b"` or similar) combined with `-x --audio-format wav -k`/`--keep-video` so the merged video survives audio post-processing, plus an additional `--print`-style marker (mirroring the existing `after_move:filepath` pattern) so `parseResult` can report a `videoPath` deterministically. This has a real bandwidth/storage trade-off (full video download vs. audio-only) worth a line in the plan's Decision Log. Once that seam exists and is committed, Phase 7 can be re-dispatched to write an honest `SKILL.md` documenting `dispatch(yt-dlp) → wait → dispatch(whisper, audioPath) ∥ dispatch(ffmpeg-frames, videoPath) → wait → dispatch(agy-vision) → wait/result`.

No SKILL.md was written and no implementation work was done, per the Full-mode protocol ("If SKIP or UPDATE_PLAN: Return with recommendation. Do NOT proceed to implementation."). `bun test` + `bunx tsc --noEmit` were run to confirm this discovery-only phase left the tree unchanged (see final report) — both green, as expected for a phase that touched no files.
