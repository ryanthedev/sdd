# Review: Phase 1 - Shared argv builder + per-call params (sample 1)

## Executed Results (Step 0)
- Test suite: `bun test` → **126 pass, 0 fail** (329 expect() calls, 9 files)
- Targeted: `bun test test/adapter-codex.test.ts test/tools.test.ts` → **41 pass, 0 fail** (92 expect() calls)
- DW-1-named tests only: `bun test ... -t "DW_1"` → **11 pass, 0 fail**
- Typecheck: `bunx tsc --noEmit` → exit 0, no output (clean)
- Lint: no separate lint config in repo; strict tsc (noUncheckedIndexedAccess, noFallthroughCasesInSwitch) is the project's lint gate → clean

## Requirement Fulfillment

### DW-1.1
PREMISE:  `buildCodexArgv("p","read")` returns `["codex","exec","--sandbox","read-only","p"]` (byte-identical to prior codex output).
EVIDENCE: src/adapters/_codex-shared.ts:55-61; test/adapter-codex.test.ts:54-58 (`test_DW_1_1_buildCodexArgv_no_cfg_is_byte_identical_to_current_codex_argv`, passed)
TRACE:    `("p","read",{})` → no `model`/`profile`/`configOverrides` truthy → `flags=[]` → `["codex","exec","--sandbox",SANDBOX_BY_MODE["read"]="read-only","p"]`. Test also asserts equality with `codex.buildArgs("p",{})` (regression guard).
VERDICT:  PASS

### DW-1.2
PREMISE:  `buildCodexArgv("p","read",{model:"o3"})` places `-m o3` before `--sandbox` and `p` last; `{configOverrides:{model_reasoning_effort:"high"}}` emits `-c model_reasoning_effort=high` before `--sandbox`.
EVIDENCE: src/adapters/_codex-shared.ts:57,59,60; test/adapter-codex.test.ts:60-70 (`test_DW_1_2_model_flag_precedes_sandbox_prompt_last`) and 72-82 (`test_DW_1_2_configOverrides_emit_dash_c_before_sandbox`), both passed
TRACE:    `{model:"o3"}` → `flags=["-m","o3"]` → `["codex","exec","-m","o3","--sandbox","read-only","p"]` (flags spread at index 2, before `--sandbox`; prompt is last element). `{configOverrides:{model_reasoning_effort:"high"}}` → `flags=["-c","model_reasoning_effort=high"]` → same position before `--sandbox`.
VERDICT:  PASS

### DW-1.3
PREMISE:  `codex.buildArgs("p",{model:"o3",effort:"high"})` emits both `-m o3` and `-c model_reasoning_effort=high`, prompt last.
EVIDENCE: src/adapters/codex.ts:66-85; test/adapter-codex.test.ts:132-144 (`test_DW_1_3_codex_buildArgs_emits_model_and_effort_flags`, passed)
TRACE:    `model:"o3"` passes non-empty-string check → `cfg.model="o3"`; `effort:"high"` ∈ EFFORT_LEVELS → `cfg.configOverrides={model_reasoning_effort:"high"}` → `buildCodexArgv` → `["codex","exec","-m","o3","-c","model_reasoning_effort=high","--sandbox","read-only","p"]`.
VERDICT:  PASS

### DW-1.4
PREMISE:  `codex.buildArgs("p",{})` is unchanged from prior behaviour (existing codex tests pass).
EVIDENCE: src/adapters/codex.ts:66-84 (both `if` branches skipped for `{}`); test/adapter-codex.test.ts:146-148 (`test_DW_1_4_no_params_argv_unchanged_from_today`) plus pre-existing tests at lines 25-48 (default sandbox, workspace-write, never danger-full-access, metachar prompt literal) — all passed in the 41/41 run
TRACE:    `{}` → `model`/`effort` both `undefined` → `cfg={}` → `buildCodexArgv("p","read",{})` → `["codex","exec","--sandbox","read-only","p"]`, identical to prior adapter output.
VERDICT:  PASS

### DW-1.5
PREMISE:  dispatch `inputShape` accepts `model`/`effort`; an out-of-enum `effort` is rejected; the new `effort` key alters no non-codex adapter and dispatch forwards both keys without breaking other adapters.
EVIDENCE: src/tools/dispatch.ts:30-41 (schema: `model` = `z.string().min(1).optional()`, `effort` = `z.enum(["low","medium","high"]).optional()`), 72-73 (verbatim forwarding into DispatchOpts); test/tools.test.ts:226-246 (`test_DW_1_5_dispatch_forwards_model_and_effort_into_dispatch_opts`), 248-263 (`test_DW_1_5_out_of_enum_effort_rejected_at_tool_boundary`), 265-273 (`test_DW_1_5_forwarded_keys_inert_for_adapters_that_do_not_read_them`) — all passed
TRACE:    `{adapter,prompt,model:"o3",effort:"high"}` → zod accepts → handler builds `opts` with both keys → spy on `jobStore.dispatch` observed `{model:"o3",effort:"high"}` verbatim. `effort:"max"` → `schema.safeParse(...).success === false`. Inertness: `grok.buildArgs("p",{model:"o3",effort:"high"}) === grok.buildArgs("p",{})`; `agy.buildArgs("p",{effort:"high"}) === agy.buildArgs("p",{})`. Independently confirmed by grep: no `src/adapters/*.ts` other than codex.ts references `effort`; only agy.ts:68 reads `model` (pre-existing shared key per the clarification, src/types.ts:41-46 open index signature).
VERDICT:  PASS

