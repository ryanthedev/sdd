# Review: Phase 4 - yt-dlp adapter (sample 1)

## Executed Results (Step 0)
- Test suite (focused): `bun test test/adapter-yt-dlp.test.ts` → 27 pass / 0 fail (90 expects)
- Test suite (full): `bun test` → 203 pass / 0 fail across 15 files
- Typecheck: `bunx tsc --noEmit` → exit 0, no errors
- Coverage: `bun test test/adapter-yt-dlp.test.ts --coverage` → src/adapters/yt-dlp.ts 100.00% funcs / 100.00% lines, no uncovered lines
- Lint: no lint command configured in this project (package.json has test/typecheck only); typecheck is the stated static gate

## Requirement Fulfillment

### DW-4.1
PREMISE:  "`buildArgs` places all flags before the positional URL and never after it."
EVIDENCE: src/adapters/yt-dlp.ts:85-120 — argv assembled flags-first; line 119 `argv.push("--", url)` is the final statement before `return`, so the URL is structurally the last element, preceded by an end-of-options `--`.
TRACE:    `buildArgs(URL, {outputDir, cookies, subLangs, sleepRequests})` → argv = ["yt-dlp", "-x", …, "--print", "after_move:filepath", "--no-simulate", "--no-quiet", "--", URL] → every dash-prefixed element index < indexOf(URL); URL is argv[argv.length-1].
VERDICT:  PASS — `test_DW_4_1_url_is_last_argv_element_all_flags_before_it` and `test_DW_4_1_end_of_options_separator_immediately_precedes_url` ran and passed.

### DW-4.2
PREMISE:  "`parseResult` returns `failed` on exit 0 when the expected audio artifact is absent."
EVIDENCE: src/adapters/yt-dlp.ts:140-157 — `lastMarkerMatch` extracts the marker path line; line 150 `existsSync(wavPath)` false → `status: "failed"` with "does not exist" summary. Missing marker line entirely → failed at lines 141-148.
TRACE:    stdout = "…\n<tmp>/never-written.wav\n", exit 0 → marker matched → existsSync false → {status:"failed", summary contains path + "does not exist"}.
VERDICT:  PASS — `test_DW_4_2_exit_0_with_absent_audio_file_is_failed` ran and passed (real temp dir, file never written); the no-marker-line backstop test also passed.

### DW-4.3
PREMISE:  "`parseResult` returns `done` with the audio path in `artifacts` on exit 0 + file present."
EVIDENCE: src/adapters/yt-dlp.ts:158-167 — existsSync true → `{status:"done", artifacts:[wavPath, ...subtitles]}`.
TRACE:    real WAV written to temp dir → stdout contains its absolute path line, exit 0 → marker matched → existsSync true → done, artifacts = [wav] (absolute).
VERDICT:  PASS — `test_DW_4_3_exit_0_and_existing_wav_is_done_with_artifact` ran and passed; `test_DW_4_3_existing_subtitles_are_appended_to_artifacts` verifies existing VTTs appended and ghost VTTs filtered.

### DW-4.4
PREMISE:  "a `../`-escaping `outputDir` throws a `TypeError` before spawn."
EVIDENCE: src/adapters/yt-dlp.ts:241-252 (`resolveContained`) called from `resolveOutputDir` (line 200) at buildArgs entry (line 83). The adapter is pure (no spawn); JobStore calls `buildArgs` at src/lib/jobs.ts:243 before any child process is created, so the throw provably precedes spawn.
TRACE:    cwd=<tmp>, outputDir="../../etc" → resolve(base, raw) → relative(base, resolved) starts with ".." → TypeError thrown, argv never built.
VERDICT:  PASS — `test_DW_4_4_dotdot_escaping_outputDir_throws_TypeError` and `test_DW_4_4_deep_dotdot_escape_throws_TypeError` ran and passed; contained relative paths and absolute paths pass through (both tested).

### DW-4.5
PREMISE:  "identity `injectContract` returns the URL unchanged."
EVIDENCE: src/adapters/yt-dlp.ts:125-127 — `return prompt;`, no transformation.
TRACE:    URL in → identical string out (same value, verified for both a clean URL and a metacharacter-laden one).
VERDICT:  PASS — `test_DW_4_5_injectContract_is_identity` ran and passed. The repo's contract-marker backstop is preserved via CLI flags instead (`--print after_move:filepath`, line 115) with `parseResult` failing on a missing marker (lines 141-148) — consistent with the invariant that a missing marker → failed even on exit 0.

