# Plan: Selectable codex models/agents in the sdd MCP plugin
**Created:** 2026-07-06
**Status:** in-progress
**Started:** 2026-07-07
**Current Phase:** 1
**Complexity:** medium
---
## Context
**Problem:** There is no way to pick a codex model or reasoning-effort "agent" through the sdd MCP. `src/adapters/codex.ts:53` hardcodes `["codex","exec","--sandbox",<mode>,prompt]` with no model flag, and `src/tools/dispatch.ts:56-61` forwards only `cwd`/`mode`/`timeoutMs`/`outputPath` into `DispatchOpts`. Every codex dispatch runs the user's default model (`gpt-5.5`, `medium` effort).

**Success criteria:** (1) A caller can select a named codex variant by adapter name (`dispatch(adapter:"codex-high")`). (2) A caller can select model/effort at call time on the base `codex` adapter (`dispatch(adapter:"codex", model, effort)`). (3) `codex` unchanged as the medium-effort default. (4) `bun test` + `bunx tsc --noEmit` both green.

## Constraints
- Flags MUST precede the positional prompt in `buildArgs` (a flag after the prompt is absorbed as prompt text; codex still exits 0, so no error catches it).
- Security barricade: argv is a `string[]`, `shell:false`, no shell string ever. The per-call param must NOT let a caller pass arbitrary codex `-c key=value` config — that could override `--sandbox` (`-c sandbox_mode=danger-full-access`) and subvert the mode barricade. Per-call is a constrained allowlist (`model` + `effort` enum). The factory may take richer config because it is trusted, author-written code.
- Contract-marker validation backstop is unchanged: variants reuse codex's `injectContract`/`parseResult` verbatim.
- Discovery skip rule (verified `discover.ts:37`): a leading-`_` filename is skipped silently — shared helpers live in `_codex-*.ts` and are never loaded as adapters.
- `binary` presence-probe field (verified `list-adapters.ts:34`, `Bun.which(a.binary ?? a.name)`): variants export `binary:"codex"` so `list_adapters` probes the real binary, not the variant name. `buildArgs` still controls the spawned argv[0].
- Each new adapter needs a `test/adapter-<name>.test.ts` driving `buildArgs`/`parseResult` (per "Adding an adapter" doctrine). The existing `test/adapter-codex.test.ts` must be updated for the new `buildArgs` behaviour, keeping its existing assertions green when no model/effort is passed.
- SKILL.md / agent bodies must use braced `${CLAUDE_PLUGIN_ROOT}` for any plugin file reference (grug: `plugin-root-must-be-braced`).

## Chosen Approach
**Both, over a shared argv builder.** A single pure helper `buildCodexArgv(prompt, mode, cfg)` owns flag assembly and ordering in one place. The base `codex` adapter reads an allowlisted `{model, effort}` from `opts` (Option B, per-call); a `_codex-factory.ts` builds pinned variants from richer `{model, profile, configOverrides}` (Option A, roster). Both call the same builder, so flag-ordering and the security barricade are defined once, not duplicated. **Fallback:** if per-call params prove risky, drop Option B and keep only the factory roster (Option A) — the shared builder still stands.

## Rejected Approaches
- **Option A only (drop-in variants):** stable tool surface, but no call-time model choice — user asked for both.
- **Option B only (per-call param):** flexible, but no named roster and it widens the public MCP surface without the reuse a factory gives.
- **Duplicated arg logic per adapter (no shared builder):** flag-ordering + sandbox-safety logic copy-pasted into codex.ts and the factory — two places to get the security barricade wrong.

---
## Implementation Phases

### Phase 1: Shared argv builder + allowlisted per-call params
**Model:** fable
**Skills:** cc-defensive-programming, aposd-designing-deep-modules
**Gate:** Full
**Depends on:** none
**File scope:** `src/adapters/_codex-shared.ts, src/adapters/codex.ts, src/tools/dispatch.ts, test/adapter-codex.test.ts, test/tools.test.ts`

**Goal:** Extract codex flag assembly into a pure shared helper, then let the base `codex` adapter select model/effort from an allowlisted subset of `DispatchOpts` threaded through the dispatch tool.

