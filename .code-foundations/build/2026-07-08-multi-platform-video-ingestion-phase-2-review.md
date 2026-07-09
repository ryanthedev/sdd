# Review: Phase 2 - agy shared helper extraction

## Executed Results (Step 0)
- Test suite: `bun test` → 174 pass, 0 fail, 489 expect() calls, 14 files (3.51s)
- Agy-scoped subset: `bun test test/adapter-agy-shared.test.ts test/adapter-agy.test.ts test/adapter-agy-image.test.ts` → 42 pass, 0 fail, 94 expect() calls
- Typecheck: `bunx tsc --noEmit` → clean, no output, exit 0
- Lint: no separate lint command configured in this project (CLAUDE.md lists only `bun test` and `bunx tsc --noEmit` as required gates) — N/A

## Requirement Fulfillment

### DW-2.1
PREMISE:  `agy.ts` and `agy-image.ts` import `buildAgyArgv`/`lastMarkerMatch` from `_agy-shared.ts`; no local copies remain.
EVIDENCE: src/adapters/agy.ts:35 (`import { buildAgyArgv, lastMarkerMatch } from "./_agy-shared.ts";`); src/adapters/agy-image.ts:59 (same import). `grep -n "function buildAgyArgv\|function lastMarkerMatch\|matchAll\|RegExpExecArray" src/adapters/agy.ts src/adapters/agy-image.ts` → 0 matches.
TRACE:    Read both files end-to-end; `agy.ts` calls `buildAgyArgv(...)` at line 78 and `lastMarkerMatch(...)` at line 93, `agy-image.ts` calls `buildAgyArgv(...)` at line 97 and `lastMarkerMatch(...)` at line 123 — no local `function lastMarkerMatch` / inline argv-array literal duplicating the shared logic exists in either file (confirmed by diff against HEAD: both local `lastMarkerMatch` definitions were deleted, argv literals replaced with `buildAgyArgv(...)` calls).
VERDICT:  PASS

### DW-2.2
PREMISE:  existing agy + agy-image tests pass unchanged (the test files are byte-identical to before this phase).
EVIDENCE: `git status --short` → `test/adapter-agy.test.ts` and `test/adapter-agy-image.test.ts` do NOT appear in the modified-file list (only `src/adapters/agy.ts`, `src/adapters/agy-image.ts` are `M`; `_agy-shared.ts` and `test/adapter-agy-shared.test.ts` are new `??` files). `git diff --stat HEAD -- test/adapter-agy.test.ts test/adapter-agy-image.test.ts` → empty output (no diff).
TRACE:    Working tree state of both test files matches HEAD exactly (zero-line diff) → byte-identical. Ran `bun test test/adapter-agy.test.ts test/adapter-agy-image.test.ts` (combined with the shared-helper test) → all 42 tests pass against the refactored implementation files.
VERDICT:  PASS

### DW-2.3
PREMISE:  `buildAgyArgv` unit test asserts `--print` is second-to-last and prompt is last for representative flag sets.
EVIDENCE: test/adapter-agy-shared.test.ts:19-65 — five tests: empty flags (line 19), single flag (line 26), multi-flag agy.ts-shaped set (line 33), agy-image.ts-shaped set (line 50), and a general N-flag invariant test (line 59) all asserting `argv[argv.length-1]` is the prompt and `argv[argv.length-2]` is `"--print"`.
TRACE:    Ran the file directly — `test_DW_2_3_empty_subcommand_flags_still_yields_valid_argv`, `..._single_flag_...`, `..._multi_flag_set_...`, `..._agy_image_shape_...`, and the unnamed general invariant test all pass (confirmed in the 42-pass run above).
VERDICT:  PASS

