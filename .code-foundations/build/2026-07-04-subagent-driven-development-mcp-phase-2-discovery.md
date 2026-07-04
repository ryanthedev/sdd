# Discovery + Design: Phase 2 - JobStore (spawn, lifecycle, logging, mode guard, reaping)

## Files Found
- `src/types.ts` — core domain types: `AdapterMode`, `JobState`, `AdapterResult`, `DispatchOpts`, `Job` (Phase 1, consume verbatim).
- `src/adapters/types.ts` — `Adapter` port: `name`, `mode`, `buildArgs(prompt, opts): string[]`, `injectContract(prompt): string`, `parseResult(stdout, stderr, exitCode): AdapterResult` (Phase 1, consume verbatim).
- `src/adapters/discover.ts` — directory-scan registry returning `Adapter[]` (Phase 1). Not touched by this phase.
- `src/lib/log.ts` — `log(...args)` → stderr-only (`console.error("[sdd]", ...)`). The only sanctioned logging channel.
- `src/server.ts` / `src/register.ts` — boot + zero tools + SIGINT/SIGTERM shutdown that calls `server.close()` then `process.exit(0)`. NOT in this phase's file scope (Phase 3 owns `register.ts`; it will construct the JobStore and wire `shutdown()`).
- `test/adapters-discover.test.ts` — existing test conventions: `bun:test`, `mkdtempSync` per-test temp dirs, `captureStderr` helper, `test_DW_x_y_...` naming.

## Current State
Phase 1 is committed: port + core types + discovery + zero-tool boot, 11 tests, `tsc` clean. No runtime job machinery exists yet. `src/lib/jobs.ts` and `src/lib/ids.ts` do not exist.

## Gaps
- No spawn/lifecycle machinery — this phase creates it (`JobStore`).
- The `Job` type carries no `pid` / child-process handle (by design — internal). JobStore keeps a private `TrackedJob` record wrapping the public `Job` plus the child handle, buffers, log stream, and a completion promise.
- `dispatch(adapter, ...)` takes the **Adapter object** (not a name) — Phase 3's `list_adapters`/dispatch tool resolves a name → Adapter via `discoverAdapters()` and hands JobStore the object (plan line 89 confirms: no `listAdapters` on JobStore).
- The plan's `wait` contract is `{done, stillRunning}` but the edge case "wait on an unknown jobId → reported, not thrown" needs a reporting channel. Resolved by returning a superset `{done, stillRunning, unknown}` (extra field; Phase 3 keeps consuming `done`/`stillRunning` verbatim). Recorded under Deviations.

