# Review: Phase 4 - yt-dlp adapter (amended: video retention + dual path markers) — sample 3

Independent post-gate review. Files: `src/adapters/yt-dlp.ts`, `test/adapter-yt-dlp.test.ts`.

## Executed Results (Step 0)

- Test suite (focused): `bun test test/adapter-yt-dlp.test.ts` → **32 pass, 0 fail** (104 expect calls)
- Test suite (whole): `bun test` → **274 pass, 0 fail** across 18 files
- Typecheck: `bunx tsc --noEmit` → **clean** (strict + noUncheckedIndexedAccess on)
- Lint: no lint script defined in `package.json` (only `typecheck`/`test`) — typecheck stands in; clean
- Coverage: `bun test test/adapter-yt-dlp.test.ts --coverage` → **`src/adapters/yt-dlp.ts` 100.00% funcs / 100.00% lines**
- Reviewer probe script (adversarial cases beyond the suite): 7/7 expected outcomes — detailed under Correctness Dimensions

## Requirement Fulfillment

### DW-4.1
PREMISE:  `buildArgs` places all flags before the positional URL and never after it.
EVIDENCE: src/adapters/yt-dlp.ts:98-156 — all flags pushed into `argv` first; line 155 `argv.push("--", url)` is the only append after the flag block, so the URL is structurally the last element with `--` immediately before it. Marker flags (`--print` ×2, `--no-simulate`, `--no-quiet`, lines 144-151) are pushed before the separator.
TRACE:    `buildArgs(URL, {outputDir, cookies, subLangs, sleepRequests})` → `["yt-dlp", "-f", …, "-o", <tpl>, "--cookies", <p>, …, "--print", "after_move:filepath", "--print", "after_video:SDD_VIDEO_PATH:%(filepath)s", "--no-simulate", "--no-quiet", "--", URL]` → every dash-prefixed element has index < indexOf(URL); URL is argv[len-1].
VERDICT:  **PASS** — `test_DW_4_1_url_is_last_argv_element_all_flags_before_it` (iterates every dash-prefixed element, asserts index < urlIdx) and `test_DW_4_1_end_of_options_separator_immediately_precedes_url` both pass.

### DW-4.2
PREMISE:  `parseResult` returns `failed` on exit 0 when the expected audio artifact is absent.
EVIDENCE: src/adapters/yt-dlp.ts:176-193 — no wav-path line → `failed` (line 177-184); wav-path line present but `!existsSync(wavPath)` → `failed` (line 186-193).
TRACE:    stdout `"[ExtractAudio] Destination: <ghost>\n<ghost>\n"`, exit 0, file never written → regex matches `<ghost>` → `existsSync` false → `{status:"failed", summary contains "does not exist", artifacts:[]}`.
VERDICT:  **PASS** — `test_DW_4_2_exit_0_with_absent_audio_file_is_failed` plus the no-line backstop test ("missing audio-path line entirely on exit 0 is failed") both pass.

### DW-4.3
PREMISE:  `parseResult` returns `done` with the audio path in `artifacts` on exit 0 + file present.
EVIDENCE: src/adapters/yt-dlp.ts:176-213 — last `.wav` line extracted (line 176), existence verified (186), `artifacts` built audio-first (205), `status:"done"` (209).
TRACE:    exit 0 + stdout containing `<dir>/dQw4w9WgXcQ.wav` (real temp file on disk) → match → exists → `{status:"done", artifacts:[<abs wav>]}`.
VERDICT:  **PASS** — `test_DW_4_3_exit_0_and_existing_wav_is_done_with_artifact` (also asserts the artifact is absolute) passes; subtitle-append and last-occurrence variants pass too.

### DW-4.4
PREMISE:  A `../`-escaping `outputDir` (and `cookies`) throws a `TypeError` before spawn.
EVIDENCE: src/adapters/yt-dlp.ts:287-298 (`resolveContained`) — `relative(base, resolved)` starting with `..` (or `===".."`, or absolute) → `throw new TypeError`. Called from `resolveOutputDir` (246) and `resolveOptionalCookies` (256), both inside `buildArgs`. Pre-spawn confirmed independently in JobStore: `adapter.buildArgs` is invoked at src/lib/jobs.ts:243, `spawn` at src/lib/jobs.ts:282 in `#spawnAndTrack` — the throw aborts dispatch before any child exists.
TRACE:    `buildArgs(URL, {cwd:<tmp>, outputDir:"../../etc"})` → `resolve(tmp, "../../etc")` → `relative(tmp, …)` = `"../../etc"` → starts with `"../"` → TypeError thrown, argv never constructed.
VERDICT:  **PASS** — `test_DW_4_4_dotdot_escaping_outputDir_throws_TypeError`, the deep-escape variant, and the cookies-path variant all pass. Reviewer probe: exact-boundary `outputDir: ".."` also throws TypeError (caught by the `rel === ".."` branch).

