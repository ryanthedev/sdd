# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`sdd` (Subagent-Driven Development) is a Claude Code **plugin**: an MCP server plus a Skills layer. It lets Claude delegate scoped, fresh-context work units to external CLI harnesses that run as child processes in the current working tree. Claude stays the brain and owns the diff; a harness does one bounded task (review, second opinion, implementation, image generation, video ingestion) and reports back a structured `{status, summary, artifacts, raw}` result.

Eleven adapters ship today: the agent harnesses `codex`, `agy`, `grok`, `kimi`, `qwen`, `mistral`; the artifact producers `agy-image`, `agy-vision`; and the video pipeline `yt-dlp`, `whisper`, `ffmpeg-frames`. There is deliberately **one** codex adapter — reasoning tier and model are per-call `dispatch` opts, not pinned variant files. See the README for the per-adapter gotcha table.

Runtime is **Bun** (`>=1.3.0`), TypeScript, strict mode, ESM. No build step — `.ts` runs directly.

## Commands

```bash
bun install              # install deps (@modelcontextprotocol/sdk, zod)
bun test                 # full test suite
bun test test/jobs.test.ts   # single test file
bun test -t "dispatch"       # single test by name pattern
bunx tsc --noEmit        # strict typecheck (also `bun run typecheck`)
bun run src/server.ts    # run the MCP server standalone (stdio); logs to stderr, Ctrl-C exits clean
```

Always run **both** `bun test` and `bunx tsc --noEmit` before considering a change done — `strict` + `noUncheckedIndexedAccess` + `noFallthroughCasesInSwitch` are on, so the typecheck catches things tests won't.

## Architecture

Hexagonal / Clean Architecture. Dependencies point inward toward the core types; the core knows nothing about MCP, tools, or adapters.

| Layer | Location | Role |
|---|---|---|
| Core domain types | `src/types.ts` | `Job`, `AdapterResult`, `DispatchOpts` — imported inward by everything. |
| The one dangerous capability | `src/lib/jobs.ts` (`JobStore`) | Owns spawning caller-controlled work units as child processes, streaming to per-job logs, pid/process-group reaping, and classifying done vs failed. Every other component stays pure/thin. |
| Outbound port | `src/adapters/types.ts` (`Adapter`) | A harness = pure data + pure functions (`buildArgs`, `injectContract`, `parseResult`). **No I/O, no spawning** — that's why adapters are unit-testable by feeding stdout/stderr/exitCode straight into `parseResult`. |
| Adapter discovery | `src/adapters/discover.ts` | Scans `src/adapters/*.ts` at call time. There is **no central registry** — dropping a valid file in is enough. Malformed/incomplete files are skipped with a stderr warning, never a crash. `discover.ts`/`types.ts`/`*.test.ts`/`*.d.ts`, plus any `_`- or `.`-prefixed file (`_codex-shared.ts`, `_agy-shared.ts`, …), are treated as infra and never loaded as adapters. |
| MCP tools | `src/tools/*.ts` | Eight tool factories: `dispatch`, `status`, `result`, `wait`, `cancel`, `list_adapters`, `check_adapter`, `usage`. Each takes a shared `Runtime` (`src/tools/runtime.ts` = one `JobStore` + adapters dir). |
| Account limits | `src/lib/limits.ts` | The second (and only other) piece that spawns: performs the `LimitsProbe` an adapter *declares*, over stdio JSON-RPC, and caches the snapshot ~60s. Unlike JobStore its argv contains **no caller input at all**. |
| Server wiring | `src/register.ts`, `src/server.ts` | `server.ts` dynamically imports `register.ts` so a half-installed plugin fails with a clear message, not a module-resolution stack. `register.ts` builds the `McpServer`, registers the eight tools, connects stdio, installs deterministic shutdown (reap children → close → exit 0). |

Async spine: `dispatch` returns a job id **synchronously and never blocks**; the child runs in the background; callers poll with `status`/`result` or block with `wait`. All job state is **in-memory and session-scoped** — restarting the server loses the job map (accepted for v1, no disk persistence).

## Non-obvious invariants — do not break these

- **Security barricade (`JobStore.dispatch`):** children are spawned from an argv **array** with `shell: false` and an explicit `cwd`. A prompt with shell metacharacters is literal argument text and can never be evaluated. A runtime guard in `#buildArgv` rejects any non-array/non-string argv from an adapter, backing the type-level `string[]` guarantee. Never introduce a shell string or `shell: true`.
- **Contract-marker validation is the correctness backstop:** a job's terminal state is decided by exit code **AND** the adapter's `parseResult` marker check. A missing contract marker → `failed` **even on exit 0** (the guard against a harness that exits clean without doing the work). A signal-killed job is always `failed` (never trust a parser on a job we terminated). A throwing `parseResult` is contained → `failed`.
- **Parse markers by LAST occurrence, not first** (see `agy.ts`) — the harness may echo the injected instruction, so the first match is the echo and the real result is last.
- **The JobStore imposes no concurrency policy:** every dispatch runs immediately and in parallel — a job is never refused for concurrency reasons, no matter what else is running in the same `cwd`. Agent harnesses are unconditionally permissive (codex `--sandbox workspace-write`, agy `--dangerously-skip-permissions`, grok `--always-approve`, kimi/qwen `--yolo`, mistral `--auto-approve`), so any dispatched harness may edit the tree it is handed. Deciding whether two jobs can safely share a working tree — and serializing the ones that can't — is the **caller's** job, not the server's.
- **The account-limits capability is all-or-nothing and pure:** an adapter that reports quota exports `readLimits` (pure DATA describing the call) *and* `parseLimits` (a pure normalizer). Declaring one without the other is a malformed adapter and discovery skips the file. The adapter never spawns — `src/lib/limits.ts` performs the call — which is what keeps the port I/O-free and `parseLimits` fixture-testable. `parseLimits` must DEGRADE on an unrecognized payload (drop fields), never throw, and must never report an unquantifiable window as `0%` — that reads as "plenty left" on a payload we didn't understand.
- **`plugin.json` `version` is the single source of truth**, read at startup by `register.ts:readVersion` (prefers `$CLAUDE_PLUGIN_ROOT`, falls back to a path relative to the module). Bump it there, nowhere else.
- **stdout is the JSON-RPC transport — never `console.log` anywhere in `src/`.** All human-facing output (banner, warnings, shutdown) goes through the stderr logger in `src/lib/log.ts`. Child env is passed through for credentials but is **never** written to a job log.

## Adding an adapter

Create `src/adapters/<name>.ts` exporting the `Adapter` shape (`name`, `buildArgs`, `injectContract`, `parseResult`). No registration needed — discovery picks it up. Put all CLI flags before any positional prompt arg (a flag placed after the prompt gets absorbed as prompt text by some harnesses; encode the ordering structurally in `buildArgs`). `injectContract` must append a marker the harness will emit; `parseResult` must extract and validate it, returning `failed` when the marker is absent. Add a `test/adapter-<name>.test.ts` that drives `parseResult` with representative stdout/stderr/exitCode triples.

## Orchestration doctrine

`skills/subagent-driven-development/SKILL.md` holds the doctrine on when to fan out, when the caller must serialize jobs that share a working tree, and how to use `wait`. Read it before changing tool semantics or the skill.