### DW-2.4
PREMISE:  discovery does not load `_agy-shared.ts` (a discovery run lists real adapters, not the helper).
EVIDENCE: src/adapters/discover.ts:37 (`isCandidate`: `if (fileName.startsWith(".") || fileName.startsWith("_")) return false;`) — `_agy-shared.ts` starts with `_`, so it is filtered before `require()` is ever called. test/adapter-agy-shared.test.ts:96-103 (`test_DW_2_4_discovery_excludes_agy_shared_helper`) asserts `discoverAdapters(...)` includes `"agy"` and `"agy-image"` but no name containing `"agy-shared"`.
TRACE:    `discoverAdapters(join(import.meta.dir, "../src/adapters"))` on the real adapters directory → `isCandidate("_agy-shared.ts")` returns `false` at the `startsWith("_")` check, so the file is skipped before load; the module is also not an `Adapter` (exports only two plain functions, no `name`/`mode`/`buildArgs`/`injectContract`/`parseResult`) so it would additionally fail `toAdapter` validation even if loaded. Test passed in the 42-pass run.
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] DW-2.1 — covered indirectly: `test/adapter-agy.test.ts` and `test/adapter-agy-image.test.ts` (unchanged files) pass against the refactored source, which is only possible if the re-exported/imported `buildAgyArgv`/`lastMarkerMatch` produce identical behavior to the deleted local copies. Also directly confirmed by source inspection (grep, diff) above — no automated test asserts "no local copy exists" as a static property, but the requirement is a structural/code-inspection claim, appropriately covered by direct code reading plus the regression suite proving behavioral equivalence.
- [x] DW-2.2 — covered by `git diff --stat` (zero diff) + full test-file execution (42/42 pass).
- [x] DW-2.3 — covered by 5 dedicated tests in test/adapter-agy-shared.test.ts (all ran, all pass).
- [x] DW-2.4 — covered by `test_DW_2_4_discovery_excludes_agy_shared_helper` (ran, passes).
- [x] Test coverage matches the stated 100% level — every DW item has either a directly-executed automated test or git-verified structural evidence (DW-2.1/2.2, which are about absence-of-code and byte-identity, are not meaningfully "testable" beyond static inspection + regression pass, and both were verified that way).

## Dead Code
None found. Checked both refactored files for leftover unused imports, unreachable code, or commented-out blocks — `agy.ts` and `agy-image.ts` cleanly import only `buildAgyArgv`/`lastMarkerMatch` and use both; no stray local definitions remain (confirmed by the grep above and the diff hunks, which show clean deletions of the old local `lastMarkerMatch` functions with no orphaned fragments).

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Pure functions (`buildAgyArgv`, `lastMarkerMatch`) with no shared/mutable state, no async, no I/O — nothing to race. |
| Error Handling | N/A | `buildAgyArgv`/`lastMarkerMatch` do no I/O, parsing of untrusted input, or external calls; both are total functions over their typed inputs (array/string in, array/match out). Caller-side validation (`pushOptionalStringFlag`, `resolveOutputPath`) is unchanged by this refactor. |
| Resources | N/A | No file handles, connections, locks, caches, or threads touched by the extracted helpers. |
| Boundaries | PASS | Traced the adversarial case: `buildAgyArgv([], prompt)` (empty array spread) → `["agy", ...[], "--print", prompt]` = `["agy", "--print", prompt]`, still valid, prompt still last — matches test at line 19-24. Traced `lastMarkerMatch` on text with zero matches → `for...of matchAll` loop body never executes → `last` stays `undefined` → returns `undefined` (not a thrown error or empty-array crash) — matches `discover.ts`-independent test at adapter-agy-shared.test.ts:74-77. |
| Security | N/A | No untrusted input is newly introduced or handled differently by this refactor — `buildAgyArgv`'s `subcommandFlags` trust boundary is explicitly documented as pre-validated by the caller (comment at `_agy-shared.ts:22-25`), unchanged from the pre-refactor inline arrays which had the same implicit trust. The argv-array/no-shell invariant (CLAUDE.md's security barricade) is unaffected — `buildAgyArgv` still returns a plain `string[]`. |