## Code Standards
No `docs/code-standards.md` found. Conventions inferred from Phase 1 code and enforced here:
- Bun + strict TS (`noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `strict`). `.ts` import extensions.
- stderr-only logging via `src/lib/log.ts` — never `console.log` (stdout is the JSON-RPC transport).
- Rich doc comments explaining the "why" (security rationale, dependency direction).
- Spawn with an **argv array + explicit cwd, never a shell string** (the security barricade).

## Test Infrastructure
`bun test` (bun:test: `test`, `expect`, `afterEach`). Per-test `mkdtemp` temp dirs, `captureStderr`, DW-tagged test names. Stubs are plain objects implementing the `Adapter` interface whose `buildArgs` returns argv running `bun -e`/`sleep`/a temp writer script — no codex/agy needed.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-2.1 | dispatch returns a jobId synchronously (<100ms) while child runs; fast adapter reaches `done` with populated `AdapterResult` | COVERED | `test_DW_2_1_dispatch_returns_id_synchronously_and_reaches_done` (asserts `dispatch` returns a string in <100ms, then `wait` → `done`, `job.state==="done"`, `result.status==="done"`, summary populated) |
| DW-2.2 | Child exits 0 but omits the required contract marker → `failed` (silent-misparse backstop) | COVERED | `test_DW_2_2_exit_zero_without_marker_is_failed` (stub exits 0 with markerless stdout; `parseResult` returns failed; job lands `failed` with `exitCode===0`) |
| DW-2.3 | Two concurrent write dispatches in same cwd → 2nd rejected; two reads run concurrently | COVERED | `test_DW_2_3_second_write_same_cwd_rejected`, `test_DW_2_3_two_reads_run_concurrently`, `test_DW_2_3_writes_in_different_cwds_allowed` |
| DW-2.4 | `wait([...], shortTimeout)` returns partial and never exceeds timeout; `cancel` kills child + its subprocess group | COVERED | `test_DW_2_4_wait_returns_partial_within_timeout`, `test_DW_2_4_wait_never_exceeds_timeout`, `test_DW_2_4_cancel_terminates_child_and_group` (grandchild pid ESRCH) |
| DW-2.5 | `shutdown()` and a SIGINT to the server kill every tracked child — no orphaned pids | COVERED | `test_DW_2_5_shutdown_kills_all_tracked_children` (pid liveness `kill(pid,0)`→ESRCH), `test_DW_2_5_sigint_to_server_reaps_children` (real Bun harness subprocess w/ `installSignalHandlers`, SIGINT, grandchild pid ESRCH) |
| DW-2.6 | prompt/opts reach the child via argv array; shell metacharacters passed literally, no shell eval | COVERED | `test_DW_2_6_metacharacters_passed_literally` (writer script records `argv`; asserts `; rm -rf`/backtick prompt arrives byte-for-byte), `test_DW_2_6_buildArgs_nonarray_rejected` (runtime barricade rejects a shell-string return) |

**All items COVERED:** YES (6 DW-IDs in prompt == 6 rows here)

Extra coverage beyond the DW floor: unknown-jobId `wait` (reported not thrown), `cancel`/`get` on unknown id (no-op/undefined), `parseResult` that throws → `failed`, spawn `error` (bad command) → `failed`, killed-by-signal → `failed` with signal noted, log-file-unwritable → dispatch fails fast, cwd-does-not-exist → dispatch fails fast, timeout clamp to the documented cap.

## Design Decisions

### cc-routine-and-class-design (APPLIER)
- **Containment, no inheritance.** `JobStore` is a standalone class; it *contains* a `Map<string, TrackedJob>`, a log dir, timeout config, and optional signal handlers. No "is-a" relationship anywhere → LSP N/A, containment default satisfied. Final check: depth 0, no protected data (all `#private`), no empty overrides. PASS.
- **Parameter counts:** `dispatch(adapter, prompt, opts)`=3, `wait(jobIds, timeoutMs)`=2, `get`=1, `cancel`=1, `shutdown`=0. All ≤ 5 → PASS.
- **Functional cohesion:** `dispatch` is one operation at its abstraction level ("create+launch a job", like `CreateUser`); its lower-level steps are extracted into named private helpers: `#assertValidAdapter`, `#resolveCwd`, `#assertNoWriteConflict`, `#buildArgv`, `#openLogPath`, `#classify`, `#killGroup`. The shutdown/signal handling is an *orchestrator* (temporal cohesion is acceptable because it only coordinates `#killGroup` calls + awaits). PASS.
- **Information hiding — "what does this class hide?"** the child-process handles, the pid/process-group mechanics, the log streaming, the completion-promise wiring, and the temp log dir. Callers see only `{dispatch, get, wait, cancel, shutdown}` over plain `Job`/`AdapterResult` data.

### cc-defensive-programming (APPLIER)
- **Barricade at `dispatch` (the trust boundary).** `prompt`/`opts` are untrusted. All validation happens here (error handling, not assertions, because these are anticipated bad inputs from a public API): adapter shape, `prompt` is a string, cwd exists+is-a-dir (fail fast), and — the security barricade — `buildArgs` must return a **non-empty array of strings** (runtime guard backing the type-level `string[]` guarantee; rejects any accidental shell-string / non-string element).
- **Spawn is argv-array + explicit `cwd` + `shell:false` + `detached:true`.** Using `node:child_process.spawn` (not Bun.spawn) specifically for `detached:true` → the child becomes its own process-group leader (`setsid`), which is what lets `cancel`/`shutdown` kill the **whole group** (`process.kill(-pid, SIGKILL)`) including grandchildren. Explicit reaping (plan's "not detached" intent = server-owned, reaped on shutdown) is preserved by killing on `cancel`/`shutdown`.
- **Untrusted output parsing is wrapped.** `adapter.parseResult(...)` runs inside try/catch — a throwing parser yields `failed`, never crashes the store. Child `error` (e.g. ENOENT command) → `failed`. Killed-by-signal → `failed` with the signal noted (does not trust `parseResult`).
- **No secrets in logs.** The per-job log receives only child stdout/stderr, never `env`. `env: process.env` is passed *to the child* (harness needs credentials) but never written to the log.
- **Correctness lean:** a job whose result is uncertain (parser throws, signal kill, exit≠success-marker) is marked `failed` rather than optimistically `done` — never report a wrong "done".
- **No empty catch:** the only bare catches are documented "process already exited — nothing to kill" no-ops in `#killGroup`.

### Key mechanics
- **`ids.ts`:** `newJobId()` → `` `job-${randomUUID()}` `` (collision-free, readable).
- **`dispatch` is synchronous** (returns `jobId: string`, not a Promise) — spawn returns immediately; child runs async. Guarantees the <100ms DW-2.1 contract.
- **`wait`** builds per-job completion promises and `Promise.race`s them against an `unref`'d `setTimeout(timeout)`; clears the timer if all finish first → never blocks past the timeout. Default 30s, clamped to a 10min cap.
- **`shutdown()`/`cancel()` are async** and `await` the child's `close` — so post-call the pid is reaped and `process.kill(pid,0)` deterministically throws `ESRCH` (DW-2.5/2.4 assertions).
- **Signal handlers** are opt-in via `new JobStore({ installSignalHandlers: true })`. The handler only *reaps children* (calls `shutdown()`), never `process.exit` — the server (register.ts, Phase 3) owns exit. Handlers are removed on `shutdown()` (idempotent, no listener leak across test JobStores).
- **`logDir` injectable** via constructor for test isolation + to exercise the unwritable-log fail-fast path (uid-independent: point logDir under a regular file → `mkdir` ENOTDIR).

## Prerequisites
- [x] Phase 1 port + core types exist and are exported.
- [x] `node:child_process` / `node:fs` available under Bun 1.3.14.
- [x] Test harness (`bun test`) working.
- [ ] Empirical check during build: `node:child_process` `detached:true` process-group kill semantics under Bun on macOS (validated by the grandchild-ESRCH tests; fallback = direct-pid kill already wired in `#killGroup`).

## Recommendation
BUILD — the plan fits reality. Implement `src/lib/ids.ts`, `src/lib/jobs.ts`, `test/jobs.test.ts`. One documented extension: `wait` returns a `{done, stillRunning, unknown}` superset to satisfy the "unknown jobId reported not thrown" edge case without breaking the verbatim `{done, stillRunning}` consumption.
