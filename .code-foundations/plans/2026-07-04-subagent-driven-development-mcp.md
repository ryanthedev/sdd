# Plan: SDD — Subagent-Driven Development MCP

**Created:** 2026-07-04
**Status:** in-progress
**Started:** 2026-07-04 16:47
**Current Phase:** 1
**Complexity:** medium
---
## Context

**Problem:** rtd drives CLI agent harnesses (codex, agy) by hand as one-shot headless subagents — independent plan reviewers, image generation — but there is no programmatic way for Claude Code to delegate scoped work units to them, fan out in parallel, and collect structured results. Build an MCP server **+ Skills layer** (one Claude Code plugin) where Claude stays the brain and owns the diff, delegating fresh-context work units (code, review, second-opinion, image-gen) to CLI harnesses that execute in the same working tree and report back.

Seeded from confirmed research: `/Users/r/.code-foundations/research/2026-07-03-subagent-driven-development-mcp.md` (Status: confirmed — grill + cold read + infra-fact verification done).

**Success criteria:**
- An MCP client can `dispatch` a work unit to a named adapter, poll `status`, collect a structured `{status, summary, artifacts, raw}` `result`, `wait` on a fan-out of jobs, `list_adapters`, and `cancel`.
- Three working adapters: `codex`, `agy` (review/implement), `agy-image` (Nano Banana PNG).
- Async job model: `dispatch` never blocks; only the opt-in long `wait` blocks.
- Same-cwd execution with a write-write concurrency guard; jobs run as child processes the server explicitly reaps on shutdown.
- A skill layer teaches orchestration doctrine (fan out reads / serialize writes, poll-by-default `wait`, per-harness gotchas).

