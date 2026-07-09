# Review: Phase 4 - yt-dlp adapter (amended: video retention) — sample 2

## Executed Results (Step 0)
- Test suite (focused): `bun test test/adapter-yt-dlp.test.ts` → 32 pass / 0 fail (104 expect calls)
- Test suite (full): `bun test` → 274 pass / 0 fail across 18 files
- Typecheck: `bunx tsc --noEmit` → clean (exit 0)
- Lint: no separate lint config in repo; strict tsc is the gate (per CLAUDE.md) → clean
- Coverage: `bun test --coverage test/adapter-yt-dlp.test.ts` → `src/adapters/yt-dlp.ts` **100.00% funcs / 100.00% lines**
- Adversarial probe script (scratchpad `probe.ts`, run with `bun`): 7/7 probes OK (details inline below)

## Requirement Fulfillment

### DW-4.1
PREMISE:  `buildArgs` places all flags before the positional URL and never after it.
EVIDENCE: src/adapters/yt-dlp.ts:98–156 — all flags built first; `argv.push("--", url)` at :155 is the final mutation before `return argv`.
TRACE:    full-opts call (outputDir+cookies+subLangs+sleepRequests) → flags/optional groups/marker prints appended → `--` then URL appended last → URL is `argv[argv.length-1]`, `--` is `argv[argv.length-2]`; every dash-prefixed element indexes strictly below the URL.
VERDICT:  PASS — `test_DW_4_1_url_is_last_argv_element_all_flags_before_it`, `test_DW_4_1_end_of_options_separator_immediately_precedes_url` (both ran, pass).

### DW-4.2
PREMISE:  `parseResult` returns `failed` on exit 0 when the expected audio artifact is absent.
EVIDENCE: src/adapters/yt-dlp.ts:176–193 — no audio-path line → `failed` (:177–184); line present but `!existsSync(wavPath)` → `failed` (:186–193).
TRACE:    exit 0 + stdout naming a never-written `.wav` → regex matches the path → `existsSync` false → `{status:"failed", summary contains "does not exist"}`; exit 0 with no path line at all → "no output audio path" failure.
VERDICT:  PASS — `test_DW_4_2_exit_0_with_absent_audio_file_is_failed`, `missing audio-path line entirely on exit 0 is failed` (ran, pass).

### DW-4.3
PREMISE:  `parseResult` returns `done` with the audio path in `artifacts` on exit 0 + file present.
EVIDENCE: src/adapters/yt-dlp.ts:176–213 — last `.wav` line extracted (:176, :185), existence verified (:186), `artifacts = [wavPath, ...]` (:205), `status:"done"` (:209).
TRACE:    exit 0 + stdout containing a real temp `.wav` path → match → `existsSync` true → `{status:"done", artifacts:[wavPath]}`, path absolute.
VERDICT:  PASS — `test_DW_4_3_exit_0_and_existing_wav_is_done_with_artifact`, `test_DW_4_3_existing_subtitles_are_appended_to_artifacts` (ran, pass).

### DW-4.4
PREMISE:  a `../`-escaping `outputDir` (and `cookies`) throws a `TypeError` before spawn.
EVIDENCE: src/adapters/yt-dlp.ts:287–298 (`resolveContained`) via :246 (outputDir) and :256 (cookies). "Before spawn" grounded in src/lib/jobs.ts:242–243 — `injectContract` → `buildArgs` run inside `#buildArgv`, whose result feeds `#spawnAndTrack` (jobs.ts:114); a throw in `buildArgs` therefore precedes any spawn.
TRACE:    `outputDir:"../../etc"` with cwd = temp dir → `resolve(base, raw)` escapes base → `relative(base, resolved)` starts with `..` → `TypeError` thrown; same for cookies `"../../.netrc"`; probe confirmed bare `".."` is also caught (`rel === ".."` branch).
VERDICT:  PASS — `test_DW_4_4_dotdot_escaping_outputDir_throws_TypeError`, `test_DW_4_4_deep_dotdot_escape_throws_TypeError`, `a dotdot-escaping cookies path throws a TypeError too` (ran, pass) + probe 5.

### DW-4.5
PREMISE:  identity `injectContract` returns the URL unchanged.
EVIDENCE: src/adapters/yt-dlp.ts:161–163 — `return prompt;`.
TRACE:    any string in (incl. one laced with shell metacharacters) → same string out, reference-equal.
VERDICT:  PASS — `test_DW_4_5_injectContract_is_identity` (ran, pass).

### DW-4.6
PREMISE:  `buildArgs` retains a resolution-capped video alongside the wav, and `parseResult` reports the video path in `artifacts` on exit 0 + files present.
EVIDENCE: src/adapters/yt-dlp.ts:104–111 (`-f bv*[height<=720]+ba/b[height<=720]/b`, `-k`), :144–151 (labeled `after_video:SDD_VIDEO_PATH:%(filepath)s` print); parse side :198–205 — last labeled video line, existence-checked, appended after the wav.
TRACE:    argv contains `height<=720` after `-f` and `-k`; stdout with real wav + `SDD_VIDEO_PATH:<real mp4>` on exit 0 → `artifacts === [wav, video]`, summary names the video.
VERDICT:  PASS — `test_DW_4_6_buildArgs_caps_resolution_keeps_video_and_emits_labeled_video_print`, `test_DW_4_6_parseResult_reports_both_audio_and_video_in_artifacts` (ran, pass).

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have corresponding DW-named tests that ran in Step 0 (`test_DW_4_1_*` ×2, `test_DW_4_2_*`, `test_DW_4_3_*` ×2, `test_DW_4_4_*` ×2, `test_DW_4_5_*`, `test_DW_4_6_*` ×2)
- [x] Stated level 100%: measured 100% funcs / 100% lines on src/adapters/yt-dlp.ts
No gaps.