### DW-4.5
PREMISE:  Identity `injectContract` returns the URL unchanged.
EVIDENCE: src/adapters/yt-dlp.ts:161-163 — `return prompt;`, no transformation.
TRACE:    `injectContract(url)` → `url` (same reference), including a metacharacter-laden hostile URL.
VERDICT:  **PASS** — `test_DW_4_5_injectContract_is_identity` passes (plain + hostile input).

### DW-4.6
PREMISE:  `buildArgs` retains a resolution-capped video alongside the wav, and `parseResult` reports the video path in `artifacts` on exit 0 + files present.
EVIDENCE: buildArgs: src/adapters/yt-dlp.ts:104-105 (`-f bv*[height<=720]+ba/b[height<=720]/b` — 720p cap), 111 (`-k` keep video), 147-148 (labeled `--print after_video:SDD_VIDEO_PATH:%(filepath)s` channel). parseResult: 198-199 (last labeled video line + existence check), 205 (artifacts = `[wav, video, …subs]`).
TRACE:    argv contains `-f` value with `height<=720`, `-k`, and the labeled print → exit 0 + stdout `"<wav>\nSDD_VIDEO_PATH:<mp4>\n"` with both temp files on disk → `{status:"done", artifacts:[wav, mp4]}`, summary names the video.
VERDICT:  **PASS** — `test_DW_4_6_buildArgs_caps_resolution_keeps_video_and_emits_labeled_video_print` and `test_DW_4_6_parseResult_reports_both_audio_and_video_in_artifacts` pass; artifact-order and last-video-line-wins tests pass.

**All requirements met:** YES

## Test-DW Coverage

- [x] Every DW item has DW-ID-named automated tests that ran in Step 0 (DW-4.1 ×2, DW-4.2, DW-4.3 ×2, DW-4.4 ×2, DW-4.5, DW-4.6 ×2), plus supporting non-DW tests.
- [x] Coverage matches the stated 100% level: `src/adapters/yt-dlp.ts` at 100.00% funcs / 100.00% lines under the focused run.

No gaps.

## Edge cases + security (prompt-listed — all verified)

| Listed case | Result | Evidence |
|---|---|---|
| Option injection (`--exec=`, `-o/etc/passwd` as "URL") | HANDLED | Scheme allowlist `^https?:\/\//i` (yt-dlp.ts:227) rejects both with TypeError — probe: `-o/etc/passwd` → TypeError; tests: `--exec=touch …`, `file://`, embedded-whitespace all throw. `--` separator still immediately precedes the URL after the amendment (line 155; separator test passes). NBSP (U+00A0) smuggling also rejected (probe F — `\s` matches U+00A0 at line 230). |
| Silent-success guard (exit 0, no audio file → failed; absent-file video marker dropped, not fatal) | HANDLED | Lines 176-193 (two failed paths, both tested); line 198-199 drops a video marker whose file is missing — test "a labeled video path whose file is missing is dropped, not fatal" passes: `done`, artifacts `[wav]` only. |
| Two path markers never collide/cross-parse; last-occurrence-wins each | HANDLED | Structurally disjoint: audio line must start `/` and end `.wav` (line 81); video line must start `SDD_VIDEO_PATH:` (line 87). Probes: a video marker ending `.wav` is NOT taken as audio (→ failed, artifacts []); a bare wav line never yields a phantom video; both-present with `.wav`-suffixed video assigns channels correctly. Last-wins via `lastMarkerMatch` (matchAll iteration, `_agy-shared.ts:42-46`) — tested for both channels ("last audio-path line wins…", "the LAST labeled video line wins…"). |
| Traversal barricade intact on outputDir + cookies; cookies contents never echoed | HANDLED | `resolveContained` (287-298) covers both keys; tests + probe pass. The adapter only ever handles the cookies PATH — no `readFile`/read of the cookies file anywhere in the module; only the path reaches argv (`--cookies <path>`, line 121). |
| `mode: "read"`; no `console.*` | HANDLED | Line 71 `mode: AdapterMode = "read"`, asserted by test "mode is read and the adapter opts out of live probing". `grep console\.` over both files → 0 matches. |

