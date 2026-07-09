# Review: Phase 4 - yt-dlp adapter (sample 3)

## Executed Results (Step 0)
- Test suite (focused): `bun test test/adapter-yt-dlp.test.ts` → 27 pass / 0 fail (90 expect calls)
- Test suite (full): `bun test` → 203 pass / 0 fail across 15 files
- Typecheck: `bunx tsc --noEmit` → clean (exit 0)
- Coverage: `bun test test/adapter-yt-dlp.test.ts --coverage` → `src/adapters/yt-dlp.ts` **100.00% funcs / 100.00% lines**
- Lint: no separate lint command configured in this repo; typecheck (strict + noUncheckedIndexedAccess) is the gate per CLAUDE.md.

## Requirement Fulfillment

### DW-4.1
PREMISE:  `buildArgs` places all flags before the positional URL and never after it.
EVIDENCE: src/adapters/yt-dlp.ts:85–120 — fixed flag block (85–99), optional groups (101–110), marker flags (115), then `argv.push("--", url)` at :119 as the final statement; nothing is appended after.
TRACE:    `buildArgs(URL, {outputDir, cookies, subLangs, sleepRequests})` → argv = [`yt-dlp`, `-x`, …, `--sleep-requests`, `2`, `--print`, `after_move:filepath`, `--no-simulate`, `--no-quiet`, `--`, URL] → URL is the last element; every dash-prefixed element indexes strictly below it.
VERDICT:  PASS — `test_DW_4_1_url_is_last_argv_element_all_flags_before_it` and `test_DW_4_1_end_of_options_separator_immediately_precedes_url` (test/adapter-yt-dlp.test.ts:34, :58), both passing.

### DW-4.2
PREMISE:  `parseResult` returns `failed` on exit 0 when the expected audio artifact is absent.
EVIDENCE: src/adapters/yt-dlp.ts:140–157 — marker line extracted (:140), then `existsSync(wavPath)` (:150); absent file → `{status:"failed", …silent-success guard}` (:151–156). No-marker-line case also fails (:141–148).
TRACE:    stdout containing `<tmp>/never-written.wav` on its own line, exitCode 0, file never written → `existsSync` false → `status:"failed"`, summary names the path and "does not exist".
VERDICT:  PASS — `test_DW_4_2_exit_0_with_absent_audio_file_is_failed` (:87) plus the no-marker backstop test (:95), both passing; the check is a real on-disk `existsSync`, not a stdout grep.

### DW-4.3
PREMISE:  `parseResult` returns `done` with the audio path in `artifacts` on exit 0 + file present.
EVIDENCE: src/adapters/yt-dlp.ts:158–167 — `{status:"done", artifacts:[wavPath, ...subtitles]}`.
TRACE:    real temp `.wav` written, its absolute path as the last stdout line, exitCode 0 → marker matched → `existsSync` true → `done`, `artifacts[0]` === the wav path (absolute).
VERDICT:  PASS — `test_DW_4_3_exit_0_and_existing_wav_is_done_with_artifact` (:103) and subtitle-append test (:113), both passing.

### DW-4.4
PREMISE:  a `../`-escaping `outputDir` throws a `TypeError` before spawn.
EVIDENCE: src/adapters/yt-dlp.ts:241–252 (`resolveContained`: `relative(base, resolved)` starting with `..` or absolute → `throw new TypeError`), reached from `resolveOutputDir` (:195–201) inside `buildArgs` (:83). Pre-spawn: src/lib/jobs.ts:242–243 calls `injectContract` then `buildArgs` inside `#buildArgv`, whose result feeds `#spawnAndTrack` — a throw here aborts dispatch before any child exists.
TRACE:    `buildArgs(URL, {cwd: <tmp>, outputDir: "../../etc"})` → `resolve(tmp, "../../etc")` escapes base → `relative()` starts with `..` → TypeError thrown; no argv returned, nothing spawnable.
VERDICT:  PASS — `test_DW_4_4_dotdot_escaping_outputDir_throws_TypeError` (:175) and `test_DW_4_4_deep_dotdot_escape_throws_TypeError` (:180), both passing; inside-cwd relative path counter-test (:190) confirms no over-rejection.

### DW-4.5
PREMISE:  identity `injectContract` returns the URL unchanged.
EVIDENCE: src/adapters/yt-dlp.ts:125–127 — `return prompt;`.
TRACE:    `injectContract(URL)` → URL, byte-identical; hostile metacharacter string → returned verbatim (never evaluated — spawned as one argv element with `shell:false`).
VERDICT:  PASS — `test_DW_4_5_injectContract_is_identity` (:216), passing.

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have corresponding tests with DW-IDs in the names, all ran in Step 0
- [x] Coverage matches the stated 100% level: measured 100% funcs / 100% lines on src/adapters/yt-dlp.ts

