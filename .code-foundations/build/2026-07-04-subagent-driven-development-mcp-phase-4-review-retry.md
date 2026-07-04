# Review: Phase 4 - agy / agy-image adapters (retry)

## Executed Results (Step 0)
- Test suite: `bun test` (full repo) → 85 pass, 0 fail, 211 expect() calls, across 8 files. Phase-4 subset alone (`bun test test/adapter-agy.test.ts test/adapter-agy-image.test.ts`) → 29 pass, 0 fail, 59 expect() calls.
- Typecheck: `bunx tsc --noEmit` → clean, no output, exit 0.
- Lint: no lint script defined in `package.json` (only `start`, `typecheck`, `test`). Nothing to run.
- Coverage (informational, via `bun test --coverage` on the phase-4 test files): `src/adapters/agy.ts` 100.00% funcs / 100.00% lines; `src/adapters/agy-image.ts` 100.00% funcs / 100.00% lines.

## Requirement Fulfillment

### DW-4.1
PREMISE:  agy buildArgs emits flags-before-`--print` with the prompt as the immediately-following single argv element (assert on the argv array).
EVIDENCE: `src/adapters/agy.ts:66-74` — `buildArgs` pushes optional `--model`/`--sandbox` flags first, then `return ["agy", ...flags, "--print", prompt];`. Nothing is ever pushed after this return, so the prompt is structurally the last array element and `--print` structurally the second-to-last.
TRACE:    `buildArgs("implement the feature", { model: "opus", sandbox: "workspace-write" })` → flags accumulate `["--model","opus","--sandbox","workspace-write"]` → returns `["agy","--model","opus","--sandbox","workspace-write","--print","implement the feature"]`. Test `test_DW_4_1_flags_all_precede_print_prompt_is_last_element` (test/adapter-agy.test.ts:24-32) asserts this exact array and that `argv.slice(printIdx+1)` is exactly `["implement the feature"]`. Ran in Step 0 — passes.
VERDICT:  PASS

### DW-4.2
PREMISE:  An agy run whose output lacks the required marker is classified failed, not done (silent-misparse backstop). ALSO verify the harder case: stdout containing an EARLY echoed marker line (e.g. an instruction echo `AGY_RESULT: DONE`) followed by a LATER real `AGY_RESULT: FAILED` must be classified failed — i.e. the LAST marker wins, not the first.
EVIDENCE: `src/adapters/agy.ts:51,60-64,87-96` — `RESULT_MARKER_RE` is `/^AGY_RESULT:\s*(DONE|FAILED)\s*$/gm`; `lastMarkerMatch` iterates `text.matchAll(re)` and keeps the final match; `parseResult` returns `failed` with a "missing AGY_RESULT marker" summary when no match is found.
TRACE:    Missing-marker case: `parseResult("some unrelated output with no marker at all", "", 0)` → `lastMarkerMatch` finds no match → `status: "failed"`, summary contains "missing AGY_RESULT marker" (test/adapter-agy.test.ts:44-48, ran, passes). Last-wins case: stdout = echoed instruction line `AGY_RESULT: DONE` then echoed `AGY_RESULT: FAILED` (both from the injected-contract text) then a real narrative failure then a final real `AGY_RESULT: FAILED` → `matchAll` yields 3 matches (DONE, FAILED, FAILED); `last` is the final `FAILED` match → `match[1] === "FAILED"` → `status: "failed"` (test/adapter-agy.test.ts:61-77, ran, passes). Symmetric positive case also verified: early echoed `DONE`+`FAILED` followed by a real final `DONE` → last match is `DONE`, exit 0 → `status: "done"` (test/adapter-agy.test.ts:87-96, ran, passes) — proving the mechanism is genuinely last-match, not just "reject on any FAILED seen".
VERDICT:  PASS

