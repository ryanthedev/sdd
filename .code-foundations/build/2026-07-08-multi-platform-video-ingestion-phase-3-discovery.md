# Discovery + Design: Phase 3 - Extend dispatch opts schema

## Files Found
- `src/tools/dispatch.ts` — the tool factory. `inputShape` (zod) is the closed client boundary; `handler` builds a `DispatchOpts` object literal by hand-copying each optional key from `args` when defined, then calls `rt.jobStore.dispatch(adapter, args.prompt, opts)`.
- `src/types.ts` — `DispatchOpts` interface: `cwd?`, `mode?`, `timeoutMs?`, plus an open `[k: string]: unknown` index signature. No change needed here — the index signature already accepts arbitrary adapter-specific keys.
- `test/tools.test.ts` — dispatch tests already live here (405 lines), NOT in a `test/dispatch.test.ts` (that file does not exist). Per the phase's file-scope note ("if dispatch tests currently live elsewhere e.g. test/tools.test.ts, add there and note it"), new tests go into `test/tools.test.ts`. Confirmed via `grep dispatch test/tools.test.ts` — 47 matches, includes existing passthrough tests for `outputPath` (line ~201) and `model`/`effort` (line ~226) plus a dirty-schema test for `effort` (line ~248) — these are the exact patterns to mirror for the six new opts.

## Current State
`inputShape` currently declares: `adapter`, `prompt`, `cwd`, `mode`, `timeoutMs`, `model`, `effort`, `outputPath`. The handler's `opts` object literal spreads each one conditionally (`...(args.X !== undefined ? { X: args.X } : {})`). This is the exact "switchboard" pattern called out in the phase's file hints — every new zod key needs a matching spread-copy line, or it silently never reaches `JobStore.dispatch`.

`outputPath`'s current description says: `'Adapter-specific: absolute or cwd-relative ".png" path for image-generating adapters (agy-image) to save to. Required by those adapters; ignored by others.'` — Phase 6 reuses this same opt for a JSON/MD artifact, so the ".png"-specific wording needs to broaden (description text only; the zod type `z.string().min(1).optional()` is unchanged).

## Gaps
None — the plan's scope maps directly onto the existing switchboard pattern. No prerequisite phases block this; Phase 1 (preflight) and Phase 2 (`_agy-shared.ts` extraction) are unrelated to `dispatch.ts`.

## Code Standards
No `docs/code-standards.md` found in the worktree. Followed the file's own established conventions instead: zod `.describe()` on every field, JSDoc-style block comments only at file/section level (not per-field), conditional-spread copy pattern in the opts object literal, `test_DW_N_M_*` / `test_edge_*` naming in tests.

## Test Infrastructure
Bun's built-in test runner (`bun:test`), `describe`-free flat `test()` blocks, `zod`'s `.safeParse` invoked directly against `z.object(dispatchInputShape)` for schema-boundary (dirty) tests — no HTTP/MCP transport in the loop. Passthrough tests use `spyOn(rt.jobStore, "dispatch")` and inspect `dispatchSpy.mock.calls[0]![2]` (the third positional arg, `opts`) via `toMatchObject`. This requires a real adapter file on disk (`ok-adapter.ts`) plus `newRuntime(dir)`, and — critically — the tests currently `await rt.jobStore.wait([...jobId], 5000)` afterward so the spawned child is reaped before `afterEach` tears the runtime down.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-3.1 | dispatching with each new opt forwards it onto `opts` (test asserts passthrough) | COVERED | `test_DW_3_1_dispatch_forwards_video_ingestion_opts_into_dispatch_opts` — one dispatch call carrying all six new opts (`outputDir`, `cookies`, `subLangs`, `frameCount`, `sceneThreshold`, `addDir`), asserts `dispatchSpy.mock.calls[0]![2]` `toMatchObject` with all six verbatim |
| DW-3.2 | `sceneThreshold: 1.5` and `frameCount: 0` are rejected with a zod validation error (dirty) | COVERED | `test_DW_3_2_out_of_range_scene_threshold_and_frame_count_rejected_at_tool_boundary` — `schema.safeParse` with `sceneThreshold: 1.5` → `success: false`; `frameCount: 0` → `success: false`; also asserts valid boundary values (`sceneThreshold: 0`, `sceneThreshold: 1`, `frameCount: 1`) succeed, and `frameCount: 1.5` (non-integer) is rejected |
| DW-3.3 | omitting all new opts leaves existing dispatch behavior unchanged (existing dispatch tests still green) | COVERED | No existing test in `test/tools.test.ts` is modified; full `bun test` run after the change proves the existing 40+ dispatch/status/result/wait/cancel tests are unaffected (regression-anchoring, not a new test) |

