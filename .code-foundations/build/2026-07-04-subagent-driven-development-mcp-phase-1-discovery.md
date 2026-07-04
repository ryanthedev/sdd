# Discovery + Design: Phase 1 - Scaffold + Adapter port + core types

## Files Found
- `/Users/r/repos/sdd/.code-foundations/plans/2026-07-04-subagent-driven-development-mcp.md` (the plan)
- `/Users/r/repos/sdd/.gitignore` (`node_modules/`, `*.log`, `.DS_Store`, `dist/`)
- Nothing else. The repo is an initialized git repo on branch `feature/subagent-driven-development-mcp` with **no source tree yet** — Phase 1 scaffolds it from scratch.

## Current State
Empty repo skeleton. No `package.json`, `tsconfig.json`, `src/`, `test/`, or `.claude-plugin/`. Reference implementation studied: `/Users/r/repos/oberskills/mcp` (`src/server.ts` dynamic-import bootstrap, `src/register.ts` McpServer construction + version-from-manifest, `src/lib/log.ts` stderr-only logger). Baton's `tsconfig.json` studied as the strict-config template to mirror.

Key structural difference from oberskills: oberskills nests the server under `mcp/` (so its manifest args point at `mcp/src/server.ts` and its version fallback is `../../.claude-plugin/plugin.json`). This project puts `src/` at the **repo root** per the plan's file scope, so manifest args point at `${CLAUDE_PLUGIN_ROOT}/src/server.ts` and the version fallback is `../.claude-plugin/plugin.json` relative to `src/register.ts`.

## Gaps
| # | Gap between plan and reality | Resolution |
|---|---|---|
| 1 | `discoverAdapters(dir): Adapter[]` is pinned **synchronous**, but validating "exports the port shape" needs to load each module, and ESM `import()` is async. | Probed Bun 1.3.14: `createRequire(import.meta.url)` loads an ESM/TS module **synchronously** and returns its named exports (`SYNC REQUIRE OK`). Sync seam is honorable as-pinned — no UPDATE_PLAN needed. |
| 2 | `src/adapters/*.ts` scan will also hit non-adapter infra files (`types.ts`, `discover.ts`). | Fixed, adapter-count-independent skip set (`discover.ts`, `types.ts`, dotfiles, `_`-prefixed, non-`.ts`). Never edited when adding an adapter, so "no central list to edit" holds. |
| 3 | "exits cleanly on SIGINT" — default Bun behavior is exit 130, ambiguous as "clean". | Install explicit SIGINT/SIGTERM handlers in `startServer` that close the server and `process.exit(0)`. Phase 2 extends these to reap children. |

## Code Standards
No `docs/code-standards.md` found. Conventions taken from the dispatch prompt + reference repos: Bun + strict TS; dependency-free `server.ts` dynamic-importing `register.ts`; stderr-only logging (no `console.log` in `src/`); `@modelcontextprotocol/sdk` ^1.29 + `zod` ^4; scripts `typecheck`/`test`; plugin.json is the single version source.

## Test Infrastructure
`bun test` (`bun:test` — `test`, `expect`, `describe`, `afterAll`). No framework exists yet; this phase establishes it. DW-1.1 needs an integration test that spawns `bun run src/server.ts` as a child (`Bun.spawn`), reads stderr for the "0 tools" line, sends SIGINT, and asserts a clean exit — with a hard timeout so a hang can't wedge the suite.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-1.1 | `bun run src/server.ts` starts, connects stdio, logs "0 tools" to stderr, exits cleanly on SIGINT | COVERED | `test/server-boot.test.ts`: `test_DW_1_1_boots_logs_zero_tools_and_exits_clean_on_sigint` — spawn child, assert stderr matches `/0 tools/`, send SIGINT, assert exit code 0 within timeout |
| DW-1.2 | `tsc --noEmit` and `bun test` pass clean on the scaffold | COVERED | Whole suite green + `bunx tsc --noEmit` clean; captured in final output. (Gate, not a unit test.) |
| DW-1.3 | Adapter port + AdapterResult/Job/JobState/DispatchOpts exported from types.ts/adapters/types.ts, `buildArgs` typed `string[]` | COVERED | `test/types.test.ts`: `test_DW_1_3_*` — construct a conforming `Adapter`/`Job`/`AdapterResult`/`DispatchOpts` value and assert `buildArgs` returns a `string[]` (compile-time typing + runtime shape) |
| DW-1.4 | `discoverAdapters()` returns `[]` for empty dir and skips (with stderr warning) a file missing a required export, without throwing | COVERED | `test/adapters-discover.test.ts`: `test_DW_1_4_empty_dir_returns_empty`, `test_DW_1_4_missing_export_is_skipped_with_warning_no_throw`, plus `test_DW_1_4_valid_adapter_is_discovered`, `test_DW_1_4_missing_dir_returns_empty`, `test_DW_1_4_infra_files_skipped_silently`, `test_DW_1_4_import_throw_is_skipped_with_warning` |

