# Discovery + Design: Phase 5 - `whisper` + `ffmpeg-frames` adapters

## Files Found
- `src/adapters/whisper.ts` — does not exist yet (to create).
- `src/adapters/ffmpeg-frames.ts` — does not exist yet (to create).
- `test/adapter-whisper.test.ts`, `test/adapter-ffmpeg-frames.test.ts` — do not exist yet (to create).
- `src/adapters/yt-dlp.ts` (Phase 4) — read-mode fetch adapter; identity `injectContract`; local
  `resolveContained`/traversal-barricade helper; derives its output path from a marker the CLI
  itself prints (`--print after_move:filepath`), not from `opts` (parseResult gets none).
- `src/adapters/agy-image.ts` — `resolveOutputPath`/`assertContained` traversal barricade;
  `existsSync` read-only fs check inside `parseResult`.
- `src/adapters/_agy-shared.ts` — agy-specific argv/marker helpers; NOT reused here (whisper/ffmpeg
  are real CLI tools, not the `agy` harness — importing an agy-named helper into non-agy adapters
  would be a semantic mismatch, and it's outside this phase's file scope anyway).
- `src/lib/jobs.ts:242-243,358` — confirms `injectContract` runs BEFORE `buildArgs`, and
  `parseResult(stdout, stderr, exitCode)` is called with exactly those 3 args — no `opts`, no argv.
- `src/tools/dispatch.ts:74-92` — `frameCount` (positive int) and `sceneThreshold` ([0,1]) are
  already zod-validated at the tool boundary (Phase 3); adapters must still independently validate
  (opts are untrusted at the adapter boundary too — "internal team API is still external").

