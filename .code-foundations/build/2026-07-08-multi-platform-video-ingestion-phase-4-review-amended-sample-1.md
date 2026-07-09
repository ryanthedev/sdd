# Review: Phase 4 (amended) — yt-dlp adapter, sample 1

## Executed Results (Step 0)
- Test suite (focused): `bun test test/adapter-yt-dlp.test.ts` → 32 pass, 0 fail (104 expect calls)
- Test suite (whole): `bun test` → 274 pass, 0 fail (783 expect calls, 18 files)
- Typecheck: `bunx tsc --noEmit` → clean, no errors
- Lint: no separate lint step configured in this repo; tsc strict (+ `noUncheckedIndexedAccess`) is the gate — clean

## Requirement Fulfillment

### DW-4.1
PREMISE:  `buildArgs` places all flags before the positional URL and never after it.
EVIDENCE: src/adapters/yt-dlp.ts:98-156 — argv assembled as literal array; every flag pushed in lines 98-151; `argv.push("--", url)` at line 155 is the final push, so the URL is structurally the LAST element with no code path that can append after it.
TRACE:    `buildArgs(URL, {outputDir, cookies, subLangs, sleepRequests})` → base flags (98-118) → optional groups (120-129) → marker flags (144-151) → `["--", url]` (155) → return. Test iterates every dash-prefixed element and asserts its index < indexOf(URL).
VERDICT:  PASS — `test_DW_4_1_url_is_last_argv_element_all_flags_before_it` (test:34) and `test_DW_4_1_end_of_options_separator_immediately_precedes_url` (test:60), both green in Step 0.

### DW-4.2
PREMISE:  `parseResult` returns `failed` on exit 0 when the expected audio artifact is absent.
EVIDENCE: src/adapters/yt-dlp.ts:186-193 — after the last-occurrence wav-line match, `existsSync(wavPath)` gates success; absent file → `{status: "failed", summary: "...does not exist... (silent-success guard)"}`.
TRACE:    stdout `"...\n<ghost>.wav\n"`, exit 0, file never written → regex matches at 176 → `existsSync` false at 186 → `failed` with the ghost path in the summary.
VERDICT:  PASS — `test_DW_4_2_exit_0_with_absent_audio_file_is_failed` (test:149) plus the no-marker-line backstop (test:157), both green.

### DW-4.3
PREMISE:  `parseResult` returns `done` with the audio path in `artifacts` on exit 0 + file present.
EVIDENCE: src/adapters/yt-dlp.ts:176-213 — wav line matched (176), file exists (186), `artifacts = [wavPath, ...]` with wav first (205), `status: "done"` (209).
TRACE:    real temp `.wav` written, stdout carries its absolute path as a bare line, exit 0 → match → existsSync true → `done`, `artifacts[0]` === wav path, absolute.
VERDICT:  PASS — `test_DW_4_3_exit_0_and_existing_wav_is_done_with_artifact` (test:165) and `test_DW_4_3_existing_subtitles_are_appended_to_artifacts` (test:175), both green.

### DW-4.4
PREMISE:  a `../`-escaping `outputDir` (and `cookies`) throws a `TypeError` before spawn.
EVIDENCE: src/adapters/yt-dlp.ts:287-298 (`resolveContained`) — relative input resolved against job cwd; `relative(base, resolved)` yielding `..`, `../…`, or an absolute → `throw new TypeError(...)`. Wired for outputDir at 246 and cookies at 256; both run inside `buildArgs`, i.e. before any argv exists to spawn.
TRACE:    `{cwd: <tmp>, outputDir: "../../etc"}` → resolve → rel = `../../etc` → `startsWith("../")` true → TypeError thrown from buildArgs. Same path for `cookies: "../../.netrc"`. Containment counter-case: `"media/../audio"` resolves inside cwd and is accepted (test:252).
VERDICT:  PASS — `test_DW_4_4_dotdot_escaping_outputDir_throws_TypeError` (test:237), `test_DW_4_4_deep_dotdot_escape_throws_TypeError` (test:242), cookies variant (test:247), all green.