## Constraints
- **Stack:** Bun + strict TypeScript, matching baton/oberskills/upublish. `tsc --noEmit` and `bun test` clean; **stderr-only logging** in server code (stdout is the JSON-RPC transport).
- **MCP SDK:** `@modelcontextprotocol/sdk` (^1.29), zod raw-shape input schemas — mirror `oberskills/mcp` server.ts/register.ts/tools/ structure.
- **In-memory, session-scoped job state.** No disk persistence in v1 (restart loses the job map — accepted).
- **Child processes, not detached.** Server must explicitly track child pids and kill them on SIGTERM/SIGINT (MCP child cleanup is undocumented — cannot rely on the harness). SIGKILL'd server orphaning children is an accepted v1 residual.
- **Adapter output contract, not post-hoc summarization:** adapters inject format markers into the dispatched prompt and `parseResult` extracts + **validates** them (missing markers → failed/suspect regardless of exit code — the backstop for agy's exit-0 misparse).
- **agy `--print` flag order:** all flags before `--print`, prompt immediately after (misparse exits 0 silently).
- No secrets in logs; the spawn boundary treats the prompt/opts as untrusted input (no shell interpolation — argv array, never a shell string).

---
## Chosen Approach
**Ports-and-adapters (hexagonal).** A single `Adapter` port (interface) defines `mode`, `buildArgs()`, `parseResult()`; harnesses are outbound adapters discovered by directory scan; a core `JobStore` owns spawn/lifecycle/state; the six MCP tools are the inbound adapter (thin wrappers over `JobStore`). **Rationale:** matches the confirmed "code-plugin adapters + structured results" design and the existing `oberskills/mcp` tool-module pattern; isolates the one dangerous component (subprocess spawning) in `JobStore` behind a small port so adapters stay pure data+parse. **Fallback:** if the port proves over-engineered for three adapters, collapse `parseResult` marker logic into a shared helper — but keep the JobStore/tool split.

## Rejected Approaches
- **Thin per-tool shell-out:** each MCP tool directly spawns its CLI, no shared JobStore or adapter port. Rejected — duplicates spawn/lifecycle/reaping logic per tool, blocks the structured-results + mode-guard invariants, and reduces to the thin `spawn→stdout` wrapper the research flagged as the failure mode (all-agents-mcp archived for exactly this).

---
## Implementation Phases

### Phase 1: Scaffold + Adapter port + core types
**Model:** fable
**Skills:** aposd-designing-deep-modules, ca-architecture-boundaries
**Gate:** Full
**Depends on:** none
**File scope:** `package.json, tsconfig.json, .claude-plugin/plugin.json, src/server.ts, src/register.ts, src/lib/log.ts, src/types.ts, src/adapters/types.ts, src/adapters/discover.ts, test/adapters-discover.test.ts`

**Goal:** Stand up the Bun+TS repo skeleton at `~/repos/sdd` and define the two foundational seams every later phase consumes: the `Adapter` port and the core job/result types, plus the adapter directory-scan discovery mechanism.

**Scope:**
- IN: repo scaffold (package.json, tsconfig mirroring baton's strict config, plugin.json manifest, dependency-free `server.ts` that dynamic-imports `register.ts`, stderr-only `lib/log.ts`); `Adapter` interface; `Job`/`JobState`/`DispatchOpts`/`AdapterResult` types; `adapters/discover.ts` (scan `src/adapters/*.ts`, validate each exports the port shape); a stub `register.ts` that starts and lists zero tools.
- OUT: JobStore runtime (Phase 2), any concrete adapter, any tool handler.

**Constraints:** `server.ts` stays dependency-free and prints a clear stderr message + non-zero exit if `register.ts` import fails (mirror oberskills pattern). Version read from plugin.json.
**Edge cases:** adapters dir empty or a file missing a required export → discovery reports it, does not crash the server.

**Produces:**
- `Adapter` port: `{ name: string; mode: "read" | "write"; buildArgs(prompt: string, opts: DispatchOpts): string[]; injectContract(prompt: string): string; parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult }`
- `AdapterResult`: `{ status: "done" | "failed"; summary: string; artifacts: string[]; raw: string }`
- `Job`/`JobState`: `JobState = "running" | "done" | "failed"`; `Job = { id: string; adapter: string; mode: "read"|"write"; cwd: string; state: JobState; logPath: string; ... }`
- `discoverAdapters(dir): Adapter[]` — directory-scan registry (no central list to edit).
**Security-sensitive:** yes — the `Adapter.buildArgs` contract must return an argv array (never a shell string); this is the type-level guardrail against command injection that Phase 2 relies on.

**Done when:**
- [ ] DW-1.1: `bun run src/server.ts` starts, connects stdio, logs "0 tools" to stderr, exits cleanly on SIGINT.
- [ ] DW-1.2: `tsc --noEmit` and `bun test` pass clean on the scaffold.
- [ ] DW-1.3: `Adapter` port + `AdapterResult`/`Job`/`JobState`/`DispatchOpts` types exported from `src/types.ts` / `src/adapters/types.ts`, `buildArgs` typed to return `string[]`.
- [ ] DW-1.4: `discoverAdapters()` returns `[]` for an empty dir and skips (with a stderr warning) a file missing a required export, without throwing.

**Difficulty:** MEDIUM
**Uncertainty:** exact plugin.json manifest shape for bundling an MCP server + skills (cross-check an existing rtd plugin manifest during build).

### Phase 2: JobStore — spawn, lifecycle, logging, mode guard, reaping
**Model:** fable
**Skills:** cc-defensive-programming, cc-routine-and-class-design
**Gate:** Full
**Depends on:** Phase 1
**File scope:** `src/lib/jobs.ts, src/lib/ids.ts, test/jobs.test.ts`

**Goal:** Implement the core `JobStore` that dispatches an adapter as a child process in the caller's cwd, streams output to a per-job log file, tracks the pid, and on child exit captures the exit code and runs the adapter's `parseResult` into an `AdapterResult` — plus the write-write concurrency guard and explicit child reaping on server shutdown.

**Scope:**
- IN: `JobStore.dispatch(adapter, prompt, opts)` → jobId (spawns child via argv array, cwd, streams stdout+stderr to a per-job log under a temp dir); in-memory `Map<jobId, Job>`; `get(jobId)`, `wait(jobIds, timeoutMs)` → `{done, stillRunning}`; `cancel(jobId)` (process-group kill); write-write guard (refuse a second `write` job in the same cwd); shutdown handler (SIGTERM/SIGINT) that kills all tracked children.
- OUT: MCP tool wrappers (Phase 3), concrete adapters, the long-vs-short `wait` default policy tuning (expose the param; default set here, doctrine for when to use the long block lives in the Phase 5 skill).

**Constraints:** spawn with an argv array + explicit cwd — **never** a shell string (barricade at the trust boundary; prompt/opts are untrusted). Log files never contain secrets from the env. `wait` returns partial and never blocks past its timeout; default timeout short (~30s), caller may pass up to a documented cap.
**Edge cases:** child exits 0 but `parseResult` marks failed (agy misparse) → job state `failed`; child killed by signal → `failed` with signal noted; log file unwritable → dispatch fails fast with a clear error; `wait` on an unknown jobId → reported, not thrown; concurrent `write` to same cwd → rejected with an actionable message.

**Produces:** `JobStore` class/instance API consumed verbatim by the Phase 3 tools: `dispatch(adapter, prompt, opts)→jobId`, `get(jobId)→Job` (backs status/result), `wait(jobIds, timeoutMs)→{done, stillRunning}`, `cancel(jobId)`, `shutdown()`. Job state transitions `running → done|failed` reflect exit code **and** `parseResult` validation. (No `listAdapters` on JobStore — the Phase 3 `list_adapters` tool composes Phase 1's `discoverAdapters()` with a PATH presence check directly.)
**Security-sensitive:** yes — subprocess spawning with caller-controlled prompt/opts; process-group signal handling; parsing untrusted CLI output.

**Done when:**
- [ ] DW-2.1: `dispatch` returns a jobId synchronously (< 100ms) while the child runs; a fake fast adapter reaches `done` with a populated `AdapterResult`.
- [ ] DW-2.2: A child that exits 0 but omits the required contract marker lands in `failed` (silent-misparse backstop), asserted with a stub adapter.
- [ ] DW-2.3: Two concurrent `write`-mode dispatches in the same cwd → the second is rejected; two `read`-mode dispatches run concurrently.
- [ ] DW-2.4: `wait([...], shortTimeout)` returns `{done, stillRunning}` partial and never exceeds the timeout; `cancel` terminates a running child and its subprocess group.
- [ ] DW-2.5: `shutdown()` (and a SIGINT to the server) kills every tracked child — no orphaned pids remain (asserted by pid liveness check post-shutdown).
- [ ] DW-2.6: prompt/opts reach the child via an argv array; a prompt containing shell metacharacters (`; rm -rf`, backticks) is passed literally with no shell evaluation (asserted).

**Difficulty:** HIGH
**Uncertainty:** cross-platform process-group kill semantics (macOS primary target); whether `wait` polls or uses child-exit events (impl latitude).

### Phase 3: Tool surface (6 MCP tools) + codex adapter
**Model:** sonnet
**Skills:** cc-routine-and-class-design, cc-defensive-programming
**Gate:** Standard
**Depends on:** Phase 2
**File scope:** `src/register.ts, src/tools/**, src/adapters/codex.ts, test/tools.test.ts, test/adapter-codex.test.ts`

**Goal:** Wire the six MCP tools (`dispatch`, `status`, `result`, `wait`, `list_adapters`, `cancel`) as thin zod-typed wrappers over `JobStore`, and ship the `codex` adapter to prove the async spine end-to-end with a real harness.

**Scope:**
- IN: one tool module per tool (mirror oberskills ToolModule shape: name/title/description/inputShape/handler), registered in `register.ts`; the `codex` adapter (`buildArgs`: `codex exec --sandbox <mode> <prompt>`; `injectContract`: append the `VERDICT:`/`## Findings` markers; `parseResult`: split progress(stderr)/answer(stdout), extract+validate markers, `mode: "read"` for review).
- OUT: agy/agy-image (Phase 4), skill layer (Phase 5).

**Constraints:** tool handlers stay thin — no spawn logic (it lives in JobStore); every tool wraps errors into an MCP error result (mirror oberskills try/catch). `list_adapters` reports each adapter's name/mode and whether its underlying CLI binary is present on PATH.
**Edge cases:** `dispatch` to an unknown adapter → clear error; `result` on a still-running job → returns running status, not a partial artifact; `dispatch` a `write` job blocked by the guard → surfaces JobStore's rejection.

**Produces:** A runnable MCP server: an external client can dispatch→status→result→wait→cancel against the `codex` adapter; `list_adapters` (composing `discoverAdapters()` + PATH check) shows `codex`.

(No `Security-sensitive` flag: the spawn trust boundary is fully contained in Phase 2's JobStore, which spawns the argv array without a shell. Adapters only return argv **data** — `buildArgs` is typed `string[]`, so it structurally cannot introduce a shell string — and parse plain-text markers. The security enforcement lives in Phase 2, marked and Full-gated there.)

**Done when:**
- [ ] DW-3.1: All six tools registered and callable; a dispatch→wait→result round-trip against `codex` returns a structured `{status, summary, artifacts, raw}`.
- [ ] DW-3.2: `codex` `parseResult` puts the final answer in `summary`/`raw` from stdout and does not leak the stderr progress log into `summary`.
- [ ] DW-3.3: `list_adapters` reports `codex` with its mode and a `binaryPresent` flag (false when `codex` not on PATH).
- [ ] DW-3.4: `status` distinguishes `running` (pid alive) from `done`/`failed` (exit code + marker validation), not pid-liveness alone.

**Difficulty:** MEDIUM
**Uncertainty:** codex `exec` flag surface may have shifted since the grug note — build verifies against `codex --help`.

### Phase 4: agy + agy-image adapters
**Model:** sonnet
**Skills:** cc-defensive-programming
**Gate:** Standard
**Depends on:** Phase 2
**File scope:** `src/adapters/agy.ts, src/adapters/agy-image.ts, test/adapter-agy.test.ts, test/adapter-agy-image.test.ts`

**Goal:** Implement the two `agy`-backed adapters against the Phase 1 port — `agy` for review/implement and `agy-image` for Nano Banana image generation — each with exactly one output contract.

**Scope:**
- IN: `agy` adapter (`buildArgs`: all flags before `--print`, prompt immediately after — `agy <flags> --print <prompt>`; `parseResult`: validate the review marker, exit-0-misparse backstop → `failed` when the marker is absent; `mode` per job); `agy-image` adapter (separate file, own contract: prompt → PNG at an explicit artifact path returned in `artifacts`, `mode: "read"`).
- OUT: tool wiring (Phase 3 owns register.ts), skill doctrine (Phase 5).

**Constraints:** the agy flag-order landmine is encoded structurally in `buildArgs` (prompt is the last, immediate arg after `--print`); no shared registry edit (discovery is directory-scan from Phase 1), so this phase touches only its own adapter files. `agy-image` writes only to an explicit absolute artifact path, never the source tree.
**Edge cases:** agy exits 0 with a self-answer about `--print` (misparse) → marker absent → `failed`; `agy-image` produces no file → `failed` with the reason; relative artifact path → resolved to absolute before spawn (grug: agy searches all of /Users for a relative name).

**Produces:** Two discoverable adapters usable via the Phase 3 `dispatch` tool: `agy` (read/write review+implement) and `agy-image` (read, PNG in `artifacts`).

(No `Security-sensitive` flag, same reasoning as Phase 3: adapters return argv **data** (`buildArgs: string[]`) and parse plain-text output; the spawn/no-shell trust boundary is enforced in Phase 2. `buildArgs` returning an argv array — flags before `--print`, prompt as the last element — is the structural guard, verified by T-4.1.)

**Done when:**
- [ ] DW-4.1: `agy` `buildArgs` emits flags-before-`--print` with the prompt as the immediately-following single argv element (asserted on the argv array).
- [ ] DW-4.2: An agy run whose output lacks the required marker is classified `failed`, not `done` (silent-misparse backstop), asserted with a captured/stubbed misparse output.
- [ ] DW-4.3: `agy-image` returns the PNG absolute path in `artifacts` and is `mode: "read"`; a missing output file → `failed`.
- [ ] DW-4.4: Both adapters are found by `discoverAdapters()` with no edit to any central registry file.

**Difficulty:** MEDIUM
**Uncertainty:** whether agy image-gen needs an explicit "save to <path>" instruction in the injected prompt (grug note suggests yes — give an absolute path).

### Phase 5: Skills layer + plugin manifest + README
**Model:** sonnet
**Skills:** oberskills:skill-craft
**Gate:** Minimal
**Depends on:** Phase 3, Phase 4
**File scope:** `skills/**, .claude-plugin/plugin.json, README.md`

**Goal:** Author the orchestration skill(s) that give an agent the judgment to use the MCP tools well, finalize the plugin manifest wiring the MCP server + skills, and write the README.

**Scope:**
- IN: a `subagent-driven-development` SKILL.md (orchestration doctrine: fan out reads / serialize writes, poll-by-default `wait` with the long-block escape hatch, per-harness gotchas — agy `--print` order, codex stderr/stdout split, which adapter suits review vs implement vs image; trigger description for "get a second opinion", "review with codex", "generate an image"); plugin.json finalized (mcpServers entry for the sdd server, skills bundled); README (install, tool surface, adding an adapter).
- OUT: any runtime TS (frozen after Phase 4).

**Constraints:** SKILL.md frontmatter follows the oberskills house format (name, description third-person what+when, when_to_use triggers; description+when_to_use ≤ 1,536 chars). Manifest is the single version source. No secrets in README.
**Edge cases:** the skill must not claim MCP does what Bash can't in the overstated "async" framing — describe the honest delta (structured collection + live job-state as a tool surface).

**Produces:** An installable Claude Code plugin: `/plugin install` wires the MCP server and the orchestration skill; the skill triggers on delegation intents and reaches for the sdd tools.
**Done when:**
- [ ] DW-5.1: `plugin.json` registers the sdd MCP server (command/args) and validates as JSON; version present.
- [ ] DW-5.2: SKILL.md passes the house-format checks (frontmatter fields present, combined length ≤ 1,536) and documents the fan-out-reads/serialize-writes + poll-default-wait doctrine and the three adapters' gotchas.
- [ ] DW-5.3: README documents install, the six tools, the three adapters, and how to add an adapter (drop a file in `adapters/`).

**Difficulty:** LOW
**Uncertainty:** whether one skill or a small skill set reads better — decide during authoring (skill-craft informs).

---
## Test Coverage
**Level:** 100% (matches rtd's error policy — everything that can be asserted, is; per-DW plus dirty/boundary from each phase's Edge cases)

## Test Plan
- [ ] T-1.1 (DW-1.1): server boots, connects stdio, clean SIGINT exit — integration.
- [ ] T-1.2 (DW-1.2): `tsc --noEmit` + `bun test` green on scaffold — build gate.
- [ ] T-1.3 (DW-1.3): port + result/job types exported, `buildArgs` typed `string[]` — type/unit.
- [ ] T-1.4 (DW-1.4, dirty): empty adapters dir → `[]`; file missing an export → skipped with warning, no throw.
- [ ] T-2.1 (DW-2.1): dispatch returns id < 100ms; fake adapter reaches `done` with populated result — unit.
- [ ] T-2.2 (DW-2.2, dirty): exit-0-without-marker stub → `failed` (misparse backstop).
- [ ] T-2.3 (DW-2.3, dirty): concurrent same-cwd `write` → second rejected; concurrent `read` → both run.
- [ ] T-2.4 (DW-2.4): `wait` returns partial within timeout; `cancel` kills child + group.
- [ ] T-2.5 (DW-2.5, dirty): post-`shutdown`/SIGINT no tracked child pid stays alive.
- [ ] T-2.6 (DW-2.6, dirty): prompt with `; rm -rf`/backticks passed literally via argv, no shell eval.
- [ ] T-3.1 (DW-3.1): dispatch→wait→result round-trip vs codex returns structured result — integration.
- [ ] T-3.2 (DW-3.2): codex parseResult keeps stderr progress out of `summary`.
- [ ] T-3.3 (DW-3.3, dirty): `list_adapters` `binaryPresent:false` when codex not on PATH.
- [ ] T-3.4 (DW-3.4): status `running` vs `done`/`failed` reflects exit+markers.
- [ ] T-3.5 (Phase 3 edge, dirty): `dispatch` to an unknown adapter → clear error, no job created.
- [ ] T-3.6 (Phase 3 edge, dirty): `result` on a still-running job → returns running status, not a partial artifact.
- [ ] T-4.1 (DW-4.1): agy `buildArgs` argv has flags-before-`--print`, prompt immediately after.
- [ ] T-4.2 (DW-4.2, dirty): agy misparse output (no marker) → `failed`.
- [ ] T-4.3 (DW-4.3, dirty): agy-image returns absolute PNG path; missing file → `failed`.
- [ ] T-4.4 (DW-4.4): both adapters discovered with no registry edit.
- [ ] T-4.5 (Phase 4 edge, dirty): `agy-image` given a relative output path resolves it to absolute before spawn (guards the grug `/Users`-wide-search landmine).
- [ ] T-5.1 (DW-5.1): plugin.json valid JSON, registers sdd server, version present.
- [ ] T-5.2 (DW-5.2): SKILL.md frontmatter + length checks pass; doctrine present.
- [ ] T-5.3 (DW-5.3): README covers install, tools, adapters, add-an-adapter — manual.

---
## Assumptions
| Assumption | Confidence | Verify Before Phase | Fallback If Wrong |
|---|---|---|---|
| Project lives at `~/repos/sdd`, standalone repo, name `sdd` | Medium (user away at decision) | Phase 1 | Rename/relocate — mechanical; slug + plugin name change |
| Full spec (6 tools/3 adapters) is v1 scope, built spine-first | High (confirmed in research) | Phase 3 | Drop Phase 4/parts of Phase 3 to a follow-up if scope tightens |
| stdio MCP server is one long-lived session-scoped process | Medium (inferred, not documented) | Phase 2 | If per-call, in-memory job map fails → escalate to disk persistence sooner |
| `codex exec` / `agy --print` flag surfaces match grug notes | Medium | Phase 3 / Phase 4 | Build verifies against `--help`; adjust buildArgs |
| Claude Code `MCP_TOOL_TIMEOUT` default ~28h → long `wait` safe in CC | High (verified 2026-07-04) | Phase 3 | Short-poll default already covers other clients |

## Decision Log
| Decision | Alternatives Considered | Rationale | Phase |
|---|---|---|---|
| Ports-and-adapters (JobStore core, adapters as port, tools as inbound) | Thin per-tool shell-out | Matches confirmed design; isolates the dangerous spawn in one place; avoids the archived-wrapper failure mode | all |
| Adapter discovery by directory scan | Static central registry | Keeps phase file-scopes disjoint (parallel waves); resolves the doc's open "adapter discovery" question; add-an-adapter = drop a file | 1, 3, 4 |
| Child processes, server reaps on shutdown | Detached children (survive restart) | Detached orphans mutate the tree uncollectably; MCP child cleanup is undocumented so the server must reap explicitly | 2 |
| Output-contract markers validated in parseResult | Trust exit code; or a summarizer LLM call | No hot-path LLM cost; doubles as the agy exit-0 silent-misparse backstop | 2, 3, 4 |
| `agy-image` a separate adapter | One agy adapter branching on job kind | One output contract per adapter keeps the marker-validation invariant clean | 4 |

---
## Notes
- **Build prerequisite:** `~/repos/sdd` does not exist yet. Phase 1 scaffolds it; `git init` is required before `/code-foundations:build` (build needs a feature branch). The plan file currently lives at `/Users/r/.code-foundations/plans/` alongside the research doc — copy it into the repo (or run build from the repo) once Phase 1 creates it. **Flag for the human before build.**
- **Wave eligibility:** Phases 3 and 4 both depend only on Phase 2 and have disjoint file scopes (`tools/**` + `codex.ts` vs `agy*.ts`) — wave-eligible (both Standard gate). Phases 1 and 2 are Full gate and run alone. DAG: 1 → 2 → {3, 4} → 5. Build at **default** effort.
- **Intentionally staged files (not accidental overlap):** `src/register.ts` is a zero-tool stub in Phase 1 and gets the six tools wired in Phase 3; `.claude-plugin/plugin.json` is created (manifest + version) in Phase 1 and finalized (mcpServers + skills bundling) in Phase 5. These are sequential in the DAG (never in the same wave), so no parallel collision — the revisits are deliberate. The only parallel wave, {3,4}, is genuinely disjoint.
- **Riskiest assumption (from research):** async alone isn't MCP-unique (Bash can background + poll). The justification is structured collection + live job-state as a tool surface. Keep the JobStore/adapter split real — if it degenerates to thin spawn→stdout, the all-agents-mcp critique applies.
- **Deferred (v1 out):** disk persistence; read-during-write hard interlock (skill sequences write→review instead); fan-out concurrency cap (add a max-concurrent limit when needed); SIGKILL orphan reconciliation (needs disk persistence).
- **Open, decide during build:** exact `DispatchOpts` shape (sandbox mode, timeout, model per adapter); `wait` all-of vs any-of default and the short-timeout/long-cap values; log temp-dir location + cleanup lifecycle.

---
## Execution Log
_To be filled during /code-foundations:build_