## Dead Code

None found. All imports used; `VIDEO_MARKER_PREFIX` consumed at line 148; the `_check: Adapter` + `void _check` at 307-308 is a deliberate compile-time shape assertion, not dead code. No debug statements or commented-out blocks.

## Correctness Dimensions

| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Adapter is pure functions + module-level regex constants. The `g`-flag regexes are only ever consumed via `matchAll` (`lastMarkerMatch`, yt-dlp.ts:201), which clones the regex and never mutates the original's `lastIndex` — probed: back-to-back `parseResult` calls give identical results, no cross-call state. |
| Error Handling | PASS | Exit≠0 → failed with stderr tail (166-175, tested incl. 5000-char truncation); missing marker → failed (177); missing file → failed (186); all malformed opts throw TypeError rather than silently coercing (tested). |
| Resources | N/A | No handles opened — only `existsSync`. Tests clean their temp dirs in `afterEach`. |
| Boundaries | PASS | Empty stdout/stderr, empty prompt, empty outputDir/cookies strings, `".."` exact boundary (probe G), CRLF line endings (probe D — `\r?$` in all three regexes), stderr tail capped at 400 chars, URL echo truncated at 120 chars. All traced or tested. |
| Security | PASS | Probes E/F/G + the barricade tests: option-injection rejected at entry, `--` end-of-options structural, traversal TypeError pre-spawn (buildArgs at jobs.ts:243 precedes spawn at jobs.ts:282), `%`→`%%` template escape tested, cookies contents untouched. |

## Loaded-Skill Criteria (code-foundations:cc-defensive-programming)

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry | PASS | All five untrusted inputs (URL prompt, outputDir, cookies, subLangs, sleepRequests) validated at `buildArgs` entry before argv construction; child stdout re-validated in `parseResult` (marker + on-disk existence). |
| cc-defensive-programming | No empty catch blocks | PASS | Zero try/catch in `src/adapters/yt-dlp.ts`; errors propagate as TypeError (contained by JobStore's documented throwing-parseResult handling upstream). |
| cc-defensive-programming | No executable code in assertions | N/A | No assertion mechanism used; error strategy is throw-at-boundary. |
| cc-defensive-programming | Assertions for bugs only / error handling for anticipated conditions | PASS | Anticipated runtime failures (bad URL, bad opts, harness misbehavior) use error handling (TypeError / `failed` result), never assertions. |
| cc-defensive-programming | Barricade placement + defense-in-depth on security paths | PASS | Barricade at the adapter entry (external boundary); the security-critical URL path has TWO independent layers (scheme+charset allowlist AND `--` separator), and the credential-adjacent cookies path is validated and never read — matches the skill's defense-in-depth requirement for security-critical paths. |
| cc-defensive-programming | Consistent error-handling strategy with the codebase | PASS | Same pattern as the agy-image precedent: TypeError pre-spawn, structured `failed` AdapterResult post-run, stderr-tail summaries. |

## Notes (non-blocking)

- `parseResult` inherently trusts child-stdout paths: a forged-but-existing absolute path would be reported as an artifact. The existence check is a silent-success guard, not anti-forgery — this is the shared `parseResult(stdout,…)` contract across all adapters, not a defect introduced here.
- `AUDIO_PATH_LINE_RE` requires a leading `/` (POSIX-only) — explicitly documented as a darwin-targeted assumption (yt-dlp.ts:79-80). Would need revisiting for Windows support.
- An absolute `outputDir`/`cookies` path bypasses containment by design ("explicit caller target", agy-image precedent) — consistent with the barricade's documented semantics, flagged only for awareness.
- The exact yt-dlp `after_move`/`after_video` stage→filepath mapping is pinned to a later manual E2E phase per the code comment (yt-dlp.ts:141-143); this review verifies the parse contract the unit tests own, which is what the DW items specify.
- Focused-run coverage shows `_agy-shared.ts` at 83% lines only because `buildAgyArgv` belongs to the agy adapters; it is covered in the whole-suite run (274 pass).

## Issues

None.

**Verdict: PASS**
