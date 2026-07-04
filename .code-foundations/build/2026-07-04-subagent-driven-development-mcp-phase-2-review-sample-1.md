# Review: Phase 2 - JobStore (security-sensitive sample 1)

## Executed Results (Step 0)
- Test suite (target file): `bun test test/jobs.test.ts` → **23 pass / 0 fail**, 59 expect() calls.
- Test suite (full): `bun test` → **34 pass / 0 fail** across 4 files.
- Typecheck: `bunx tsc --noEmit` → exit 0 (clean).
- Lint: no linter configured (no biome/eslint/prettier config; `package.json` scripts are `start`, `typecheck`, `test`). tsc is the project's static gate and passes. N/A.

## Requirement Fulfillment

### DW-2.1
PREMISE:  dispatch returns a jobId synchronously (< 100ms) while the child runs; a fake fast adapter reaches done with a populated AdapterResult.
EVIDENCE: `src/lib/jobs.ts:100-116` (synchronous `dispatch` returning `string`), `:274-334` (`#spawnAndTrack` — child runs async, `close` handler calls `#classify`). Test `test/jobs.test.ts:83-112`.
TRACE:    dispatch(fast,"do the thing") → validates → spawns detached child (`bun -e "…VERDICT: ok"`) → returns `job-<uuid>` in <100ms with state `running`; on child close, `#classify` (exit 0, marker present) sets state `done`, exitCode 0, result.status `done`, summary contains "ok".
VERDICT:  PASS (elapsed<100 asserted; wait→done; job.result populated).

### DW-2.2
PREMISE:  A child that exits 0 but omits the required contract marker lands in failed (silent-misparse backstop), asserted with a stub adapter.
EVIDENCE: `src/lib/jobs.ts:342-367` (`#classify`: no signal → exitCode 0 → parseResult drives state; `state = result.status === "done" ? "done" : "failed"`). Test `test/jobs.test.ts:117-136`.
TRACE:    child writes "did some stuff, exiting 0", exits 0 → parseResult finds no "VERDICT:" → returns status `failed` → job.exitCode 0 AND job.state `failed`.
VERDICT:  PASS (exitCode 0 and state failed both asserted).

### DW-2.3
PREMISE:  Two concurrent write-mode dispatches in the same cwd → the second is rejected; two read-mode dispatches run concurrently.
EVIDENCE: `src/lib/jobs.ts:222-233` (`#assertNoWriteConflict` — only checks running write jobs with matching cwd). Tests `test/jobs.test.ts:141-181` (reject same-cwd write; allow different-cwd writes; allow two reads) and `:434-442` (opts.mode override).
TRACE:    dispatch #1 write cwd=X → running; dispatch #2 write cwd=X → loop finds running write in X → throws `write-write conflict`. Two reads in X → guard returns early (mode≠write) → both running. dispatch is synchronous with no await between guard and spawn, so no check/spawn interleaving.
VERDICT:  PASS.

