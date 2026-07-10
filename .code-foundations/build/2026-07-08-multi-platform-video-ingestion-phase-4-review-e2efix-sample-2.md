# Review: Phase 4 - yt-dlp adapter (e2efix, security-sensitive sample 2)

Reviewed files: `src/adapters/yt-dlp.ts`, `test/adapter-yt-dlp.test.ts`. Independent review; build agent's design/discovery docs not read.

## Executed Results (Step 0)
- Focused suite: `bun test test/adapter-yt-dlp.test.ts` → **33 pass, 0 fail** (106 expect calls)
- Full suite: `bun test` → **275 pass, 0 fail** across 18 files
- Typecheck: `bunx tsc --noEmit` → **clean (exit 0)** (strict + noUncheckedIndexedAccess)
- Lint: no separate lint config in repo; typecheck is the gate per CLAUDE.md
- Coverage: `bun test test/adapter-yt-dlp.test.ts --coverage` → `src/adapters/yt-dlp.ts` **100.00% funcs / 100.00% lines**
- Reviewer probes (executed, scratchpad `probe.ts`): P1–P7 below

## Requirement Fulfillment

### DW-4.1
PREMISE:  "all flags before the positional URL; URL never absorbed as an option."
EVIDENCE: src/adapters/yt-dlp.ts:116-172 (`buildArgs` — all flags pushed first; `argv.push("--", url)` is structurally the final statement, URL is always the last element with `--` immediately preceding)
TRACE:    `buildArgs(URL, {outputDir, cookies, subLangs, sleepRequests})` → fixed flag block, optional flag groups, marker `--print` block, then `["--", url]` appended last → every `-`-prefixed element indexed strictly before the URL; `--` end-of-options makes the URL unparseable as an option even if dash-prefixed input slipped past validation.
VERDICT:  PASS — tests `test_DW_4_1_url_is_last_argv_element_all_flags_before_it` (asserts every dash element precedes the URL index) and `test_DW_4_1_end_of_options_separator_immediately_precedes_url`, both passing in Step 0.

### DW-4.2
PREMISE:  "`parseResult` → `failed` on exit 0 when the expected AUDIO artifact is absent."
EVIDENCE: src/adapters/yt-dlp.ts:192-209 (no marker line → failed; marker present but `!existsSync(wavPath)` → failed)
TRACE:    stdout `"[ExtractAudio] Destination: <ghost>\n<ghost>\n"`, exitCode 0, no file on disk → marker matches, `existsSync` false → `{status:"failed", summary:"…does not exist…"}`. No marker line at all → failed via the silent-misparse backstop.
VERDICT:  PASS — `test_DW_4_2_exit_0_with_absent_audio_file_is_failed` + "missing audio-path line entirely on exit 0 is failed", both passing.

### DW-4.3
PREMISE:  "`parseResult` → `done` with the audio path in `artifacts` on exit 0 + file present."
EVIDENCE: src/adapters/yt-dlp.ts:192-238 (`lastMarkerMatch(AUDIO_PATH_LINE_RE)` → `existsSync` → `{status:"done", artifacts:[wavPath, …]}`)
TRACE:    exit 0, stdout containing absolute `<dir>/dQw4w9WgXcQ.wav` line, real temp file on disk → last bare-absolute-`.wav` line captured → exists → `done`, `artifacts[0]` = absolute wav path.
VERDICT:  PASS — `test_DW_4_3_exit_0_and_existing_wav_is_done_with_artifact` (also asserts `isAbsolute(artifacts[0])`), plus subtitle-append and last-occurrence tests, all passing.

### DW-4.4
PREMISE:  "`../`-escaping `outputDir`/`cookies` → `TypeError` before spawn."
EVIDENCE: src/adapters/yt-dlp.ts:312-323 (`resolveContained`: relative input resolved against job cwd; `relative(base, resolved)` starting with `..` or absolute → `throw new TypeError`), applied to outputDir (line 271) and cookies (line 281). "Before spawn": src/lib/jobs.ts:242-243 — `buildArgs` runs inside `dispatch` during argv construction, so the throw propagates before any child process exists.
TRACE:    `buildArgs(URL, {cwd: d, outputDir: "../../etc"})` → `resolve(d, "../../etc")` escapes `d` → `relative()` starts with `..` → TypeError thrown from `buildArgs`, spawn never reached.
VERDICT:  PASS — `test_DW_4_4_dotdot_escaping_outputDir_throws_TypeError`, `test_DW_4_4_deep_dotdot_escape_throws_TypeError`, cookies variant, plus reviewer probe P3 (`"a/../../evil"` mixed-form escape → TypeError). Contained relative (`media/../audio`) and absolute paths correctly pass through (tests at lines 270, 278).

