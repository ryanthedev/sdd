# Review: Phase 1 - Shared argv builder + per-call params (sample 2)

## Executed Results (Step 0)
- Test suite: `bun test` → **126 pass, 0 fail** (329 expect calls, 9 files)
- Targeted: `bun test test/adapter-codex.test.ts test/tools.test.ts` → **41 pass, 0 fail**
- DW-named tests in isolation: `bun test test/adapter-codex.test.ts -t "test_DW_1_"` → 8 pass, 0 fail; `bun test test/tools.test.ts -t "test_DW_1_5"` → 3 pass, 0 fail
- Typecheck: `bunx tsc --noEmit` → exit 0, clean
- Lint: no lint command configured in this repo (package.json has `test`/`typecheck` only); typecheck is the static gate

## Requirement Fulfillment

### DW-1.1
PREMISE:  `buildCodexArgv("p","read")` returns `["codex","exec","--sandbox","read-only","p"]` (byte-identical to prior codex output).
EVIDENCE: src/adapters/_codex-shared.ts:55-61; test/adapter-codex.test.ts:54-58 (`test_DW_1_1_buildCodexArgv_no_cfg_is_byte_identical_to_current_codex_argv`, ran, pass)
TRACE:    `buildCodexArgv("p","read",{})` → flags=[] (no model/profile/overrides) → `["codex","exec","--sandbox",SANDBOX_BY_MODE["read"]="read-only","p"]`; test also asserts equality with `codex.buildArgs("p",{})`.
VERDICT:  PASS

### DW-1.2
PREMISE:  `buildCodexArgv("p","read",{model:"o3"})` places `-m o3` before `--sandbox` and `p` last; `{configOverrides:{model_reasoning_effort:"high"}}` emits `-c model_reasoning_effort=high` before `--sandbox`.
EVIDENCE: src/adapters/_codex-shared.ts:56-60; test/adapter-codex.test.ts:60-82 (`test_DW_1_2_model_flag_precedes_sandbox_prompt_last`, `test_DW_1_2_configOverrides_emit_dash_c_before_sandbox`, ran, pass)
TRACE:    `{model:"o3"}` → flags=["-m","o3"] → `["codex","exec","-m","o3","--sandbox","read-only","p"]`; `{configOverrides:{model_reasoning_effort:"high"}}` → flags=["-c","model_reasoning_effort=high"] → same shape, prompt last. Spread `...flags` precedes the literal `"--sandbox"` structurally (line 60), so ordering cannot regress per-callsite.
VERDICT:  PASS

### DW-1.3
PREMISE:  `codex.buildArgs("p",{model:"o3",effort:"high"})` emits both `-m o3` and `-c model_reasoning_effort=high`, prompt last.
EVIDENCE: src/adapters/codex.ts:66-85; test/adapter-codex.test.ts:132-144 (`test_DW_1_3_codex_buildArgs_emits_model_and_effort_flags`, ran, pass)
TRACE:    `{model:"o3",effort:"high"}` → model validated non-empty string → cfg.model="o3"; effort in EFFORT_LEVELS → cfg.configOverrides={model_reasoning_effort:"high"} → buildCodexArgv → `["codex","exec","-m","o3","-c","model_reasoning_effort=high","--sandbox","read-only","p"]`.
VERDICT:  PASS

### DW-1.4
PREMISE:  `codex.buildArgs("p",{})` is unchanged from prior behaviour (existing codex tests pass).
EVIDENCE: src/adapters/codex.ts:66-84 (no-param path: cfg stays `{}`); test/adapter-codex.test.ts:146-148 (`test_DW_1_4_no_params_argv_unchanged_from_today`, ran, pass); `git diff HEAD -- test/adapter-codex.test.ts` shows **insertions only (152+/0-)** — the pre-existing tests (lines 25-48: read-only default, workspace-write mapping, no danger-full-access, metachar prompt) are byte-unmodified and all pass in the executed suite.
TRACE:    `{}` → model undefined, effort undefined → cfg={} → buildCodexArgv("p","read",{}) → `["codex","exec","--sandbox","read-only","p"]`.
VERDICT:  PASS

