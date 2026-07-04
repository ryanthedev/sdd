# Discovery + Design: Phase 3 - Tool surface (6 MCP tools) + codex adapter

## Files Found
- `src/lib/jobs.ts` — Phase 2's `JobStore`: `dispatch(adapter, prompt, opts) → jobId`, `get(jobId) → Job|undefined`,
  `wait(jobIds, timeoutMs) → {done, stillRunning, unknown}`, `cancel(jobId) → boolean`, `shutdown()`. Throws
  synchronously on bad adapter/cwd/write-conflict (no job created). Job state is `running|done|failed`, decided
  by exit code AND `parseResult` marker validation (never pid-liveness alone) — confirmed by reading `#classify`.
- `src/types.ts` — `AdapterMode`, `JobState`, `AdapterResult { status, summary, artifacts, raw }`, `DispatchOpts`
  (`cwd?`, `mode?`, `timeoutMs?`, open index signature), `Job`.
- `src/adapters/types.ts` — `Adapter` port: `name`, `mode`, `buildArgs(prompt, opts): string[]`,
  `injectContract(prompt): string`, `parseResult(stdout, stderr, exitCode): AdapterResult`.
- `src/adapters/discover.ts` — `discoverAdapters(dir): Adapter[]`, directory-scan, synchronous `require`,
  never throws, skips infra files (`discover.ts`, `types.ts`) and anything missing a required export.
- `src/lib/log.ts` — `log(...args)` → `console.error("[sdd]", ...)`, stderr-only.
- `src/register.ts` — Phase 1 stub: builds the `McpServer`, zero tools registered, SIGINT/SIGTERM close +
  `process.exit(0)`. This phase adds tool registration and JobStore-shutdown composition.
- `test/jobs.test.ts` — Phase 2's pattern: stub `Adapter` objects spawning real short-lived `bun -e ...`
  children so DW behavior is proven deterministically without codex/agy installed; per-test fresh log dirs;
  `afterEach` calls `store.shutdown()`.
- `test/adapters-discover.test.ts` — pattern for writing adapter fixtures to a fresh `mkdtemp` dir per test
  (avoids `require` cache collisions across tests).
- `/Users/r/repos/oberskills/mcp/src/register.ts` + `src/lib/tool.ts` + `src/tools/grade-run.ts` — the
  ToolModule shape to mirror: `{name, title, description, inputShape: z.ZodRawShape, handler}`, `ok()`/`err()`
  result helpers, `friendlyMessage()`, registrar wraps each tool's `invoke` in try/catch and turns a throw into
  an `isError` MCP result.

## Current State
Phase 1 + 2 are complete and match the plan's contract exactly: the `Adapter` port, core types, directory-scan
discovery, and a fully defensive `JobStore` all exist and are tested (11 + 34 tests). `src/tools/` does not exist
yet. `src/register.ts` registers zero tools. No adapter files exist under `src/adapters/` besides the
infra files (`types.ts`, `discover.ts`).