**Scope:**
- IN: `_codex-shared.ts` exporting `buildCodexArgv`; refactor `codex.ts` `buildArgs` to read `opts.model`/`opts.effort` and delegate; add optional `model` (string) + `effort` (enum) to `dispatch.ts` `inputShape` and forward into `DispatchOpts`; update codex + dispatch tests.
- OUT: the factory and roster variants (Phase 2); any doctrine text (Phase 3); profile/arbitrary-config on the per-call path (deliberately excluded for security).

**Constraints:** Per-call reads ONLY `model` + `effort`; never arbitrary `configOverrides` from `opts`. `effort` maps to `configOverrides:{model_reasoning_effort:<effort>}` inside the adapter. Flags emitted as `["codex","exec", ...flags, "--sandbox", <mode>, prompt]` — prompt stays last. Existing codex tests must stay green for the no-arg call. Dispatch-tool coverage (DW-1.5) EXTENDS the existing `test/tools.test.ts` (see `test_dispatch_forwards_outputPath_into_dispatch_opts`) — no new `test/dispatch.test.ts` file. `DispatchOpts` already has an open index signature (`types.ts:45`), so forwarding `model`/`effort` needs no `src/types.ts` edit.
**Edge cases:** no model + no effort → argv byte-identical to today's output (regression guard); `effort` constrained by zod enum (`low|medium|high`) so an unknown value is rejected at the tool boundary; a `model` string containing shell metacharacters stays one literal argv element.
**Depends on:** none | **Unlocks:** Phase 2, Phase 3
**Produces:** `buildCodexArgv(prompt: string, mode: AdapterMode, cfg?: { model?: string; profile?: string; configOverrides?: Record<string,string> }): string[]` exported from `src/adapters/_codex-shared.ts`; dispatch `inputShape` gains `model?: string` and `effort?: "low"|"medium"|"high"`, both forwarded verbatim into `DispatchOpts`.
**Security-sensitive:** yes

**Done when:**
- [ ] DW-1.1: `buildCodexArgv("p","read")` returns `["codex","exec","--sandbox","read-only","p"]` (byte-identical to current codex output).
- [ ] DW-1.2: `buildCodexArgv("p","read",{model:"o3"})` places `-m o3` before `--sandbox` and `p` last; `{configOverrides:{model_reasoning_effort:"high"}}` emits `-c model_reasoning_effort=high` before `--sandbox`.
- [ ] DW-1.3: `codex.buildArgs("p",{model:"o3",effort:"high"})` emits both `-m o3` and `-c model_reasoning_effort=high`, prompt last.
- [ ] DW-1.4: `codex.buildArgs("p",{})` is unchanged from today (existing tests pass untouched in intent).
- [ ] DW-1.5: dispatch `inputShape` accepts `model`/`effort`; an out-of-enum `effort` is rejected; neither key reaches any other adapter's behaviour.
- [ ] DW-1.6: a shell-metacharacter `model` value stays a single literal argv element (barricade preserved).
- [ ] DW-1.7: `buildCodexArgv("p","read",{profile:"x"})` emits `-p x` before `--sandbox` (the profile slot is wired even though no profile exists yet — proven, not dead).
- [ ] DW-1.8: `discoverAdapters(src/adapters)` does NOT return `_codex-shared` (the leading-`_` exclusion holds even before Phase 2 exists).

### Phase 2: Factory + effort-roster variants
**Model:** sonnet
**Skills:** aposd-designing-deep-modules, gof-design-patterns
**Gate:** Standard
**Depends on:** Phase 1
**File scope:** `src/adapters/_codex-factory.ts, src/adapters/codex-high.ts, src/adapters/codex-low.ts, test/adapter-codex-high.test.ts, test/adapter-codex-low.test.ts`

**Goal:** A `makeCodexVariant` factory over the shared builder that emits complete drop-in Adapter modules, plus two shipped variants pinning high/low reasoning effort on the default model.

