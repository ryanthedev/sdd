# Review: Phase 2 - Factory + effort-roster variants (codex-high / codex-low)

## Executed Results (Step 0)
- Test suite: `bun test` → **140 pass, 0 fail** (375 expect() calls, 11 files, 2.83s)
- Targeted: `bun test test/adapter-codex-high.test.ts test/adapter-codex-low.test.ts` → **14 pass, 0 fail** (46 expect() calls)
- Typecheck: `bunx tsc --noEmit` → clean, no output, exit 0
- Lint: no lint script defined in `package.json` (only `start`/`typecheck`/`test`) — nothing to run
- Extra verification: ran a standalone script invoking `createListAdaptersTool` against the real `src/adapters` dir; `codex` confirmed on PATH (`/Users/r/.nvm/versions/node/v22.17.0/bin/codex`). Output:
  ```json
  [
    { "name": "codex-high", "mode": "read", "binaryPresent": true },
    { "name": "codex-low",  "mode": "read", "binaryPresent": true },
    { "name": "codex",      "mode": "read", "binaryPresent": true }
  ]
  ```

## Requirement Fulfillment

### DW-2.1
PREMISE:  `makeCodexVariant({name:"x",configOverrides:{model_reasoning_effort:"high"}}).buildArgs("p",{})` emits `-c model_reasoning_effort=high` before `--sandbox`, prompt last.
EVIDENCE: `src/adapters/_codex-factory.ts:50-61` (`makeCodexVariant`), `src/adapters/_codex-shared.ts:55-61` (`buildCodexArgv`); test `test/adapter-codex-high.test.ts:17-28`.
TRACE:    `cfg={name:"x",configOverrides:{model_reasoning_effort:"high"}}` → destructure `name="x"`, `variantMode=undefined` → `resolvedMode="read"`, `argvCfg={configOverrides:{...}}` → `buildArgs("p",{})` calls `buildCodexArgv("p","read",argvCfg)` → flags: `cfg.model` undefined (skip), `cfg.profile` undefined (skip), one `configOverrides` entry → push `"-c","model_reasoning_effort=high"` → return `["codex","exec","-c","model_reasoning_effort=high","--sandbox","read-only","p"]`. Matches expected exactly.
VERDICT:  PASS

### DW-2.2
PREMISE:  `codex-high`/`codex-low` each export `name`, `mode`, `binary:"codex"`, `buildArgs`, `injectContract`, `parseResult`; `parseResult`/`injectContract` are codex's (identity reuse, not re-implemented).
EVIDENCE: `src/adapters/codex-high.ts:18-23`, `src/adapters/codex-low.ts:18-23`; test `test/adapter-codex-high.test.ts:45-53`, `test/adapter-codex-low.test.ts:38-45`.
TRACE:    Both variant files re-export `variant.*` from `makeCodexVariant(...)`, and `makeCodexVariant` at `_codex-factory.ts:59-60` sets `injectContract: codex.injectContract, parseResult: codex.parseResult` — direct references to the imported `codex` module's functions, not re-implementations. Tests assert `codexHigh.injectContract === codex.injectContract` and `codexHigh.parseResult === codex.parseResult` (strict identity via `toBe`), same for `codexLow`. Both ran and passed.
VERDICT:  PASS

### DW-2.3
PREMISE:  `discoverAdapters(src/adapters)` returns `codex-high` and `codex-low` and does NOT return `_codex-factory` or `_codex-shared`.
EVIDENCE: `src/adapters/discover.ts:34-39` (`isCandidate`, skips `_`-prefixed files), `src/adapters/discover.ts:82-123`; test `test/adapter-codex-high.test.ts:97-103`.
TRACE:    `discoverAdapters(join(import.meta.dir,"../src/adapters"))` scans real directory; `_codex-factory.ts`/`_codex-shared.ts` fail `isCandidate` (`fileName.startsWith("_")` → `false`) and are never `require`'d or added to `adapters`. `codex-high.ts`/`codex-low.ts` pass `isCandidate`, load, validate against the Adapter port (`toAdapter`), and are pushed. Test asserts `names` contains `codex-high`/`codex-low` and `names.some(n=>n.includes("codex-factory"))===false` / same for `codex-shared`. Ran and passed.
VERDICT:  PASS

