# Review: Phase 3 - dispatch opts for video-ingestion adapters

## Executed Results (Step 0)
- Test suite: `bun test` → 176 pass, 0 fail, 500 expect() calls, across 14 files (3.55s)
- Typecheck: `bunx tsc --noEmit` → 0 errors (clean exit)
- Lint: no separate lint command defined in this project; typecheck is the enforced static gate per CLAUDE.md

## Requirement Fulfillment

### DW-3.1
PREMISE:  dispatching with each new opt (`outputDir`, `cookies`, `subLangs`, `frameCount`, `sceneThreshold`, `addDir`) forwards it onto `opts` handed to the JobStore.
EVIDENCE: src/tools/dispatch.ts:115-128 (opts construction), src/tools/dispatch.ts:131 (`rt.jobStore.dispatch(adapter, args.prompt, opts)`); test/tools.test.ts:279-310 (`test_DW_3_1_dispatch_forwards_video_ingestion_opts_into_dispatch_opts`)
TRACE:    dispatch.handler called with `{ outputDir: "/tmp/out-dir", cookies: "/tmp/cookies.txt", subLangs: "en,en-US", frameCount: 5, sceneThreshold: 0.4, addDir: "/tmp/frames-dir" }` → each `args.X !== undefined` spread guard is true → all six keys land in `opts` → `rt.jobStore.dispatch(adapter, prompt, opts)` called once, spy captured `opts` at `dispatchSpy.mock.calls[0][2]` → `expect(opts).toMatchObject({...all six...})` passes.
VERDICT:  PASS (ran in Step 0, part of the 176 green tests)

### DW-3.2
PREMISE:  `sceneThreshold: 1.5` and `frameCount: 0` are rejected with a zod validation error (dirty).
EVIDENCE: src/tools/dispatch.ts:74-88 (`frameCount: z.number().int().positive().optional()`, `sceneThreshold: z.number().min(0).max(1).optional()`); test/tools.test.ts:316-328 (`test_DW_3_2_out_of_range_scene_threshold_and_frame_count_rejected_at_tool_boundary`)
TRACE:    `z.object(dispatchInputShape).safeParse({..., sceneThreshold: 1.5})` → `.max(1)` constraint violated → `success: false`. `safeParse({..., frameCount: 0})` → `.positive()` constraint violated (0 is not > 0) → `success: false`. Also verified: `frameCount: -1` fails `.positive()`, `frameCount: 1.5` fails `.int()`, `sceneThreshold: -0.1` fails `.min(0)`; boundary values `sceneThreshold: 0`, `sceneThreshold: 1`, `frameCount: 1` all pass.
VERDICT:  PASS

### DW-3.3
PREMISE:  omitting all new opts leaves existing dispatch behavior unchanged (existing dispatch tests still green).
EVIDENCE: src/tools/dispatch.ts:115-128 (each new key only enters `opts` via an `args.X !== undefined` guard, so omitted keys are absent, not `undefined`-valued, in the spread result); test/tools.test.ts:122-263 (pre-existing dispatch tests: round-trip, status transitions, unknown-adapter, outputPath forwarding, model/effort forwarding, write-write conflict — none pass the six new opts)
TRACE:    e.g. `test_dispatch_forwards_outputPath_into_dispatch_opts` (line 201) dispatches with only `{adapter, prompt, outputPath}` → none of the six new `args.X !== undefined` guards fire → `opts` contains no new keys → `expect(opts).toMatchObject({outputPath: "/tmp/out.png"})` passes exactly as before the opts were added. All other pre-existing tests in this file (round-trip, status, cancel, write-write conflict, list_adapters, unknown-job errors) pass unmodified.
VERDICT:  PASS (all pre-existing tests green in the Step 0 run; no regression)

**All requirements met:** YES