### DW-4.5
PREMISE:  "identity `injectContract`."
EVIDENCE: src/adapters/yt-dlp.ts:177-179 (`return prompt;`)
TRACE:    any string in → same string out, byte-identical (incl. hostile metacharacter string).
VERDICT:  PASS — `test_DW_4_5_injectContract_is_identity`, passing.

### DW-4.6
PREMISE:  "retains a res-capped video and reports its ABSOLUTE path in `artifacts` (resolved from the `post_process:SDD_VIDEO_PATH:` basename joined to the audio dir); the merged file is selected, never a `.fNNN.` fragment or the `.wav`."
EVIDENCE: buildArgs: src/adapters/yt-dlp.ts:122-129 (`-f bv*[height<=720]+ba/b[height<=720]/b`, `-k`), 160-167 (`--print post_process:SDD_VIDEO_PATH:%(filepath)s`). parseResult: lines 219-224 (`join(dirname(wavPath), basename(value))` gated by `existsSync`); VIDEO_PATH_LINE_RE (line 105) only accepts `webm|mp4|mkv|mov` extensions, so a `.wav` value can never match.
TRACE:    stdout `<abs wav>\nSDD_VIDEO_PATH:jNQXAC9IVRw.webm\n` with both files on disk → basename joined to `dirname(wav)` → absolute video path exists → `artifacts = [wav, video]`. ExtractAudio's `SDD_VIDEO_PATH:clip.wav` line rejected by extension regex (probe P4: artifacts = wav only). Absolute-form marker value re-rooted to the wav dir via `basename` (probe P6). Fragment exclusion: fragments are downloaded pre-merge files, not postprocessor `filepath` outputs, so they never ride the `post_process` print channel (adapter header documents verification against real yt-dlp 2026.07.04; not re-executable here — network/real-binary runs prohibited by dispatch; see Notes).
VERDICT:  PASS — `test_DW_4_6_buildArgs_caps_resolution_keeps_video_and_emits_labeled_video_print`, `test_DW_4_6_parseResult_resolves_basename_video_against_wav_dir_and_reports_both`, `.wav`-marker-rejection, missing-video-dropped-not-fatal, and last-marker-wins tests, all passing.

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have DW-ID-named automated tests that ran in Step 0 (DW-4.1 ×2, DW-4.2, DW-4.3 ×2, DW-4.4 ×2, DW-4.5, DW-4.6 ×2)
- [x] Coverage matches the stated 100% level: `src/adapters/yt-dlp.ts` at 100.00% funcs / 100.00% lines under the focused suite

## Edge cases + security (prompt-listed)
| Listed case | Status | Evidence |
|---|---|---|
| `--exec=` as URL blocked | HANDLED | Test line 311 (TypeError); scheme allowlist at yt-dlp.ts:252 |
| `-o/etc/passwd` as URL blocked | HANDLED | Reviewer probe P1 → TypeError ("prompt must be a single http(s) video URL") |
| `--` separator present | HANDLED | Test line 60 asserts `argv[len-2] === "--"`; structural in buildArgs:171 |
| `.wav` post_process line not taken as video | HANDLED | Test line 118 + probe P4; extension allowlist regex (line 105) |
| Video marker with missing resolved file dropped, not fatal | HANDLED | Test line 145: status stays `done`, artifacts = wav only |
| Traversal barricade on both outputDir and cookies | HANDLED | Tests 255/260/265 + probe P3; shared `resolveContained` (line 312) |
| Cookies contents never echoed | HANDLED | Adapter handles only the path string (lines 275-282); never opens/reads the file; no logging in the module |
| `mode:"read"` | HANDLED | yt-dlp.ts:86; asserted at test line 336 |
| No `console.*` | HANDLED | `grep -rn "console\." src/adapters/yt-dlp.ts` → no matches |

