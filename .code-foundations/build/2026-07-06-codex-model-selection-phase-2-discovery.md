# Discovery + Design: Phase 2 - Factory + effort-roster variants

## Files Found
- `src/adapters/_codex-shared.ts` — Phase 1's `buildCodexArgv(prompt, mode, cfg?)`, exists and matches plan spec exactly (byte-identical no-arg output, flag order `-m`, `-p`, `-c...`, `--sandbox`, prompt last).
- `src/adapters/codex.ts` — base adapter; exports `name`, `mode`, `injectContract`, `buildArgs` (delegates to `buildCodexArgv` with allowlisted `opts.model`/`opts.effort`), `parseResult`. These last two are the exact functions Phase 2 must reuse verbatim.
- `src/adapters/types.ts` — `Adapter` port: `name`, optional `binary` (defaults to `name` for the PATH probe), `mode`, `buildArgs`, `injectContract`, `parseResult`.
- `src/adapters/discover.ts` — `isCandidate` skips `.d.ts`/`.test.ts`/dotfiles/**leading-underscore files**; `toAdapter` validates the module's *top-level named exports* (not a returned object) against the port shape.
- `src/tools/list-adapters.ts` — probes `Bun.which(a.binary ?? a.name)`; needs `binary` set for codex-derived variants.
- `src/tools/runtime.ts` — `listAdapters(rt)`/`findAdapter` call `discoverAdapters(rt.adaptersDir)` fresh each time; `createRuntime()` defaults to the real `src/adapters` dir.
- `test/adapter-codex.test.ts` — Phase 1 tests already exercise `buildCodexArgv` and `codex.buildArgs`; none of it needs touching in this phase (file scope excludes it).
- `test/adapters-discover.test.ts` — generic discovery tests with fixture dirs; untouched per plan (DW-2.3 lives in the new variant test files instead, against the real `src/adapters` dir, mirroring `test_DW_1_8_discovery_excludes_codex_shared_helper` in `adapter-codex.test.ts`).
- `test/tools.test.ts` — has the pattern to mirror for `list_adapters` assertions (`test_DW_3_3_list_adapters_reports_codex_from_real_adapters_dir` uses `createRuntime()` with the default adapters dir + `createListAdaptersTool(rt)`).
- No `src/adapters/_codex-factory.ts`, `codex-high.ts`, `codex-low.ts` yet — all three plus their two test files need to be created (files IN scope for this phase).
- No `docs/code-standards.md` in the repo.

## Current State
Phase 1 is committed (766898b): the shared argv builder and per-call allowlist on the base `codex` adapter both exist and are tested. Phase 2 builds directly on top: a factory that assembles a complete drop-in `Adapter` module from a small config, plus two concrete files (`codex-high.ts`, `codex-low.ts`) that pin `model_reasoning_effort` on the default model and expose the port members as named exports so discovery's `toAdapter` (which reads `mod.name`, `mod.mode`, etc. off the *module namespace*) picks them up.

## Gaps
- The plan's "Produces" line describes `makeCodexVariant(cfg)` returning `{ name, mode, binary, buildArgs, injectContract, parseResult }` — an object — but discovery reads *module-level exports*, not a returned object. `codex-high.ts`/`codex-low.ts` must destructure the factory's return value into individual `export const` statements. No contradiction, just a translation step to get right in the variant files.
- No existing precedent in this repo for a factory-produced adapter (agy/grok/qwen/kimi/mistral/agy-image are all hand-written single-file adapters). This phase establishes the first one.

## Code Standards
No `docs/code-standards.md` found. Following the conventions visible in `_codex-shared.ts`/`codex.ts`: header doc-comment explaining the module's role + security posture, named exports (no default export), explicit `AdapterMode`/`DispatchOpts`/`AdapterResult` types imported from `../types.ts`, JSDoc on exported functions explaining *why*, not just *what*.

## Test Infrastructure
`bun:test` (`test`, `expect`). Pure-function adapter tests need no spawn/mocking — feed literal strings into `buildArgs`/`parseResult`. Discovery/list_adapters tests that need the *real* `src/adapters` directory use `createRuntime()` (default adapters dir) or `discoverAdapters(join(import.meta.dir, "../src/adapters"))` directly, per `adapter-codex.test.ts`'s `test_DW_1_8_...` and `tools.test.ts`'s `test_DW_3_3_...`.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-2.1 | `makeCodexVariant({name:"x",configOverrides:{model_reasoning_effort:"high"}}).buildArgs("p",{})` emits `-c model_reasoning_effort=high` before `--sandbox`, prompt last | COVERED | `test_DW_2_1_factory_buildArgs_emits_configOverrides_before_sandbox_prompt_last` in `adapter-codex-high.test.ts` |
| DW-2.2 | `codex-high`/`codex-low` each export `name`, `mode`, `binary:"codex"`, `buildArgs`, `injectContract`, `parseResult`; `parseResult`/`injectContract` are codex's (identity reuse) | COVERED | `test_DW_2_2_codex_high_exports_port_shape_and_reuses_codex_contract` (codex-high test file), `test_DW_2_2_codex_low_exports_port_shape_and_reuses_codex_contract` (codex-low test file) — assert `===` identity against `codex.injectContract`/`codex.parseResult` |
| DW-2.3 | `discoverAdapters(src/adapters)` returns `codex-high` and `codex-low`, does NOT return `_codex-factory` or `_codex-shared` | COVERED | `test_DW_2_3_discovery_includes_variants_excludes_factory_and_shared` in `adapter-codex-high.test.ts` |
| DW-2.4 | `list_adapters` shows `codex-high`/`codex-low` with `binaryPresent:true` when `codex` is on PATH | COVERED | `test_DW_2_4_list_adapters_reports_variants_with_binary_present` in `adapter-codex-low.test.ts` |
| DW-2.5 | `codex-high.buildArgs("p",{model:"o3",effort:"low"})` still emits pinned high effort, no `-m o3` | COVERED | `test_DW_2_5_codex_high_ignores_per_call_model_and_effort` in `adapter-codex-high.test.ts` |
| DW-2.6 (dirty) | shell-metacharacter prompt through `makeCodexVariant(...).buildArgs` stays one literal argv element | COVERED | `test_DW_2_6_shell_metachar_prompt_stays_single_literal_argv_element` in `adapter-codex-high.test.ts` |

**All items COVERED:** YES

## Design Decisions

### Design: `makeCodexVariant` factory

#### Approaches Considered
1. **Closure factory returning a complete Adapter object** — `makeCodexVariant(cfg)` builds a `buildArgs` closure over the pinned `CodexArgvConfig` (delegating to `buildCodexArgv`), and returns `{ name, mode, binary: "codex", buildArgs, injectContract: codex.injectContract, parseResult: codex.parseResult }`. Variant files call it once and re-export each field as a top-level `export const`.
2. **Config-object factory + per-variant assembly** — `makeCodexVariant(cfg)` returns only a validated config object; each variant file (`codex-high.ts`, `codex-low.ts`) builds its own `buildArgs` closure calling `buildCodexArgv` directly and manually re-exports `codex.injectContract`/`codex.parseResult`.
3. **Class-based `CodexVariant implements Adapter`** — a class with a constructor taking cfg, instance methods `buildArgs`/`injectContract`/`parseResult`; variant files `export const codexHigh = new CodexVariant(...)` and re-export its bound methods.

#### Comparison
| Criterion | 1 (closure factory) | 2 (config-only factory) | 3 (class-based) |
|-----------|---|---|---|
| Interface simplicity | One function, one call site per variant | One function + duplicated closure-building code per variant file | One class, but variant files need `.bind()` or arrow wrappers to get plain functions for named exports |
| Information hiding | Full — flag assembly, sandbox mapping, contract reuse all inside the factory | Partial — flag-ordering knowledge (`buildCodexArgv` call shape) leaks into every variant file | Full, but adds OO ceremony (`this` binding) the rest of the adapters layer doesn't use |
| Caller ease of use | Variant file is ~5 lines of destructuring re-exports | Variant file duplicates a `buildArgs` closure — more code, more chance of drift | Variant file needs method binding boilerplate to produce free functions for discovery's `mod.buildArgs` check |
| Fits existing conventions | Matches `codex.ts`'s "pure data + pure functions, no I/O" style; factory is just a function that returns plain data | Same functional style but violates single-source-of-truth for buildArgs assembly (Phase 1's stated goal for `_codex-shared.ts`) | Contradicts the port's explicit "pure data + pure functions" comment (`types.ts`); no other adapter uses a class |

#### Choice: 1 (closure factory returning a complete Adapter-shaped object)
Rationale: keeps `buildCodexArgv`-calling logic in exactly one new place (the factory), matches the codebase's functional adapter convention, and makes each variant file a trivial, hard-to-get-wrong re-export. Sacrifices nothing — Approach 2's only "benefit" (avoiding a closure) is not a real benefit since the factory already needs to build one to satisfy `Adapter["buildArgs"]`'s pure-function signature. Approach 3's class ceremony buys nothing extra and fights the file's own header doctrine.

### Depth Check
- Interface: 1 function (`makeCodexVariant`), 1 parameter object (`name`, plus the optional `model`/`profile`/`configOverrides`/`mode` slots already shaped by Phase 1's `CodexArgvConfig`).
- Hidden details: sandbox-mode mapping, flag-ordering/security barricade (both already hidden inside `buildCodexArgv`, and the factory does not re-expose them), the fact that `injectContract`/`parseResult` are identity-shared with `codex.ts` rather than re-implemented, the closure construction needed to satisfy the `Adapter["buildArgs"]` signature.
- Common case complexity: simple — one call (`makeCodexVariant({ name: "codex-high", configOverrides: { model_reasoning_effort: "high" } })`) produces a complete, discoverable, drop-in adapter.

### GoF pattern: Factory Method (function form)
`makeCodexVariant` is a parameterized Factory Method: it is the single place that knows how to assemble a complete `Adapter` object from a `CodexArgvConfig`-shaped input, replacing what would otherwise be hand-written, duplicated `Adapter` object literals in `codex-high.ts`/`codex-low.ts`. Counter-indicator check: this is *not* over-applying the pattern — there are already 2 concrete variants shipping now (with a 3rd, model-named slot documented for Phase 3), i.e. genuine recurring variation, not a one-off. A class-based Creator/ConcreteCreator hierarchy (the textbook OOP form) was explicitly rejected above in favor of a plain factory *function* because the codebase's Adapter port is data-plus-functions, not classes — same intent (defer/centralize object construction), lighter mechanism.

### Variant file shape
```ts
// codex-high.ts
import { makeCodexVariant } from "./_codex-factory.ts";

const variant = makeCodexVariant({
  name: "codex-high",
  configOverrides: { model_reasoning_effort: "high" },
});

export const name = variant.name;
export const mode = variant.mode;
export const binary = variant.binary;
export const buildArgs = variant.buildArgs;
export const injectContract = variant.injectContract;
export const parseResult = variant.parseResult;
```
`codex-low.ts` is identical except `name: "codex-low"` and `model_reasoning_effort: "low"`. `buildArgs` on the returned object deliberately ignores its `opts` parameter (only reads the closed-over pinned cfg) — this is what makes DW-2.5 (pinned variants ignore per-call model/effort) hold structurally rather than by an extra runtime check.

## Prerequisites
- [x] Phase 1 files exist and match spec (`_codex-shared.ts`, `codex.ts` with allowlisted `buildArgs`)
- [x] `Adapter` port, `discoverAdapters`, `createListAdaptersTool`, `createRuntime` all available and unchanged
- [x] No missing prerequisites

## Recommendation
BUILD. Implement `_codex-factory.ts` (closure factory per Approach 1), `codex-high.ts`, `codex-low.ts` (thin re-export files), and their two test files.