### DW-1.5
PREMISE:  dispatch `inputShape` accepts `model`/`effort`; an out-of-enum `effort` is rejected; the new `effort` key alters no non-codex adapter and dispatch forwards both keys without breaking other adapters.
EVIDENCE: src/tools/dispatch.ts:30-41 (schema: `model` z.string().min(1).optional, `effort` z.enum(["low","medium","high"]).optional), 72-73 (forwarding into DispatchOpts); test/tools.test.ts:226-246 (`test_DW_1_5_dispatch_forwards_model_and_effort_into_dispatch_opts` — spy asserts opts matchObject {model:"o3",effort:"high"}), 248-263 (`test_DW_1_5_out_of_enum_effort_rejected_at_tool_boundary` — safeParse of the exact inputShape rejects effort:"max", accepts low/medium/high, rejects model:""), 265-273 (`test_DW_1_5_forwarded_keys_inert_for_adapters_that_do_not_read_them` — grok inert for both keys, agy inert for effort). All ran, pass.
TRACE:    `{adapter,prompt,effort:"max"}` → zod enum fails → handler never runs. `{model:"o3",effort:"high"}` → parsed → opts spread at dispatch.ts:72-73 → jobStore.dispatch receives them verbatim. Cross-adapter: `rg effort src/` (I ran it) matches ONLY dispatch.ts and codex.ts across src/ — no other adapter file references `effort`, so it structurally cannot alter any non-codex adapter; agy's `opts.model` read (agy.ts:68) is the pre-existing shared key the DW clarification exempts.
VERDICT:  PASS

### DW-1.6
PREMISE:  a shell-metacharacter `model` value stays a single literal argv element (barricade preserved).
EVIDENCE: src/adapters/_codex-shared.ts:57 (`flags.push("-m", cfg.model)` — one array element); src/lib/jobs.ts:287 (`shell: false`) and jobs.ts:241-250 (#buildArgv string[] runtime guard); test/adapter-codex.test.ts:150-157 (`test_DW_1_6_shell_metachar_model_stays_single_literal_argv_element`, ran, pass)
TRACE:    model=`` "o3; rm -rf / && echo `whoami` $(id)" `` → passes non-empty-string check → pushed as the single element after `-m` → test asserts `argv[mIndex+1]` is the byte-identical string and the prompt is still last; spawn path is argv-array + `shell:false`, so it is argument data, never shell-evaluated.
VERDICT:  PASS

### DW-1.7
PREMISE:  `buildCodexArgv("p","read",{profile:"x"})` emits `-p x` before `--sandbox`.
EVIDENCE: src/adapters/_codex-shared.ts:58; test/adapter-codex.test.ts:84-94 (`test_DW_1_7_profile_flag_precedes_sandbox`, ran, pass)
TRACE:    `{profile:"x"}` → flags=["-p","x"] → `["codex","exec","-p","x","--sandbox","read-only","p"]`.
VERDICT:  PASS

### DW-1.8
PREMISE:  `discoverAdapters(<adapters dir>)` does NOT return `_codex-shared`.
EVIDENCE: src/adapters/discover.ts:37 (`isCandidate` rejects `fileName.startsWith("_")`); test/adapter-codex.test.ts:193-197 (`test_DW_1_8_discovery_excludes_codex_shared_helper` — scans the REAL src/adapters dir, asserts "codex" present as a scan sanity check and no name containing "codex-shared", ran, pass)
TRACE:    `discoverAdapters(src/adapters)` → readdir includes `_codex-shared.ts` → `isCandidate("_codex-shared.ts")` → startsWith("_") → false → skipped before require(); returned names contain "codex" but nothing matching "codex-shared".
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] All DW items have corresponding named tests (`test_DW_1_1` … `test_DW_1_8`) that ran in Step 0 (8 in test/adapter-codex.test.ts, 3 DW-1.5 tests in test/tools.test.ts)
- [x] Coverage level 100%: every DW item and every listed edge case is exercised by an automated test; supplementary tests cover combined flag ordering, empty-string skip, effort-only path, write-mode + flags, programmatic-path TypeErrors, and danger-full-access absence
- DW-1.5's cross-adapter clause is test-backed for grok (both keys) and agy (effort); observed-behavior supplement: `rg effort src/` shows no adapter file other than codex.ts reads `effort`

## Edge Cases (prompt-listed — verdict standing)
| Edge case | Handling | Evidence | Verdict |
|---|---|---|---|
| no model + no effort → argv byte-identical | cfg stays `{}`, flags empty | `test_DW_1_1` + `test_DW_1_4` assert the exact prior array; pre-existing tests unmodified (git diff insertions-only) and pass | PASS |
| effort constrained by zod enum, unknown rejected at tool boundary | dispatch.ts:38-41 `z.enum(["low","medium","high"])` | `test_DW_1_5_out_of_enum_effort_rejected_at_tool_boundary` parses the exact inputShape: "max" rejected, all three levels accepted | PASS |
| metachar model stays one literal argv element | array push, shell:false spawn | `test_DW_1_6_shell_metachar_model_stays_single_literal_argv_element` | PASS |