## Current State
Phases 1-4 are complete: preflight, `_agy-shared.ts`, the `DispatchOpts` opt surface (`outputDir`,
`cookies`, `subLangs`, `frameCount`, `sceneThreshold`, `addDir`, `sleepRequests`), and the `yt-dlp`
fetch adapter. No media-processing adapter exists yet. `mlx_whisper` and `ffmpeg` are not installed
in this environment (confirmed: this phase's tests must not spawn either binary).

## Gaps
The plan pins CLI flag shapes for both adapters but leaves two load-bearing design questions open
that the file hints don't answer directly:

1. **How does `parseResult` learn `opts.outputDir`, given it receives no `opts`?** yt-dlp/agy-image
   solve this because the harness itself prints the resolved absolute artifact path on stdout as a
   flag-driven marker (`--print after_move:filepath` / the injected `AGY_IMAGE_SAVED:` line).
   Neither `mlx_whisper` nor `ffmpeg` has an equivalent purpose-built "print the thing I just wrote"
   flag, so an analogous bridge had to be found or the phase would be untestable/undesignable as
   specified.
2. **How does a single ffmpeg invocation guarantee a non-empty frame set with zero scene cuts** and
   still cap+report a drop count, given no two-pass model is available.

Resolved both by reading the actual upstream source (see Design Decisions) rather than guessing.

## Code Standards
No `docs/code-standards.md` found in the repo. Followed the established adapter conventions instead
(local traversal-barricade copies per adapter, JSDoc header explaining every non-obvious departure,
`test_DW_N_M_...`-named tests, `const _check: Adapter = {...}` self-check at file end).

## Test Infrastructure
`bun:test` (`test`, `expect`, `afterEach`). Adapter tests drive `buildArgs`/`injectContract`/
`parseResult` directly with synthetic stdout/stderr/exitCode and real temp files/dirs
(`mkdtempSync(tmpdir())`, cleaned in `afterEach`) standing in for what the real binary would have
produced — established in `test/adapter-yt-dlp.test.ts` and `test/adapter-agy-image.test.ts`. No
real `mlx_whisper`/`ffmpeg` binary is spawned.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-5.1 | `whisper.buildArgs` pins the large-v3-turbo model and outputs SRT to `opts.outputDir`. | COVERED | `test_DW_5_1_pins_model_and_output_dir`, `test_DW_5_1_output_format_all_includes_srt` |
| DW-5.2 | `whisper.parseResult` → `failed` on exit 0 with no transcript file (dirty). | COVERED | `test_DW_5_2_exit_0_missing_transcript_files_is_failed`, `test_DW_5_2_exit_0_missing_args_marker_is_failed` |
| DW-5.3 | `ffmpeg-frames.buildArgs` injects `sceneThreshold` (default 0.35) and caps at `frameCount` (default 150). | COVERED | `test_DW_5_3_default_threshold_and_cap`, `test_DW_5_3_explicit_threshold_and_cap` |
| DW-5.4 | frames manifest `frames[]` maps every emitted frame to a timestamp and sets `dropped` when the cap fires (dirty: over-cap input). | COVERED | `test_DW_5_4_manifest_maps_every_frame_to_a_timestamp`, `test_DW_5_4_dropped_set_when_cap_fires_dirty` |
| DW-5.5 | 0-scene-cut input falls back to periodic frames (never empty). | COVERED | `test_DW_5_5_filter_structurally_guarantees_frame_zero_selected`, `test_DW_5_5_zero_scene_cut_single_fallback_frame_still_done` |
| DW-5.6 | a `../`-escaping `outputDir` throws a `TypeError` before spawn (both adapters). | COVERED | `test_DW_5_6_dotdot_outputDir_throws_whisper`, `test_DW_5_6_dotdot_outputDir_throws_ffmpeg_frames` |

**All items COVERED:** YES

## Design Decisions

### 1. `whisper.ts` — bridging `outputDir` from `buildArgs` to `parseResult` without shared state

Verified against the actual `mlx-whisper` CLI source
(`ml-explore/mlx-examples/whisper/mlx_whisper/cli.py`, fetched this session):
- `main()` does `args = vars(parser.parse_args()); if args["verbose"] is True: print(f"Args: {args}")`
  **before** popping anything out of `args` — so the full parsed-argument dict, including
  `output_dir` and `output_name` verbatim, is printed to stdout as one line, whenever `--verbose`
  is `True`. `--verbose` **defaults to `True`**, but `buildArgs` passes it explicitly (`--verbose True`)
  so the marker is never silently lost to a future default change.
- Neither `cli.py` nor `writers.py`'s `ResultWriter.__call__` print the resolved output file path
  anywhere else. There is no `--print`-style flag. Verified by reading both files directly, not
  guessed.
- `--output-name <fixed>` fixes the output basename independent of the input audio filename (this
  flag was added specifically for mlx-whisper's CLI, confirmed in `cli.py`). `buildArgs` passes
  `--output-name transcript`, so `parseResult` doesn't need to parse the input audio path back out
  of anything — it only needs `output_dir`, and the expected filenames are the same two literal
  strings (`transcript.srt`, `transcript.txt`) on both ends.
- `--output-format all` (not `-f srt` as the Scope-IN line literally says) is required to produce
  **both** `.srt` and `.txt` in one invocation — the plan's own `Produces` line requires
  `artifacts=[transcriptSrt, transcriptTxt]`, which `-f srt` alone cannot satisfy. DW-5.1 only
  requires SRT to be *pinned/present*, which `-f all` still does. Documented as a deliberate
  resolution of that Scope-IN vs. Produces tension, not silent scope drift.
- `parseResult` regex-extracts `output_dir` from the printed `Args: {...}` dict-repr line
  (`/output_dir':\s*'([^']*)'/`), then verifies `transcript.srt`/`transcript.txt` both exist via
  `existsSync` (read-only fs — precedented by `agy-image.ts`). Missing marker or missing file(s) →
  `failed`, matching the exit-0-silent-misparse backstop pattern used everywhere else in this repo.
- Trade-off, stated plainly: this is less clean than yt-dlp's purpose-built `--print` flag — it
  leans on an argparse debug-print line that is not a documented stable CLI contract of
  mlx-whisper. It is the *only* channel mlx-whisper's CLI offers for this, verified by reading the
  source rather than assumed. Forcing `--verbose True` explicitly (rather than relying on the
  default) is the mitigation.

### 2. `ffmpeg-frames.ts` — same bridging problem, solved differently

ffmpeg has no debug-args-dict equivalent, but it unconditionally prints (at default loglevel, not
suppressed by `-hide_banner`) a line of the form `Output #0, <format>, to '<path>':` describing
exactly what it was told to write to — a well-established, stable part of ffmpeg's console output
(spot-checked via web search this session, e.g. `Output #0, wav, to 'D.wav':`). `parseResult`
extracts the output path pattern from that line and takes its `dirname()` as the artifact
directory — it never needs `opts`.

Frame timestamps: `showinfo` prints one `pts_time:<seconds>` line per frame reaching it (verified
fact per the plan). `-frame_pts 1` names each kept output file after its own (integer) pts, which
is monotonic with time but not literally "seconds" — so `parseResult` does NOT parse the filename
for the timestamp. Instead: sort the actual output files ascending by their embedded numeric pts
(chronological order), sort the `pts_time:` values from stderr in their (already chronological)
appearance order, and zip the first `min(files.length, ptsTimes.length)` of each — `-frames:v N`
keeps the *earliest* N selected frames, which is exactly the first N `pts_time:` entries in
appearance order. `dropped = selectedCount - files.length` when `selectedCount > files.length`.

Non-empty guarantee (DW-5.5), single invocation, no two-pass: the `-vf` chain is
`mpdecimate,select='gt(scene\,TH)+not(mod(n\,150))',showinfo` — the periodic OR-term
`not(mod(n,150))` is true whenever `n` is a multiple of 150, which **always includes `n=0`**
(`0 mod anything == 0`), so at least one frame (the very first frame reaching `select`, after
`mpdecimate`) is always selected regardless of whether any real scene cut ever fires. This is the
plan's own suggested `select='gt(scene,TH)+eq(n,0)'` pattern, generalized to also resample every
150 frames instead of only frame 0, so a long cut-free clip yields more than one fallback frame
("periodic," not just "one frame"). The period is expressed in **frame count**, not seconds,
because introducing an `fps=` filter ahead of `select` to normalize to a known frame rate would
change what `scene` is comparing frame-to-frame against — altering the *verified* scene-detection
behavior the plan already confirmed this session. Frame-count periodicity is a documented,
accepted imprecision (period varies with source fps) in exchange for not touching the verified
base filter chain. `-vsync vfr` is required so ffmpeg doesn't pad/drop `select`'s variable-rate
output back to a constant rate (a well-known gotcha with `select`-based frame extraction); it may
print a deprecation notice on newer ffmpeg builds but still functions, and the notice doesn't
collide with the `Output #0` / `pts_time:` parsing.

None of this is exercised against a real `ffmpeg`/`mlx_whisper` binary in this environment (neither
is installed) — both designs are grounded in verified upstream source/docs rather than executed,
consistent with how Phase 4's `yt-dlp` adapter was also built and tested without the real binary.
This is disclosed, not glossed over: it is the stated uncertainty in the plan's own "Uncertainty"
line for this phase ("exact ffmpeg PTS-naming flag combo... resolve at build").

### Manifest write is a scoped exception to "parseResult only does read-only fs"

The plan's Scope-IN line explicitly assigns manifest construction to `parseResult`
("`parseResult` builds the manifest and classifies"), and the manifest isn't a file ffmpeg itself
can produce. `parseResult` therefore does one `writeFileSync` (`manifest.json`, into the external
`opts.outputDir`-derived directory — never the source tree, so the write-write guard is unaffected,
same reasoning as the child processes' own external-dir writes in yt-dlp/agy-image). A failed write
is treated as a failed result (a required `Produces` artifact must not be silently dropped).

### Traversal barricade

Both adapters get their own local copy of `resolveContained`/`assertContained`
(yt-dlp's/agy-image's semantics: relative path resolved against `opts.cwd` or `process.cwd()` must
stay inside that base; absolute paths pass through as an explicit caller target) — duplicated per
file, matching the existing repo convention (yt-dlp.ts and agy-image.ts each already carry their
own copy; no shared `traversal.ts` module exists, and creating one is outside this phase's file
scope).

## Prerequisites
- [x] Phase 3 (`DispatchOpts` opt surface incl. `frameCount`/`sceneThreshold`) complete.
- [x] Phase 4 (`yt-dlp`) complete — establishes the external-dir `mode:"read"` + traversal-barricade
      pattern this phase reuses.
- [x] No missing prerequisites.

## Recommendation
BUILD. Both open design questions (opts→parseResult bridging for whisper; single-invocation
non-empty guarantee for ffmpeg-frames) have concrete, source-verified answers — proceeding rather
than returning UPDATE_PLAN.
