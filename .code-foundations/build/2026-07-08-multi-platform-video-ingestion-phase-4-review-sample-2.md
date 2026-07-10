# Review: Phase 4 - yt-dlp adapter (sample 2)

## Executed Results (Step 0)
- Test suite (focused): `bun test test/adapter-yt-dlp.test.ts` → 27 pass, 0 fail, 90 expect() calls
- Test suite (full): `bun test` → 203 pass, 0 fail, 593 expect() calls across 15 files
- Typecheck: `bunx tsc --noEmit` → exit 0, no errors
- Lint: no separate lint command exists in this project (CLAUDE.md defines only `bun test` + `bunx tsc --noEmit`); strict tsc serves that role → clean

## Requirement Fulfillment

### DW-4.1
PREMISE:  `buildArgs` places all flags before the positional URL and never after it.
EVIDENCE: src/adapters/yt-dlp.ts:85-120 — all flags pushed first; the final statement is `argv.push("--", url); return argv;` (lines 119-120), so nothing can follow the URL.
TRACE:    `buildArgs(URL, {outputDir, cookies, subLangs, sleepRequests})` → base flags → optional flag groups → marker flags → `["--", url]` last → URL is `argv[argv.length-1]`, every dash-prefixed element indexed strictly before it.
VERDICT:  PASS — `test_DW_4_1_url_is_last_argv_element_all_flags_before_it` and `test_DW_4_1_end_of_options_separator_immediately_precedes_url` executed and passed (exercises ALL optional opts simultaneously, asserting every `-`-prefixed element precedes the URL index).

### DW-4.2
PREMISE:  `parseResult` returns `failed` on exit 0 when the expected audio artifact is absent.
EVIDENCE: src/adapters/yt-dlp.ts:150-157 — `if (!existsSync(wavPath))` → `status: "failed"` with "silent-success guard" summary; lines 140-148 also fail when no path line exists at all.
TRACE:    stdout containing an absolute `.wav` path line for a never-written file, exit 0 → regex matches → `existsSync` false (real on-disk check) → `failed`, summary contains path + "does not exist".
VERDICT:  PASS — `test_DW_4_2_exit_0_with_absent_audio_file_is_failed` executed and passed; the no-path-line-at-all variant ("silent-misparse backstop") also executed and passed.

### DW-4.3
PREMISE:  `parseResult` returns `done` with the audio path in `artifacts` on exit 0 + file present.
EVIDENCE: src/adapters/yt-dlp.ts:158-167 — `status: "done"`, `artifacts: [wavPath, ...subtitles]`.
TRACE:    real temp `.wav` written to disk; stdout carries its absolute path as the last path line; exit 0 → last-occurrence match → `existsSync` true → `done`, `artifacts[0]` = absolute wav path; existing `.vtt` appended, non-existent ghost sub filtered.
VERDICT:  PASS — `test_DW_4_3_exit_0_and_existing_wav_is_done_with_artifact` and `test_DW_4_3_existing_subtitles_are_appended_to_artifacts` executed and passed.

### DW-4.4
PREMISE:  a `../`-escaping `outputDir` throws a `TypeError` before spawn.
EVIDENCE: src/adapters/yt-dlp.ts:241-252 (`resolveContained`); before-spawn ordering: src/lib/jobs.ts:242-243 calls `injectContract` then `buildArgs` inside `#buildArgv`, invoked before `#spawnAndTrack` (jobs.ts:114) — a throw propagates out of `dispatch` with no child process created.
TRACE:    `buildArgs(URL, {cwd: tmp, outputDir: "../../etc"})` → `resolve(tmp, "../../etc")` → `relative(tmp, resolved)` starts with `..` → `TypeError` thrown; `buildArgs` is a pure function executed before any spawn in the JobStore flow.
VERDICT:  PASS — `test_DW_4_4_dotdot_escaping_outputDir_throws_TypeError` and `test_DW_4_4_deep_dotdot_escape_throws_TypeError` executed and passed; a contained relative path (`media/../audio`) is resolved, not rejected (also executed and passed — no false positive).

