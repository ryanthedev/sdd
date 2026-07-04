# Review: Phase 2 - JobStore (security-sensitive sample 3)

## Executed Results (Step 0)
- Full suite: `bun test` → **34 pass / 0 fail** (96 expect() calls, 4 files)
- Phase-2 file: `bun test test/jobs.test.ts` → **23 pass / 0 fail** (59 expect() calls)
- Typecheck: `bunx tsc --noEmit` → **exit 0** (clean)
- Lint: no linter configured (no biome/eslint/prettier config present); tsc is the only static gate — clean
- Coverage: `bun test test/jobs.test.ts --coverage` → jobs.ts 91.18% funcs / **94.87% lines** (ids.ts + log.ts 100%). Uncovered: 297–298 (stderr streaming handler), 391–399 (`#installSignalHandlers` body — exercised out-of-process by the SIGINT test, so not counted by in-process instrumentation).

## Requirement Fulfillment

### DW-2.1
PREMISE:  "dispatch returns a jobId synchronously (< 100ms) while the child runs; a fake fast adapter reaches done with a populated AdapterResult."
EVIDENCE: jobs.ts:100-116 (fully synchronous dispatch → `return id`); classify at :342-367; test test_DW_2_1 jobs.test.ts:83-112.
TRACE:    dispatch(fast,"do the thing") → sync validate/build/spawn, job.state="running", returns id in <100ms (asserted `elapsed<100`) → child writes "VERDICT: ok", exits 0 → close→#classify→parseResult sees marker→result.status "done" → job.state "done", exitCode 0, result.summary contains "ok".
VERDICT:  PASS

### DW-2.2
PREMISE:  "A child that exits 0 but omits the required contract marker lands in failed (silent-misparse backstop), asserted with a stub adapter."
EVIDENCE: jobs.ts:365-366 (`state = result.status === "done" ? "done" : "failed"`); test test_DW_2_2 jobs.test.ts:117-136.
TRACE:    child prints "did some stuff, exiting 0", exits 0 → #classify: exitCode=0, parseResult finds no "VERDICT:" → returns status "failed" → job.exitCode 0 AND job.state "failed". Asserted exitCode===0 && state==="failed".
VERDICT:  PASS

### DW-2.3
PREMISE:  "Two concurrent write-mode dispatches in the same cwd → the second is rejected; two read-mode dispatches run concurrently."
EVIDENCE: guard jobs.ts:222-233; tests jobs.test.ts:141-181 (second write rejected; different cwds allowed; two reads concurrent).
TRACE:    write A in cwd → running & registered synchronously (:317). write B same cwd → #assertNoWriteConflict finds running write job with matching cwd → throws /write-write conflict/. Two reads: mode!=="write" → guard returns early → both running.
VERDICT:  PASS

### DW-2.4
PREMISE:  "wait([...], shortTimeout) returns {done, stillRunning} partial and never exceeds the timeout; cancel terminates a running child and its subprocess group."
EVIDENCE: wait jobs.ts:130-159 (`Promise.race([all(done), timed]`, `timer.unref`); cancel :166-176; killGroup :370-382 (`process.kill(-pid, SIGKILL)`); tests jobs.test.ts:186-235.
TRACE:    wait([quick,slow],1500) → quick done, slow still running → {done:[q],stillRunning:[s]}. wait([slow],250) → race resolves at ~250ms (elapsed<2000, not the 1e9 interval). cancel: detached child is group leader; kill(-pid) reaps child + non-detached grandchild → grandchild pid dies (asserted `!pidAlive(gpid)`), state "failed".
VERDICT:  PASS

### DW-2.5
PREMISE:  "shutdown() (and a SIGINT to the server) kills every tracked child — no orphaned pids remain (asserted by pid liveness check post-shutdown)."
EVIDENCE: shutdown jobs.ts:183-191 (killGroup each, await all done); signal handlers :391-401; tests jobs.test.ts:245-309.
TRACE:    shutdown → killGroup(pidA),killGroup(pidB) → await both `done` (resolved via close/signal path) → pidAlive(pidA)===false && pidAlive(pidB)===false. SIGINT test: real Bun subprocess with installSignalHandlers, SIGINT → JobStore reap → group SIGKILL → tracked childPid dead (asserted `!pidAlive(childPid)`).
VERDICT:  PASS

