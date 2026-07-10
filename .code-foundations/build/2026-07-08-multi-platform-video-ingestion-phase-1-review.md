# Review: Phase 1 - preflight tooling check

## Executed Results (Step 0)
- Test suite: `bun test` → 164 pass, 0 fail, 465 expect() calls across 13 files (`test/preflight.test.ts` alone: 13 pass, 55 expect() calls, 277ms)
- Typecheck: `bunx tsc --noEmit` → clean (no output, exit 0)
- Lint: no separate lint command configured in this repo; typecheck is the strict gate per CLAUDE.md
- Direct CLI run (`bun run src/lib/preflight.ts`, real host PATH): printed valid JSON, `ok:false` (yt-dlp/mlx-whisper absent, ffmpeg present at 8.1.1 on this machine), exit code 1

## Requirement Fulfillment

### DW-1.1
PREMISE:  `preflight()` returns `ok:false` with a per-tool `hint` when a binary is absent (test stubs PATH).
EVIDENCE: `src/lib/preflight.ts:262-265` (`probeTool`: `Bun.which` miss → `{name, found:false, hint: spec.installHint}`); `test/preflight.test.ts:72-86` (`test_DW_1_1_reports_ok_false_with_hint_when_binary_absent`)
TRACE:    `preflight(undefined, {PATH: emptyDir})` → `Bun.which("yt-dlp"/"mlx_whisper"/"ffmpeg", {PATH: emptyDir})` resolves `undefined` for all three → each `probeTool` short-circuits to `found:false` with a non-empty `hint` → `preflight.ok = results.every(r => r.hint === undefined)` = false.
VERDICT:  PASS (ran: 13/13 pass in `test/preflight.test.ts`, this test included)

### DW-1.2
PREMISE:  `preflight()` returns `ok:true` with resolved versions when all three are present.
EVIDENCE: `src/lib/preflight.ts:266-270` (version resolved, attached to result); `test/preflight.test.ts:91-104` (`test_DW_1_2_reports_ok_true_with_versions_when_all_present`)
TRACE:    fixture `yt-dlp`→"2024.12.13", `mlx_whisper`→"mlx_whisper 0.4.2", fake `ffmpeg`→"8.1.1" + full encoder set on a scoped PATH → each `probeTool` resolves via `Bun.which`, `probeVersion` parses a version string, no `minVersion` set on any real spec so no outdated hint, `probeMissingCapabilities` finds `mjpeg`/`png`/`pcm_s16le` all present → no hint on any tool → `ok:true`, each tool object matches `{name, found:true, version}` exactly.
VERDICT:  PASS (ran, passing)

### DW-1.3
PREMISE:  README documents install for all three (yt-dlp, mlx-whisper, ffmpeg) + the Instagram cookies/nightly caveat.
EVIDENCE: `README.md:87-108` ("Video ingestion setup" table + "Instagram caveat" section); `test/preflight.test.ts:304-320` (`test_DW_1_3_readme_documents_all_three_tools_and_instagram_caveat`)
TRACE:    Read `README.md` directly — table lists `yt-dlp` (`brew install yt-dlp`), `ffmpeg` (`brew install ffmpeg`), `mlx-whisper` (`pip install -U mlx-whisper`); "Instagram caveat" subsection names cookies export via `yt-dlp --cookies <path>` and the nightly channel (`pip install -U --pre "yt-dlp[default]"`). Regex assertions in the test all matched against the live file content.
VERDICT:  PASS (ran, passing)

### DW-1.4
PREMISE:  no `console.*` in the library code path (grep-clean; only the `import.meta.main` branch prints).
EVIDENCE: `src/lib/preflight.ts:327-331` (CLI branch uses `process.stdout.write`, not `console.*`); `test/preflight.test.ts:265-271` (`test_DW_1_4_no_console_usage_anywhere_in_preflight_source`)
TRACE:    `grep -n "console\." src/lib/preflight.ts` (run directly) → no matches, including inside the `import.meta.main` block, which calls `process.stdout.write(JSON.stringify(...))` and `process.exit(...)` instead.
VERDICT:  PASS (grep run directly + test passing)

### DW-1.5
PREMISE:  `bun run src/lib/preflight.ts` prints valid JSON and exits non-zero when a tool is missing.
EVIDENCE: `src/lib/preflight.ts:327-331` (CLI entry); `test/preflight.test.ts:281-298` (`test_DW_1_5_cli_prints_valid_json_and_exits_nonzero_when_tool_missing`)
TRACE:    Ran `bun run src/lib/preflight.ts` directly against the real host PATH — stdout was valid JSON (`JSON.parse` succeeded), `ok:false`, exit code 1 (yt-dlp/mlx-whisper absent on this machine). Test additionally spawns the same command with PATH forced to an empty dir for determinism, asserts `exitCode !== 0`, `JSON.parse(stdout)` succeeds, `ok:false`, and at least one tool has `found:false` + a string `hint`.
VERDICT:  PASS (both my own direct run and the automated test pass)

**All requirements met:** YES

## Test-DW Coverage
- [x] DW-1.1 → `test_DW_1_1_reports_ok_false_with_hint_when_binary_absent` (ran, pass)
- [x] DW-1.2 → `test_DW_1_2_reports_ok_true_with_versions_when_all_present` (ran, pass)
- [x] DW-1.3 → `test_DW_1_3_readme_documents_all_three_tools_and_instagram_caveat` (ran, pass)
- [x] DW-1.4 → `test_DW_1_4_no_console_usage_anywhere_in_preflight_source` (ran, pass) + independently re-grepped, clean
- [x] DW-1.5 → `test_DW_1_5_cli_prints_valid_json_and_exits_nonzero_when_tool_missing` (ran, pass) + independently re-ran the CLI directly
- [x] All three listed edge cases also covered by named tests (see below)
- Coverage matches the stated 100% level — every exported function (`preflight`, `DEFAULT_TOOL_SPECS`) and every branch in `probeTool` (absent / present-clean / outdated / missing-capability / OR-group-satisfied / hung probe / unparseable probe / unknown-name throw / subset filter) has a dedicated test, all passing.