### DW-2.4
PREMISE:  wait([...], shortTimeout) returns {done, stillRunning} partial and never exceeds the timeout; cancel terminates a running child and its subprocess group.
EVIDENCE: `src/lib/jobs.ts:130-159` (`wait` — `Promise.race([Promise.all(done), timed]))`, unref'd timer), `:166-176` (`cancel` → `#killGroup` → await done), `:370-382` (`#killGroup` signals `-pid`). Tests `:186-235`.
TRACE:    wait([quick,slow],1500) → quick done, slow still running → {done:[quick], stillRunning:[slow]}. wait([slow],250) resolves at ~250ms (elapsed<2000 asserted), never the 1e9 interval. cancel: child spawns non-detached grandchild (same group) → `process.kill(-pid,SIGKILL)` kills the group → grandchild pid dies (asserted via pidAlive), job→failed via signal path.
VERDICT:  PASS.

### DW-2.5
PREMISE:  shutdown() (and a SIGINT to the server) kills every tracked child — no orphaned pids remain (asserted by pid liveness check post-shutdown).
EVIDENCE: `src/lib/jobs.ts:183-191` (`shutdown` kills each running group and awaits reaping), `:391-401` (`#installSignalHandlers` → SIGINT/SIGTERM → `void this.shutdown()`). Tests `:245-309` (direct shutdown + real-subprocess SIGINT harness).
TRACE:    two children write their pids; shutdown() kills each group and `await Promise.all(done)` → pidAlive(pidA)==false, pidAlive(pidB)==false, both jobs failed. SIGINT test spawns a real Bun harness with installSignalHandlers, SIGINTs it, and asserts the tracked child pid is dead.
VERDICT:  PASS (pid-liveness checks confirm no orphans).

### DW-2.6
PREMISE:  prompt/opts reach the child via an argv array; a prompt with shell metacharacters is passed literally with no shell evaluation (asserted).
EVIDENCE: `src/lib/jobs.ts:241-255` (`#buildArgv` — rejects non-array/non-string), `:282-288` (`spawn(argv[0], argv.slice(1), {shell:false})`). Tests `:314-333` (hostile string round-trips byte-for-byte; `/tmp/pwned` never created) and `:335-343` (non-array buildArgs rejected).
TRACE:    prompt "hello; rm -rf $HOME && `touch /tmp/pwned` | cat" → passed as a discrete argv element to a writer that echoes `argv[3]` → file contains the exact hostile string; `existsSync("/tmp/pwned")===false` (backtick never executed). A malformed adapter returning a shell string throws before spawn.
VERDICT:  PASS.

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have corresponding tests that ran in Step 0 (test names reference DW-IDs: `test_DW_2_1_…` through `test_DW_2_6_…`).
- [x] Coverage matches the stated 100% level; every DW item and every prompt-listed edge case has an executed test:
  - exit 0 but parseResult failed → `test_DW_2_2_exit_zero_without_marker_is_failed` ✓
  - child killed by signal → `test_killed_by_signal_notes_the_signal` ✓
  - log file unwritable → `test_dispatch_unwritable_log_fails_fast` ✓
  - wait on unknown jobId → `test_wait_on_unknown_jobid_is_reported_not_thrown` ✓
  - concurrent write same cwd rejected → `test_DW_2_3_second_write_same_cwd_rejected` ✓
  - SECURITY argv array / no shell → `test_DW_2_6_metacharacters_passed_literally` + `test_DW_2_6_buildArgs_nonarray_rejected` ✓
- No gaps found.

## Dead Code
None found. Every import in `jobs.ts` (spawn/ChildProcess, WriteStream/closeSync/createWriteStream/mkdirSync/mkdtempSync/openSync/statSync, tmpdir, isAbsolute/join/resolve, types, newJobId, log) is used. No unreachable code after returns, no debug statements, no commented-out blocks. `ids.ts` is a single used function.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | `dispatch` is fully synchronous — no await between `#assertNoWriteConflict` (jobs.ts:222) and `#jobs.set` (jobs.ts:317), so the write-guard cannot be raced in single-threaded JS. `settled` flag (jobs.ts:319-325) makes `close`/`error` finalize idempotent. `shutdown` idempotent via `#shuttingDown`. Traced adversarial double-fire and concurrent same-cwd dispatch; both handled. |
| Error Handling | PASS | Barricade at `dispatch` validates adapter, prompt, cwd, argv before any effect. cwd stat failure, log mkdir/open failure, non-array/non-string argv all throw fast with clear messages (jobs.ts:214,262,268,245-252). spawn `error` event → failed (jobs.ts:328-333); parseResult throw contained → failed (jobs.ts:357-363); signal kill → failed (jobs.ts:347-350). All exercised by passing tests. |
| Resources | PASS | logStream `.end()` on finalize (jobs.ts:322); wait timer `unref`'d and `clearTimeout`'d (jobs.ts:145-149) so a pending wait cannot keep the process alive; signal handlers removed on shutdown (jobs.ts:403-408). Child stdio piped and drained into bounded arrays + stream. |
| Boundaries | PASS | `#clampTimeout` handles NaN/undefined→default and clamps [0, max] (jobs.ts:384-387). Empty/unknown id sets handled in `wait`/`get`/`cancel` without throwing. Empty argv rejected (jobs.ts:244). Adversarial NaN timeout traced → returns default, no hang. |
| Security | PASS | Single spawn site, `shell:false`, argv array (`argv[0]` + `argv.slice(1)`), explicit validated cwd (jobs.ts:282-288). No template/string-concatenated command reaches a shell anywhere in the file. prompt→injectContract→buildArgs→`#buildArgv` string-array guard. Logs capture only child stdout/stderr chunks (jobs.ts:293-300); `process.env` is handed to the child (documented, required for the harness) but never written to the log — no secret-leak path in the JobStore. `#killGroup` targets the process group (`-pid`) so grandchildren cannot orphan. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | No executable code in assertions | PASS | `#assert*` methods are real runtime `throw`s (error handling), not compiled-out asserts; nothing relies on assertion side effects. |
| cc-defensive-programming | No empty catch blocks | PASS | Every catch acts: cwd/log catches re-throw with context (jobs.ts:214,261,267), parseResult catch → failed (jobs.ts:359). The one bare catch in `#killGroup` (jobs.ts:378-380) is a documented no-op ("process already exited") after a bare-pid fallback — intentional, not a swallowed bug. |
| cc-defensive-programming | External input validated at entry (barricade) | PASS | `dispatch` is the trust boundary and validates adapter shape, prompt type, cwd existence/dir, and the argv array (types + non-empty) before any spawn (jobs.ts:101-114). Untrusted prompt/opts never reach a shell. |
| cc-defensive-programming | Assertions for bugs only / anticipated errors handled | PASS | Anticipated bad input (missing cwd, unwritable log, malformed adapter, spawn ENOENT, throwing parser) is handled with errors/failed-state, not assertions. Correctness-leaning classify: a job we signalled is never re-parsed (jobs.ts:347-350). |
| cc-routine-and-class-design | Parameter count ≤ 7 | PASS | Max is `#spawnAndTrack` at 6 params (jobs.ts:274-281) — within threshold. `dispatch` 3, `wait` 2, others ≤1. |
| cc-routine-and-class-design | Functional cohesion | PASS | JobStore hides spawn/lifecycle/reaping behind a small surface; each private helper is one operation (`#resolveCwd`, `#buildArgv`, `#openLogPath`, `#classify`, `#killGroup`). `dispatch` orchestrates at its abstraction level. |
| cc-routine-and-class-design | Inheritance / LSP | N/A | No inheritance; JobStore is a standalone class, id scheme isolated in `ids.ts`. Containment/seam design, not inheritance. |

## Notes (non-blocking)
1. `dispatch` has no guard against being called after `shutdown()` — a post-shutdown dispatch would still spawn a child that `shutdown` won't reap. No DW item or edge case requires this; the server owns lifecycle. Minor hardening opportunity only.
2. `env: process.env` forwards the full parent environment to a caller-influenced child. This is intended and documented (the harness needs credentials), and the log-leak vector is closed. Flagging only so the trust decision is explicit: the child (codex/agy) is trusted with credentials; the *prompt* is not, and the prompt path is correctly shell-free.
3. On the spawn-`error` path (jobs.ts:328-333) `job.exitCode` is left undefined (optional field) while `result.status` is `failed` — consistent with the type contract; noted for completeness.

## Issues (if FAIL)
None.

**Verdict: PASS**
