# Review: Phase 1 - Shared argv builder + per-call params (sample 3)

## Executed Results (Step 0)
- Test suite: `bun test` → 126 pass, 0 fail (329 expect() calls, 9 files)
- Targeted: `bun test test/adapter-codex.test.ts test/tools.test.ts` → 41 pass, 0 fail
- Typecheck: `bunx tsc --noEmit` → clean (exit 0)
- Lint: no separate lint config in repo; strict tsc (noUncheckedIndexedAccess etc.) is the gate → clean

## Requirement Fulfillment

### DW-1.1
PREMISE:  `buildCodexArgv("p","read")` returns `["codex","exec","--sandbox","read-only","p"]` (byte-identical to prior codex output).
EVIDENCE: src/adapters/_codex-shared.ts:55-61; test/adapter-codex.test.ts:54-58 (`test_DW_1_1_buildCodexArgv_no_cfg_is_byte_identical_to_current_codex_argv`, ran green)
TRACE:    ("p","read",{}) → no model/profile/overrides pushed → `["codex","exec","--sandbox",SANDBOX_BY_MODE["read"]="read-only","p"]`. Independently verified byte-identical to prior output via `git show HEAD:src/adapters/codex.ts` — the pre-change buildArgs returns exactly `["codex","exec","--sandbox","read-only","p"]` for ("p",{}).
VERDICT:  PASS

### DW-1.2
PREMISE:  `buildCodexArgv("p","read",{model:"o3"})` places `-m o3` before `--sandbox` and `p` last; `{configOverrides:{model_reasoning_effort:"high"}}` emits `-c model_reasoning_effort=high` before `--sandbox`.
EVIDENCE: src/adapters/_codex-shared.ts:56-60; test/adapter-codex.test.ts:60-70 (`test_DW_1_2_model_flag_precedes_sandbox_prompt_last`) and 72-82 (`test_DW_1_2_configOverrides_emit_dash_c_before_sandbox`), both ran green
TRACE:    {model:"o3"} → flags=["-m","o3"] → `["codex","exec","-m","o3","--sandbox","read-only","p"]`; {configOverrides:{model_reasoning_effort:"high"}} → flags=["-c","model_reasoning_effort=high"] → same ordering, prompt last. Flags array is spread before the hardcoded `--sandbox` pair; prompt is structurally the final element (line 60).
VERDICT:  PASS

### DW-1.3
PREMISE:  `codex.buildArgs("p",{model:"o3",effort:"high"})` emits both `-m o3` and `-c model_reasoning_effort=high`, prompt last.
EVIDENCE: src/adapters/codex.ts:66-85; test/adapter-codex.test.ts:132-144 (`test_DW_1_3_codex_buildArgs_emits_model_and_effort_flags`, ran green)
TRACE:    model="o3" passes string/non-empty check → cfg.model="o3"; effort="high" passes EFFORT_LEVELS check → cfg.configOverrides={model_reasoning_effort:"high"} → buildCodexArgv → `["codex","exec","-m","o3","-c","model_reasoning_effort=high","--sandbox","read-only","p"]`.
VERDICT:  PASS

### DW-1.4
PREMISE:  `codex.buildArgs("p",{})` is unchanged from prior behaviour (existing codex tests pass).
EVIDENCE: src/adapters/codex.ts:66-84; test/adapter-codex.test.ts:146-148 (`test_DW_1_4_no_params_argv_unchanged_from_today`) plus the pre-existing tests at 25-48 — all ran green
TRACE:    {} → model/effort both undefined → cfg stays empty → buildCodexArgv("p","read",{}) → `["codex","exec","--sandbox","read-only","p"]` = the HEAD-committed output (verified via `git show HEAD:src/adapters/codex.ts`).
VERDICT:  PASS