**All requirements met:** YES

## Test-DW Coverage
- [x] All 5 DW items have DW-ID-named automated tests that ran in Step 0 (test_DW_4_1 ×2, test_DW_4_2, test_DW_4_3 ×2, test_DW_4_4 ×2, test_DW_4_5)
- [x] Coverage matches the stated 100% level: bun coverage reports 100.00% functions / 100.00% lines on src/adapters/yt-dlp.ts, zero uncovered lines
- No gaps.

## Dead Code
None found. `const _check: Adapter = {…}; void _check;` (lines 261-262) is an intentional compile-time shape assertion, not dead code. No unused imports, no debug statements, no commented-out blocks, no unreachable code.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Adapter is pure functions + module-level constants; only shared mutable-looking state is the two `g`-flag regexes, and `String.prototype.matchAll` clones the regex per spec, so no lastIndex bleed between calls (probed: repeated parseResult calls in the suite, including back-to-back matches, all pass). |
| Error Handling | PASS | Adversarial inputs traced: exit≠0 → failed + stderr tail (lines 130-139); exit 0 + no marker → failed (141-148); exit 0 + ghost file → failed (150-157); throwing buildArgs on bad opts is contained by JobStore's dispatch path. `existsSync` never throws on bad paths. |
| Resources | N/A | No handles, connections, or processes opened by the adapter; `existsSync` is the only fs touch. Tests clean their temp dirs in afterEach. |
| Boundaries | PASS | Empty prompt, empty stdout, empty stderr, 5000-char stderr (truncated to ≤600-char summary), duplicate subtitle lines (deduped), multiple marker lines (last wins), `%` in outputDir (escaped to `%%`), missing outputDir — all traced and test-backed. `match[1]!` is safe: group 1 exists whenever the regex matches. |
| Security | PASS | Option injection: `--exec=…` / `-o/etc/passwd` prompts rejected by scheme check (lines 181-183) AND, defense-in-depth, `--` end-of-options precedes the URL (line 119); non-http/file:// URLs and whitespace-embedded URLs rejected (tests at test file lines 231-240). Shell metacharacters stay one literal argv element (test line 224). Traversal barricade covers outputDir AND cookies (lines 200, 210 → 241-252). Adapter never reads the cookies file — only the validated path enters argv — so cookie contents cannot reach output/logs from this code. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry (barricade) | PASS | Every untrusted field validated at the buildArgs boundary before use: prompt/URL (176-188), outputDir (195-201), cookies (204-211), subLangs (213-222, rejects leading `-` and whitespace — its own option-injection guard), sleepRequests (224-231). Internal helpers assume validated data — correct barricade shape. |
| cc-defensive-programming | No empty catch blocks | PASS | No try/catch exists in the adapter; anticipated failures return `failed` results or throw typed errors. |
| cc-defensive-programming | No executable code in assertions | N/A | No assertions used; validation is error handling (TypeError), which is correct for external input per the skill's assertion-vs-error-handling table. |
| cc-defensive-programming | Assertions for bugs only / anticipated errors handled | PASS | Anticipated runtime conditions (bad URL, bad opts, missing file, nonzero exit) all use error handling, never assertions. |
| cc-defensive-programming | Security-critical path gets defense in depth | PASS | URL barricade is two independent layers (scheme+charset validation AND structural `--` separator AND shell:false argv upstream); traversal barricade applies to both path-typed opts. |

## Notes (non-blocking)
- An **absolute** `cookies`/`outputDir` path passes through without containment (line 242). This is documented intentional design ("explicit caller-specified target", agy-image precedent) and DW-4.4 only names `../`-escaping paths; the adapter never reads the cookies file, so the exposure is limited to yt-dlp itself opening the named path.
- `AUDIO_PATH_LINE_RE` anchors on a leading `/` — POSIX-only, documented as a deliberate darwin-target assumption (lines 70-73).
- An `outputDir` containing a newline is legal on disk and is not rejected; at runtime it could split the marker line and yield a spurious `failed`. Undemonstrated at the unit level and not a listed edge case — fail-closed direction anyway.
- `injectContract` is identity rather than marker-appending; the header comment (lines 11-26) documents why (JobStore applies injectContract before buildArgs, and the prompt IS the URL), and the marker obligation is met via `--print after_move:filepath` + parseResult's fail-on-missing-marker. Verified against src/lib/jobs.ts:242-243.

## Issues
None.

**Verdict: PASS**
