# Discovery + Design: Phase 4 - agy + agy-image adapters

## Files Found
- `src/adapters/types.ts` — the `Adapter` port (Phase 1): `{ name, mode, buildArgs(prompt, opts): string[], injectContract(prompt): string, parseResult(stdout, stderr, exitCode): AdapterResult }`.
- `src/adapters/discover.ts` — directory-scan discovery (Phase 1). Duck-types any `*.ts` file in `src/adapters/` (excluding `discover.ts`, `types.ts`, `.d.ts`, `.test.ts`, dotfiles) against the port shape. No central registry to edit.
- `src/types.ts` — core types: `AdapterMode = "read"|"write"`, `AdapterResult = {status, summary, artifacts, raw}`, `DispatchOpts = {cwd?, mode?, timeoutMs?, [k: string]: unknown}`, `Job`/`JobState`.
- `src/lib/jobs.ts` — Phase 2 `JobStore`. Confirms the calling contract: `injectContract(prompt)` runs first (prompt only, no opts), then `buildArgs(contracted, opts)` (opts available), then on child exit `parseResult(stdout, stderr, exitCode)` — **no opts passed to parseResult**. This is load-bearing for agy-image's design (see below). Runtime guard rejects non-array/non-string argv from `buildArgs`.
- `test/adapters-discover.test.ts` (Phase 1) — shows the expected duck-typed export shape (plain `export const name/mode` + `export function buildArgs/injectContract/parseResult`).
- `test/jobs.test.ts` (Phase 2) — shows the `stubAdapter` test-double pattern; not directly reused (different file scope) but confirms conventions (bun:test, tmpdir fixtures).
- No `src/adapters/agy.ts`, `agy-image.ts`, `test/adapter-agy.test.ts`, `test/adapter-agy-image.test.ts` exist yet — this phase creates all four.
- `src/adapters/codex.ts` (Phase 3) does **not** exist in this worktree — Phase 3 is being built in a sibling worktree and hasn't merged here. `discoverAdapters()` run against this worktree's `src/adapters/` will therefore only surface `agy`/`agy-image` once added (plus skip `discover.ts`/`types.ts`) — good, a clean DW-4.4 test target.

## Current State
Phase 1 (port + discovery) and Phase 2 (JobStore) are complete and merged into this worktree. Phase 4's two adapter files are pure additions — no existing code to modify, no shared file (register.ts, tools/) in scope.

## Gaps
- The plan's two adapters must each supply a single, distinct output-contract marker (per plan: "each with exactly ONE output contract") — no shared marker constant between `agy` and `agy-image` to avoid cross-adapter collision if both ever run in the same log.
- `agy-image`'s marker-and-file-existence design has a real constraint: `parseResult` receives no `opts`, so it cannot independently know the expected output path unless the harness's own stdout reports it back. Resolved via design below (marker echoes the absolute path; buildArgs passes that same absolute path to the CLI via `--out`).
- Real `agy`/`agy-image` CLI flag surfaces are unknown (agy may not be installed here, per the dispatch prompt) — flags beyond `--print`/`--out` are therefore a reasonable, documented guess (`--model`, `--sandbox`), validated defensively, not load-bearing for the DW items (which only assert flag *order*, not specific flag names).

## Code Standards
No `docs/code-standards.md` found in this repo. Followed the codebase's own established conventions instead: JSDoc header block per file explaining role + security rationale (see `types.ts`, `discover.ts`, `jobs.ts`); `.ts` extensions on relative imports; stderr-only logging (not needed here — adapters are pure, no logging); bun:test with descriptive `test_DW_N_M_*` names for DW-traced tests plus additional descriptively-named tests for edge cases; tmpdir fixtures with `afterEach` cleanup, mirroring `test/adapters-discover.test.ts` and `test/jobs.test.ts`.

## Test Infrastructure
`bun test` (bun:test — `test`, `expect`, `afterEach`). Existing patterns: `mkdtempSync`/`rmSync` fixture cleanup, `import.meta.dir`-relative paths available in Bun. `discoverAdapters` is exercised against real fixture files in Phase 1's test; for DW-4.4 this phase points `discoverAdapters` at the real `src/adapters/` directory (not a fixture) since Phase 3's `codex.ts` isn't present in this worktree, giving a clean two-adapter result.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-4.1 | agy `buildArgs` emits flags-before-`--print` with the prompt as the immediately-following single argv element (assert on the argv array) | COVERED | `test_DW_4_1_no_extra_flags_prompt_immediately_after_print`, `test_DW_4_1_flags_all_precede_print_prompt_is_last_element` |
| DW-4.2 | An agy run whose output lacks the required marker is classified `failed`, not `done` (silent-misparse backstop), asserted with a stubbed misparse output | COVERED | `test_DW_4_2_missing_marker_on_exit_0_is_failed_misparse_backstop`, `test_DW_4_2_simulated_print_flag_self_answer_misparse_is_failed` |
| DW-4.3 | agy-image returns the PNG absolute path in `artifacts` and is `mode: "read"`; a missing output file → `failed` | COVERED | `test_DW_4_3_mode_is_read`, `test_DW_4_3_valid_marker_and_existing_file_is_done_with_absolute_artifact`, `test_DW_4_3_missing_output_file_is_failed_with_reason` |
| DW-4.4 | Both adapters are found by `discoverAdapters()` with no edit to any central registry file | COVERED | `test_DW_4_4_agy_discovered_via_directory_scan` (in adapter-agy.test.ts), `test_DW_4_4_agy_image_discovered_via_directory_scan` (in adapter-agy-image.test.ts) |
| Edge (plan) | agy-image relative output path → resolved to absolute before spawn | COVERED | `edge_relative_output_path_resolved_to_absolute_before_spawn` |