### DW-4.5
PREMISE:  identity `injectContract` returns the URL unchanged.
EVIDENCE: src/adapters/yt-dlp.ts:161-163 — `return prompt;` verbatim, no transformation.
TRACE:    URL in → same string reference out; also verified with a hostile metacharacter-laden URL returned byte-identical.
VERDICT:  PASS — `test_DW_4_5_injectContract_is_identity` (test:278), green.

### DW-4.6
PREMISE:  `buildArgs` retains a resolution-capped video alongside the wav, and `parseResult` reports the video path in `artifacts` on exit 0 + files present.
EVIDENCE: src/adapters/yt-dlp.ts:104-111 — `-f bv*[height<=720]+ba/b[height<=720]/b` (cap) and `-k` (keep video after wav extraction); 144-151 — labeled `--print after_video:SDD_VIDEO_PATH:%(filepath)s` channel; 198-205 — `lastMarkerMatch(VIDEO_PATH_LINE_RE, …)` + `existsSync` → video appended to artifacts after the wav.
TRACE:    argv contains the height cap, `-k`, and the labeled print (buildArgs half); stdout `"<wav>\nSDD_VIDEO_PATH:<mp4>\n"` with both temp files present, exit 0 → `done`, `artifacts === [wav, video]`, summary names the video (parseResult half).
VERDICT:  PASS — `test_DW_4_6_buildArgs_caps_resolution_keeps_video_and_emits_labeled_video_print` (test:89) and `test_DW_4_6_parseResult_reports_both_audio_and_video_in_artifacts` (test:99), both green.

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have corresponding tests ran in Step 0 (`test_DW_4_1_*` ×2, `test_DW_4_2_*`, `test_DW_4_3_*` ×2, `test_DW_4_4_*` ×2 + cookies, `test_DW_4_5_*`, `test_DW_4_6_*` ×2)
- [x] Coverage matches the stated 100% level: all three exported functions plus every validator branch (url scheme/whitespace/empty, outputDir required/absolute/relative/escape/%-escape, cookies present/empty/escape, subLangs whitespace/leading-dash, sleepRequests type/sign) are exercised; parseResult driven across exit≠0, no-marker, ghost-audio, ghost-video, subtitles, dedupe, last-occurrence (audio AND video), stderr truncation.

## Dead Code
None blocking. `const _check: Adapter = {…}; void _check;` (yt-dlp.ts:307-308) is a deliberate compile-time interface-conformance check, not dead code — see Notes.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | Pure functions, no shared mutable state. Adversarial probe: the module-level `g`-flag regexes (lines 81/87/92) would be stateful if `exec`/`test`'d, but the only consumers are `text.matchAll(re)` (lastMarkerMatch, _agy-shared.ts:44) and `stdout.matchAll(...)` (yt-dlp.ts:201) — matchAll operates on a clone and never mutates the original's `lastIndex`. Traced: repeated parseResult calls cannot see stale offsets. |
| Error Handling | PASS | exit≠0 → `failed` with a bounded stderr tail (300-305; tests 212/220/228); every malformed opt throws TypeError instead of silently coercing (tests 297-314); a present wav line cannot rescue a non-zero exit (test 220). |
| Resources | N/A | Only I/O is `existsSync`; no handles, connections, or spawning in the adapter (port contract: pure). |
| Boundaries | PASS | Empty prompt, empty stdout, no marker line, empty/`" "` video capture (`.trim()` → existsSync("") → dropped), 5000-char stderr truncation, `%` in outputDir, `..x`-named dir NOT falsely rejected (startsWith(`..${sep}`) not bare `..`) — all traced or tested green. |
| Security | PASS | See edge-case verifications below; both option-injection layers and the traversal barricade demonstrated by executed tests. |

