# sdd — Subagent-Driven Development

An MCP server + Skills layer, shipped as one Claude Code plugin, for delegating scoped work units to CLI agent harnesses (`codex`, `agy`) that run as child processes in the current working tree. Claude stays the brain and owns the diff; a harness does one bounded task — review, second opinion, implementation, image generation — and reports back a structured `{status, summary, artifacts, raw}` result.

## Install

```
/plugin install sdd
```

This wires the `sdd` MCP server (`.claude-plugin/plugin.json` → `mcpServers.sdd`, running `bun run src/server.ts`) and auto-discovers the `subagent-driven-development` skill under `skills/`. Requires `bun >= 1.3.0` (see `package.json` `engines`); dependencies (`@modelcontextprotocol/sdk`, `zod`) install via `bun install` in this repo.

To run the server standalone (e.g. for manual testing):

```
bun run src/server.ts
```

It connects over stdio, logs `sdd <version> connected (6 tools)` to stderr, and exits cleanly on `SIGINT`/`SIGTERM`.

## The six tools

All state is in-memory and session-scoped — restarting the server loses the job map (accepted for v1, no disk persistence).

| Tool | Signature | What it does |
|---|---|---|
| `dispatch` | `(adapter, prompt, cwd?, mode?, timeoutMs?) → jobId` | Spawns a work unit on a named adapter as a child process in `cwd` (defaults to the server's cwd). Returns immediately — never blocks. `write`-mode jobs are serialized per `cwd`: a second concurrent write in the same `cwd` is rejected with an actionable error. |
| `status` | `(jobId) → {state, adapter, mode, exitCode?}` | Snapshot of a job's lifecycle: `running`, `done`, or `failed`. `done`/`failed` reflects the exit code **and** the adapter's contract-marker validation — never pid-liveness alone. |
| `result` | `(jobId) → {status, summary, artifacts, raw}` | Collects a terminal job's structured result. A still-running job returns `{status:"running"}` with no `summary`/`artifacts`/`raw` — never a partial result. |
| `wait` | `(jobIds[], timeoutMs?) → {done, stillRunning, unknown}` | Blocks until every job in `jobIds` is terminal or `timeoutMs` elapses, whichever is first — never blocks past the timeout. Defaults to a short ~30s poll; pass a larger `timeoutMs` (clamped at a 10-minute cap) for a long block instead of repolling. |
| `list_adapters` | `() → [{name, mode, binaryPresent}]` | Lists every adapter discovered under `src/adapters/`, with its mode (`read`/`write`) and whether its underlying CLI is present on `PATH`. Call this before `dispatch` to confirm the harness is actually installed. |
| `cancel` | `(jobId) → {cancelled}` | Terminates a running job's entire process group. No-op (`cancelled:false`) for an unknown or already-terminal job id — never throws. |

See `skills/subagent-driven-development/SKILL.md` for the orchestration doctrine on when to fan out, when to serialize, and how to use `wait`.

## The three adapters

| Adapter | Default mode | Job | Gotcha |
|---|---|---|---|
| `codex` | `read` | Review / second opinion | stdout carries the final answer, stderr carries progress — `summary`/`raw` come from stdout only. Output contract: a `VERDICT:` line + `## Findings` section; missing either (or non-zero exit) → `failed`. |
| `agy` | `write` | Review / implement | All flags before `--print`, prompt immediately after — a flag placed after `--print` is silently absorbed into the prompt and agy still exits 0. `buildArgs` enforces the order structurally. Output contract: last line `AGY_RESULT: DONE`/`FAILED`, parsed by **last** occurrence (not first) to survive an echoed instruction. |
| `agy-image` | `read` | Image generation (Nano Banana) | `outputPath` must be absolute (or resolve inside the job `cwd`) and end in `.png` — a bare relative filename risks the harness searching broadly instead of writing where intended. Success requires both the `AGY_IMAGE_SAVED:` marker and the file actually existing on disk. |

## Adding an adapter

Drop a file in `src/adapters/` exporting the `Adapter` port shape — there is no central registry to edit:

```ts
export const name = "my-adapter";
export const mode: "read" | "write" = "read";

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  // Return an argv array (never a shell string) — this is spawned with no shell.
  return ["my-cli", "--flag", prompt];
}

export function injectContract(prompt: string): string {
  // Append instructions asking the harness to emit a parseable, validatable marker.
  return `${prompt}\n\nEnd with: MY_RESULT: DONE|FAILED`;
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  // Extract + validate the marker. Missing marker → failed, regardless of exitCode
  // (the backstop for a harness that exits 0 without doing the work).
}
```

`src/adapters/discover.ts` scans `src/adapters/*.ts` at startup, validates each file exports `name`, `mode`, `buildArgs`, `injectContract`, and `parseResult`, and skips (with a stderr warning, never a crash) anything malformed or missing an export. `test/*.ts` and `.d.ts` files, plus `discover.ts`/`types.ts` themselves, are treated as infrastructure and never loaded as adapters.

## Development

```
bun install
bun test           # full suite
bunx tsc --noEmit   # strict typecheck
```

`plugin.json`'s `version` field is the single version source, read at server startup (`src/register.ts:readVersion`).