## Dead Code
None found. All imports used; `const _check: Adapter = {…}; void _check;` (lines 332-333) is the repo's intentional compile-time shape-conformance idiom, not dead code. No debug statements, no unreachable code, no commented-out blocks.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | Module-level `g`-flag regexes are the one shared-state hazard; `lastMarkerMatch` (`_agy-shared.ts`) and the subtitle scan both use `matchAll`, which iterates a species clone and never mutates the original's `lastIndex`. Probe P2: two consecutive `parseResult` calls on identical stdout both return `done` with 2 artifacts — no state bleed. |
| Error Handling | PASS | Non-zero exit → failed with truncated stderr tail (tests 230/238/246); exit 0 without marker → failed; marker without file → failed; malformed opts → TypeError, never silent coercion (test 324). No empty catches (no try/catch at all — a throwing `parseResult` is contained by jobs.ts:358-361). |
| Resources | N/A | Pure functions; only `existsSync` reads. No handles, connections, or processes opened by the adapter itself. |
| Boundaries | PASS | Empty prompt, empty cookies, empty outputDir, non-string outputDir, `-`-leading/whitespace subLangs, non-finite/≤0/string sleepRequests all rejected (tests 284, 315-332); 5000-char stderr truncated to a bounded tail (test 246); `%` in outputDir escaped to `%%` (test 288); CRLF tolerated by all three marker regexes (`\r?$`). |
| Security | PASS | Two independent URL layers: http(s) scheme allowlist + whitespace/control-char rejection (probes P1/P5, tests 311-320) AND structural `--` separator; shell metacharacters stay one literal argv element (test 304; `shell:false` argv-array spawn in JobStore). Traversal barricade on both path opts. `%`-template escape. Cookies path-only handling. |

## Loaded-Skill Criteria (code-foundations:cc-defensive-programming)
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | No executable code in assertions | N/A | No assertions in the module |
| cc-defensive-programming | No empty catch blocks | PASS | Zero catch blocks; error containment delegated to JobStore per the port design |
| cc-defensive-programming | External input validated at entry | PASS | Every untrusted input validated at the `buildArgs` barricade: URL (scheme + control chars), outputDir (required + containment), cookies (containment), subLangs (charset), sleepRequests (finite positive). Child stdout also treated as external: marker parse + independent `existsSync` verification (defense in depth, correctness-leaning — appropriate for a pipeline feeding downstream phases). |
| cc-defensive-programming | Assertions for bugs only / anticipated errors get handling | PASS | Anticipated runtime failures (bad input → TypeError before spawn; bad child output → `failed` result), never assertions |
| cc-defensive-programming | Barricade design + consistent error strategy | PASS | Follows the repo's established adapter pattern (agy-image's `assertContained` semantics, TypeError-at-entry, `failed` AdapterResult); security-critical paths (cookies, URL) validated even though JobStore's argv-array spawn is itself a barricade — defense in depth per skill rule |

## Notes (non-blocking)
1. **Fragment-last artificial ordering (probe P7):** if stdout contained `SDD_VIDEO_PATH:a.f251.webm` *after* the merged-video line, last-wins would select the fragment. Not demonstrable as a real defect: the marker channel is yt-dlp's own `--print post_process` output (not attacker text), and the header documents — verified against real yt-dlp 2026.07.04 by the E2E — that fragments never appear as a `post_process` filepath. Real-binary re-verification was prohibited for this review (no network). Even in the artificial case the result is a degraded artifact, gated by `existsSync`, never a traversal (basename+join).
2. `SUBTITLE_LINE_RE` is not line-start anchored (no `[info] ` prefix requirement); a hypothetical stdout line ending in `…subtitles to: <existing .vtt path>` from another source would be collected. Subtitle paths derive from the `-o` template, so no attacker-controlled path reaches this in practice; existence-filtered regardless.
3. `AUDIO_PATH_LINE_RE` assumes POSIX absolute paths (leading `/`) and lowercase `.wav` — both documented and consistent with this darwin-targeted project and `--audio-format wav`.

## Issues
None.

**Verdict: PASS**