## Dead Code
None found. No TODO/FIXME/debugger markers, no unreachable code after returns, no commented-out blocks in `src/lib/preflight.ts` or `test/preflight.test.ts`.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | `preflight()` runs `Promise.all(selected.map(probeTool))` (`preflight.ts:318`) — each `probeTool` call is independent (own `Bun.spawn`, no shared mutable state), so no interleaving hazard. Traced: fanning out 3 tools concurrently produces 3 independent results, order-preserved by `Promise.all`. |
| Error Handling | PASS | `runProbe` (`preflight.ts:199-219`) wraps spawn + timeout race in try/catch, resolving `undefined` on any spawn failure — never throws, never hangs. Traced the "hang-tool" and "bad-tool" fixture tests: a probe that never exits is killed at `probeTimeoutMs` and still returns `found:true` with no version; a probe that exits non-zero with unparseable stdout still returns `found:true`. The only real throw path is intentional (`preflight(["unknown-name"])` → `TypeError`, validated input). |
| Resources | PASS | `runProbe` kills the child (`proc.kill()`) on timeout before returning (`preflight.ts:210-212`); the hang-tool test (a `while true` loop running directly in the `/bin/sh` process, no grandchild fork) confirms the process is actually terminated rather than leaking — `probeTimeoutMs: 200` test returns within its own test timeout, i.e., the kill worked. No file handles or locks are opened outside the spawn's own stdout/stderr pipes, which are always drained or abandoned-with-kill. |
| Boundaries | PASS | `compareVersions` (`preflight.ts:182-191`) uses `?? 0` against `noUncheckedIndexedAccess`-checked indices, handling unequal segment-count comparisons (e.g. "1.0" vs "1.0.0") without an out-of-bounds read. `parseFfmpegEncoders`/`parseYtDlpVersion`/`parseMlxWhisperVersion` all use `?.` on regex/array results and return `undefined` rather than throwing on empty/malformed input. |
| Security | PASS | Version/capability probes are spawned via `Bun.spawn([resolvedPath, ...args], ...)` — an argv array, never a shell string — consistent with the project's spawn barricade. `versionArgs`/`capabilityArgs` come from static, code-owned `ToolSpec`s, not runtime user input, so there's no injection surface. The one true external input, the `tools: string[]` filter, is validated against the spec registry and rejected with `TypeError` on an unknown name (`preflight.ts:306-316`), traced via the "unknown tool name" test. |

## Loaded-Skill Criteria

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | No executable code in assertions | N/A | File contains no `assert`/`console.assert` statements at all. |
| cc-defensive-programming | No empty catch blocks | PASS | Sole `catch` block (`preflight.ts:216-218`) returns `undefined`, not empty — traced via the "bad probe" test, which drives a spawn that exits non-zero and confirms the module degrades gracefully rather than swallowing silently. |
| cc-defensive-programming | External input validated at entry | PASS | `preflight(tools, options)`'s `tools` parameter — the one value crossing a module boundary from a caller (the future video-ingest skill) — is validated against `specs` and rejected via `TypeError` on an unrecognized name (`preflight.ts:306-316`), traced and confirmed by the "unknown tool name" test (`rejects.toThrow(TypeError)`). |
| cc-defensive-programming | Assertions for bugs only | N/A | No assertions used; all anticipated-failure paths (missing binary, failed probe, bad parse, timeout) go through error-handling / fault-tolerant returns per the barricade design, not assertions. |
| code-clarity-and-docs | Interface comments define the abstraction, don't restate the code | PASS | Sampled every exported interface/function doc (`PreflightToolResult`, `PreflightResult`, `ToolSpec`, `preflight`, `runProbe`, `probeTool`) — each uses different words than the entity name and states rationale (e.g., why `found` is decided by presence alone, why capability checks never short-circuit), passing the "different words" test. |
| code-clarity-and-docs | README accuracy | PASS | Cross-checked every README claim in the "Video ingestion setup" section against actual runtime behavior: the documented `bun run src/lib/preflight.ts` command was run directly and its real output (JSON, exit 1) matches the README's description; install commands match `DEFAULT_TOOL_SPECS[*].installHint` verbatim. |

## Notes (non-blocking)
- `test/preflight.test.ts` imports from `node:fs` twice on separate lines (`mkdtempSync, rmSync, writeFileSync` on line 13, `readFileSync` on line 16) instead of one consolidated import — purely stylistic, no functional impact.
- None of the three real `DEFAULT_TOOL_SPECS` set a `minVersion`, so the "present but wrong/old version" edge case is exercised only through a synthetic spec in tests, not against real yt-dlp/mlx-whisper/ffmpeg thresholds. This is a documented, deliberate scope decision (module doc: "no real threshold is asserted here... none is sourced") rather than an omission — the mechanism itself is fully implemented and tested end-to-end through the real `preflight()` function, which is what the edge-case list asks to see handled.
- `runProbe`'s timeout path calls `proc.kill()` on the direct child only (no process-group kill). For the three real tools (`yt-dlp --version`, `ffmpeg -version`, `mlx_whisper --version`) this is a single-process invocation with no grandchildren, so it's not a demonstrated defect against any DW item or listed edge case — flagged here only as a hardening opportunity if a future tool's version probe forks subprocesses.

## Issues (if FAIL)
None.

**Verdict: PASS**