### DW-2.6
PREMISE:  "prompt/opts reach the child via an argv array; a prompt containing shell metacharacters is passed literally with no shell evaluation (asserted)."
EVIDENCE: buildArgv jobs.ts:241-255; spawn :282-288 (`shell:false`, argv array, explicit cwd); tests jobs.test.ts:314-343.
TRACE:    dispatch(adapter, "hello; rm -rf $HOME && `touch /tmp/pwned` | cat") → injectContract(prompt)→buildArgs returns [BUN,writer,outFile,prompt] (prompt a discrete element) → guard passes (all strings) → spawn(argv[0], argv.slice(1), {shell:false}) → child writes argv[3] verbatim → received === HOSTILE byte-for-byte AND /tmp/pwned NOT created. Non-array buildArgs → TypeError (/argv array|only strings/).
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] All 6 DW items have automated tests that ran and passed in Step 0 (test names carry the DW id: test_DW_2_1 … test_DW_2_6).
- [x] Every listed edge case has a passing automated test (see below).
- [~] Stated coverage level is **100%**; measured line coverage is **94.87%** on jobs.ts. The two uncovered regions do not correspond to any DW item or listed edge case: (1) the stderr streaming handler (:297-298) is the symmetric twin of the covered stdout handler and is not hit because no test child writes to stderr; (2) `#installSignalHandlers` (:391-399) IS exercised by the passing out-of-process SIGINT test (test_DW_2_5_sigint…) but that runs in a separate Bun process so the in-process instrumenter cannot count it. Neither leaves a requirement unverified. Flagged as a Note, not a blocker (per verdict rules the shortfall maps to no DW item or listed edge case).

Listed-edge-case → test mapping (all pass):
| Edge case | Test | Handled |
|---|---|---|
| exit 0 but parseResult failed | test_DW_2_2 | Yes (:365-366) |
| killed by signal → failed w/ signal noted | test_killed_by_signal_notes_the_signal | Yes (:347-350) |
| log file unwritable → fail fast | test_dispatch_unwritable_log_fails_fast | Yes (:258-271 pre-touch) |
| wait unknown jobId reported not thrown | test_wait_on_unknown_jobid… | Yes (:135-140) |
| concurrent write same cwd rejected, actionable msg | test_DW_2_3_second_write… | Yes (:227-231 msg names job/adapter + "Serialize writes") |
| SECURITY: argv array + explicit cwd, no shell | test_DW_2_6_metacharacters… / _nonarray_rejected | Yes |