**All items COVERED:** YES

## Design Decisions

**Cross-cutting: argv[0] convention.** Following the plan's codex example (`buildArgs`: `["codex", "exec", "--sandbox", mode, prompt]` — argv[0] is the binary name itself, consumed by `JobStore#spawnAndTrack`'s `spawn(argv[0], argv.slice(1), ...)`), both adapters' `buildArgs` return `["agy", ...]` as argv[0].

**agy.ts**
- `mode` default: `"write"` (not `"read"`). Rationale: agy is used for both review (read) and implement (write); the write-write concurrency guard in JobStore only fires for `mode: "write"` jobs. Defaulting to the more-restrictive `"write"` means a caller must explicitly opt in to `"read"` via `opts.mode` for review-only jobs — an accidental implement dispatch can never silently bypass the write-write guard. (JobStore already supports this: `const mode = opts.mode ?? adapter.mode`.)
- `buildArgs(prompt, opts)`: builds an optional-flags array (`--model <opts.model>`, `--sandbox <opts.sandbox>`, each validated as a non-empty string if present — external input, validated at entry per cc-defensive-programming) and returns `["agy", ...flags, "--print", prompt]`. The prompt is *always* the last `.push`, `--print` is *always* the second-to-last — there is no code path where anything can land after the prompt. This is the structural encoding of the flag-order landmine the plan calls out (agy's `--print` swallows the very next token; anything after it is silently absorbed into the prompt and agy exits 0).
- `injectContract(prompt)`: appends instructions asking the harness to end its response with `AGY_RESULT: DONE` or `AGY_RESULT: FAILED` as the sole marker line.
- `parseResult(stdout, stderr, exitCode)`: regex-matches `/^AGY_RESULT:\s*(DONE|FAILED)\b/m`. No match → `failed` (silent-misparse backstop — covers both a real misparse and a harness that just didn't finish). Match found but `exitCode !== 0` → `failed`. Match `FAILED` → `failed`. Match `DONE` + exit 0 → `done`, `summary` is the raw stdout (matches the discovery-test fixture's convention of echoing stdout as summary), `artifacts: []` (agy's review/implement contract produces no file artifacts).

**agy-image.ts**
- `mode`: fixed `"read"` per plan (writes only to an explicit external artifact path, never the source tree — doesn't count as a working-tree write for the write-write guard).
- Key design constraint: `parseResult(stdout, stderr, exitCode)` receives **no `opts`**, so it cannot look up the caller's intended output path independently — the JobStore call sequence (confirmed by reading `jobs.ts`) is `injectContract(prompt)` (prompt only) → `buildArgs(contracted, opts)` (opts here) → later, on exit, `parseResult(stdout, stderr, exitCode)` (opts NOT threaded through). Resolution: the absolute path is computed once in `buildArgs` (which does have `opts`) and passed to the real CLI as a `--out <absolutePath>` flag (a real argv flag, not prompt text — mirrors how a real image-gen CLI would take an explicit output flag). `injectContract` (no opts) only adds a generic, path-agnostic instruction: "save to the path given via `--out`, then print `AGY_IMAGE_SAVED: <path>` as the last line." `parseResult` then extracts the path from that echoed marker and independently verifies the file exists on disk (`existsSync`) — this both proves the harness actually did the work (not just claimed exit 0) and gives `parseResult` the path without needing `opts`.
- `resolveOutputPath(opts)` (used inside `buildArgs`): requires `opts.outputPath` to be a non-empty string ending in `.png` (external input, validated at entry — throws `TypeError` otherwise, fail-fast per cc-defensive-programming); resolves it to absolute via `node:path` if relative, using `opts.cwd` (resolved the same way JobStore resolves cwd) as the base, else `process.cwd()`. This directly guards the grug-noted landmine: a relative filename handed to agy searches all of `/Users` — resolving to absolute in `buildArgs`, before the argv ever reaches `spawn`, eliminates that path entirely.
- `parseResult`: regex `/^AGY_IMAGE_SAVED:\s*(.+)$/m`. No match → `failed` (missing confirmation marker). Match + `exitCode !== 0` → `failed`. Match + `!existsSync(path)` → `failed` ("reported output file does not exist: `<path>`" — the DW-4.3/edge "no file produced" case, with the reason in `summary`). Match + file exists → `done`, `artifacts: [path]` (absolute, since it was constructed as absolute in `buildArgs` and echoed verbatim), `summary` describes the save.
- Both files add a private, non-exported `const _check: Adapter = { name, mode, buildArgs, injectContract, parseResult}` under type-only import of `Adapter` — a compile-time-only proof (no runtime effect) that the module's plain exports satisfy the port shape, since `discoverAdapters` duck-types at runtime and TS can't otherwise catch a drifted signature.

## Prerequisites
- [x] Required files (Phase 1 port, Phase 2 JobStore, Phase 1 discovery) exist and are stable — read-only reference, not modified.
- [x] Dependencies available (`bun`, `typescript`, `zod` already installed; `node_modules` present per dispatch prompt).
- [x] No missing prerequisites — Phase 4 depends only on Phase 2, which is merged.

## Recommendation
BUILD. Proceed to stub → implement → validate for `src/adapters/agy.ts`, `src/adapters/agy-image.ts`, `test/adapter-agy.test.ts`, `test/adapter-agy-image.test.ts`.