## Test-DW Coverage
- [x] DW-3.1 → `test_DW_3_1_dispatch_forwards_video_ingestion_opts_into_dispatch_opts` (test/tools.test.ts:279)
- [x] DW-3.2 → `test_DW_3_2_out_of_range_scene_threshold_and_frame_count_rejected_at_tool_boundary` (test/tools.test.ts:316)
- [x] DW-3.3 → covered by the full pre-existing dispatch test set remaining green (no new-opt regression); `test_dispatch_forwards_outputPath_into_dispatch_opts` (line 201) is the most direct no-new-opts regression check
- [x] Test coverage matches the stated 100% level — all three DW items have direct automated-test backing that ran in Step 0

## Dead Code
None found. No unused imports, no unreachable code, no debug statements, no commented-out blocks in src/tools/dispatch.ts. The opts-construction block (lines 115-128) is a repetitive but intentional pattern consistent with the pre-existing `cwd`/`mode`/`timeoutMs`/`model`/`effort`/`outputPath` fields — every one of the 12 optional inputShape fields (cwd, mode, timeoutMs, model, effort, outputPath, outputDir, cookies, subLangs, frameCount, sceneThreshold, addDir) has a matching spread guard; none is declared-but-not-copied.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | dispatch.ts's handler is a pure synchronous-construction + single async call; no shared mutable state introduced by this change |
| Error Handling | PASS | `rt.jobStore.dispatch(...)` call is wrapped in try/catch (dispatch.ts:130-135); a schema-validation failure never reaches the handler (MCP SDK validates inputShape before invoking it) — traced via `test_DW_1_5_out_of_enum_effort_rejected_at_tool_boundary` pattern reused for DW-3.2 |
| Resources | N/A | no new file handles/connections/locks introduced in this file; opts values are passed through as plain strings/numbers |
| Boundaries | PASS | traced adversarial inputs: `frameCount: 0` → rejected (`.positive()` excludes 0); `frameCount: -1` → rejected; `frameCount: 1.5` → rejected (`.int()`); `sceneThreshold: 1.5`/`-0.1` → rejected; `sceneThreshold: 0`/`1` (inclusive boundaries) → accepted, matching the "0..1 inclusive" edge-case spec exactly |
| Security | N/A | this file only shapes a `DispatchOpts` object handed to `JobStore.dispatch`; no shell/argv construction happens here (that's adapter-layer, out of scope per the reviewed file list) — the empty-string case is excluded by `.min(1)` on every new string field, preventing an empty-but-defined path value from silently reaching an adapter |

## Loaded-Skill Criteria
Skill loaded: `code-foundations:cc-defensive-programming`.

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry (barricade) | PASS | All six new opts are MCP-client-supplied (external) input; each is validated by a zod schema entry at the tool boundary before ever reaching `opts`/`JobStore.dispatch` (dispatch.ts:50-96). No new opt bypasses the schema. |
| cc-defensive-programming | No executable code in assertions | N/A | No assertions (`assert`/`console.assert`) introduced in this diff |
| cc-defensive-programming | No empty catch blocks | PASS | The one catch block in this file (dispatch.ts:133-135) forwards the error via `friendlyMessage(e)` into an `err(...)` result — not swallowed |
| cc-defensive-programming | Assertions for bugs only / anticipated input gets error handling | PASS | Out-of-range `frameCount`/`sceneThreshold` are anticipated bad input from an external caller, correctly handled via zod validation (error handling), not an assertion |

## Notes (non-blocking)
- The `opts` construction block (dispatch.ts:115-128) repeats the same `...(args.X !== undefined ? { X: args.X } : {})` pattern 12 times. This is consistent with pre-existing style in the file (not introduced by this change) and is a style observation only — no requirement calls for refactoring it.
- `frameCount` has no declared upper bound (only `>=1`); `sceneThreshold`/`frameCount` have no adapter-layer consumer in the reviewed file set (adapters are out of scope for this review), so whether a very large `frameCount` is handled sanely downstream was not assessed here.
- DW-3.1's test uses a generic fixture adapter (`OK_ADAPTER`) rather than a real frame-extraction adapter — sufficient to prove opts-forwarding at the tool boundary (the DW item's actual scope), but does not by itself prove a real adapter reads these keys correctly (that's outside src/tools/dispatch.ts).

## Issues (if FAIL)
None.

**Verdict: PASS**
