# Discovery + Design: Phase 1 - Shared argv builder + allowlisted per-call params

## Files Found
- `src/adapters/codex.ts` — current adapter; `buildArgs` hardcodes `["codex","exec","--sandbox",<sandbox>,prompt]` (line 53). Holds `SANDBOX_BY_MODE` map (lines 24-27).
- `src/tools/dispatch.ts` — `inputShape` has `adapter/prompt/cwd/mode/timeoutMs/outputPath`; handler forwards cwd/mode/timeoutMs/outputPath into `DispatchOpts` via conditional spreads (lines 56-61).
- `src/types.ts` — `DispatchOpts` has the open index signature `[k: string]: unknown` (line 45) — no core-type edit needed, as the plan states. Its doc comment (line 38) already names `model` as an adapter-specific key.
- `src/adapters/discover.ts` — `isCandidate` (line 37) skips `fileName.startsWith("_")` — the `_codex-shared.ts` exclusion already exists in code; DW-1.8 proves it against the real directory.
- `src/lib/jobs.ts` — line 243: `adapter.buildArgs(contracted, opts)`.
- `test/adapter-codex.test.ts` — pure-function tests; asserts exact argv arrays for no-arg and write-mode calls, metachar prompt literality, contract markers.
- `test/tools.test.ts` — has `test_dispatch_forwards_outputPath_into_dispatch_opts` (line 198): spy on `rt.jobStore.dispatch`, assert `opts` via `toMatchObject`. This is the pattern DW-1.5 extends.
- `src/adapters/_codex-shared.ts` — does NOT exist yet (to be created).

## Current State
Every codex dispatch runs the harness default model/effort; no flag path exists. The dispatch tool strips `model`/`effort` (zod object parsing drops unknown keys), so today those keys can only reach an adapter via programmatic `JobStore.dispatch` calls.