### DW-4.5
PREMISE:  identity `injectContract` returns the URL unchanged.
EVIDENCE: src/adapters/yt-dlp.ts:125-127 — `return prompt;`.
TRACE:    `injectContract(url)` → same string reference back, including a hostile URL with shell metacharacters, byte-identical.
VERDICT:  PASS — `test_DW_4_5_injectContract_is_identity` executed and passed.

**All requirements met:** YES

## Test-DW Coverage
- [x] All 5 DW items have DW-ID-named tests that ran in Step 0 (`test_DW_4_1_*` ×2, `test_DW_4_2_*`, `test_DW_4_3_*` ×2, `test_DW_4_4_*` ×2, `test_DW_4_5_*`)
- [x] Coverage matches the stated 100% level: every exported function (`buildArgs`, `injectContract`, `parseResult`) and every validator branch (URL, outputDir, cookies, subLangs, sleepRequests, `%`-escape, stderr tail, dedupe, last-occurrence) is exercised across the 27 focused tests
- No gaps.

## Edge cases + security (prompt-listed)
| Case | Handled | Evidence |
|---|---|---|
| exit≠0 → `failed` with stderr tail | YES | yt-dlp.ts:130-139 + `stderrTail` (254-259); tests "non-zero exit is failed and carries the stderr tail" (login-required), "a very long stderr is truncated" (rate-limited), "a present audio-path line cannot rescue a non-zero exit" — all passed |
| exit 0 + no audio file → `failed`, real existence check | YES | `existsSync(wavPath)` at yt-dlp.ts:150 — real on-disk check; DW-4.2 tests passed |
| URL-as-option (`--exec=...`, `-o/etc/passwd`) not option-parsed; malformed/non-http rejected | YES | two independent layers: scheme allowlist `^https?:\/\//i` + whitespace/control-char rejection (yt-dlp.ts:176-188) AND structural `--` end-of-options separator immediately before the URL (line 119). `--exec=touch /tmp/pwned`, `file:///etc/passwd`, `https://a.com/x --exec=evil`, `""` all throw TypeError — tests passed |
| Traversal barricade on `cookies`; contents never echoed | YES | `resolveOptionalCookies` → same `resolveContained` (yt-dlp.ts:204-211); test "dotdot-escaping cookies path throws" passed. Adapter handles only the PATH — no read of the file anywhere, so contents cannot reach summary/raw/logs (grep: no fs read of cookies) |
| `mode` is `"read"`; no `console.*` | YES | yt-dlp.ts:64 `mode: AdapterMode = "read"`; `grep -n "console\." src/adapters/yt-dlp.ts` → 0 matches; test "mode is read and the adapter opts out of live probing" passed |

## Dead Code
None found. No unused imports (all seven `node:fs`/`node:path` imports and `lastMarkerMatch` are used), no unreachable code, no debug statements, no commented-out blocks. `const _check: Adapter = {...}; void _check;` (lines 261-262) is a deliberate compile-time shape check, not dead code.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Adapter is pure functions, no shared mutable state. Probed the one candidate: `AUDIO_PATH_LINE_RE`/`SUBTITLE_LINE_RE` are module-level `/g` regexes — stale-`lastIndex` risk — but both are consumed only via `matchAll` (lastMarkerMatch, yt-dlp.ts:158), which never mutates the source regex's `lastIndex`; no `.exec`/`.test` on a `/g` regex exists. No defect demonstrable. |
| Error Handling | PASS | Every untrusted input path (URL, outputDir, cookies, subLangs, sleepRequests) throws a typed `TypeError` with an actionable, truncated message (URL truncated at 120 chars — no unbounded attacker-controlled echo); exit≠0 / missing marker / missing file each return distinct `failed` results. Malformed-opts tests (`outputDir: 42`, `sleepRequests: "2"`, `cookies: ""`) passed — DispatchOpts's `[k: string]: unknown` index signature makes these runtime guards the real barricade, and they hold. |
| Resources | N/A | No handles, connections, or processes opened by the adapter (pure port); `existsSync` allocates nothing to release. |
| Boundaries | PASS | Probed: empty stdout → no-path-line `failed` branch (test passed); empty stderr → `stderrTail` returns "" (no dangling " — stderr tail:"); 5000-char stderr → 400-char tail (test passed); multiple wav lines → LAST wins (test passed); duplicate subtitle lines → deduped via Set (test passed); `%` in outputDir → escaped to `%%` (test passed); `outputDir: ".."` exactly → `rel === ".."` branch catches it (yt-dlp.ts:246). |
| Security | PASS | Option injection blocked by two independent layers (scheme allowlist + `--` separator, both test-verified); path traversal blocked for outputDir AND cookies via containment check (`relative()` allowlist semantics, not a `../` string filter); shell metacharacters inert (argv array element verbatim — test passed); cookies contents unreachable by the adapter. |