**Scope:**
- IN: `_codex-factory.ts` exporting `makeCodexVariant({name, model?, profile?, configOverrides?, mode?})`; `codex-high.ts` and `codex-low.ts` re-exporting the port members; their test files.
- OUT: per-call params (Phase 1); any model-specific variant file (the factory's `model` slot is documented in Phase 3 but no such file ships now).

**Constraints:** Factory reuses `codex.ts`'s `injectContract` + `parseResult` verbatim (single source of the output contract). Every variant exports `binary:"codex"` and a valid `mode` (default `read`). Variant files must expose the port members as named exports so discovery's `toAdapter` validation passes. Pinned variants IGNORE per-call `model`/`effort` from `opts` (the pin is the whole point) — the config is fixed at construction. DW-2.3/2.4 assertions live in the variant test files by importing `discoverAdapters` and `createListAdaptersTool` directly; the existing `test/adapters-discover.test.ts` and `test/tools.test.ts` stay untouched.
**Edge cases:** discovery must load `codex-high`/`codex-low` and skip `_codex-factory.ts` (leading `_`); two variants must not collide on `name`; `list_adapters` reports `binaryPresent:true` via the `codex` probe.
**Depends on:** Phase 1 | **Unlocks:** Phase 3
**Produces:** `makeCodexVariant(cfg): { name, mode, binary, buildArgs, injectContract, parseResult }`; adapters `codex-high` (`model_reasoning_effort=high`) and `codex-low` (`=low`), both on the default model, discoverable by name.
**Security-sensitive:** omit — the barricade is inherited whole from Phase 1's shared `buildCodexArgv` (single source), and the factory adds no new untrusted-input path; DW-2.6 proves the inheritance holds through the factory rather than asserting it.

**Done when:**
- [ ] DW-2.1: `makeCodexVariant({name:"x",configOverrides:{model_reasoning_effort:"high"}}).buildArgs("p",{})` emits `-c model_reasoning_effort=high` before `--sandbox`, prompt last.
- [ ] DW-2.2: `codex-high`/`codex-low` each export `name`, `mode`, `binary:"codex"`, `buildArgs`, `injectContract`, `parseResult`; `parseResult`/`injectContract` are codex's (identity reuse, not re-implemented).
- [ ] DW-2.3: `discoverAdapters(src/adapters)` returns `codex-high` and `codex-low` and does NOT return `_codex-factory` or `_codex-shared`.
- [ ] DW-2.4: `list_adapters` shows `codex-high`/`codex-low` with `binaryPresent:true` when `codex` is on PATH.
- [ ] DW-2.5: `codex-high.buildArgs("p",{model:"o3",effort:"low"})` still emits the pinned high effort and no `-m o3` — per-call opts are ignored by pinned variants.
- [ ] DW-2.6 (dirty): a shell-metacharacter prompt through `makeCodexVariant(...).buildArgs` stays a single literal argv element (inherited barricade holds through the factory path).

### Phase 3: Doctrine update
**Model:** haiku
**Skills:** code-clarity-and-docs
**Gate:** Minimal
**Depends on:** Phase 1, Phase 2
**File scope:** `skills/subagent-driven-development/SKILL.md`

**Goal:** Document the codex roster, the per-call `model`/`effort` params, which lever fits which job, and the "add a `codex-<model>.ts` anytime" extension path.

**Scope:**
- IN: extend the codex section of `SKILL.md` (variants table + per-call params + factory extension note); note the security reason per-call is model/effort-only.
- OUT: any code change; README parameter reference (link only, don't duplicate).

**Constraints:** Match the skill's terse imperative bullet voice. Any plugin file reference uses braced `${CLAUDE_PLUGIN_ROOT}`. Don't re-document the base dispatch tool surface — reference the README.
**Edge cases:** omit — prose only.
**Depends on:** Phase 1, Phase 2 | **Unlocks:** none
**Produces:** updated `SKILL.md` codex doctrine covering roster + per-call selection.

**Done when:**
- [ ] DW-3.1: `SKILL.md` lists `codex`/`codex-high`/`codex-low` with their effort levels and when to reach for each.
- [ ] DW-3.2: `SKILL.md` documents per-call `model`/`effort` on `codex` and states why it's allowlisted (no arbitrary `-c`, sandbox safety).
- [ ] DW-3.3: `SKILL.md` documents adding a `codex-<model>.ts` via `makeCodexVariant` with no core change.
- [ ] DW-3.4: `SKILL.md` states that pinned variants ignore per-call `model`/`effort` — pass those to the base `codex` adapter instead.

---
## Test Coverage
**Level:** 100%
## Test Plan
- [ ] DW-1.1 regression: no-arg `buildCodexArgv` byte-identical to current output (clean).
- [ ] DW-1.2/1.3: model + effort flag emission and ordering (clean).
- [ ] DW-1.7: profile-slot emission (`-p x`) (clean).
- [ ] DW-1.6 dirty: shell-metacharacter `model` stays one literal argv element.
- [ ] DW-1.5 dirty: out-of-enum `effort` rejected at the dispatch boundary; extra keys don't leak to other adapters (extends `test/tools.test.ts`).
- [ ] DW-1.8 dirty: `discoverAdapters` excludes `_codex-shared`.
- [ ] DW-1.4 regression: existing `adapter-codex.test.ts` assertions still pass.
- [ ] DW-2.1/2.2: factory buildArgs + identity reuse of injectContract/parseResult (clean).
- [ ] DW-2.3 dirty: discovery excludes `_codex-factory`/`_codex-shared`, includes both variants.
- [ ] DW-2.4: `list_adapters` binaryPresent via codex probe.
- [ ] DW-2.5 dirty: pinned variant ignores per-call `model`/`effort`.
- [ ] DW-2.6 dirty: metachar prompt stays one literal argv element through the factory path.
- [ ] DW-3.1–3.4: doctrine prose — verified by Minimal-gate review, no automated tests.
- [ ] Full-suite: `bun test` green, `bunx tsc --noEmit` clean (strict + noUncheckedIndexedAccess + noFallthroughCasesInSwitch).

## Assumptions
| Assumption | Confidence | Verify Before Phase | Fallback If Wrong |
|---|---|---|---|
| JobStore passes caller `opts` to `buildArgs` unchanged (codex.ts:48-49 says so) | High | Phase 1 | Thread opts explicitly in JobStore if not |
| A later `-c` override can beat an earlier `--sandbox` flag (basis for the allowlist) | Medium | Phase 1 | Allowlist still correct even if not; defense-in-depth |
| `codex-high`/`codex-low` model names need no `-m` (inherit default gpt-5.5) | High | Phase 2 | Add explicit `-m gpt-5.5` in the variant cfg |

## Decision Log
| Decision | Alternatives Considered | Rationale | Phase |
|---|---|---|---|
| Per-call limited to `model`+`effort` allowlist | Arbitrary `configOverrides` passthrough | Prevent sandbox subversion via `-c sandbox_mode=…` | 1 |
| Shared `_codex-shared.ts` builder | Duplicate arg logic in codex.ts + factory | One place owns flag order + barricade | 1 |
| Effort roster (high/low) on default model | Model-named variants | Grounded in actual config (no profiles; gpt-5.5 default) | 2 |
| Factory keeps `model`/`profile`/`configOverrides` slots | Effort-only factory | User picked "model slot"; future variants need no core change | 2 |

---
## Notes
- No codex profiles exist in `~/.codex/config.toml` and no `*.config.toml` files — the `profile` slot is wired but unused until the user creates profiles.
- `codex` base adapter mode stays `read`; variants inherit `read` default.
- Phases are strictly serial (1 → 2 → 3); no wave parallelism, so build effort = low.
---
## Execution Log

### Phase 1: Shared argv builder + allowlisted per-call params (Gate: Full)
- [x] BUILD: Discovery + design + implementation complete
- [x] REVIEW: Verification passed (3-sample, 3/3 PASS on fable)
- [x] Committed
Commit: 766898b
Summary: Added `_codex-shared.ts` `buildCodexArgv(prompt, mode, cfg?)` (owns codex flag order + sandbox map, skipped by discovery via leading `_`); `codex.buildArgs` now delegates and reads allowlisted `opts.model`/`opts.effort`; dispatch tool `inputShape` gained `model` (string) + `effort` (low|medium|high enum), forwarded verbatim into DispatchOpts. Barricade intact (string[] + shell:false; no arbitrary `-c`). 126 tests pass, tsc clean.

### Phase 2: Factory + effort-roster variants (Gate: Standard)
- [x] BUILD: Discovery + design + implementation complete
- [x] REVIEW: Verification passed (single-sample sonnet, PASS)
- [x] Committed
Commit: 14d9510
Summary: Added `_codex-factory.ts` `makeCodexVariant(cfg)` (closure factory over `buildCodexArgv`, reuses codex's `injectContract`/`parseResult` by identity, ignores per-call opts to enforce pins) and shipped `codex-high`/`codex-low` variants (default model, high/low `model_reasoning_effort`), each exporting `binary:"codex"`. Discovery loads both and skips `_codex-factory`/`_codex-shared`; `list_adapters` probes the real `codex` binary. 140 tests pass, tsc clean.