### DW-2.4
PREMISE:  `list_adapters` shows `codex-high`/`codex-low` with `binaryPresent:true` when `codex` is on PATH.
EVIDENCE: `src/tools/list-adapters.ts:31-35` (`Bun.which(a.binary ?? a.name)`), `src/adapters/_codex-factory.ts:57` (`binary: "codex"`); test `test/adapter-codex-low.test.ts:80-98`.
TRACE:    `listAdapters(rt)` returns the discovered adapters including `codex-high`/`codex-low`, each with `binary:"codex"`. `list-adapters.ts:34` probes `Bun.which(a.binary ?? a.name)` → `Bun.which("codex")` for both variants (not `Bun.which("codex-high")`, which would fail since that binary doesn't exist). Ran the standalone verification script above (not just the test's cross-equality assertion) and observed `binaryPresent: true` literally for both `codex-high` and `codex-low`, matching real `codex` presence on PATH.
VERDICT:  PASS

### DW-2.5
PREMISE:  `codex-high.buildArgs("p",{model:"o3",effort:"low"})` still emits the pinned high effort and no `-m o3` — per-call opts are ignored by pinned variants.
EVIDENCE: `src/adapters/_codex-factory.ts:58` (`buildArgs: (prompt, _opts) => buildCodexArgv(prompt, resolvedMode, argvCfg)`); test `test/adapter-codex-high.test.ts:71-77`.
TRACE:    The returned closure's parameter list includes `_opts` (underscore-prefixed, unused in the body) — the call always evaluates `buildCodexArgv(prompt, resolvedMode, argvCfg)` where `argvCfg` was captured at construction time (`{configOverrides:{model_reasoning_effort:"high"}}`) and never reads `opts.model`/`opts.effort`. So `buildArgs("p",{model:"o3",effort:"low"})` → same output as `buildArgs("p",{})` → `["codex","exec","-c","model_reasoning_effort=high","--sandbox","read-only","p"]`. Test asserts this exact array, and that the array does not contain `"-m"`, `"o3"`, or `"model_reasoning_effort=low"`. Ran and passed.
VERDICT:  PASS

### DW-2.6
PREMISE:  a shell-metacharacter prompt through `makeCodexVariant(...).buildArgs` stays a single literal argv element.
EVIDENCE: `src/adapters/_codex-shared.ts:55-61` (`buildCodexArgv` pushes `prompt` as-is as the final array element); test `test/adapter-codex-high.test.ts:83-91`.
TRACE:    `dangerous = "review; rm -rf / && echo \`whoami\` $(id)"` → `variant.buildArgs(dangerous,{})` → `buildCodexArgv(dangerous,"read",argvCfg)` → returns `[..., "--sandbox","read-only", dangerous]` — `dangerous` is appended as one array element via `push`/spread, never string-concatenated or shell-joined. Since `JobStore` spawns this argv with `shell:false` (per `src/lib/jobs.ts`, out of scope but the barricade this depends on), the metacharacters are inert. Test asserts `argv[argv.length-1] === dangerous` both via the factory directly and via `codexHigh.buildArgs`. Ran and passed.
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] DW-2.1 → `test_DW_2_1_factory_buildArgs_emits_configOverrides_before_sandbox_prompt_last` (ran, passed)
- [x] DW-2.2 → `test_DW_2_2_codex_high_exports_port_shape_and_reuses_codex_contract` + `test_DW_2_2_codex_low_exports_port_shape_and_reuses_codex_contract` (ran, passed)
- [x] DW-2.3 → `test_DW_2_3_discovery_includes_variants_excludes_factory_and_shared` (ran, passed)
- [x] DW-2.4 → `test_DW_2_4_list_adapters_reports_variants_with_binary_present` (ran, passed) + independent script verification (literal `true` observed)
- [x] DW-2.5 → `test_DW_2_5_codex_high_ignores_per_call_model_and_effort` + codex-low equivalent (ran, passed)
- [x] DW-2.6 → `test_DW_2_6_shell_metachar_prompt_stays_single_literal_argv_element` (ran, passed)
- [x] Edge case: skip `_codex-factory.ts` → covered by `test_DW_2_3` assertion `names.some(n=>n.includes("codex-factory"))===false`
- [x] Edge case: no name collision → covered by `"codex-high and codex-low do not collide on name"` (`test/adapter-codex-low.test.ts:68-74`)
- [x] Edge case: `binaryPresent` via `codex` probe not variant name → covered by `test_DW_2_4` + independent script confirming literal `true` (would be `false` if the code probed `"codex-high"`/`"codex-low"` instead of `binary:"codex"`)