## Loaded-Skill Criteria

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-refactoring-guidance | Behavior-preserving change (same tests pass before and after) | PASS | `test/adapter-agy.test.ts` and `test/adapter-agy-image.test.ts` are byte-identical to pre-refactor (git diff empty) and both pass unmodified (42/42) against the refactored source — the textbook definition of a behavior-preserving refactor. |
| cc-refactoring-guidance | Duplicated code → extracted routine (TRANSFORMER pattern) | PASS | The exact duplicate `lastMarkerMatch` function and the duplicate `["agy", ..., "--print", prompt]` argv-literal pattern that existed independently in `agy.ts` and `agy-image.ts` (per the file headers' own prior documentation of "the flag-order landmine fix... exists exactly once" language) are now extracted once into `_agy-shared.ts` and consumed by both call sites — no duplication remains (confirmed by grep above). |
| cc-refactoring-guidance | Fix-first-then-refactor / small-change rigor — not mixing fix and refactor in one change | N/A (cannot verify from diff alone) | The diff under review is refactor-only (moving code, not changing behavior/fixing a bug) — confirmed by the byte-for-byte-identical argv output before/after (see edge-case verification below). Whether this refactor commit is cleanly separated from a prior "fix" commit is a git-history question outside what a single-phase code diff can establish; no evidence in the reviewed files suggests a fix was smuggled into this change. |
| cc-refactoring-guidance | Precedent set for future consumers (Phase 6's `agy-vision`) is deliberate, not accidental | PASS | `_agy-shared.ts`'s own header comment (lines 1-11) explicitly documents the extraction rationale and names the future consumer — this is a deliberate precedent-setting extraction, not an ad hoc one. |

## Edge Cases (explicit verification)

1. **Argv builder makes it structurally impossible to insert anything after the prompt.** TRACE: `buildAgyArgv` is `return ["agy", ...subcommandFlags, "--print", prompt];` — a single array-literal return statement with `prompt` as the final literal element. There is no code path, branch, or later mutation that could append anything after this return; the general invariant test (`adapter-agy-shared.test.ts:59-65`) additionally proves this empirically for a 3-flag-pair (6-element) input: `argv.slice(printIdx + 1)` always equals exactly `[prompt]`. PASS.
2. **Empty `subcommandFlags` array still produces a valid argv `["agy","--print",prompt]`.** TRACE: `buildAgyArgv([], "do the thing")` → spread of `[]` contributes nothing → `["agy", "--print", "do the thing"]`, exactly as required. Directly tested and passing (`test_DW_2_3_empty_subcommand_flags_still_yields_valid_argv`). PASS.
3. **Behavior preservation: agy/agy-image argv identical to pre-refactor inline arrays.** TRACE: pre-refactor `agy.ts` (per `git diff`) was `return ["agy", "--sandbox", "--dangerously-skip-permissions", ...flags, "--print", prompt];`; post-refactor is `buildAgyArgv(["--sandbox", "--dangerously-skip-permissions", ...flags], prompt)`, which expands to the identical array `["agy", "--sandbox", "--dangerously-skip-permissions", ...flags, "--print", prompt]`. Pre-refactor `agy-image.ts` was `return ["agy", "--sandbox", "--dangerously-skip-permissions", "--print", withPath];`; post-refactor is `buildAgyArgv(["--sandbox", "--dangerously-skip-permissions"], withPath)`, expanding to the identical `["agy", "--sandbox", "--dangerously-skip-permissions", "--print", withPath]`. `--sandbox --dangerously-skip-permissions` remains present and correctly ordered (both before `--print`) in both call sites. PASS.

## Notes (non-blocking)
- The new discovery file `.code-foundations/build/2026-07-08-multi-platform-video-ingestion-phase-2-discovery.md` is untracked (`??`) and out of scope for this review per the independence rule (not read).
- `_agy-shared.ts`'s header comment is unusually long/narrative for a 47-line file, but it directly documents the two landmines (flag-order, marker-collision) that motivated the extraction and names the Phase 6 consumer — judged appropriate given CLAUDE.md's own precedent of dense header comments in `agy.ts`/`agy-image.ts`; a style preference, not a defect.

## Issues (if FAIL)
None.

**Verdict: PASS**