### DW-1.5
PREMISE:  dispatch `inputShape` accepts `model`/`effort`; an out-of-enum `effort` is rejected; the NEW `effort` key alters no non-codex adapter, and dispatch forwards both keys without breaking other adapters (`model` is a pre-existing shared key agy reads by design).
EVIDENCE: src/tools/dispatch.ts:30-41 (schema), 72-73 (forwarding); test/tools.test.ts:226-246 (`test_DW_1_5_dispatch_forwards_model_and_effort_into_dispatch_opts`), 248-263 (`test_DW_1_5_out_of_enum_effort_rejected_at_tool_boundary`), 265-273 (`test_DW_1_5_forwarded_keys_inert_for_adapters_that_do_not_read_them`) — all ran green
TRACE:    {model:"o3",effort:"high"} → zod accepts → handler spreads both into DispatchOpts (spy asserts verbatim forwarding); {effort:"max"} → `z.enum(["low","medium","high"])` → safeParse.success=false; grok.buildArgs("p",{model,effort}) === grok.buildArgs("p",{}) and agy.buildArgs("p",{effort:"high"}) === agy.buildArgs("p",{}). Independent grep confirms `effort` is read by NO source file outside dispatch.ts + the two codex files, and the only non-codex `model` reader is agy.ts:68 (pre-existing, carved out by the clarification).
VERDICT:  PASS

