# Discovery + Design: Phase 2 - Extract `_agy-shared` helpers

## Files Found
- `src/adapters/agy.ts` — has a local `lastMarkerMatch` (lines 60-64) and inlines its argv-order guarantee directly in `buildArgs` (line 84).
- `src/adapters/agy-image.ts` — has a byte-for-byte duplicate `lastMarkerMatch` (lines 74-78) and its own `buildArgs` (line 98) building the same `["agy", "--sandbox", "--dangerously-skip-permissions", "--print", <prompt>]` shape, minus the `--model` slot.
- `src/adapters/_codex-shared.ts` — the precedent: a leading-underscore helper module exporting `buildCodexArgv`, consumed by `codex.ts` (and the Phase-2-of-the-codex-plan variant factory). Discovery skips it because `isCandidate` in `discover.ts` rejects any filename starting with `_`.
- `src/adapters/discover.ts` — `isCandidate` (line 34-39) already excludes `_`-prefixed files categorically; no change needed here for DW-2.4.
- `test/adapter-agy.test.ts`, `test/adapter-agy-image.test.ts` — existing full test suites; must pass byte-identical post-refactor (DW-2.2).
- `test/adapter-codex.test.ts:193-197` — precedent test shape for "discovery excludes the shared helper" (`test_DW_1_8_discovery_excludes_codex_shared_helper`), reused as the template for DW-2.4.

## Current State
`agy.ts` and `agy-image.ts` each hand-build the same "agy" + fixed sandbox flags + optional middle flags + `--print` + prompt-last argv shape, and each hand-roll an identical `lastMarkerMatch` scanning function. No shared module exists yet for agy; the codex family already solved this exact duplication with `_codex-shared.ts`.

## Gaps
- No `_agy-shared.ts` file yet.
- The two `lastMarkerMatch` copies are 100% identical — a straightforward move.
- The two argv-builders differ only in the middle flags (agy.ts has an optional `--model <value>` pair; agy-image.ts has none) — both fit the plan's `buildAgyArgv(subcommandFlags, prompt)` shape cleanly, mirroring `buildCodexArgv(prompt, mode, cfg)`'s existing pattern of "trusted caller assembles flags, shared fn fixes ordering."

## Code Standards
No `docs/code-standards.md` found in the worktree. Following the codebase's observed conventions instead: JSDoc header per file explaining security rationale, `Adapter` port compile-time proof (`const _check: Adapter = {...}`) at the bottom of adapter files (unaffected here — `_agy-shared.ts` is not an adapter, no `_check`), explicit `.ts` import extensions, no `console.*` in `src/`.

## Test Infrastructure
`bun:test` (`describe`-free flat `test()` blocks), tests named `test_DW_N_M_...` for DW-traceable cases plus descriptive-name tests for edge cases beyond the DW list. `discoverAdapters(join(import.meta.dir, "../src/adapters"))` is the standard way existing tests assert real-directory discovery behavior (used for both DW-2.4 and the codex precedent).

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-2.1 | `agy.ts` and `agy-image.ts` import `buildAgyArgv`/`lastMarkerMatch` from `_agy-shared.ts`; no local copies remain | COVERED | Grep-style assertion is implicit in code review; behaviorally covered by all existing argv/marker tests continuing to pass against the refactored (import-based) implementations — DW-2.2's test set is the proof these functions still work when sourced from `_agy-shared.ts`. Additionally add `test_DW_2_1_agy_and_agy_image_reexport_no_local_copies` style check via source-grep is out of scope for a runtime test; verified manually + via file diff. |
| DW-2.2 | existing agy + agy-image tests pass unchanged | COVERED | Full unchanged `test/adapter-agy.test.ts` and `test/adapter-agy-image.test.ts` suites (34 tests total) rerun after refactor |
| DW-2.3 | `buildAgyArgv` unit test asserts `--print` is second-to-last and prompt is last for representative flag sets | COVERED | New `test/adapter-agy-shared.test.ts`: `test_DW_2_3_print_second_to_last_prompt_last_various_flag_sets` (parameterized over empty flags, single flag, multi-flag) |
| DW-2.4 | discovery does not load `_agy-shared.ts` (dispatch of a bogus name still lists only real adapters) | COVERED | New `test/adapter-agy-shared.test.ts`: `test_DW_2_4_discovery_excludes_agy_shared_helper`, mirroring `test_DW_1_8_discovery_excludes_codex_shared_helper` in `test/adapter-codex.test.ts` |

**All items COVERED:** YES

## Design Decisions

**Signature:** `buildAgyArgv(subcommandFlags: string[], prompt: string): string[]` — exactly as pinned by the plan's Produces line (a cross-phase seam consumed by Phase 6's `agy-vision`, so the signature is not renegotiable here).

**Why this shape (vs. mirroring `buildCodexArgv`'s `(prompt, mode, cfg)` more literally):** the plan explicitly pins this signature and explains why: agy's two current callers differ only in the *middle* flags (agy.ts has `--sandbox --dangerously-skip-permissions [--model <v>]`; agy-image.ts has `--sandbox --dangerously-skip-permissions` only) — pushing that entire middle section into a caller-supplied `subcommandFlags: string[]` keeps the shared function's only two jobs (a) prepend `"agy"`, (b) append `"--print", prompt` as the fixed last two elements. This is the direct structural translation of the flag-order landmine documented in `agy.ts`'s header: "the prompt is always the LAST array element pushed, and `--print` is always the element immediately before it. There is no code path that can insert anything after the prompt." An empty `subcommandFlags` array still produces `["agy", "--print", prompt]` — a valid 3-element argv, satisfying the plan's edge case.

**`lastMarkerMatch`:** identical move — no logic change, just relocated with its existing doc comment (trimmed of the two now-redundant landmine paragraphs already documented once in `agy.ts`'s header, kept once in `_agy-shared.ts`).

**Trust boundary:** unlike `buildCodexArgv`, `subcommandFlags` here is NOT validated as "trusted-only" input inside `_agy-shared.ts` — the untrusted-input validation (e.g. `pushOptionalStringFlag`'s `TypeError` on a non-string `opts.model`) stays in the calling adapter (`agy.ts`), which builds `subcommandFlags` from already-validated pieces before calling `buildAgyArgv`. `_agy-shared.ts` only guarantees ordering, matching the existing division of responsibility (adapters validate opts; shared helpers only assemble/order already-trusted strings).

**File organization:** one new file `src/adapters/_agy-shared.ts`, `_`-prefixed per the established discovery-exclusion convention (`isCandidate` in `discover.ts` already excludes it — no change to `discover.ts` needed). One new test file `test/adapter-agy-shared.test.ts` mirroring the `_codex-shared` testing precedent (there is no standalone `test/adapter-codex-shared.test.ts` either — codex's shared-builder tests live inline in `test/adapter-codex.test.ts`; for agy I'm using a dedicated new test file since the plan's File scope list doesn't mention adding to the existing two test files for the new unit tests, and a separate file keeps DW-2.3/DW-2.4 cleanly attributable to the new module without touching the "must pass unchanged" existing suites at all).

## Prerequisites
- [x] Required files exist (agy.ts, agy-image.ts, discover.ts, both existing test files)
- [x] Dependencies available (bun, tsc — already used throughout the repo)
- [x] No missing prerequisites

## Recommendation
BUILD. Straightforward pure refactor: extract `_agy-shared.ts`, refactor both adapters to import from it, add unit tests for the new module, and rerun the two existing adapter test suites unchanged to prove no behavior drift.