### DW-4.3
PREMISE:  agy-image returns the PNG absolute path in artifacts and is mode "read"; a missing output file → failed. ALSO verify: an opts.outputPath containing `../` that would escape the job cwd is REJECTED before spawn (path-traversal containment).
EVIDENCE: `src/adapters/agy-image.ts:43` (`export const mode: AdapterMode = "read";`), `:72-95` (`parseResult` — extracts `AGY_IMAGE_SAVED:` path via `lastMarkerMatch`, checks `existsSync(savedPath)`, returns `artifacts: [savedPath]` on success or `status:"failed"` with the path and "does not exist" in the summary on a missing file), `:113-145` (`resolveOutputPath`/`assertContained` — relative paths are resolved against cwd and checked via `relative(base, resolved)`; a result starting with `..`, `..${sep}`, or absolute is rejected with `TypeError` before `buildArgs` ever constructs argv).
TRACE:    Mode: `agyImage.mode === "read"` (test/adapter-agy-image.test.ts:29-31, ran, passes). Success path: a real PNG written to a temp dir, `parseResult` with a matching `AGY_IMAGE_SAVED:` line and exit 0 → `status:"done"`, `artifacts: [pngPath]`, `isAbsolute(artifacts[0])` true (test:33-44, ran, passes). Missing-file path: marker points at a path that was never written → `existsSync` false → `status:"failed"`, summary contains the path and "does not exist" (test:46-56, ran, passes). Traversal: `buildArgs("prompt", { cwd: dir, outputPath: "../../etc/evil.png" })` → `resolve(dir, "../../etc/evil.png")` lands two levels above `dir` → `relative(dir, resolved)` starts with `..` → `assertContained` throws `TypeError` before any argv is built (test:105-111, ran, passes); a deeper 6-level escape toward `.ssh/authorized_keys.png` is also rejected (test:113-118, ran, passes). I additionally hand-traced a case not in the checked-in suite — `outputPath: "a/../../b.png"` against a fresh temp dir — and confirmed via ad hoc execution that it is rejected with the expected `TypeError` message (escapes-cwd), and that a benign `sub/../sibling.png` (net-zero traversal, stays inside cwd) is correctly accepted, matching test:120-129.
VERDICT:  PASS

### DW-4.4
PREMISE:  Both adapters are found by discoverAdapters() with no edit to any central registry file.
EVIDENCE: `src/adapters/discover.ts:31` — `INFRA_FILES` is a fixed, adapter-count-independent set (`discover.ts`, `types.ts`); adding an adapter is dropping a file in the directory, never editing this set or any list. `test/adapter-agy.test.ts:120-128` and `test/adapter-agy-image.test.ts:149-157` call `discoverAdapters(join(import.meta.dir, "..", "src", "adapters"))` and assert both `agy` and `agy-image` are found with the correct `mode` and function-typed `buildArgs`/`injectContract`/`parseResult`.
TRACE:    `discoverAdapters(".../src/adapters")` → `readdirSync` lists `agy-image.ts`, `agy.ts`, `codex.ts`, `discover.ts`, `types.ts` (+ test files excluded by `.test.ts` filter) → `discover.ts`/`types.ts` skipped via `INFRA_FILES`; `agy.ts`, `agy-image.ts`, `codex.ts` loaded via `require`, validated via `toAdapter`, and pushed → `adapters.find(a => a.name === "agy")` and `.find(a => a.name === "agy-image")` both defined, with `mode` "write"/"read" respectively. Both tests ran in Step 0 — pass. No registry file (e.g. an adapter list/index) was edited to add either adapter — confirmed by inspection of `discover.ts` and by `git status`/diff scope limited to the two adapter files and their tests.
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] DW-4.1 — `test_DW_4_1_no_extra_flags_prompt_immediately_after_print`, `test_DW_4_1_flags_all_precede_print_prompt_is_last_element` (ran, pass)
- [x] DW-4.2 — `test_DW_4_2_missing_marker_on_exit_0_is_failed_misparse_backstop`, `test_DW_4_2_simulated_print_flag_self_answer_misparse_is_failed`, `test_DW_4_2_early_echoed_DONE_marker_followed_by_real_FAILED_marker_is_failed`, plus symmetric `early echoed FAILED marker followed by a later real DONE marker is done` (ran, pass)
- [x] DW-4.3 — `test_DW_4_3_mode_is_read`, `test_DW_4_3_valid_marker_and_existing_file_is_done_with_absolute_artifact`, `test_DW_4_3_missing_output_file_is_failed_with_reason`, `test_DW_4_3_dotdot_escaping_outputPath_is_rejected_before_spawn`, plus deeper-escape variant (ran, pass)
- [x] DW-4.4 — `test_DW_4_4_agy_discovered_via_directory_scan`, `test_DW_4_4_agy_image_discovered_via_directory_scan` (ran, pass)
- [x] All DW items have corresponding tests that ran in Step 0
- [x] Coverage matches the stated 100% level — measured coverage tool confirms 100% funcs/lines on both `agy.ts` and `agy-image.ts` from the phase-4 test files alone

