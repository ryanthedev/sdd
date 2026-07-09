# Review: Phase 4 - yt-dlp adapter (e2efix, sample 3)

## Executed Results (Step 0)
- Test suite (focused): `bun test test/adapter-yt-dlp.test.ts` → 33 pass / 0 fail (106 expects)
- Test suite (whole): `bun test` → 275 pass / 0 fail across 18 files
- Typecheck: `bunx tsc --noEmit` → clean (strict + noUncheckedIndexedAccess)
- Lint: no lint script in package.json (none configured for this repo)
- Coverage: `bun test --coverage test/adapter-yt-dlp.test.ts` → `src/adapters/yt-dlp.ts` 100.00% funcs / 100.00% lines

## Requirement Fulfillment

### DW-4.1
PREMISE:  "all flags before the positional URL; URL never absorbed as an option."
EVIDENCE: src/adapters/yt-dlp.ts:116-172 (flags built first; `argv.push("--", url)` last)
TRACE:    `buildArgs(URL, {outputDir, cookies, subLangs, sleepRequests})` → flags appended in order, then `--` then URL → URL is `argv[argv.length-1]`, `--` at `length-2`; every dash-prefixed element indexes strictly before the URL. `--` end-of-options plus the http(s)-scheme gate in `validateUrl` (line 252) means the positional can never be option-parsed.
VERDICT:  PASS — tests `test_DW_4_1_url_is_last_argv_element_all_flags_before_it`, `test_DW_4_1_end_of_options_separator_immediately_precedes_url` (ran, pass)

### DW-4.2
PREMISE:  "`parseResult` → `failed` on exit 0 when the expected AUDIO artifact is absent."
EVIDENCE: src/adapters/yt-dlp.ts:192-209
TRACE:    exit 0 + stdout containing `/tmp/.../never-written.wav` line → `AUDIO_PATH_LINE_RE` matches → `existsSync(wavPath)` false → `{status:"failed", summary:"…does not exist…(silent-success guard)"}`. Exit 0 with NO path line at all → `lastMarkerMatch` undefined → failed (silent-misparse backstop, line 193).
VERDICT:  PASS — tests `test_DW_4_2_exit_0_with_absent_audio_file_is_failed`, `missing audio-path line entirely on exit 0 is failed` (ran, pass)

### DW-4.3
PREMISE:  "`parseResult` → `done` with the audio path in `artifacts` on exit 0 + file present."
EVIDENCE: src/adapters/yt-dlp.ts:192-238
TRACE:    exit 0 + stdout with absolute wav line + real temp file on disk → match → `existsSync` true → `{status:"done", artifacts:[wavPath,…]}` with the wav first and absolute (regex requires leading `/`).
VERDICT:  PASS — tests `test_DW_4_3_exit_0_and_existing_wav_is_done_with_artifact`, `test_DW_4_3_existing_subtitles_are_appended_to_artifacts` (ran, pass)

### DW-4.4
PREMISE:  "`../`-escaping `outputDir`/`cookies` → `TypeError` before spawn."
EVIDENCE: src/adapters/yt-dlp.ts:312-323 (`resolveContained`); call sites 271, 281
TRACE:    `outputDir:"../../etc"` with `cwd=/tmp/x` → `resolve(base, raw)` escapes → `relative(base, resolved)` starts with `..` → TypeError thrown inside `buildArgs`. Spawn ordering verified in src/lib/jobs.ts:241-243: `#buildArgv` calls `buildArgs` before any spawn, so the throw aborts dispatch pre-spawn.
VERDICT:  PASS — tests `test_DW_4_4_dotdot_escaping_outputDir_throws_TypeError`, `test_DW_4_4_deep_dotdot_escape_throws_TypeError`, `a dotdot-escaping cookies path throws a TypeError too` (ran, pass); containment counter-tests (inside-cwd relative resolves absolute; absolute passes through) also pass

### DW-4.5
PREMISE:  "identity `injectContract`."
EVIDENCE: src/adapters/yt-dlp.ts:177-179
TRACE:    `injectContract(p)` returns `p` unchanged for both a normal URL and a metacharacter-laden string; the contract marker rides in `buildArgs`' `--print` flags instead (lines 160-167).
VERDICT:  PASS — test `test_DW_4_5_injectContract_is_identity` (ran, pass)

