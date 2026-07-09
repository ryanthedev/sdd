# Discovery + Design: Phase 4 - `yt-dlp` fetch adapter

> **AMENDMENT (post-build, Phase 7 cross-adapter contract fix).** Phase 7 caught that the visual half of the pipeline (Phase 5 `ffmpeg-frames`) needs a LOCAL VIDEO FILE, which an audio-only fetch never produced. Amended: `buildArgs` now fetches a **720p-capped merged video** (`-f "bv*[height<=720]+ba/b[height<=720]/b"`) and keeps it (`-k`/--keep-video) alongside the extracted wav; `parseResult` reports **both** — `artifacts = [audioWavPath, videoPath, ...subtitlePaths]`. New **DW-4.6** added and covered. Marker channel for the second path: a LABELLED `--print after_video:SDD_VIDEO_PATH:%(filepath)s` line (the audio wav stays the bare `after_move:filepath` line), parsed by label, last-occurrence-wins. The exact WHEN-stage→filepath mapping is pinned at the later manual E2E phase (consistent with Phase 5's ffmpeg-flag uncertainty note); the label-based parse contract is what the unit tests own. Video is ADDITIVE — the silent-success guard stays keyed on the AUDIO file alone; a video marker whose file is missing is dropped, not fatal. All 27 original tests stayed green; the one assertion pinning the now-removed `-f bestaudio` audio-only value was updated to the capped-video contract (behavior changed by the amendment, not a weakened test). Details below in the DW table and Design Decisions.

## Files Found
- `src/adapters/agy-image.ts` — `resolveOutputPath`/`assertContained` traversal barricade, external-artifact `mode:"read"` precedent, existence-check classification, `probeable = false` precedent.
- `src/adapters/_agy-shared.ts` — `lastMarkerMatch` (last-occurrence marker scan) is reusable here; `buildAgyArgv` is agy-specific and NOT reused.
- `src/adapters/mistral.ts` — minimal adapter shape + `binary` override precedent (not needed: adapter name `yt-dlp` == CLI binary name).
- `src/adapters/types.ts` — the `Adapter` port (`name`, `binary?`, `probeable?`, `mode`, `buildArgs`, `injectContract`, `parseResult`).
- `src/lib/jobs.ts:242-243, 358` — **confirmed call sequence**: `injectContract(prompt)` → `buildArgs(contracted, opts)` → spawn → `parseResult(stdout, stderr, exitCode)`. `parseResult` receives NO opts.
- `src/tools/dispatch.ts:50-96` — Phase 3 opts schema: `outputDir`, `cookies`, `subLangs`, `frameCount`, `sceneThreshold`, `addDir` present and forwarded.
- `test/adapter-agy-image.test.ts` — test patterns: temp dirs via `mkdtempSync`, DW-named tests, real-directory discovery lookup, traversal-rejection dirty tests.
- `src/adapters/yt-dlp.ts`, `test/adapter-yt-dlp.test.ts` — do NOT exist yet (green field, as planned).

## Current State
All Phase 4 prerequisites are in place: the Adapter port supports `probeable`/`binary`, discovery is scan-based (dropping the file in registers it), and Phase 3 forwards `outputDir`/`cookies`/`subLangs` onto `opts`.

## Gaps
1. **`sleepRequests` seam gap (plan inconsistency, non-blocking):** Phase 4's scope says "optional `--sleep-requests <n>`" and the goal mentions "cookies/sleep/sub-lang opts", but Phase 3's produced contract (and `dispatch.ts`'s closed zod shape) has **no sleep key** — an MCP client cannot pass one today (zod strips unknown keys). Resolution: the adapter reads and validates `opts.sleepRequests` (the open `DispatchOpts` index signature makes adapter-specific keys legitimate), so the adapter side is complete; exposing the key in `dispatch.ts` is a one-line Phase-3-style follow-up **outside this phase's file scope** (`src/adapters/yt-dlp.ts`, `test/adapter-yt-dlp.test.ts` only). Flagged to the orchestrator — no DW item depends on it.
2. No other gaps; plan matches reality.

## Code Standards
`docs/code-standards.md` found and applied: argv arrays only (no shell strings), no `console.log` in `src/`, throw `TypeError` on malformed opts (never coerce/ignore), `.ts` import extensions, plain top-level adapter exports + `_check: Adapter` conformance proof, last-occurrence marker matching, one `test/adapter-yt-dlp.test.ts` per adapter with DW-named tests + real-directory discovery lookup, "job" not "task".

## Test Infrastructure
`bun test`; adapter tests drive `buildArgs`/`injectContract`/`parseResult` directly with synthetic stdout/stderr/exitCode triples and real temp files (`mkdtempSync` + `afterEach` cleanup) standing in for harness output. No real `yt-dlp` binary is spawned (it is not installed on this machine — per plan, tests are pure-function driven).

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-4.1 | `buildArgs` places all flags before the positional URL and never after it | COVERED | `test_DW_4_1_url_is_last_argv_element_all_flags_before_it`, `test_DW_4_1_end_of_options_separator_immediately_precedes_url` |
| DW-4.2 | `parseResult` returns `failed` on exit 0 when the expected audio artifact is absent | COVERED | `test_DW_4_2_exit_0_with_absent_audio_file_is_failed` (synthetic nonexistent path drives the `existsSync` check) |
| DW-4.3 | `parseResult` returns `done` with the audio path in `artifacts` on exit 0 + file present | COVERED | `test_DW_4_3_exit_0_and_existing_wav_is_done_with_artifact`, `test_DW_4_3_existing_subtitles_are_appended_to_artifacts` |
| DW-4.4 | a `../`-escaping `outputDir` throws a `TypeError` before spawn | COVERED | `test_DW_4_4_dotdot_escaping_outputDir_throws_TypeError`, `test_DW_4_4_deep_dotdot_escape_throws_TypeError`, plus the analogous cookies-path test |
| DW-4.5 | identity `injectContract` returns the URL unchanged | COVERED | `test_DW_4_5_injectContract_is_identity` |
| DW-4.6 | `buildArgs` retains the res-capped video alongside the wav; `parseResult` reports the video path in `artifacts` on exit 0 + files present | COVERED | `test_DW_4_6_buildArgs_caps_resolution_keeps_video_and_emits_labeled_video_print`, `test_DW_4_6_parseResult_reports_both_audio_and_video_in_artifacts` (+ ordering, missing-video-dropped, last-video-wins edge tests) |

**All items COVERED:** YES (6/6 — original 5 DW-IDs + amended DW-4.6)

## Design Decisions

### How `parseResult` knows the expected audio path (the phase's key question)
`parseResult(stdout, stderr, exitCode)` receives no opts (confirmed at `jobs.ts:358`), and `injectContract` must be identity (a prompt-borne marker would corrupt the URL argv). So the marker cannot ride in the prompt the way agy-image's does. **Design: yt-dlp itself emits the marker via a deterministic CLI flag.** `buildArgs` appends `--print after_move:filepath --no-simulate --no-quiet`:
- `--print after_move:filepath` makes yt-dlp print the **final post-postprocessing absolute filepath** of the output on its own stdout line (the `.wav`, since `-x --audio-format wav` converts before `after_move` fires).
- `--no-simulate` re-enables the actual download (`--print` alone implies simulate).
- `--no-quiet` restores normal info output (`--print` implies quiet), so best-effort `[info] Writing video subtitles to: <path>` lines remain visible for subtitle artifact collection.

`buildArgs` resolves `outputDir` to an **absolute** path before it reaches the `-o` template, so the printed filepath line is an absolute path ending in `.wav`. `parseResult` scans stdout for the LAST line matching `^(\/.*\.wav)$` (via the shared `lastMarkerMatch` — last-occurrence-wins, consistent with the repo invariant), then independently verifies `existsSync` — the silent-success guard. A missing path line → `failed` even on exit 0 (contract-marker backstop). Leading-`/` anchoring keeps `[ExtractAudio] Destination: …` narration lines from being captured as the path (POSIX assumption, consistent with this darwin-targeted project).

Subtitles are best-effort: collect every `Writing video (automatic )subtitles to: <path>.vtt` match, keep only those that exist on disk, dedupe — never a failure condition (Instagram/X have no subs).

### Argument-injection barricade on the URL (beyond the plan's shell-metacharacter case)
The URL is the untrusted prompt. `shell:false` + argv array already makes shell metacharacters inert, but yt-dlp itself parses options — a "URL" of `--exec=<cmd>` would be parsed as yt-dlp's `--exec` option (arbitrary command execution). Two independent layers:
1. **Validation at entry:** the URL must start with `http://`/`https://` and contain no whitespace/control chars → `TypeError` otherwise (kills any leading-dash option injection).
2. **Structural:** a literal `--` end-of-options separator is always the argv element immediately before the URL, so even a pathological string can never be option-parsed.

### Other decisions
- **`mode: "read"`** — media lands in a caller-named external dir, not the working tree (agy-image precedent; dodges the write-write guard).
- **`probeable = false`** — check_adapter's generic probe would hand a non-URL prompt with no `outputDir`; a probe would also perform a real network download. Binary-presence check only.
- **No `binary` export** — adapter name `yt-dlp` equals the CLI binary name; the port defaults `binary` to `name`.
- **Traversal barricade** on `outputDir` AND `cookies`: relative paths resolve against `opts.cwd` (else `process.cwd()`) and must stay contained (`relative()` not starting with `..`) → `TypeError` before argv; absolute paths are explicit caller targets and pass. Same `assertContained` semantics as agy-image, reimplemented locally (agy-image's is module-private and `.png`-specific; extracting a shared helper would touch a file outside this phase's file scope).
- **Cookies are credential-adjacent:** the adapter only ever handles the *path* (validated, passed as `--cookies <path>` argv); it never reads the file, so contents can never reach a job log.
- **`%` escaping in the `-o` template:** `%` is a template metacharacter to yt-dlp; a literal `%` in `outputDir` is escaped to `%%` so a legal-on-disk directory name cannot corrupt the output template. Template: `<outputDir>/%(id)s.%(ext)s`.
- **`--no-playlist`** — enforces the scope-OUT of profile/bulk downloads structurally (one URL → one video).
- **`opts.sleepRequests`** — optional finite number > 0 → `--sleep-requests <n>`; `TypeError` on malformed (see Gaps for the dispatch-schema follow-up).
- **`parseResult` check order:** exit≠0 first (failed + stderr tail, the most informative message for login-required/rate-limited/extractor-broken), then missing-marker backstop, then existence check, then `done`.

## Prerequisites
- [x] Phase 3 opts (`outputDir`, `cookies`, `subLangs`) forwarded by dispatch — verified in `dispatch.ts:122-124`
- [x] `Adapter` port supports `probeable` — verified in `src/adapters/types.ts:36`
- [x] `lastMarkerMatch` available in `_agy-shared.ts` (underscore-prefixed, discovery-safe to import)
- [x] Discovery auto-registers new adapter files — no registry edit needed

## Recommendation
BUILD — create `src/adapters/yt-dlp.ts` + `test/adapter-yt-dlp.test.ts` per the design above; flag the `sleepRequests` dispatch-schema gap to the orchestrator.