## Edge cases + security (prompt-listed)
| Listed case | Status | Evidence |
|---|---|---|
| exit≠0 → `failed` + stderr tail | PASS | yt-dlp.ts:130–138 + `stderrTail` (:254–259); tests :150, :158 (path line cannot rescue nonzero exit), :166 (tail truncated <600 chars, keeps the actionable end) |
| exit 0 + no audio file → `failed`, real existence check | PASS | `existsSync` at :150; tests :87, :95 |
| URL-as-option (`--exec=…`, `-o/etc/passwd`) not option-parsed | PASS | Two independent layers: `validateUrl` (:176–188) requires `^https?://` and no whitespace/control chars (allowlist — `--exec=…`, `-o/etc/passwd`, `file:///etc/passwd` all rejected with TypeError, tests :231, :235); AND structural `--` end-of-options immediately before the URL (:119, test :58). Shell metachars inert as one argv element (test :224). |
| Traversal barricade on `cookies`; contents never echoed | PASS | `resolveOptionalCookies` → same `resolveContained` (:204–211); test :185. Adapter handles only the PATH — no fs read of the cookies file anywhere in the file; grep of src/adapters confirms no `console.*` and no cookie-content access, so contents cannot reach stdout/logs via this adapter. |
| `mode === "read"`, no `console.*` | PASS | :64 `mode: AdapterMode = "read"`; `grep console\. src/adapters/yt-dlp.ts` → 0 matches; test :256 asserts both mode and `probeable:false`. Discovery test :261 confirms scan pickup. |

## Dead Code
None found. No unused imports (all six node/path imports used), no unreachable code, no debug statements; `_check`/`void _check` (:261–262) is a deliberate compile-time shape assertion, not dead code.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | Pure functions, no shared mutable state. Probed the one hazard: module-level `g`-flag regexes (:74, :79) reused across calls — they are only ever consumed via `matchAll`, which clones the regex and never mutates the source's `lastIndex` (and the source is never `exec`'d), so no cross-call statefulness; repeated in-process `parseResult` calls in the suite all pass. |
| Error Handling | PASS | Untrusted input → TypeErrors at entry (correct per assertion-vs-error-handling table: external input gets error handling, not assertions). Probed `parseResult` throwing on hostile stdout (e.g. NUL byte in a matched path makes `existsSync` throw): JobStore invariant contains a throwing `parseResult` → `failed`, per CLAUDE.md; nonzero exit short-circuits before any parsing (:130). |
| Resources | N/A | No handles, connections, locks, or processes owned here — `existsSync` is stat-and-return; spawning lives in JobStore. |
| Boundaries | PASS | Probed: empty stdout (no-marker → failed, test :95); multiple marker lines (last wins, test :138); `\r` line endings handled (`\r?$` :74, :79); empty stderr (no dangling " — stderr tail:", :256); >400-char stderr truncated from the END keeping the actionable error (test :166); empty/whitespace URL rejected (:177, test :239); `rel === ".."` exact-parent edge covered (:246); `%` in outputDir escaped so a legal dir name can't become a template field (:98, test :208). |
| Security | PASS | Argv-array + `shell:false` (JobStore) + scheme allowlist + control-char reject + `--` separator = layered option-injection defense; allowlist-based (RF-6 satisfied). Traversal: containment via `relative()` semantics, not `../` string filtering (SM-1's "good" form). Error messages echo only what the caller supplied (truncated) — no secrets leaked (SO-4). |

## Loaded-Skill Criteria (cc-defensive-programming)
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | GC-1 external input validated at entry | PASS | Every untrusted field (prompt URL, outputDir, cookies, subLangs, sleepRequests) validated before argv assembly (:82–110, :176–231); type-level `DispatchOpts` index signature is `unknown`, so the runtime `typeof` checks are load-bearing and present. |
| cc-defensive-programming | GC-3 / RF-9 assertions only for never-occur bugs | PASS | No assertions used; all anticipated bad input handled with thrown TypeErrors (error handling), matching the skill's table for external input. |
| cc-defensive-programming | EC-3 / RF-2 no empty catch blocks | PASS | Zero catch blocks in the adapter; containment of parse throws is the JobStore's documented job. |
| cc-defensive-programming | SM-1 path traversal via allowlist containment | PASS | `resolveContained` (:241–252) uses `relative()`-based containment, not `../` substring filtering; escaping paths TypeError'd pre-spawn (tests :175, :180, :185). |
| cc-defensive-programming | SM-3 / RF-7 command injection — no shell string concatenation | PASS | argv is a structural array; URL is a single element after `--`; `shell:false` upstream. No string-built command anywhere. |
| cc-defensive-programming | SO-4 error messages don't aid attackers | PASS | TypeError messages echo the caller's own (truncated) input and resolved paths back to the caller who supplied them; no internal secrets, no cookie contents. |
| cc-defensive-programming | RF-12 fallback masking failure | PASS | No silent defaults: absent marker/file → explicit `failed` with reason; malformed optional opts throw rather than being dropped (test :244). |
| cc-defensive-programming | Barricade design (GH-3) | PASS | Single entry barricade in `buildArgs`; private helpers assume validated data past it — matches the class-level barricade pattern. |

## Notes (non-blocking)
- `parseResult` performs filesystem I/O (`existsSync`) although the repo doctrine describes adapters as "no I/O". The dispatch requirements explicitly mandate a "real on-disk existence check", so this is required behavior, not a defect — but the CLAUDE.md adapter-layer description is now slightly stale.
- An **absolute** `outputDir`/`cookies` path bypasses containment by design (":242 — explicit caller-specified target", documented agy-image precedent). DW-4.4 only covers relative `../` escapes, so this is a design observation, not a finding.
- SSRF (SM-2) in the internal-network sense (e.g. `http://169.254.169.254/…`) is not blocked — the tool's purpose is fetching caller-named http(s) URLs, and only the scheme is restricted. Not a listed requirement; flagging for awareness only.
- `-o/etc/passwd` is not tested verbatim, but the tested `--exec=…` and `file://` rejections exercise the identical `^https?://` allowlist branch that rejects it.

## Issues
None.

**Verdict: PASS**