**All items COVERED:** YES (4 DW-IDs in prompt, 4 in table).

## Design Decisions

### Type placement (Clean Architecture: dependencies point inward)
- `src/types.ts` — inner **core/domain** types: `JobState`, `Job`, `DispatchOpts`, `AdapterResult`. No imports from adapters or infrastructure.
- `src/adapters/types.ts` — the **`Adapter` port** (boundary interface), importing `AdapterResult` + `DispatchOpts` from `../types.ts`. Arrow points inward (adapter boundary → core types), never the reverse.

`buildArgs(prompt, opts): string[]` is typed to return `string[]` (argv array). This is the security-sensitive type-level guardrail: an adapter structurally *cannot* hand Phase 2's JobStore a shell string, so the spawn boundary can never introduce command injection. `injectContract(prompt): string` and `parseResult(stdout, stderr, exitCode): AdapterResult` complete the port exactly as the plan pins.

### Module design: `discoverAdapters` (design-it-twice, APOSD)

**Approaches considered**
1. **Named `export const adapter: Adapter`** — each file exports one object; discovery reads `mod.adapter`.
2. **Default export** — `export default {...}`; discovery reads `mod.default`.
3. **Module-as-adapter** — the file exports the port members as named exports (`export const name`, `export function buildArgs`, …); discovery validates the module namespace and assembles an `Adapter`.

| Criterion | A (named) | B (default) | C (module-as-adapter) |
|-----------|-----------|-------------|-----------------------|
| Interface simplicity (one fn `discoverAdapters`) | equal | equal | equal |
| Information hiding | high | high | high |
| Caller ease of use (Phase 2 gets a cohesive `Adapter`) | good | good | good (assembled) |
| DW-1.4 "missing a **required export**" maps literally | partial (missing a property) | partial | **exact** (a named export is absent) |
| Skips infra files cleanly | yes (no `adapter` export) | yes | needs a skip-set |

**Choice: C (module-as-adapter), with a fixed infra skip-set.** Rationale: DW-1.4's wording — "a file *missing a required export*" — maps 1:1 to a module-level named export being absent, which is the most literal, most naturally-testable contract. Discovery validates `name:string`, `mode:"read"|"write"`, and `buildArgs`/`injectContract`/`parseResult` are functions, then returns a freshly-assembled `Adapter` object (cohesive value for Phase 2's JobStore — not a loose bag). Sacrifice: a small skip-set (`discover.ts`, `types.ts`, dotfiles, `_`-prefixed, non-`.ts`) is needed so infra files don't warn — but that set is **adapter-count-independent** (adding an adapter never edits it), so the plan's "no central list to edit" invariant holds.

**Deep-module depth check**
- Interface methods: 1 (`discoverAdapters(dir): Adapter[]`).
- Hidden details: directory reading, synchronous module loading (`createRequire`), shape validation, per-file error isolation (import throw / missing export → warn + skip), infra-file exclusion, absolute-path resolution.
- Common case complexity: **simple** — caller gets a `Adapter[]`, knows nothing of the mechanism; failures surface as a stderr warning (not swallowed silently — APOSD silent-failure guard) and the bad file is skipped, never crashing the server (edge case in the plan).

### Server boot (mirror oberskills, adapt paths)
- `src/server.ts` — dependency-free; `await import("./register.ts")` in a try/catch → on failure, `console.error` a clear actionable message + `process.exit(1)`. No stdout writes.
- `src/register.ts` — builds `McpServer` (name `sdd`, version from `readVersion()`), registers **zero** tools, connects `StdioServerTransport`, logs `sdd <v> connected (0 tools)` to stderr, installs SIGINT/SIGTERM handlers → close + `exit(0)`.
- `readVersion()` — reads `$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json`, fallback `../.claude-plugin/plugin.json` relative to `import.meta.url`; `"0.0.0"` last resort.
- `src/lib/log.ts` — `console.error("[sdd]", ...args)`.

## Prerequisites
- [x] Repo exists at `/Users/r/repos/sdd`, git-initialized on the feature branch
- [x] Bun 1.3.14 available; sync ESM require confirmed
- [x] Reference bootstrap pattern available (oberskills/mcp)
- [x] No missing dependencies (SDK + zod install from npm)

## Recommendation
**BUILD** — no plan gaps require UPDATE_PLAN. Scaffold the root-level Bun+TS repo, define `src/types.ts` (core) + `src/adapters/types.ts` (Adapter port), implement `src/adapters/discover.ts` (sync directory-scan via `createRequire`), a zero-tool `register.ts` with clean SIGINT exit, and validate every DW item with passing tests plus the dirty/boundary cases from the plan's Edge cases.
</content>
</invoke>