## Gaps
1. **agy already reads `opts.model`** (`src/adapters/agy.ts:68`, `pushOptionalStringFlag(flags, opts, "model", "--model")` — validated non-empty string, emitted as a literal argv element before `--print`, prompt still last). Adding `model` to the dispatch `inputShape` with verbatim forwarding (pinned by this phase's **Produces** line) makes agy's pre-existing model knob reachable via MCP. See "DW-1.5 interpretation" below — surfaced loudly, not absorbed silently.
2. No other gaps: plan line references all check out against reality (codex.ts:53, dispatch.ts:56-61, types.ts:45, discover.ts:37).

## Assumption Verification (from dispatch prompt)
| Assumption | Result | Evidence |
|---|---|---|
| JobStore passes caller `opts` to `buildArgs` unchanged | **VERIFIED** | `src/lib/jobs.ts:243` — `adapter.buildArgs(contracted, opts)`; `opts` is the caller's object, untouched. |
| Later `-c` can beat earlier `--sandbox` | **UNVERIFIED (informational per plan)** | Not probed (would require live codex config experiments). The allowlist is correct regardless. Note: caller-influenced flags are emitted BEFORE `--sandbox`, so if later-wins holds, the trusted sandbox flag prevails — belt-and-suspenders on top of the allowlist. |
| `codex exec` accepts `-m/-p/-c` | **VERIFIED** (added check) | `codex exec --help`: `-c, --config <key=value>`, `-m, --model <MODEL>`, `-p, --profile <CONFIG_PROFILE_V2>`. |

## DW-1.5 interpretation (documented, not silent)
DW-1.5's tail — "neither key reaches any other adapter's behaviour" — read strictly against agy is self-contradictory with this phase's own Produces contract ("both forwarded verbatim into DispatchOpts") plus agy's pre-existing, deliberate `opts.model` read (out of this phase's file scope). The codebase's own core-type doc (`types.ts:38`) predates this plan and names `model` as a shared adapter-specific key. Adopted reading, matching the DW's evident anti-leakage intent:
- `effort` reaches NO adapter other than codex (no other adapter reads it) — tested directly.
- `model` does not affect any adapter that doesn't read it (tested against grok, which reads no opts keys, and the fixture adapter) — and agy honoring it is agy's own designed, validated, barricade-safe behavior, unchanged by this diff (agy.ts untouched).
This is flagged for the phase reviewer; if the strict reading was intended, the fix belongs in an UPDATE_PLAN that either drops verbatim forwarding or amends agy — both out of this phase's scope. Security check on the newly reachable path: agy validates `model` as a non-empty string (TypeError otherwise), emits it as one literal argv element positioned before `--print`; the prompt stays last; agy's `--sandbox` is boolean and unaffected. Barricade holds.

## Code Standards
No `docs/code-standards.md` found. Observed conventions applied instead: header doc-comments explaining security posture; `TypeError` for invalid opts values (agy's `pushOptionalStringFlag` precedent); flags-before-prompt encoded structurally; no `console.log` in `src/`; strict TS.

## Test Infrastructure
`bun:test` (`expect/test/spyOn`). Adapter tests are pure-function (synthetic stdout/stderr/exitCode, no spawn). `test/tools.test.ts` writes fixture adapter files to a temp dir and spies on `rt.jobStore.dispatch` to assert forwarded opts. DW tests named `test_DW_N_M_...`.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-1.1 | `buildCodexArgv("p","read")` → `["codex","exec","--sandbox","read-only","p"]` | COVERED | `test_DW_1_1_buildCodexArgv_no_cfg_is_byte_identical_to_current_codex_argv` (adapter-codex.test.ts) |
| DW-1.2 | model flag + configOverrides before `--sandbox`, prompt last | COVERED | `test_DW_1_2_model_flag_precedes_sandbox_prompt_last`, `test_DW_1_2_configOverrides_emit_dash_c_before_sandbox` |
| DW-1.3 | `codex.buildArgs("p",{model,effort})` emits both flags, prompt last | COVERED | `test_DW_1_3_codex_buildArgs_emits_model_and_effort_flags` |
| DW-1.4 | `codex.buildArgs("p",{})` unchanged | COVERED | `test_DW_1_4_no_params_argv_unchanged_from_today` + ALL existing buildArgs tests kept untouched in intent |
| DW-1.5 | inputShape accepts model/effort; out-of-enum effort rejected; keys inert elsewhere | COVERED (under documented reading above) | `test_DW_1_5_dispatch_forwards_model_and_effort_into_dispatch_opts`, `test_DW_1_5_out_of_enum_effort_rejected_at_tool_boundary`, `test_DW_1_5_forwarded_keys_inert_for_adapters_that_do_not_read_them` (tools.test.ts) |
| DW-1.6 | metachar `model` stays one literal argv element | COVERED | `test_DW_1_6_shell_metachar_model_stays_single_literal_argv_element` |
| DW-1.7 | `{profile:"x"}` emits `-p x` before `--sandbox` | COVERED | `test_DW_1_7_profile_flag_precedes_sandbox` |
| DW-1.8 | discovery excludes `_codex-shared` | COVERED | `test_DW_1_8_discovery_excludes_codex_shared_helper` (adapter-codex.test.ts — in file scope; `adapters-discover.test.ts` stays untouched per plan) |

**Count check:** 8 DW-IDs in prompt, 8 in table. **All items COVERED:** YES

## Design Decisions

## Design: buildCodexArgv (`_codex-shared.ts`)

### Approaches Considered
1. **A — Pure cfg function:** `buildCodexArgv(prompt, mode, cfg?)` takes an already-trusted `{model?, profile?, configOverrides?}` shape; each caller owns its own trust policy (codex.ts allowlists+validates untrusted opts; Phase 2's factory passes author-written cfg).
2. **B — Opts-aware builder:** shared helper reads `DispatchOpts` directly and does the allowlisting inside. One seam would mix two trust levels — the factory's richer trusted cfg would need a bypass flag or second entry point, and the shared module would have to know MCP/DispatchOpts shapes.
3. **C — Fluent builder class:** `new CodexArgv().model(x).sandbox(m)...` — interface complexity rivals the ~10-line implementation; classitis.

### Comparison
| Criterion | A | B | C |
|-----------|---|---|---|
| Interface simplicity | 1 function, 3-field cfg | 1-2 functions + trust param | many methods |
| Information hiding | flag spelling/order/sandbox map hidden; trust policy stays at each boundary | trust policy leaks into shared module | order hidden, verbose |
| Caller ease of use | codex.ts: 5 lines; factory: direct | codex.ts trivial, factory awkward | verbose everywhere |
| Security seam clarity | validation exactly at each trust boundary | two trust levels in one function | scattered |

### Choice: A
Rationale: single place owns flag order + sandbox mapping + prompt-last invariant; trust decisions stay at the boundaries that own them (per cc-defensive barricade design). Also matches the plan's pinned Produces signature exactly. Sacrificed: nothing material; B's "one less mapping step" is not worth mixing trust levels.

### Depth Check
- Interface methods: 1 exported function (+ exported `CodexArgvConfig` type)
- Hidden details: `-m`/`-p`/`-c` spelling, fixed flag ordering (model, profile, overrides, then `--sandbox`), `SANDBOX_BY_MODE` mapping (moves from codex.ts into the shared module), prompt-last invariant
- Common case complexity: simple — `buildCodexArgv(prompt, mode)` with no cfg

### Defensive-programming decisions (cc-defensive-programming)
- **Trust boundary = codex.ts `buildArgs`** for the per-call path. zod at the MCP layer is the outer barricade, but `JobStore.dispatch` is also callable programmatically (bypasses zod), and sandbox subversion is security-critical → validate again in the adapter (defense-in-depth, per "security-critical paths validate again"). Invalid `model` (non-string/empty) or `effort` (out of `low|medium|high`) → **throw `TypeError`** (loud failure, agy's existing precedent; propagates to the dispatch tool's try/catch → clean MCP error). Silently dropping a bad effort would run at the wrong effort — a silent-failure red flag.
- `buildCodexArgv`'s cfg is a **trusted** input by contract (documented in its header): callers validate untrusted data before constructing cfg. Empty-string model/profile are skipped (never emit `-m ""`).
- Barricade: argv stays a `string[]`; every caller value is one literal element; caller-influenced flags precede `--sandbox`; `SANDBOX_BY_MODE` still only maps to `read-only`/`workspace-write` — `danger-full-access` remains unreachable.

## Prerequisites
- [x] Required files exist (`_codex-shared.ts` to be created — in scope)
- [x] Dependencies available (zod already imported in dispatch.ts; no new deps)
- [x] Assumption 1 verified (opts pass-through)

## Recommendation
**BUILD.** Implement `_codex-shared.ts`, refactor `codex.ts` to delegate, extend `dispatch.ts` inputShape + forwarding, extend both test files. The DW-1.5/agy nuance is documented above for the reviewer, not a blocker.