## Dead Code
None found. No empty catch blocks (neither file contains a `catch` in executable code — grep confirms the only "catch" hits are in prose comments). No unused imports (`agy-image.ts` imports `existsSync`, `isAbsolute`, `relative`, `resolve`, `sep` — all used; `agy.ts` imports only type-only `Adapter`/`AdapterMode`/`AdapterResult`/`DispatchOpts`, all used). No unreachable code after early returns — both `parseResult` implementations are a clean sequence of early-return guard clauses with no code following a terminal return.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Adapters are pure functions (no shared state, no async, no I/O beyond a single synchronous `existsSync` read); no concurrency surface exists in these two files. |
| Error Handling | PASS | Malformed `opts.model`/`opts.sandbox`/`opts.outputPath` (wrong type, empty string, wrong extension, non-string `opts.cwd`) all throw `TypeError` at entry rather than silently coercing or dropping (agy.ts:111-118, agy-image.ts:113-126); non-zero exit code and missing markers are both explicitly handled as `failed`, never left to fall through. |
| Resources | N/A | No file handles, connections, locks, or caches are opened by either adapter; `existsSync` is a single synchronous stat call with no handle to leak. |
| Boundaries | PASS | Traced adversarial inputs: empty string `outputPath`, non-`.png` extension, absolute vs. relative paths, single- and multi-level `../` escapes, and a net-zero `sub/../sibling.png` — all resolve per the documented contract (rejected, rejected, passthrough, rejected, rejected, accepted respectively); marker regex traced against CRLF, trailing whitespace, lowercase, and mid-line (non-whole-line) marker text via ad hoc execution — CRLF/trailing-whitespace still match (as intended, `\s*$` tolerates it), lowercase and mid-line text correctly fail to match (treated as "missing marker" → failed), matching the documented whole-line-anchor design. |
| Security | PASS | Command injection: `buildArgs` returns a `string[]` argv, never a shell string, so a prompt/flag value containing shell metacharacters is passed as literal argv text (per the Adapter port's `buildArgs` doc, src/adapters/types.ts:22-29) — no adapter code concatenates into a shell command. Path traversal: `assertContained` (agy-image.ts:138-145) rejects any relative `outputPath` whose resolved path falls outside the base cwd, verified by TRACE above and an additional hand-traced `a/../../b.png` case; an absolute `outputPath` is treated as an explicit caller-specified target per the documented design, not a traversal, which matches the DW-4.3 wording ("escape the job cwd" — a concept only meaningful for cwd-relative resolution). |

## Loaded-Skill Criteria

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | GC-1: routine protects itself from bad input data | PASS | `pushOptionalStringFlag` (agy.ts:111-118) and `resolveOutputPath`/`assertContained` (agy-image.ts:113-145) validate all untrusted `opts` fields (type, non-empty, extension, containment) before use; both throw rather than silently accepting bad data. |
| cc-defensive-programming | GC-3 / RF-9: assertions used only for conditions that should never occur, not for normal/expected error handling | PASS | Neither file uses a language-level `assert`; all input-validation failures (bad opts, traversal, missing file) go through explicit `throw new TypeError(...)` / structured `AdapterResult{status:"failed"}` returns — i.e., real error handling for anticipated bad input, not assertions. The one true "should never happen" check (`_check: Adapter = {...}` at the bottom of each file) is a compile-time-only type assertion, correctly not a runtime assertion misused for error handling. |
| cc-defensive-programming | EC-3 / RF-2: code free of empty catch blocks | PASS | Grep confirms zero `catch` blocks (empty or otherwise) in either file — there is no exception-catching code path at all, so no red flag applies. |
| cc-defensive-programming | RF-6: allowlist- vs blacklist-based validation for security-relevant input | PASS | Path containment uses an allowlist approach (`relative(base, resolved)` must resolve to something inside `base`, i.e. must NOT start with `..`) rather than blacklisting literal `../` substrings, which is exactly the recommended pattern (checklist explicitly calls out "Bad: Filter `../`" as the red flag) — the code note at agy-image.ts:33-35 documents this choice explicitly. |
| cc-defensive-programming | SM-3 / RF-7: command-injection defense for CLI-spawning code — no string concatenation for shell commands | PASS | Both `buildArgs` functions build and return a `string[]` argv array exclusively (no template-string/concatenation into a single shell command string anywhere in either file), consistent with the Adapter port's documented no-shell-spawn contract. |

## Notes (non-blocking)
- `assertContained`'s comment (agy-image.ts:136-137) mentions "or an absolute path, on some platforms/drives" as a possible `relative()` result signaling escape — this is a Windows-drive-letter concern; the code correctly checks `isAbsolute(rel)` to cover it, though the project only runs on Bun/macOS in this repo so it's untested on that platform. Not a defect — just an observation that this branch has no dedicated test (it's also not reachable on the CI/dev platform in use).
- No lint script exists in `package.json`; only `tsc --noEmit` and `bun test` were available to run. This does not block the review — the dispatch prompt's "how to run the suite" section lists exactly these two commands.

## Issues (if FAIL)
None.

**Verdict: PASS**