### DW-4.6
PREMISE:  "retains a res-capped video and reports its ABSOLUTE path in `artifacts` (resolved from the `post_process:SDD_VIDEO_PATH:` basename joined to the audio dir); the merged file is selected, never a `.fNNN.` fragment or the `.wav`."
EVIDENCE: src/adapters/yt-dlp.ts:122-129 (`-f bv*[height<=720]+ba/…`, `-k`), 160-167 (labeled `--print post_process:SDD_VIDEO_PATH:%(filepath)s`), 105 + 219-224 (video-extension-only regex, last occurrence, `join(dirname(wav), basename(value))`, existence check)
TRACE:    stdout `"<abs wav>\nSDD_VIDEO_PATH:jNQXAC9IVRw.webm\n"` with both files on disk → wav matched → video regex matches basename → resolved to `dirname(wav)/jNQXAC9IVRw.webm` (absolute, since wav is absolute) → exists → `artifacts=[wav, video]`. A `SDD_VIDEO_PATH:clip.wav` (ExtractAudio) line is rejected by the extension alternation `(?:webm|mp4|mkv|mov)`; the LAST video-extension line wins (`lastMarkerMatch`), so the merged output (Merger fires before ExtractAudio; fragments never appear as a `post_process` filepath) is selected, never a fragment or the wav.
VERDICT:  PASS — tests `test_DW_4_6_buildArgs_caps_resolution_keeps_video_and_emits_labeled_video_print`, `test_DW_4_6_parseResult_resolves_basename_video_against_wav_dir_and_reports_both`, `post_process ExtractAudio (.wav) line is not mistaken for the video marker`, `the LAST labeled video line wins`, `a labeled video whose resolved file is missing is dropped, not fatal` (ran, pass)

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have corresponding tests (ran in Step 0), DW-IDs in test names (`test_DW_4_1` … `test_DW_4_6`)
- [x] Coverage matches the stated 100% level: 100% funcs / 100% lines on src/adapters/yt-dlp.ts
- [x] Prompt-listed edge cases each have an executed test: option injection (`--exec=…`, `file://`, whitespace URL → TypeError), `--` separator placement, ExtractAudio `.wav` marker not taken as video, missing resolved video dropped not fatal, traversal barricade on both paths, `%` template escaping, non-zero exit with stderr tail

## Dead Code
None found. All imports used; `const _check: Adapter = …; void _check` (lines 332-333) is a compile-time shape assertion, not dead code.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | Pure functions, no shared mutable state. Module-level `g`-flag regexes probed for `lastIndex` leakage: `lastMarkerMatch` uses `matchAll` (never mutates the source regex's lastIndex) and `SUBTITLE_LINE_RE` likewise; 33 repeated `parseResult` calls in one process all match correctly — no cross-call state. |
| Error Handling | PASS | Non-zero exit → failed with truncated stderr tail (tested); missing marker / missing file on exit 0 → failed (tested); all malformed opts throw TypeError rather than silently coercing (tested); a throwing `parseResult` is contained by JobStore (src/lib/jobs.ts:357-361). |
| Resources | N/A | No handles, processes, or connections opened by the adapter — `existsSync` only; spawning is JobStore's. |
| Boundaries | PASS | Empty stdout, empty stderr, 5000-char stderr, duplicate subtitle lines, multiple wav/video lines, ghost paths all traced/tested. Probed `SDD_VIDEO_PATH:.webm` (bare extension): `.+\.` requires ≥1 stem char → no match → correctly no video. `basename()` strips a traversal-bearing marker value (`../../x.mp4` → `x.mp4`), so a hostile marker cannot resolve outside the audio dir. |
| Security | PASS | URL: http(s) allowlist + whitespace/control-char reject + literal `--` separator (both layers tested with `--exec=touch /tmp/pwned`, `file:///etc/passwd`, embedded `--exec`); `shell:false` argv-array spawn upstream; traversal barricade on outputDir AND cookies (tested); cookies file never read — only the validated path enters argv, contents can never reach a log; `%`→`%%` template escaping (tested); no `console.*` in the file (grep: 0 matches); `mode:"read"`, `probeable:false` (tested). |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry (barricade) | PASS | `DispatchOpts` is an open `[k: string]: unknown` map (src/types.ts:41-46), so every adapter-specific opt is untrusted; all five (prompt/URL, outputDir, cookies, subLangs, sleepRequests) get runtime `typeof`+shape validation at `buildArgs` entry, TypeError on violation (lines 247-302, all exercised by executed tests). |
| cc-defensive-programming | Assertions for bugs only / anticipated errors get handling | PASS | No assertions used; anticipated runtime failures (bad input, harness misbehavior) use error handling (TypeError / `failed` result) — correct side of the assertion-vs-handling table for external input. |
| cc-defensive-programming | No executable code in assertions | N/A | No assertions in the file. |
| cc-defensive-programming | No empty catch blocks | PASS | No catch blocks in the adapter; the containment catch lives in JobStore and populates a failed result, not empty. |
| cc-defensive-programming | Security-critical defense-in-depth (no single-layer trust) | PASS | Option injection blocked by two independent layers (scheme allowlist AND `--` separator); silent success blocked by two (marker parse AND on-disk existence check); credential path traversal-barricaded and contents never read. |

## Notes (non-blocking)
- No lint script exists in package.json; "lint" in Step 0 is therefore vacuous for this repo (tests + strict tsc are the configured gates).
- The `.fNNN.` fragment exclusion ultimately rests on yt-dlp's documented/observed `post_process` semantics (fragments are never the info-dict `filepath`; the header cites verification against real yt-dlp 2026.07.04). The extension filter + last-occurrence selection are correct against every synthetic stdout shape tested, but a future yt-dlp behavior change here would only be caught by the E2E, not these unit tests. Could not demonstrate a defect (real-binary runs forbidden in this review).
- `SUBTITLE_LINE_RE` is not line-start-anchored, so any stdout line ending `…subtitles to: <existing>.vtt` adds that path to artifacts. Existence-filtered, `.vtt`-only, best-effort channel — could not construct a harmful trace.
- `VIDEO_PATH_LINE_RE`'s `i` flag also matches a lowercased `sdd_video_path:` prefix; harmless (yt-dlp echoes the label verbatim) and it usefully accepts uppercase extensions.

## Issues
None.

**Verdict: PASS**