## Security Focus
- **(a) string[] argv, no shell:** buildCodexArgv returns a plain string[]; JobStore spawns with `shell: false` (src/lib/jobs.ts:287) and a runtime guard rejects any non-string element (jobs.ts:241-250). Demonstrated by `test_DW_1_6` and the pre-existing metachar-prompt test. HOLDS.
- **(b) allowlist, no arbitrary `-c` passthrough:** codex.buildArgs (codex.ts:66-84) destructures ONLY `opts.model` and `opts.effort`; `effort` maps to the single hardcoded key `model_reasoning_effort` (codex.ts:81), so a caller can never choose a config key. A hypothetical `configOverrides` in dispatch args is stripped by the zod object schema and, even on the programmatic JobStore path, is never read by the adapter — `-c sandbox_mode=danger-full-access` is unreachable from caller input. The sandbox mapping itself (_codex-shared.ts:43-46) only knows `read-only`/`workspace-write`, so `danger-full-access` is structurally unemittable (asserted by two tests). Adversarial trace `model:"--sandbox"`: emitted as the `-m` value element, one literal arg, followed later by the trusted `--sandbox <mode>` pair — worst case codex rejects the argv and the job fails; no sandbox subversion path. HOLDS.

## Dead Code
None found. `profile` in CodexArgvConfig is live (required by DW-1.7, exercised by tests); all imports in the five reviewed files are used; no debug statements, no unreachable code, no commented-out blocks.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Changed code is pure functions (argv assembly, zod schema, opts spreading) — no shared mutable state introduced; job serialization untouched (write-write test still passes) |
| Error Handling | PASS | Adversarial trace: programmatic `buildArgs("p",{effort:"max"})` throws TypeError (test ran, passes); via the tool, the throw path is inside `try` at dispatch.ts:77-82 → clean `err(...)` MCP result, not a crash. `model:42` / `model:""` also throw (tests ran, pass) |
| Resources | N/A | No files, connections, locks, or processes opened by the changed code; spawning stays in unmodified JobStore |
| Boundaries | PASS | Empty-string model: rejected at zod (`min(1)`, test asserts), thrown by adapter programmatically (test asserts), and skipped by buildCodexArgv's falsy check (test asserts) — no bare `-m` flag possible on any path. Empty cfg `{}` and `configOverrides ?? {}` traced to the exact prior argv |
| Security | PASS | See Security Focus — barricade traced end-to-end, allowlist verified by reading every `opts.*` access in codex.ts, metachar test ran |

## Loaded-Skill Criteria
| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | External input validated at entry (barricade) | PASS | Untrusted `effort` validated at the tool boundary (zod enum, dispatch.ts:38-41) AND re-validated inside the adapter (codex.ts:31,77-82) because JobStore.dispatch is programmatically reachable — correct defense-in-depth on a security-critical (sandbox) path, per the skill's "barricade does not replace defense-in-depth for security-critical paths" rule |
| cc-defensive-programming | Assertions for bugs only / anticipated errors get error handling | PASS | No assertions used; anticipated bad programmatic input throws TypeError (error handling), surfaced as a clean MCP error — matches the skill's table (public-API precondition crossing a trust boundary) |
| cc-defensive-programming | No empty catch blocks | PASS | The only catch in changed code (dispatch.ts:80-82) returns a structured error with the cause via friendlyMessage — nothing swallowed |
| cc-defensive-programming | No executable code in assertions | N/A | No assert statements in the changed files |
| aposd-designing-deep-modules | Deep module / interface depth | PASS | buildCodexArgv: one function + a 3-field cfg hides flag spelling, fixed ordering, prompt-last invariant, and the sandbox mapping; callers (codex.ts, Phase-2 factory) need zero knowledge of codex flag syntax |
| aposd-designing-deep-modules | Information leakage (same knowledge in multiple modules) | PASS | Flag ordering/sandbox mapping exists exactly once (_codex-shared.ts); codex.ts delegates rather than duplicating. The effort-enum duplication (zod + EFFORT_LEVELS) is deliberate, documented defense-in-depth on a security path, not accidental leakage — see Notes |
| aposd-designing-deep-modules | Silent failure surfaced to callers | PASS | Invalid model/effort throw loudly (traced above) rather than silently running at defaults; missing contract markers still classify the job `failed` (tests ran, pass) |

## Notes (non-blocking)
- The `low|medium|high` effort literal set exists in two places (dispatch.ts zod enum, codex.ts EFFORT_LEVELS Set). Both are documented as intentional mirrors; if they ever drift, the adapter is stricter, which fails safe. A shared exported const would remove the drift risk — matter of degree, not a defect.
- `test_DW_1_5_forwarded_keys_inert_...` samples grok and agy rather than every adapter (kimi/mistral/qwen/agy-image). My grep confirms no other adapter references `effort`, so the clause holds today; a future adapter reading `effort` accidentally would not be caught by this test. Acceptable for the DW as written.
- DW-1.2's "byte-identical to prior" for DW-1.1 is additionally anchored by the git diff showing the pre-existing codex tests untouched — stronger than the new test alone.

## Issues
None.

**Verdict: PASS**