Coverage matches the stated 100% level — every DW item and every listed edge case has a directly-named, executed automated test (plus one independently-run script for DW-2.4/edge-case-3 as extra confirmation beyond the test's cross-equality assertion).

## Dead Code
None found. `_codex-factory.ts`, `codex-high.ts`, `codex-low.ts` — all imports used, no unreachable code, no debug statements (`console.log`, etc.), no commented-out blocks.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | All three files are pure, synchronous, side-effect-free functions/closures over immutable captured config — no shared mutable state, no async, no I/O. |
| Error Handling | N/A | `makeCodexVariant` takes trusted, author-written config (documented at `_codex-factory.ts:13-16`), not caller/opts data — there is no untrusted input at this boundary to validate. `buildCodexArgv` (reviewed in Phase 1, out of scope) already handles `cfg.model`/`cfg.profile` omission via truthy checks. |
| Resources | N/A | No file handles, connections, locks, caches, or threads in scope. |
| Boundaries | PASS | Traced `configOverrides:{}` (empty object) → `Object.entries({})` yields no entries → no extra flags, matches "defaults mode to read and never emits danger-full-access" test (`_codex-factory.ts` test, `mode` omitted → `["codex","exec","--sandbox","read-only","p"]`). Traced omitted `mode` → `variantMode ?? "read"` → `"read"`, never `undefined` leaks through. |
| Security | PASS | Traced the adversarial case per DW-2.5: an attacker-controlled `opts` (`{model:"o3", effort:"low", configOverrides:{sandbox_mode:"danger-full-access"}}` even) cannot influence output — `buildArgs`'s closure signature discards `opts` entirely (`_opts`, never read). Traced DW-2.6: shell metacharacters in `prompt` stay a single literal argv element (never shell-joined), consistent with the `shell:false` barricade this phase depends on but does not re-implement. `binary` is hardcoded to the literal string `"codex"` at `_codex-factory.ts:57`, not derived from `name` or any variant config field, so a pinned variant can never spoof a different CLI's PATH probe. |

## Loaded-Skill Criteria

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| aposd-designing-deep-modules | Interface simplicity — is `makeCodexVariant` a deep module (small interface, real hidden complexity)? | PASS | Single-function interface (`makeCodexVariant(cfg)`) hides flag assembly, sandbox mapping, mode-default resolution, and contract-function wiring — a caller (`codex-high.ts`/`codex-low.ts`) needs 4 lines to produce a fully conformant `Adapter`. Common case (pin one `configOverrides` key) requires no knowledge of `buildCodexArgv`'s internals. |
| aposd-designing-deep-modules | Information hiding — is variant-shape knowledge duplicated across module boundaries? | Note (non-blocking) | `CodexVariant` (`_codex-factory.ts:35-42`) mirrors the shape of `Adapter` (`src/adapters/types.ts:15-54`) with `binary` narrowed from optional to required. This is a local, single-file type used only to type-check the factory's own return value — not shared/re-declared knowledge that could drift out of sync with a caller, since `codex-high.ts`/`codex-low.ts` never reference `CodexVariant` directly (they destructure `variant.*`). Not a demonstrated defect, flagged only as a minor duplication to watch if the Adapter port shape changes. |
| aposd-designing-deep-modules | Generality sweet spot — is specialization pushed to the right layer? | PASS | Specialization (which model/effort to pin) is pushed UP into the thin `codex-high.ts`/`codex-low.ts` call sites (each a 4-line `makeCodexVariant` call), while the general mechanism (flag assembly, sandbox mapping, contract reuse) stays DOWN in the factory + shared `buildCodexArgv`. Matches the doctrine comment at `_codex-factory.ts:1-7` explicitly citing this as the intended pattern for future `codex-<model>.ts` variants. |
| gof-design-patterns | Correct pattern selection — is a factory-style creation function justified here, not over-engineered? | PASS | Symptom matched: "hard-coded class/object-literal construction scattered across files" (would otherwise require hand-writing a full `Adapter` object literal per variant, duplicating `injectContract`/`parseResult` wiring and flag-ordering logic in each). `makeCodexVariant` is a simple factory *function* (not a GoF Factory Method with subclass polymorphism, and not over-applied — no abstract factory hierarchy, no unnecessary indirection layers). Consistent with "if a straightforward solution works, use it" — this is the straightforward solution for N pinned variants sharing one construction recipe. |

## Notes (non-blocking)
- No lint script is configured in this project (`package.json` scripts are `start`/`typecheck`/`test` only), so "Lint" in Step 0 has nothing to execute against — not a phase defect, just recorded for completeness.
- `CodexVariant`'s local interface duplicates the `Adapter` port shape (see Loaded-Skill Criteria row above) — cosmetic, not a functional risk given its single-file, single-consumer scope.
- Doc comments in `_codex-factory.ts`/`codex-high.ts`/`codex-low.ts` are unusually thorough and explicitly document the security trust boundary, the identity-reuse rationale, and the ignored-`opts` design choice — this made independent verification straightforward and is worth preserving as a convention for future `codex-<model>.ts` variants (per the plan's Phase 3 doctrine note referenced in the header).

## Issues (if FAIL)
None.

**Verdict: PASS**