`codex` **is** on PATH in this build environment (`/Users/r/.nvm/.../bin/codex`, `codex exec --help` confirms
`-s/--sandbox <read-only|workspace-write|danger-full-access>`). Per the dispatch prompt's explicit instruction,
tests must not depend on the real binary (no network calls, no cost, deterministic CI) — so the round-trip test
uses a stub adapter (same technique as Phase 2's suite), and `codex`'s own `buildArgs`/`injectContract`/
`parseResult` are unit-tested as pure functions with synthetic stdout/stderr/exitCode, per the prompt's explicit
allowance ("The codex adapter's parseResult must be unit-testable with sample stdout/stderr strings").

## Gaps
- The plan's Adapter port has no field for "the CLI binary name if it differs from the adapter name" — `codex`'s
  binary is literally `codex`, so `list_adapters`' PATH check uses `adapter.name` directly. This is a documented
  assumption, not a gap for this phase (only `codex` ships here); Phase 4 owns whatever `agy`/`agy-image` need.
- No shared "runtime" (JobStore instance + adapters dir) yet — needed so all six tools operate on the same
  JobStore. Built in this phase as `src/tools/runtime.ts` (in scope: `src/tools/**`).

## Code Standards
No `docs/code-standards.md` found in this repo. Following the house conventions from the dispatch prompt
(mirror oberskills' register.ts/tools pattern) and the conventions already established in Phase 1/2 code
(stderr-only logging, JSDoc module banners explaining responsibility + security reasoning, defensive
validation at boundaries, `#private` fields, functional-cohesion-named helpers).

## Test Infrastructure
`bun test` (Bun's built-in Jest-compatible runner: `test`, `expect`, `afterEach`, `mock`/`spyOn` available from
`"bun:test"`). Existing tests use `mkdtempSync` fixture dirs, stub `Adapter` objects spawning `bun -e` one-liners
as fast fake children, and an `until()` poll helper. This phase follows the same pattern for tool-level tests.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-3.1 | All six tools registered and callable; dispatch→wait→result round-trip (stub if codex absent) returns structured `{status, summary, artifacts, raw}` | COVERED | `test_DW_3_1_dispatch_wait_result_round_trip_returns_structured_result` (stub adapter through the six tool handlers); `register.ts` wiring verified by `test_all_six_tools_registered_on_server` |
| DW-3.2 | codex `parseResult` puts the answer in `summary`/`raw` from stdout and never leaks stderr progress into `summary` | COVERED | `test_DW_3_2_parseResult_summary_and_raw_from_stdout_only`, `test_DW_3_2_stderr_progress_never_leaks_into_summary` (in `test/adapter-codex.test.ts`) |
| DW-3.3 | `list_adapters` reports codex with mode + `binaryPresent` (false when not on PATH) | COVERED | `test_DW_3_3_list_adapters_reports_codex_from_real_adapters_dir`; `test_DW_3_3_binaryPresent_true_for_a_real_binary_and_false_for_a_fake_one` (deterministic, doesn't depend on whether `codex` itself is installed) |
| DW-3.4 | `status` distinguishes `running` from `done`/`failed` via exit+marker validation, not pid-liveness alone | COVERED | `test_DW_3_4_status_running_then_done_with_marker`, `test_DW_3_4_status_failed_on_exit_0_without_marker_not_done` |
| Edge | dispatch to unknown adapter → clear error, no job created | COVERED | `test_edge_dispatch_unknown_adapter_returns_error_and_creates_no_job` (spies on `jobStore.dispatch`, asserts not called) |
| Edge | result on a still-running job → running status, no partial artifact | COVERED | `test_edge_result_on_running_job_returns_running_not_partial_artifact` |
| Edge | dispatch a write job blocked by JobStore's guard → surfaced cleanly | COVERED | `test_edge_dispatch_write_write_conflict_surfaced_as_clean_error` |

**All items COVERED:** YES

## Design Decisions

**Tool module shape — factory functions, not bare static exports.** oberskills' tools are stateless (each call
does its own I/O fresh); ours share one mutable `JobStore` across all six tools, so a bare `export const
handler` (module-load-time closure with no way to inject a test double) would make `dispatch`/`status`/
`result`/`wait`/`cancel` impossible to unit-test in isolation and would force tests to share global mutable
state. Instead each tool module exports `name/title/description/inputShape` as before, plus a factory
`createXTool(rt: Runtime): ToolModule<Shape>` whose `handler` closes over the injected `rt`. This keeps the
per-object shape identical to the mirrored pattern (`{name, title, description, inputShape, handler}`) while
making the JobStore dependency explicit and swappable — the defensive-programming principle of no hidden
global coupling, and a straightforward DI seam for tests (cc-routine-and-class-design: prefer an explicit,
narrow, testable interface over an implicit one).

**`Runtime` is a plain data holder, not a class.** `{ jobStore: JobStore, adaptersDir: string }` plus two free
functions (`listAdapters(rt)`, `findAdapter(rt, name)`) that call `discoverAdapters(rt.adaptersDir)` fresh each
time (cheap, and adapters are directory-scanned by design so a freshly-dropped adapter file is picked up
without a restart). No behavior hides inside `Runtime` itself — functional cohesion at the free-function level
instead of a fat class.

**`list_adapters` binary-presence check uses `Bun.which(adapter.name)`.** No subprocess spawn, synchronous,
already typed in `bun-types`. Assumption: the adapter's `name` doubles as its CLI binary name — true for
`codex` (this phase's only adapter). Documented in code; not solved generically because the frozen `Adapter`
port (Phase 1, read-only in this phase) has no separate binary-name field, and only `codex` ships here.

**Server shutdown composition: explicit `jobStore.shutdown()`, not `JobStore`'s built-in signal handlers.**
`JobStore` offers an opt-in `installSignalHandlers` for standalone use (Phase 2's own tests deliberately leave
it off). The real server already installs its own SIGINT/SIGTERM handler (Phase 1) that closes the MCP
transport and calls `process.exit(0)`. Installing a second, independent signal handler inside `JobStore` would
race against that shutdown sequence (order of `process.on` registration decides who runs first; `process.exit`
in the register.ts handler could fire before JobStore finishes reaping). Composing explicitly — `register.ts`'s
shutdown handler awaits `runtime.jobStore.shutdown()` before closing the transport and exiting — keeps the
shutdown sequence deterministic: reap children, then close transport, then exit.

**codex `buildArgs` sandbox mapping.** `codex exec --help` (verified in this environment) lists
`--sandbox <read-only|workspace-write|danger-full-access>` — not the plan doc's generic `<mode>` placeholder.
Mapped `AdapterMode` → sandbox flag: `"read" → "read-only"`, `"write" → "workspace-write"`; `danger-full-access`
is never emitted (constraint: read-only unless the job is write mode). `buildArgs` resolves
`opts.mode ?? mode` (the module's own exported `mode` constant) itself, since `JobStore.dispatch` calls
`adapter.buildArgs(contracted, opts)` with the *original* `opts` — the resolved effective mode used for the
write-write guard is computed inside `JobStore`, not threaded back into `opts`, so `buildArgs` must independently
apply the same `opts.mode ?? adapter.mode` fallback to pick a consistent sandbox flag.

**codex contract markers.** `injectContract` appends an explicit instruction block asking for a line starting
`VERDICT:` and a `## Findings` section. `parseResult` validates both are present in **stdout only**; either
missing (or a non-zero exit code) → `failed` — the same silent-misparse backstop pattern DW-2.2 established for
JobStore, applied here to codex's own contract. `stderr` is accepted as a parameter (matching the Adapter port
signature) but never concatenated into `summary`/`raw`, satisfying DW-3.2 structurally, not just by test luck.

## Prerequisites
- [x] Phase 1 (`Adapter` port, core types, `discoverAdapters`) and Phase 2 (`JobStore`) complete and read.
- [x] `codex` CLI present in this dev environment for manual `--help` verification (not used at test runtime).
- [x] Bun 1.3.14, `Bun.which` typed and functional (verified).
- [ ] None missing.

## Recommendation
BUILD. Stub the interface (Runtime, ToolModule shape, six tool factories, codex adapter signatures), implement
each DW item, then validate with `bun test` + `tsc --noEmit`.
