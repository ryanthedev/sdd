# Review: Phase 2 - JobStore (security-sensitive sample 2)

## Executed Results (Step 0)
- Test suite (full): `bun test` → **34 pass / 0 fail** (96 expect() calls, 4 files).
- Test suite (target file): `bun test test/jobs.test.ts` → **23 pass / 0 fail** (59 expect() calls).
- Typecheck: `bunx tsc --noEmit` → **EXIT 0** (clean; `tsconfig` has `strict: true`).
- Lint: **N/A — no linter configured** (no biome/eslint/oxlint/dprint config; `package.json` scripts are `start`/`typecheck`/`test` only). Strict `tsc` is the standing static gate and passes.
- Independent adversarial probe (`/tmp/sdd-p2-sample2/probe.ts`, non-mutating): dispatched a prompt `x; rm -rf / \`id\` $(whoami)` through a stub adapter → child received it **byte-for-byte** (`SUMMARY_EQ_HOSTILE true`), and a `process.env.SDD_SECRET` value was **not** present in the job log (`LOG_CONTAINS_SECRET false`). Confirms DW-2.6 and the env-leak edge case independently of the author's own test.

## Requirement Fulfillment

### DW-2.1
PREMISE:  "dispatch returns a jobId synchronously (< 100ms) while the child runs; a fake fast adapter reaches done with a populated AdapterResult."
EVIDENCE: `src/lib/jobs.ts:100-116` (`dispatch` is fully synchronous — no `await` anywhere; returns `id` at :115). Terminal classification at `:342-367`. Test `test/jobs.test.ts:83-112`.
TRACE:    `dispatch(fast, "do the thing")` → validate → `spawn` (async child) → return id. Test measures `elapsed < 100`ms and `state === "running"` immediately; after `wait`, `state === "done"`, `exitCode === 0`, `result.status === "done"`, `result.summary` contains "ok".
VERDICT:  PASS (test ran green in Step 0).

### DW-2.2
PREMISE:  "A child that exits 0 but omits the required contract marker lands in failed (silent-misparse backstop), asserted with a stub adapter."
EVIDENCE: `#classify` at `src/lib/jobs.ts:353-367` — `job.exitCode` set to 0, then `job.state = result.status === "done" ? "done" : "failed"`. Stub parser returns `failed` when marker absent. Test `test/jobs.test.ts:117-136`.
TRACE:    child writes "did some stuff, exiting 0", exits 0 → `parseResult` sees no `VERDICT:` → returns `status:"failed"` → `job.exitCode === 0` AND `job.state === "failed"`. Both asserted.
VERDICT:  PASS.

### DW-2.3
PREMISE:  "Two concurrent write-mode dispatches in the same cwd → the second is rejected; two read-mode dispatches run concurrently."
EVIDENCE: `#assertNoWriteConflict` at `src/lib/jobs.ts:222-233` (guards only `mode === "write"` with matching running `cwd`). Tests `test/jobs.test.ts:141-181` (reject same-cwd 2nd write; allow different cwds; allow two same-cwd reads) plus `:434-442` (opts.mode override).
TRACE:    write A in cwd → running; write B same cwd → loop finds running write job with equal cwd → throws `/write-write conflict/`. Two reads same cwd → guard early-returns (mode ≠ write) → both running. `dispatch` is synchronous end-to-end (no `await` between the guard check at :107 and the `#jobs.set` at :317), so no interleaving window exists in the single-threaded runtime.
VERDICT:  PASS.