### DW-1.6
PREMISE:  a shell-metacharacter `model` value stays a single literal argv element (barricade preserved).
EVIDENCE: src/adapters/_codex-shared.ts:57 (`flags.push("-m", cfg.model)` — one element); src/lib/jobs.ts:241-250 (#buildArgv string[] guard), 282-287 (`spawn(argv[0], argv.slice(1), {shell:false})`); test/adapter-codex.test.ts:150-157 (`test_DW_1_6_shell_metachar_model_stays_single_literal_argv_element`, ran green)
TRACE:    model="o3; rm -rf / && echo `whoami` $(id)" → single push after "-m" → argv[mIndex+1] === the exact string, prompt still last; spawned with shell:false so it is argument data, never evaluated.
VERDICT:  PASS

### DW-1.7
PREMISE:  `buildCodexArgv("p","read",{profile:"x"})` emits `-p x` before `--sandbox`.
EVIDENCE: src/adapters/_codex-shared.ts:58; test/adapter-codex.test.ts:84-94 (`test_DW_1_7_profile_flag_precedes_sandbox`, ran green)
TRACE:    {profile:"x"} → flags=["-p","x"] → `["codex","exec","-p","x","--sandbox","read-only","p"]`.
VERDICT:  PASS

### DW-1.8
PREMISE:  `discoverAdapters(<adapters dir>)` does NOT return `_codex-shared`.
EVIDENCE: src/adapters/discover.ts:37 (`fileName.startsWith("_")` → not a candidate); test/adapter-codex.test.ts:193-197 (`test_DW_1_8_discovery_excludes_codex_shared_helper`, ran green against the REAL src/adapters dir)
TRACE:    scan of src/adapters → `_codex-shared.ts` fails isCandidate (leading underscore) → skipped silently; returned names contain "codex" (sanity: dir actually scanned) and none containing "codex-shared".
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have corresponding named tests (`test_DW_1_1` … `test_DW_1_8`) that ran in Step 0
- [x] Coverage matches the stated 100% level: every DW item and every listed edge case has a dedicated executed test; supplementary tests cover combined ordering (adapter-codex.test.ts:96-118), empty-string omission (120-122), effort-only path (159-163), write mode + flags (165-175), and programmatic-path TypeErrors (179-187)

## Edge cases (explicit requirements)
- no model + no effort → byte-identical: PASS — test_DW_1_1/test_DW_1_4 green, and independently confirmed against `git show HEAD:src/adapters/codex.ts` prior output.
- `effort` zod enum rejects unknown value: PASS — src/tools/dispatch.ts:38-41; test/tools.test.ts:248-258 rejects "max", accepts low/medium/high.
- shell-metacharacter `model` stays one literal argv element: PASS — test_DW_1_6 green; jobs.ts spawn is `shell:false` over a guarded string[].

## Dead Code
None found (no unused imports, no debug statements, no unreachable code, no commented-out blocks in the five files). Minor note below on `CodexArgvConfig.profile`.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | buildCodexArgv/buildArgs are pure functions, no shared mutable state; dispatch handler concurrency (write-write guard) is unchanged JobStore territory outside this phase's diff |
| Error Handling | PASS | Invalid programmatic model/effort throws TypeError (codex.ts:73,79); the throw propagates synchronously from JobStore.#buildArgv (jobs.ts:109) into dispatch's try/catch (dispatch.ts:77-82) → clean MCP error. Probed: `buildArgs("p",{effort:"max"})` and `{model:42}`/`{model:""}` throw — tests at adapter-codex.test.ts:179-187 ran green |
| Resources | N/A | No I/O, handles, or processes opened in the changed code; spawning stays in JobStore (unchanged) |
| Boundaries | PASS | Probed empty-string model/profile → flag omitted, not a bare `-m` (tested, adapter-codex.test.ts:120-122); empty model at the tool boundary rejected by `.min(1)` (tools.test.ts:261); adversarial `model:"--sandbox"` stays one argv element consumed as `-m`'s value and the trusted `--sandbox read-only` pair still follows — no path to a different sandbox |
| Security | PASS | (a) argv is always string[]: type-level + runtime guard jobs.ts:241-250, spawned `shell:false` jobs.ts:282-287; metachar model traced to one literal element (test_DW_1_6). (b) Allowlist holds: codex.buildArgs reads ONLY `opts.model`/`opts.effort` (codex.ts:70); `effort` maps to the single hardcoded key `model_reasoning_effort` (codex.ts:81) with an enum-constrained value, so a caller can never choose a config key — `-c sandbox_mode=danger-full-access` is unreachable. dispatch.ts:68-75 forwards only six named keys; unknown keys are stripped by z.object and never spread. `danger-full-access` is absent from SANDBOX_BY_MODE (structurally unreachable), asserted by two tests |

## Loaded-Skill Criteria

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry (barricade) | PASS | zod validates at the tool boundary (dispatch.ts:30-41); values re-checked at the adapter (codex.ts:71-82) for the programmatic path — exactly the skill's security-critical defense-in-depth rule, documented as such (codex.ts:26-30) |
| cc-defensive-programming | No empty catch blocks | PASS | The one catch (dispatch.ts:80-82) returns a structured err with the message — nothing swallowed |
| cc-defensive-programming | Assertion vs error handling selection | PASS | Anticipated bad runtime input (programmatic caller) gets error handling (thrown TypeError surfaced as MCP error), not an assertion; no side-effecting assertions anywhere in the diff |
| cc-defensive-programming | Trust-boundary placement documented and honored | PASS | _codex-shared.ts:12-25 declares cfg TRUSTED by contract and forbids reading DispatchOpts; codex.ts is the boundary owner and allowlists before constructing cfg — traced, no bypass found |
| aposd-designing-deep-modules | Information hiding / interface depth | PASS | buildCodexArgv is one function hiding flag spelling, fixed ordering, the prompt-last invariant, and the sandbox mapping; callers pass 3 optional cfg fields and cannot mis-order flags or reach `danger-full-access` |
| aposd-designing-deep-modules | Silent-failure red flag | PASS | Invalid values fail loud (throw) rather than silently running at the wrong model/effort; missing-marker outputs are `failed` even on exit 0 (codex.ts:92-99, tested) |
| aposd-designing-deep-modules | Information-leakage red flag | PASS (with note) | EFFORT_LEVELS (codex.ts:31) mirrors the zod enum (dispatch.ts:39) — duplicated knowledge, but deliberate security defense-in-depth on the sandbox-critical path, which cc-defensive-programming explicitly requires; both sites cross-reference each other |

## Notes (non-blocking)
- `CodexArgvConfig.profile` has no production caller yet — codex.ts's per-call path never sets it; it exists for the Phase 2 factory (per the file header) and is exercised only by tests (including required DW-1.7). Acceptable forward-generality for a one-phase horizon; if Phase 2 is descoped it should be removed.
- The `model` key in dispatch's inputShape is itself new in this diff (git diff HEAD shows both `model` and `effort` added); the DW-1.5 clarification's "pre-existing shared key" anchors to the DispatchOpts index signature (src/types.ts:45) and agy.ts:68 reading `opts.model` — both of which are indeed committed pre-existing code, so the clarification's carve-out for agy stands.
- The effort enum lives in three places (dispatch zod, codex EFFORT_LEVELS, and Phase-2's future rosters); if it ever grows, a shared constant would prevent drift. Matter of degree, not a defect.

## Issues
None.

**Verdict: PASS**