## Loaded-Skill Criteria (cc-defensive-programming, CHECKER)
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | GC-1 external input validated at entry | PASS | All five untrusted inputs validated in dedicated entry-point validators before argv construction (yt-dlp.ts:176-231) |
| cc-defensive-programming | GC-3 / RF-9 assertions only for never-occur conditions | PASS | No assertions used; anticipated bad input uses error handling (TypeError), matching the barricade table — correct side of the assertion/error split |
| cc-defensive-programming | EC-3 / RF-2 no empty catch blocks | PASS | Zero try/catch in the adapter; a throwing `parseResult` is contained to `failed` by JobStore per repo invariant |
| cc-defensive-programming | EC-2 exceptions carry background info | PASS | Every TypeError names the offending key, the (truncated) value, and for traversal the resolved path + cwd (yt-dlp.ts:247-249) |
| cc-defensive-programming | SM-1 path traversal: allowlist, not `../` filter | PASS | Containment via `relative(base, resolved)` prefix check — allowlist semantics; `media/../audio` inside cwd correctly ACCEPTED (test passed), so it is not a naive string denylist |
| cc-defensive-programming | SM-3 command injection (CLI tool) | PASS | argv array + `shell:false` (JobStore) + `--` separator + scheme allowlist; no string concatenation into a shell anywhere |
| cc-defensive-programming | RF-6 allowlist-based validation | PASS | URL: `^https?:\/\//i` allowlist primary; control-char denylist is a second layer behind the structural `--`, not the sole defense |
| cc-defensive-programming | SO-4 / RF-5 error messages don't aid attackers | PASS | URL echo truncated to 120 chars; no stack traces in summaries; stderr tail capped at 400 chars (required by spec for actionability) |
| cc-defensive-programming | RF-12 fallback masking failure | PASS | No silent defaults: malformed optional opts THROW rather than being dropped (test "malformed optional opts throw TypeErrors instead of being dropped" passed); missing marker/file are distinct `failed` results, never coerced to `done` |
| cc-defensive-programming | GH-3 barricade design | PASS | Class-level barricade pattern: `buildArgs` (public entry) validates everything; helpers past it assume validated data — matches agy-image precedent named in the header |

## Notes (non-blocking)
- `AUDIO_PATH_LINE_RE` anchors on a leading `/` (POSIX-only), documented as a deliberate darwin-target assumption (yt-dlp.ts:70-73). Fine here; would need revisiting for Windows support.
- The `--` separator's protection assumes yt-dlp honors POSIX end-of-options (it does — yt-dlp uses optparse semantics supporting `--`); the scheme allowlist makes this a defense-in-depth pair rather than a single point of failure regardless.
- Symlink-based escape of the containment check (a contained relative path whose intermediate component is a symlink out of cwd) is not resolved via `realpath` — same semantics as the existing agy-image barricade, an absolute `outputDir` is allowed anyway by design, and no requirement lists it. Observation only.

## Issues
None.

**Verdict: PASS**