## Dead Code
None found. (`const _check: Adapter = …; void _check;` at :307–308 is a deliberate compile-time shape check, not dead code — same pattern intent as other adapters.)

## Edge cases (prompt-listed)
| Case | Status | Evidence |
|---|---|---|
| Option injection (`--exec=`, `-o/etc/passwd`) | HANDLED | `validateUrl` scheme allowlist `/^https?:\/\//i` rejects both (tests at test:293–302; probe 4: `-o/etc/passwd` → TypeError). `--` separator still immediately precedes the URL after the amendment (test:60–64; probe 3: an option-shaped URL suffix that passes the scheme check still lands after `--`). Two independent layers intact. |
| Silent-success guard | HANDLED | exit 0 + no audio file → `failed` (DW-4.2 tests). Video marker with ABSENT file → dropped, job stays `done` with audio only (test:127–135; probe 2: video-file-only stdout with no wav line → `failed`, guard keyed on audio alone). |
| Marker collision / cross-parse | HANDLED | Audio regex anchored `^(\/.*\.wav)$` vs labeled `^SDD_VIDEO_PATH:(…)$` — disjoint by first character; a bare mp4 line from `-k`'s second after_move print matches neither channel wrongly. Last-occurrence-wins tested for BOTH channels (test:137–145, test:200–208). Probe 1: interleaved bare-mp4 + two video markers (first one a `.wav`-suffixed decoy) + bare wav → `[wav, lastVideo]`, no cross-parse. |
| Traversal barricade + cookies never echoed | HANDLED | `resolveContained` applied to both outputDir and cookies (DW-4.4). Adapter only handles the cookies PATH (`--cookies <path>`, :121); no `readFile`/read of the cookies file anywhere in the module, so contents cannot reach stdout/logs. |
| `mode: "read"`; no `console.*` | HANDLED | :71 `mode = "read"` (test:318–321); `grep console\.` over src/adapters/yt-dlp.ts → zero hits. |

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Pure functions, no shared mutable state. Only latent risk was module-level `g`-flag regexes; all consumed via `matchAll` (does not mutate source `lastIndex`) — probe 7: two consecutive `parseResult` calls both `done`. |
| Error Handling | PASS | Non-zero exit → failed with truncated stderr tail (tests :212–233); malformed opts throw TypeError, never silently coerce (test :306–314); no empty catches (no catch blocks at all — a throwing parseResult is contained by JobStore per repo invariant). |
| Resources | N/A | No handles opened; `existsSync` only. Temp dirs in tests cleaned in `afterEach`. |
| Boundaries | PASS | Empty prompt, empty cookies, empty/non-string outputDir, `\t`/`\n`/space in URL (probe 6), literal `%` in outputDir escaped to `%%` (test :270–274), 5000-char stderr truncated (test :228–233), `..` exact-match traversal (probe 5) — all traced/tested, correct. |
| Security | PASS | Untrusted URL: scheme allowlist + control-char reject + `--` separator + argv-array/`shell:false` upstream. Untrusted paths: containment barricade before spawn. No probe found a bypass. |

## Loaded-Skill Criteria (code-foundations:cc-defensive-programming)
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry | PASS | All five untrusted inputs (URL, outputDir, cookies, subLangs, sleepRequests) validated in dedicated functions before argv assembly (:222–277). |
| cc-defensive-programming | No empty catch blocks | PASS | Zero catch blocks in the adapter; error strategy is throw-TypeError-at-barricade, contained by JobStore. |
| cc-defensive-programming | No executable code in assertions / assertions for bugs only | N/A | No assertions used; anticipated bad input correctly uses error handling (TypeError), matching the skill's assertion-vs-error table for external input. |
| cc-defensive-programming | Barricade placement + defense-in-depth on security path | PASS | Validation at the buildArgs entry boundary; option-injection defended by TWO independent layers (allowlist AND `--`), traversal by containment check — security-critical path double-covered as the skill requires. |
| cc-defensive-programming | Correctness over robustness at the trust boundary | PASS | Bad input → loud TypeError before spawn (never coerced); silent success → `failed` (never a wrong `done`). |

## Notes (non-blocking)
- `AUDIO_PATH_LINE_RE` assumes POSIX absolute paths (leading `/`) — documented as intentional for this darwin-targeted project (:76–80); would need revisiting for Windows, which is out of scope.
- An absolute `outputDir`/`cookies` bypasses containment by design ("explicit caller target", :284–285) — consistent with the agy-image precedent the header cites; the DW item only names `../`-escaping relative paths.
- The exact yt-dlp `after_video` stage→filepath mapping is deferred to a later manual E2E phase per the code comment (:141–143); the unit-tested contract here is the label-based parse, which is what these DW items cover.

## Issues
None.

**Verdict: PASS**