## Edge cases + security (prompt-listed — each verified)
| Listed case | Status | Evidence |
|---|---|---|
| Option injection (`--exec=`, `-o/etc/passwd` as "URL") | HANDLED | Layer 1: `validateUrl` (222-233) rejects anything not matching `^https?://` — `--exec=…` and `-o/etc/passwd` both fail the scheme test → TypeError (tests 293, 297). Layer 2: `argv.push("--", url)` (155) — even a scheme-passing hostile URL sits after end-of-options (test 60). Both layers survive the amendment: the new marker/`-f`/`-k` flags are pushed at 144-151, before the `--`. |
| Silent-success guard: exit 0, no AUDIO file → failed | HANDLED | 186-193; test 149. No marker line at all → failed too (176-184; test 157). |
| Video marker with ABSENT file dropped, not fatal | HANDLED | 198-199: `videoMatch && existsSync(...) ? path : undefined` — ghost video yields `done` with `[wav]` only (test 127). |
| Two markers never collide/cross-parse; last-occurrence each | HANDLED | Structurally disjoint: audio line must start `/` and end `.wav` (81); video line must start `SDD_VIDEO_PATH:` (87) — neither can match the other; the `-k` bare video path line (e.g. `/dir/x.mp4`) matches neither. Last-occurrence via `lastMarkerMatch` for BOTH channels (176, 198); tests 200 (audio) and 137 (video). |
| Traversal barricade on outputDir + cookies; cookies never echoed | HANDLED | `resolveContained` (287-298) applied to both (246, 256); tests 237/242/247. The adapter handles only the cookies PATH — no fs read of the file anywhere in the module, so contents can never reach a summary/log; the only stderr echo is yt-dlp's own tail (300-305). |
| `mode: "read"`; no `console.*` | HANDLED | `mode: AdapterMode = "read"` (71; test 318). `grep -n "console\." src/adapters/yt-dlp.ts test/adapter-yt-dlp.test.ts` → 0 matches. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry (barricade) | PASS | All five untrusted inputs (prompt/URL, outputDir, cookies, subLangs, sleepRequests) validated in dedicated entry functions (222-277, 287-298) before any argv element is formed; executed tests drive every rejection branch. |
| cc-defensive-programming | No empty catch blocks | PASS | Zero try/catch in the adapter; a throwing parseResult is contained upstream by JobStore per the architecture contract — no swallowing here. |
| cc-defensive-programming | No executable code in assertions / assertions for bugs only | N/A | No assertions used; anticipated bad input is error-handled (TypeError), which is the correct side of the skill's assertion-vs-error table for external input. |
| cc-defensive-programming | Security-critical path gets defense-in-depth (never single-layer) | PASS | URL injection has TWO independent layers (scheme+charset allowlist AND `--` separator); success has TWO gates (exit code AND marker+existsSync). |
| cc-defensive-programming | Correctness over robustness at the trust boundary | PASS | Malformed opts throw rather than coerce (tests 306-314); exit 0 without the audio artifact fails rather than optimistically succeeding. Best-effort degradation is confined to genuinely optional artifacts (subs, retained video). |

## Notes (non-blocking)
- The module-level `g`-flag regex constants are safe only because every consumer uses `matchAll` (non-mutating). A future `.test()`/`.exec()` call on `AUDIO_PATH_LINE_RE` etc. would introduce cross-call `lastIndex` state — worth an inline comment.
- `AUDIO_PATH_LINE_RE`'s leading-`/` anchor is POSIX-only; documented as a darwin assumption in the header (line 76-80), so accepted, but a Windows port would silently never match.
- The `_check: Adapter` conformance idiom (307-308) is fine; `satisfies` on an object export would express the same intent without the `void`.
- parseResult trusts stdout-reported paths after an existence check; stdout originates from the locally spawned yt-dlp, same trust model as the other adapters — no demonstrable defect.

## Issues
None.

**Verdict: PASS**