**All items COVERED:** YES

## Design Decisions

**New zod fields (mirroring the existing switchboard exactly):**
- `outputDir?: z.string().min(1).optional()` — output directory for fetch/frame adapters (Phase 4/5 land media outside the source tree per the plan's split-privilege constraint).
- `cookies?: z.string().min(1).optional()` — path to a cookies file for yt-dlp-backed fetch (auth-gated platforms).
- `subLangs?: z.string().min(1).optional()` — subtitle language selector string (yt-dlp's own `--sub-langs` format, e.g. `"en,en-US"`), passed through verbatim — no format validation beyond non-empty, matching how `model` is a free string constrained only by adapter-side allowlisting, not the schema.
- `frameCount?: z.number().int().positive().optional()` — positive integer ≥1, enforced by zod's `.int().positive()` (same primitives already used by `timeoutMs`).
- `sceneThreshold?: z.number().min(0).max(1).optional()` — 0..1 inclusive via zod's `.min(0).max(1)`.
- `addDir?: z.string().min(1).optional()` — directory to grant sandboxed analysis read access to (`--add-dir`, per the plan's fuse/analyze step).

All six are optional, non-coercing (zod rejects out-of-range/wrong-type rather than clamping — satisfies the "NOT silently coerced" edge case), and each gets one `.describe()` line stating adapter-specificity, mirroring `model`/`outputPath`'s existing phrasing style.

**outputPath description-only change:** drop the ".png"-only framing; describe it as "adapter-specific artifact path (image, JSON, or Markdown depending on the adapter)". Type stays `z.string().min(1).optional()` — confirmed no other file reads or type-checks against the removed wording.

**Handler passthrough:** add six more conditional-spread lines to the `opts` object literal, following the exact `...(args.X !== undefined ? { X: args.X } : {})` shape already used for `model`/`effort`/`outputPath`. No new type needed on `DispatchOpts` (the index signature already covers it) — matches Phase 3's "no change to existing opt TYPES" scope-out and keeps `Input` (derived via `z.output<z.ZodObject<typeof inputShape>>`) automatically widened.

No design-skill was assigned for this phase (only `cc-defensive-programming`); interface choice is a direct mirror of the existing pattern, so no alternatives comparison was needed. Applying `cc-defensive-programming`: this is exactly the "external input validated at entry" barricade — `inputShape` is the closed client boundary (the MCP tool surface, untrusted by definition per the plan's context), so range validation (`frameCount >= 1`, `0 <= sceneThreshold <= 1`) belongs in zod at the boundary, not deferred to adapters in Phases 4-6 (which, per the barricade design, may assume validated data once these opts cross the boundary).

## Prerequisites
- [x] `src/tools/dispatch.ts` exists and matches expected switchboard pattern
- [x] `test/tools.test.ts` exists with the exact passthrough/dirty-schema test patterns to mirror
- [x] No missing prerequisites

## Recommendation
BUILD. Straightforward mechanical extension of an existing, well-established pattern (add 6 zod fields + 6 spread-copy lines + description tweak on `outputPath`), tests mirror three tests already present in the same file.
