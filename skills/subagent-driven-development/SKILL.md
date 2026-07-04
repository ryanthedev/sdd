---
name: subagent-driven-development
description: >-
  Orchestration doctrine for delegating scoped work units to CLI agent
  harnesses (codex, agy) through the sdd MCP server's six tools (dispatch,
  status, result, wait, list_adapters, cancel). Documents which adapter fits
  which job, the fan-out-reads/serialize-writes concurrency rule, the
  poll-by-default wait policy, and each harness's parsing gotchas. Use when
  delegating a scoped task to a CLI subagent harness, getting a second
  opinion or independent review, generating an image, fanning out parallel
  read-mode jobs, or deciding whether to poll or block on a dispatched job.
  Not for: in-process Agent-tool subagents (use oberskills:agent) or writing
  new MCP tools or adapters (runtime code, out of scope here).
when_to_use: >-
  Trigger phrases: "get a second opinion", "review this with codex", "review
  this with agy", "generate an image", "delegate this to a subagent",
  "dispatch this to codex/agy", "fan this out", "run these reviews in
  parallel". Use before calling any sdd MCP tool.
---

# Subagent-driven development

The `sdd` MCP server delegates a scoped, fresh-context work unit (review, second opinion, implementation, image generation) to a CLI harness — `codex` or `agy` — that runs as a child process in the current working tree. Six tools: `dispatch`, `status`, `result`, `wait`, `list_adapters`, `cancel`. Claude stays the brain and owns the diff; the harness does one bounded task and reports back.

## The honest value proposition

Async by itself isn't the differentiator — Bash can already background a process and poll it. What this MCP actually buys over hand-rolled Bash:

- **Structured, validated results.** Each adapter's `parseResult` extracts and validates an output-contract marker before calling a job `done`. A harness that exits 0 but never did the work (a misparsed flag, a silently-swallowed prompt) is caught and reported `failed` — a raw `bash &` + grep of stdout has no equivalent backstop.
- **Live job-state as a tool surface.** `status`/`result`/`wait`/`list_adapters` are typed, queryable tools instead of a one-off shell script you reinvent per task.

Don't oversell it as "async that Bash can't do" — that claim doesn't survive scrutiny and undermines trust in the rest of the doctrine.

## 1. Fan out reads, serialize writes

`dispatch` returns a `jobId` immediately; it never blocks.

- **Read-mode jobs run concurrently.** Reviews, second opinions, and image generation don't touch the working tree — dispatch several in the same turn, then `wait` on the batch.
- **Write-mode jobs are serialized per cwd.** The JobStore rejects a second concurrent `write` dispatch in the same cwd with an actionable error — there is no read-during-write hard interlock, so sequence deliberately: `dispatch(write) → wait → dispatch(review, read)`, never `write ∥ write` in one cwd.
- Override an adapter's default mode per dispatch via `mode` when a job doesn't fit its adapter's default (e.g. `agy` in review-only mode).

## 2. Poll-by-default wait

`wait(jobIds, timeoutMs?)` defaults to a short poll (~30s) and returns `{done, stillRunning, unknown}` — never partial results mistaken for complete ones.

- Pass a larger `timeoutMs` (clamped at a 10-minute cap) when you'd rather block once than repoll — useful for a lone long-running write with nothing else to do meanwhile.
- The long block is safe under Claude Code's own ~28h `MCP_TOOL_TIMEOUT` default; other MCP clients with a shorter tool timeout should stay on the short poll (or raise their client's timeout) rather than risk a client-side cutoff mid-wait.
- Prefer the short poll in a loop when other tool calls are worth making in between; reach for the long block only when polling adds nothing.

## 3. Per-harness gotchas

### codex — review / second opinion (`mode: read`)
- stdout carries the final answer; stderr carries progress. `summary`/`raw` are built from stdout only — never treat stderr text as the result.
- Output contract: a `VERDICT:` line plus a `## Findings` section. Missing either, or a non-zero exit, is `failed` regardless of what else is in stdout.
- codex does its own web verification when a review needs it — no extra step required from the caller.

### agy — review / implement (`mode: write` by default)
- **Flag-order landmine:** all flags go before `--print`; the prompt is the single argv element immediately after it. A flag placed after `--print` is silently absorbed into the prompt text instead of being parsed — and agy still exits 0, so there is no non-zero exit to catch the mistake. The adapter enforces the correct order structurally; if you ever construct an agy call outside this MCP, keep that order.
- Output contract: the last line of output must be exactly `AGY_RESULT: DONE` or `AGY_RESULT: FAILED`. Parsing takes the **last** matching line, not the first — a harness that echoes the instruction back before its real verdict would otherwise fool a first-match parse.
- Defaults to `write`; pass `mode: "read"` explicitly for a review-only dispatch so the write-write guard isn't bypassed by accident.

### agy-image — image generation (`mode: read`, Nano Banana)
- Always pass an absolute `outputPath` (or one that resolves inside the job cwd) ending in `.png`. A bare relative filename risks the harness searching broadly for a match instead of writing where you meant.
- `read` mode because the PNG lands at an explicit external artifact path, not inside the source tree — it doesn't trip the write-write guard.
- The reported path is only trusted once the file's existence is verified on disk; a marker claiming success with no file on disk is `failed`.

## 4. Which adapter for which job

| Job | Adapter | mode |
|---|---|---|
| Code review, second opinion | `codex` or `agy` | `read` |
| Implement a change in the working tree | `agy` | `write` |
| Generate an image | `agy-image` | `read` |

Call `list_adapters` before dispatching to confirm the adapter's underlying CLI is actually on `PATH` (`binaryPresent`) — dispatching to an adapter whose binary is missing fails at spawn time, not at discovery time.

## 5. Tool surface

`dispatch(adapter, prompt, cwd?, mode?, timeoutMs?) → jobId`, `status(jobId)`, `result(jobId)`, `wait(jobIds, timeoutMs?)`, `list_adapters()`, `cancel(jobId)`. Full parameter and return-shape reference: the project [README](../../README.md).