### DW-2.4
PREMISE:  "wait([...], shortTimeout) returns {done, stillRunning} partial and never exceeds the timeout; cancel terminates a running child and its subprocess group."
EVIDENCE: `wait` at `src/lib/jobs.ts:130-159` (`Promise.race` of all-done vs unref'd timer). `cancel` at `:166-176` → `#killGroup` at `:370-382` (`process.kill(-pid, "SIGKILL")`). Tests `test/jobs.test.ts:186-235`.
TRACE:    `wait([quick, slow], 1500)` → quick done, slow still running → partial classification returned. `wait([slow], 250)` → resolves at ~250ms (`elapsed < 2000`), never near the `1e9` interval. `cancel`: child spawns a NON-detached grandchild (`sleep 300`, same group); `process.kill(-pid)` reaps the whole group → grandchild pid observed dead via `until(() => !pidAlive(gpid))`; job settles `failed` (signal path).
VERDICT:  PASS.

### DW-2.5
PREMISE:  "shutdown() (and a SIGINT to the server) kills every tracked child — no orphaned pids remain (asserted by pid liveness check post-shutdown)."
EVIDENCE: `shutdown` at `src/lib/jobs.ts:183-191` (kill each running group, `await Promise.all(done)`). Signal handlers at `:391-401`. Tests `test/jobs.test.ts:245-309` — in-process shutdown AND a real out-of-process Bun harness with `installSignalHandlers`, killed via `proc.kill("SIGINT")`.
TRACE:    shutdown → `#killGroup` SIGKILLs each group → `close` fires → `finalize` → `resolveDone` → `await` returns → `pidAlive(pidA/pidB) === false`, both jobs `failed`. SIGINT harness: real subprocess dispatches a sleeper writing its pid; SIGINT delivered; JobStore's own handler reaps → tracked child pid observed dead.
VERDICT:  PASS.

### DW-2.6
PREMISE:  "prompt/opts reach the child via an argv array; a prompt containing shell metacharacters (`; rm -rf`, backticks) is passed literally with no shell evaluation (asserted)."
EVIDENCE: `#buildArgv` runtime guard at `src/lib/jobs.ts:241-255`; `spawn(argv[0]!, argv.slice(1), { shell: false, cwd, ... })` at `:282-288`. Tests `test/jobs.test.ts:314-343`. Independently reproduced by my probe (Step 0).
TRACE:    `HOSTILE = "hello; rm -rf $HOME && \`touch /tmp/pwned\` | cat"` → passed as a discrete argv element → child writes it verbatim → `received === HOSTILE` byte-for-byte AND `/tmp/pwned` never created. My own probe with a different hostile string got identical literal delivery. A non-array `buildArgs` return is rejected before spawn (`:335-343`).
VERDICT:  PASS.

**All requirements met:** YES

## Test-DW Coverage
- [x] All 6 DW items have automated tests named after their DW id (`test_DW_2_1_*` … `test_DW_2_6_*`), all ran green in Step 0.
- [x] Every prompt-listed edge case has a dedicated test (see table below).
- [x] Coverage level 100%: every public method (`dispatch`, `get`, `wait`, `cancel`, `shutdown`) and every branch of the classify/finalize/guard logic is exercised, including both terminal paths (signal → failed, parseResult → done/failed), the spawn-error path, the parser-throw path, timeout clamping, and idempotent shutdown.

| Edge case (from prompt) | Test | Ran |
|---|---|---|
| exit 0 but parseResult failed → failed | `test_DW_2_2_*` | PASS |
| killed by signal → failed w/ signal noted | `test_killed_by_signal_notes_the_signal` (:405) | PASS |
| log file unwritable → fail fast | `test_dispatch_unwritable_log_fails_fast` (:368) | PASS |
| wait on unknown jobId → reported not thrown | `test_wait_on_unknown_jobid_is_reported_not_thrown` (:348) | PASS |
| concurrent write same cwd → rejected, actionable msg | `test_DW_2_3_second_write_same_cwd_rejected` (:141); msg at jobs.ts:227-230 names job id, adapter, cwd, and remediation | PASS |
| SECURITY: argv array + explicit cwd, never shell | `test_DW_2_6_*` + my probe | PASS |
| SECURITY: no env secrets in log | verified — `logStream.write` only fires in the two stdout/stderr `data` handlers (jobs.ts:295,299); env is never written. My probe confirmed `LOG_CONTAINS_SECRET false` | PASS |

## Dead Code
None found. All imports (`closeSync`/`createWriteStream`/`mkdirSync`/`mkdtempSync`/`openSync`/`statSync`, path/os helpers, `log`, `newJobId`) are used. No unreachable post-return code, no debug/commented blocks.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | `dispatch` is synchronous start-to-finish (no `await` between the write-conflict check at :107 and `#jobs.set` at :317), so the guard has no TOCTOU window in the single-threaded runtime. Double-finalize prevented by the `settled` flag (:320-321) shared between `close` and `error` handlers. `wait` timer is `unref`'d and cleared (:146-149). |
| Error Handling | PASS | Trust-boundary input all validated with thrown `Error`/`TypeError` before any side effect (adapter shape, prompt type, cwd existence/dir, argv array+string, log writability). Async exit handled via `close`/`error` events, not a synchronous try; a throwing `parseResult` is contained → `failed` (:357-363, test :378). Spawn `ENOENT` → `error` event → `failed` (test :394). |
| Resources | PASS | `logStream.end()` runs exactly once in `finalize` (:322). Child groups reaped on cancel/shutdown; `shutdown` awaits all `done` promises before returning. Log file writability proven by a touch that is immediately closed (:266). No handle left dangling on the tested paths. |
| Boundaries | PASS | Empty argv rejected (:244); `argv[0]!` safe after the non-empty check. `code ?? -1` handles a null exit code (:353). Unknown ids in `wait`/`cancel`/`get` return/report rather than throw. Timeout clamped to `[0, maxTimeoutMs]` with NaN fallback (:384-387, test :415). |
| Security | PASS | `shell: false` explicit + argv-array spawn + runtime string-array guard = no code path interpolates prompt/opts into a shell string. Verified by the author's test AND my independent probe. `env: process.env` is required for harness credentials and is never written to the log (confirmed by trace and probe). Detached group enables full-group kill. |

## Loaded-Skill Criteria

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | No executable code in assertions | PASS | No `assert()` used; boundary checks are real `throw` statements that survive in production. |
| cc-defensive-programming | No empty catch that swallows bugs | PASS | Every catch either re-throws with a clearer message (:214,261,267) or records `failed` (:359). The two nested catches in `#killGroup` (:375-380) are the justified, documented ESRCH case ("process already exited"), not silent bug-swallowing. |
| cc-defensive-programming | External input validated at entry (barricade) | PASS | `dispatch` is a clean barricade: adapter object/name/mode/functions, prompt type, cwd, argv content, and log writability all validated before any spawn. "Internal team API is still external" is honored — the adapter's `buildArgs` return is re-validated at runtime even though the type says `string[]`. |
| cc-defensive-programming | Assertions for bugs only; anticipated bad input gets error handling | PASS | All anticipated bad input (bad cwd, unwritable log, malformed adapter, write conflict) is error-handled with thrown errors, not assertions. Correctness-leaning strategy fits a spawn/reap component (shut the job to `failed` rather than emit a wrong result). |
| cc-routine-and-class-design | Class cohesion / single responsibility | PASS | `JobStore` hides one capability (spawn + lifecycle + reaping of child jobs) behind a small surface; helpers are each one operation at their abstraction level (`#resolveCwd`, `#buildArgv`, `#openLogPath`, `#classify`, `#killGroup`). |
| cc-routine-and-class-design | Parameter count ≤ 7 | PASS | Public methods 1-3 params. Largest routine is the private `#spawnAndTrack` at 6 params (id, adapter, mode, cwd, logPath, argv) — within the PASS band (6-7, minor concern); all args are pre-validated primitives flowing one direction. See Note 1. |
| cc-routine-and-class-design | Inheritance / LSP | N/A | No inheritance; `JobStore` is a standalone class. No base-class substitution to verify. |

## Notes (non-blocking)
1. `#spawnAndTrack` takes 6 positional parameters (jobs.ts:274-281). Within Code Complete's PASS band but at the "minor concern" edge; a small internal struct (or passing the assembled `Job` plus `{adapter, argv}`) would future-proof it. Not a violation.
2. `createWriteStream` (jobs.ts:290) has no `'error'` listener. The pre-spawn touch (:266) already proves the path is writable, so a create-time failure is not reproducible; but a *mid-run* stream error (e.g. disk fills while streaming) would surface as an unhandled `'error'` event. No DW item or listed edge case requires mid-run log-write resilience, and I could not demonstrate a failure — robustness note only.
3. Orphan-on-unclean-kill assessment (explicitly requested): `detached: true` is required so `cancel`/`shutdown` can SIGKILL the whole group. The trade-off is real and correctly bounded — SIGINT/SIGTERM are caught and reap children (DW-2.5, proven by the out-of-process harness test), but an uncatchable `SIGKILL` to the server leaves the detached groups orphaned. This is inherent to detached groups, not a defect against any requirement. It is *partially* documented (jobs.ts:284 explains the group-kill rationale; the harness comment at test:290-291 notes the server owns `process.exit`), but the specific "SIGKILL-to-server orphans children" consequence is not called out in a comment. Consider one line in the class header documenting it as accepted behavior. Note, not a FAIL.
4. No linter is configured in the repo, so the dispatch's "lint" step has nothing to run; strict `tsc` passes and serves as the static gate.

## Issues (if FAIL)
None.

**Verdict: PASS** — all six DW items verified with execution evidence and independent traces; every prompt-listed edge case has a green test; both loaded skills' criteria pass; the trust boundary (argv-array spawn, `shell:false`, env never logged) holds under both the author's tests and my own adversarial probe. Findings are limited to non-blocking notes.