## Dead Code
None found. No unused imports (all of node:fs symbols used; ChildProcess/WriteStream types used), no unreachable code after returns, no debug/commented-out blocks.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | Write-write guard cannot race: dispatch is fully synchronous from #assertNoWriteConflict (:222) through map registration (:317) with no `await` between — Node's single thread forbids interleaving, so the 2nd write always sees the 1st as running. A finished write releases the guard because the guard only counts `state === "running"` jobs (:226), and #classify/error flip state to done|failed. finalize double-fire guarded by `settled` (:320). wait timer `unref` (:146) prevents lingering. Traced; no defect. |
| Error Handling | PASS | dispatch barricade rejects bad adapter/prompt/cwd/argv before spawn; `error` event → failed (:328-333); parseResult throw contained → failed (:359-362); signal → failed (:347-350). Missing `error` listener on the log WriteStream / pipes is a robustness gap (see Notes) but not demonstrable against any DW item or listed edge case. |
| Resources | PASS | logStream.end() on finalize (:322); detached group killed via kill(-pid) with bare-pid fallback (:370-382); signal handlers removed on shutdown (:403-408); shutdown idempotent (:184). |
| Boundaries | PASS | argv proven non-empty before `argv[0]!` (:244); clampTimeout floors at 0, caps at max, NaN→default (:384-387); unknown ids reported not thrown (get/wait/cancel). |
| Security | PASS | spawn uses argv ARRAY + `shell:false` + explicit validated cwd (:282-288); no code path interpolates prompt/opts into a shell string (grep: no shell string / shell:true anywhere). Runtime guard rejects non-array / non-string argv (:244-253), backing the type-level `string[]` and defeating a malformed adapter. env passed to child for credentials but NEVER written to the log (only child stdout/stderr chunks are logged, :293-300) — JobStore injects no secrets into the log. Metacharacter literality proven byte-for-byte + /tmp/pwned absent. |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry (barricade) | PASS | dispatch (:100-116) validates adapter shape, prompt type, cwd existence/dir, argv array/strings before any spawn — the single trust boundary. |
| cc-defensive-programming | No empty catch blocks that swallow bugs | PASS | resolveCwd/openLogPath catches rethrow with context (:214,:261,:267); killGroup inner catch is intentional + documented ("process already exited") — the ESRCH success path, not a swallowed bug (:378-380). |
| cc-defensive-programming | Assertions used for bugs only / no side-effecting asserts | PASS (N/A asserts) | No `assert()` in production path; anticipated bad input uses throw/error-handling, matching the module's exception convention. |
| cc-defensive-programming | Internal-API-is-still-external; validate cross-boundary data | PASS | buildArgs output (adapter → JobStore, a port boundary) is re-validated at :244-253 even though typed `string[]`. |
| cc-defensive-programming | Modern error propagation (unhandled async/stream rejection) | WARNING (Note) | log WriteStream and child stdio pipes have no `error` listener (:290-300); a mid-stream write error (e.g. disk full after the pre-touch check) would emit an unhandled 'error'. Not demonstrable against any DW/listed edge case; robustness note. |
| cc-routine-and-class-design | Functional cohesion; one operation per routine | PASS | dispatch orchestrates named single-purpose helpers (resolveCwd, assertNoWriteConflict, buildArgv, openLogPath, spawnAndTrack); classify/killGroup/clampTimeout each do one thing. |
| cc-routine-and-class-design | Parameter count ≤ 7 | PASS | Max is `#spawnAndTrack` at 6 params (:274-281) — within PASS band (6-7 minor concern), private internal method with clear input-order. All others ≤ 3. |
| cc-routine-and-class-design | Inheritance/LSP | PASS (N/A) | No inheritance; JobStore uses containment (Map of TrackedJob, contains ChildProcess/streams). Matches "default to containment". |
| cc-routine-and-class-design | Information hiding — what does the class hide? | PASS | Private `#`-fields hide child handle/buffers/completion promise; `get` returns a copy (:122) so callers cannot mutate internal state. |

## Notes (non-blocking)
1. Coverage shortfall vs the stated 100%: line coverage is 94.87% on jobs.ts. Genuinely-untested line is the stderr streaming handler (:297-298) — a trivial symmetric duplicate of the covered stdout handler; adding a stub whose child writes to stderr would close it. The signal-handler lines (:391-399) are functionally exercised by the passing out-of-process SIGINT test but not counted in-process.
2. No `error` listener on the per-job log `WriteStream` (:290) or the child stdout/stderr pipes (:293,:297). The likely failure (unwritable log dir/file) is caught up front by the pre-touch openSync (:266), so this only bites on a mid-run stream error (disk full); an unhandled 'error' event there could surface as an uncaught exception. Cheap hardening: `logStream.on("error", (e)=>log(...))`.
3. `#spawnAndTrack` takes 6 positional args; within the PASS band but a small `SpawnPlan` object would future-proof it if the signature grows.
4. Jobs are never evicted from `#jobs`; terminal jobs accumulate for the process lifetime. Acceptable for a session-scoped in-memory store (matches the "no disk persistence in v1" design), noted for future memory-growth awareness only.

## Issues (if FAIL)
None.

**Verdict: PASS**