### DW-1.6
PREMISE:  a shell-metacharacter `model` value stays a single literal argv element (barricade preserved).
EVIDENCE: src/adapters/_codex-shared.ts:57 (value pushed as one array element); src/lib/jobs.ts:241-250 (#buildArgv runtime guard: rejects non-array/non-string argv) and 282-287 (`spawn(argv[0], argv.slice(1), {shell:false})`); test/adapter-codex.test.ts:150-157 (`test_DW_1_6_shell_metachar_model_stays_single_literal_argv_element`, passed)
TRACE:    `model:"o3; rm -rf / && echo \`whoami\` $(id)"` → passes non-empty-string allowlist → pushed as the single element following `-m` → test asserts `argv[mIndex+1]` is byte-equal to the dangerous string and the prompt is still last. Spawned with `shell:false`, so it is argument data, never shell-evaluated.
VERDICT:  PASS

### DW-1.7
PREMISE:  `buildCodexArgv("p","read",{profile:"x"})` emits `-p x` before `--sandbox`.
EVIDENCE: src/adapters/_codex-shared.ts:58; test/adapter-codex.test.ts:84-94 (`test_DW_1_7_profile_flag_precedes_sandbox`, passed)
TRACE:    `{profile:"x"}` → `flags=["-p","x"]` → `["codex","exec","-p","x","--sandbox","read-only","p"]` — `-p x` at indices 2-3, `--sandbox` at 4.
VERDICT:  PASS

### DW-1.8
PREMISE:  `discoverAdapters(<adapters dir>)` does NOT return `_codex-shared`.
EVIDENCE: src/adapters/discover.ts:37 (`isCandidate` returns false for `fileName.startsWith("_")`); test/adapter-codex.test.ts:193-197 (`test_DW_1_8_discovery_excludes_codex_shared_helper`, passed — scans the REAL src/adapters dir)
TRACE:    `discoverAdapters(join(import.meta.dir,"../src/adapters"))` → `_codex-shared.ts` fails `isCandidate` (underscore prefix) → never required/loaded → names contain `"codex"` (sanity that the real dir was scanned) and no name containing `"codex-shared"`.
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have corresponding automated tests that ran in Step 0 — DW-1.1 through DW-1.8 each have a `test_DW_1_x_*`-named test (11 DW-named tests, 11/11 pass)
- [x] Coverage matches the stated 100% level: every DW item, every prompt-listed edge case, and the programmatic (zod-bypass) validation path each have a dedicated executed test

## Edge Cases (prompt-listed)
| Edge case | Evidence | Status |
|---|---|---|
| no model + no effort → argv byte-identical to prior output | test/adapter-codex.test.ts:54-58 and 146-148; both compare against the exact prior 5-element argv and against `codex.buildArgs("p",{})` | HANDLED |
| `effort` constrained by zod enum (`low\|medium\|high`), unknown value rejected at tool boundary | src/tools/dispatch.ts:38-41; test/tools.test.ts:248-258 (`effort:"max"` → parse failure; all three enum values → success) | HANDLED |
| shell-metacharacter `model` stays one literal argv element | test/adapter-codex.test.ts:150-157; jobs.ts `shell:false` spawn | HANDLED |

## Security Focus
- **(a) argv is always string[] spawned without a shell:** `buildCodexArgv` returns a plain `string[]` (src/adapters/_codex-shared.ts:55-61); JobStore's `#buildArgv` runtime guard rejects any non-array or non-string element (src/lib/jobs.ts:241-250); spawn is `spawn(argv[0], argv.slice(1), {shell:false})` (src/lib/jobs.ts:282-287). A metacharacter value is a single literal argument — never shell-evaluated. VERIFIED.
- **(b) per-call path is allowlist-only:** `codex.buildArgs` destructures ONLY `opts.model` and `opts.effort` (src/adapters/codex.ts:70); there is no `configOverrides` key in the dispatch `inputShape` (src/tools/dispatch.ts:21-50) and `buildArgs` never reads one from `opts`. `effort` maps to the single hardcoded key `model_reasoning_effort` (codex.ts:81), so a caller can never choose a `-c` key — `-c sandbox_mode=danger-full-access` is unreachable from the per-call path. The string `danger-full-access` is structurally unreachable in the sandbox mapping (`SANDBOX_BY_MODE` knows only `read-only`/`workspace-write`, _codex-shared.ts:43-46), and caller flags are emitted BEFORE the trusted `--sandbox` (defense-in-depth if codex parses later-wins). Adversarial trace: `model:"x -c sandbox_mode=danger-full-access"` → one literal element after `-m`, never split into flags (shell:false, no re-parsing). VERIFIED — no arbitrary-config passthrough.

## Dead Code
None found in the reviewed files. All imports used (`AdapterMode`/`AdapterResult`/`DispatchOpts` in codex.ts; `buildCodexArgv`/`CodexArgvConfig` consumed; `AdapterMode` in _codex-shared.ts). No unreachable code, debug statements, or commented-out blocks. (`CodexArgvConfig.profile` has no producer in src/ yet — see Notes; it is required by DW-1.7 and consumed by `buildCodexArgv`, so it is not dead.)

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Reviewed change is pure functions (`buildCodexArgv`, `buildArgs`) plus schema keys; no new shared state. Write-write serialization is pre-existing JobStore behavior, untouched. |
| Error Handling | PASS | Adversarial probe: programmatic `effort:"max"` / `effort:3` / `model:42` / `model:""` (bypassing zod) → `TypeError` thrown loud (codex.ts:72-79), executed via tests at adapter-codex.test.ts:179-187. Throw path is contained: `buildArgs` runs inside `rt.jobStore.dispatch` inside the handler's try/catch (dispatch.ts:77-82) → clean MCP error, no crash. |
| Resources | N/A | No I/O, handles, or processes in the changed code; spawning is pre-existing JobStore territory. |
| Boundaries | PASS | Empty-string `model`: zod `min(1)` rejects at the boundary (tools.test.ts:261, executed); programmatic empty string throws (codex.ts:72, executed at adapter-codex.test.ts:186); `buildCodexArgv` skips falsy model/profile rather than emitting a bare flag (executed at adapter-codex.test.ts:120-122). Empty `configOverrides` → zero `-c` flags (Object.entries of `{}` → no iterations). |
| Security | PASS | See Security Focus — both (a) and (b) traced and executed. Metachar model test executed (adapter-codex.test.ts:150). |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry (barricade) | PASS | Untrusted MCP args validated by zod at the tool boundary (dispatch.ts:30-41); `buildCodexArgv`'s `cfg` is trusted-by-contract with the trust decision documented at the boundary owner (_codex-shared.ts:12-25). |
| cc-defensive-programming | Defense-in-depth on security-critical paths (barricade reduces redundancy, doesn't replace it) | PASS | The sandbox barricade is security-critical, and the adapter re-validates `effort`/`model` for the programmatic zod-bypass path (codex.ts:26-31, 71-82) — executed via the TypeError tests. |
| cc-defensive-programming | No empty catch blocks / errors surface loudly | PASS | Only catch in reviewed code returns a structured `err(...)` with the message (dispatch.ts:80-82); invalid input throws rather than silently running at the wrong model/effort. |
| cc-defensive-programming | Assertions vs error handling correctly assigned | PASS | No assertions used; all anticipated-bad-input cases use error handling (throw/zod reject), which is the correct side of the table for external input. |
| aposd-designing-deep-modules | Information hiding — flag spelling/ordering/sandbox mapping in ONE place | PASS | `buildCodexArgv` is the single owner of flag ordering, the prompt-last invariant, and the sandbox mapping (_codex-shared.ts:48-61); codex.ts delegates rather than duplicating (codex.ts:84). No second copy exists (grep). |
| aposd-designing-deep-modules | Deep interface / low caller cognitive load | PASS | One function + one 3-field config type hides ordering, sandbox safety, and empty-value handling; common case (`buildCodexArgv(p, mode)`) needs zero cfg knowledge. |
| aposd-designing-deep-modules | No silent failure | PASS | `buildArgs` throws on invalid input; `parseResult` returns `failed` status with a reason — failures are surfaced, not swallowed. |
| aposd-designing-deep-modules | No information leakage across module boundaries | PASS | dispatch.ts knows nothing about codex flags; it forwards opaque keys via `DispatchOpts`' open index signature (types.ts:41-46) — the codex-specific mapping lives only in codex.ts/_codex-shared.ts. |

## Notes (non-blocking)
- `CodexArgvConfig.profile` currently has no producer in committed src/ code — `codex.buildArgs` never sets it; per the module header it exists for the Phase 2 variant factory. It is required and tested by DW-1.7, so this is expected staging, not dead code, but if Phase 2 is descoped it should be revisited.
- A hyphen-leading `model` value (e.g. `model: "--full-auto"`) passes the non-empty-string allowlist and lands as the element after `-m`. It is still one literal argv element and cannot introduce `danger-full-access` (that string is structurally unreachable, and the trusted `--sandbox` follows caller flags), and codex's own CLI parser decides whether to accept or reject it — no defect demonstrated; noted as an optional hardening (reject `model` values starting with `-`).
- `injectContract`'s CONTRACT_SUFFIX instruction says `"## Findings"` but `FINDINGS_RE` matches `Findings` after any markdown prefix without requiring the `##` — deliberate tolerance mirroring review-contract.ts per the inline comment; pre-existing Phase-agnostic behavior, not part of this change.

## Issues (if FAIL)
None.

**Verdict: PASS**
