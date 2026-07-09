# Review: Phase 4 — yt-dlp adapter (security-sensitive, e2efix sample 1)

Independent post-gate review. Files: `src/adapters/yt-dlp.ts`, `test/adapter-yt-dlp.test.ts`. No network / real yt-dlp invoked, per dispatch constraints.

## Executed Results (Step 0)
- Focused suite: `bun test test/adapter-yt-dlp.test.ts` → **33 pass, 0 fail** (106 expect calls)
- Full suite: `bun test` → **275 pass, 0 fail** across 18 files
- Typecheck: `bunx tsc --noEmit` → **clean (exit 0)**
- Lint: no separate lint config in repo; strict tsc is the gate → clean
- Reviewer probes (observed behavior, run via a scratch script driving the adapter's pure functions):
  - P1 no regex-state leak: two identical `parseResult` calls both `done` with identical artifacts (module-level `g` regexes are safe — `matchAll` clones)
  - P2 fabricated `SDD_VIDEO_PATH:a.f251.webm` as LAST marker line → fragment selected (see Notes; outside the documented input domain)
  - P3 `SDD_VIDEO_PATH:../../etc/hosts.mp4` → `basename()` strips traversal; nonexistent resolved file dropped; artifacts = `[wav]`
  - P4 URL `-o/etc/passwd` → TypeError before argv is built
  - P5 `outputDir: "a/../.."` relative escape → TypeError
  - P6 CRLF stdout → both markers still parsed

## Requirement Fulfillment

### DW-4.1
PREMISE:  "all flags before the positional URL; URL never absorbed as an option."
EVIDENCE: src/adapters/yt-dlp.ts:116-172 — argv built as flags first; `argv.push("--", url)` is the final statement, so the URL is always the last element with a literal `--` immediately before it. All variable-valued args are constrained: outputDir/cookies resolve absolute (start with `/`), subLangs rejects leading `-` (line 287), sleepRequests numeric.
TRACE:    `buildArgs(URL, {outputDir, cookies, subLangs, sleepRequests})` → argv = `["yt-dlp", "-f", …, "--cookies", <abs>, …, "--print", …, "--", URL]`; every dash-prefixed element indexes strictly below `indexOf(URL)`.
VERDICT:  **PASS** — `test_DW_4_1_url_is_last_argv_element_all_flags_before_it`, `test_DW_4_1_end_of_options_separator_immediately_precedes_url` (both ran, pass).

### DW-4.2
PREMISE:  "`parseResult` → `failed` on exit 0 when the expected AUDIO artifact is absent."
EVIDENCE: src/adapters/yt-dlp.ts:192-209 — missing marker line → `failed` (silent-misparse backstop); marker present but `!existsSync(wavPath)` → `failed` (silent-success guard).
TRACE:    stdout `…/never-written.wav\n`, exit 0 → AUDIO_PATH_LINE_RE matches → `existsSync` false → `{status:"failed", summary:"…does not exist…"}`.
VERDICT:  **PASS** — `test_DW_4_2_exit_0_with_absent_audio_file_is_failed` + "missing audio-path line entirely on exit 0 is failed" (ran, pass).

### DW-4.3
PREMISE:  "`parseResult` → `done` with the audio path in `artifacts` on exit 0 + file present."
EVIDENCE: src/adapters/yt-dlp.ts:192-238 — last absolute `.wav` line extracted, existence verified, `artifacts = [wavPath, …]`.
TRACE:    real temp `.wav` written; stdout `[download] 100%\n[ExtractAudio] Destination: <wav>\n<wav>\n`, exit 0 → `done`, `artifacts[0]` = absolute wav path.
VERDICT:  **PASS** — `test_DW_4_3_exit_0_and_existing_wav_is_done_with_artifact`, `test_DW_4_3_existing_subtitles_are_appended_to_artifacts` (ran, pass).

### DW-4.4
PREMISE:  "`../`-escaping `outputDir`/`cookies` → `TypeError` before spawn."
EVIDENCE: src/adapters/yt-dlp.ts:312-323 (`resolveContained`) — relative path resolved against job cwd; `relative(base, resolved)` leading `..` (or absolute) → TypeError. Called from both `resolveOutputDir` (line 271) and `resolveOptionalCookies` (line 281). Thrown inside `buildArgs`, i.e. before any spawn.
TRACE:    `{cwd: d, outputDir: "../../etc"}` → `resolve(d, "../../etc")` escapes `d` → `relative()` starts `..` → TypeError. Cookies path same barricade. Probe P5 additionally confirms `"a/../.."` rejected.
VERDICT:  **PASS** — `test_DW_4_4_dotdot_escaping_outputDir_throws_TypeError`, `test_DW_4_4_deep_dotdot_escape_throws_TypeError`, cookies-path test at test line 265 (ran, pass).

### DW-4.5
PREMISE:  "identity `injectContract`."
EVIDENCE: src/adapters/yt-dlp.ts:177-179 — `return prompt;` verbatim.
TRACE:    any string in → same string reference out, including a metacharacter-laden hostile URL.
VERDICT:  **PASS** — `test_DW_4_5_injectContract_is_identity` (ran, pass).

### DW-4.6
PREMISE:  "retains a res-capped video and reports its ABSOLUTE path in `artifacts` (resolved from the `post_process:SDD_VIDEO_PATH:` basename joined to the audio dir); the merged file is selected, never a `.fNNN.` fragment or the `.wav`."
EVIDENCE: buildArgs: `-f bv*[height<=720]+ba/b[height<=720]/b` (line 123), `-k` (line 129), labeled `--print post_process:SDD_VIDEO_PATH:%(filepath)s` (lines 160-167). parseResult: `VIDEO_PATH_LINE_RE` (line 105) accepts only `webm|mp4|mkv|mov` values — a `.wav` value can never match; resolution `join(dirname(wavPath), basename(value))` (line 222) yields an absolute path; existence-gated (line 223).
TRACE:    stdout `<abs wav>\nSDD_VIDEO_PATH:jNQXAC9IVRw.webm\n` with both temp files present → artifacts `[<abs wav>, <abs dir>/jNQXAC9IVRw.webm]`. `.wav` decoy line `SDD_VIDEO_PATH:clip.wav` ignored (extension allowlist). Fragment exclusion: no `SDD_VIDEO_PATH:` line ever carries a fragment per the adapter's documented verification against real yt-dlp 2026.07.04 (header lines 14-27) — `post_process` fires only for the Merger/ExtractAudio postprocessors, whose `%(filepath)s` is the merged file / the wav; unreproducible here (network forbidden), see Notes N1.
VERDICT:  **PASS** — `test_DW_4_6_buildArgs_caps_resolution_keeps_video_and_emits_labeled_video_print`, `test_DW_4_6_parseResult_resolves_basename_video_against_wav_dir_and_reports_both`, plus `.wav`-decoy, missing-video-drop, last-wins, artifact-order tests (all ran, pass).

**All requirements met:** YES

## Test-DW Coverage
- [x] Every DW item has a named `test_DW_4_*` automated test that ran in Step 0 (DW-4.1 ×2, 4.2 ×1 + backstop, 4.3 ×2, 4.4 ×2 + cookies, 4.5 ×1, 4.6 ×2 + 4 supporting)
- [x] Coverage matches the stated 100% level: every exported function (`buildArgs`, `injectContract`, `parseResult`) and every private validator branch (URL reject ×3 forms, outputDir missing/non-string/escape, cookies empty/escape, subLangs 4 reject forms, sleepRequests 2 reject forms, `%`-escape, subtitle dedupe/ghost-filter, stderr truncation, non-zero exit, discovery) is exercised by a passing test.
- Coverage note: fragment-marker exclusion (DW-4.6 clause) is covered by documented-input-domain reasoning + the extension/existence gates, not an automated test, since it cannot occur per the recorded real-binary behavior and cannot be exercised without the network (see N1).

## Dead Code
None found. All 8 path imports used; `existsSync` used; `const _check: Adapter = …; void _check` is an intentional compile-time shape assertion, not dead code. No debug statements, no commented-out blocks, no unreachable code.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | Pure functions, no shared mutable state. Adversarial case: module-level `g`-flag regexes reused across calls — probe P1 ran `parseResult` twice on identical stdout, both returned `done` with full artifacts (`matchAll` clones the regex; no `lastIndex` leak). |
| Error Handling | PASS | exit≠0 → `failed` + truncated stderr tail (tested, incl. 5000-char stderr); missing marker → `failed`; missing file on exit 0 → `failed`; all bad opts → TypeError with key + offending value, thrown pre-spawn and contained by JobStore's documented throwing-parse/args containment. No catch blocks to swallow anything. |
| Resources | N/A | No handles, connections, locks, or spawning in the adapter (pure port; only `existsSync`). |
| Boundaries | PASS | Adversarial traces: empty stdout → failed; CRLF line endings → both markers parsed (probe P6); multiple wav lines → last wins (tested); duplicate subtitle lines → deduped (tested); URL truncated at 120 chars in error text; empty string / whitespace URL rejected. |
| Security | PASS | Adversarial traces: `--exec=…` and `-o/etc/passwd` "URLs" → TypeError (test + probe P4) — scheme allowlist AND `--` separator are independent layers; shell metacharacters stay one literal argv element (tested); `../` escape on both outputDir and cookies → TypeError (tested, + `a/../..` probe P5); traversal smuggled in the video marker value neutralized by `basename()` (probe P3); `%` in outputDir escaped to `%%` (tested); cookies handled as path only — zero file reads in the adapter (grep: 0 `readFile*`/`open(`), so contents can never reach a log; no `console.*` (grep: 0); `mode: "read"` (tested). |

## Loaded-Skill Criteria
Skill: `code-foundations:cc-defensive-programming` (CHECKER mode, full checklist)

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | GC-1 external input validated at entry | PASS | All five caller inputs (URL, outputDir, cookies, subLangs, sleepRequests) validated at `buildArgs` entry; child stdout (also external) validated via marker + on-disk existence before `done`. |
| cc-defensive-programming | GC-2/GC-3 assertions for bugs only, never for anticipated errors | PASS | No assertions used; anticipated bad input uses error handling (TypeError) — the correct side of the skill's assertion-vs-error table for external input. |
| cc-defensive-programming | EC-2 exceptions carry full background | PASS | Every TypeError names the opt key, the offending value (truncated/JSON-stringified), and for traversal both resolved path and cwd (lines 318-320). |
| cc-defensive-programming | EC-3 no empty catch blocks | PASS | Zero try/catch in the file; failures propagate as typed results or throws. |
| cc-defensive-programming | SM-1 path traversal: allowlist, not `../`-filtering | PASS | Containment by `resolve` + `relative()` prefix check (semantic containment, not string-filtering `../`) — probe P5 shows a non-literal escape (`a/../..`) is caught. |
| cc-defensive-programming | SM-3 command injection (CLI) | PASS | argv array (no string concat), `shell:false` upstream, `--` end-of-options, scheme allowlist — traced via tests at lines 304-320 + probe P4. |
| cc-defensive-programming | RF-6 allowlist-based validation | PASS | http(s) scheme allowlist for URL; `webm|mp4|mkv|mov` extension allowlist for the video marker. |
| cc-defensive-programming | SO-4/RF-5 error text leaks nothing sensitive | PASS | Errors echo only the caller's own supplied values back to the MCP caller; cookies file contents never read, so never echoable. |
| cc-defensive-programming | GH-3 barricade containment | PASS | Single entry barricade in `buildArgs`; `parseResult` re-validates the child's claims (defense-in-depth on the security-critical output path), per the skill's "validate again on security paths". |
| cc-defensive-programming | RF-12 fallback masking failure | PASS (by spec) | Dropping a video whose resolved file is missing is the dispatch-specified behavior ("dropped, not fatal; audio remains the classification key"), documented at lines 210-214, and the summary omits the video note so the caller can see it's absent. |

## Notes (non-blocking)
- **N1 (fragment marker — could not demonstrate in-domain):** there is no code-level `\.f\d+\.` filter; DW-4.6's "never a `.fNNN.` fragment" rests on the header's documented verification (real yt-dlp 2026.07.04: `post_process` `%(filepath)s` is only ever the merged file or the wav, never a fragment). My probe P2 shows a *fabricated* `SDD_VIDEO_PATH:a.f251.webm` as the last marker line WOULD be selected when that file exists (`-k` keeps fragments on disk). I could not demonstrate that real yt-dlp ever emits such a line (network/real binary forbidden for this review), so this is a suspicion, not a defect. Cheap hardening if wanted: reject basenames matching `/\.f\d+\./` in `VIDEO_PATH_LINE_RE` or after the match.
- **N2 (stale comment):** test/adapter-yt-dlp.test.ts:103 says "(see also the real-binary test)" — no real-binary/E2E yt-dlp test exists under `test/` (grep confirms). Comment should be corrected or the referenced test restored.
- **N3:** `VIDEO_PATH_LINE_RE` carries the `i` flag, so a lowercase `sdd_video_path:` line would also match — harmless (nothing else emits that prefix) but slightly wider than the emitted marker.

## Issues
None blocking.

**Verdict: PASS**
