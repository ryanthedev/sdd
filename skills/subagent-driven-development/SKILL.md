---
name: subagent-driven-development
description: >-
  Orchestration doctrine for delegating scoped work units to CLI agent
  harnesses (codex, agy) through the sdd MCP server's seven tools (dispatch,
  status, result, wait, list_adapters, cancel, check_adapter). Documents which
  adapter fits which job, the fan-out-reads/serialize-writes concurrency rule,
  the poll-by-default wait policy, each harness's parsing gotchas, and how to
  health-check a harness's auth/liveness before relying on it. Use when
  delegating a scoped task to a CLI subagent harness, getting a second
  opinion or independent review, generating an image, fanning out parallel
  read-mode jobs, deciding whether to poll or block on a dispatched job, or
  checking whether a harness is installed and logged in.
  Not for: in-process Agent-tool subagents (use oberskills:agent) or writing
  new MCP tools or adapters (runtime code, out of scope here).
when_to_use: >-
  Trigger phrases: "get a second opinion", "review this with codex", "review
  this with agy", "generate an image", "delegate this to a subagent",
  "dispatch this to codex/agy", "fan this out", "run these reviews in
  parallel", "is codex working", "is the harness logged in", "check an
  adapter", "health-check an adapter". Use before calling any sdd MCP tool.
---

# Subagent-driven development

The `sdd` MCP server delegates a scoped, fresh-context work unit (review, second opinion, implementation, image generation) to a CLI harness — `codex` or `agy` — that runs as a child process in the current working tree. Seven tools: `dispatch`, `status`, `result`, `wait`, `list_adapters`, `cancel`, `check_adapter`. Claude stays the brain and owns the diff; the harness does one bounded task and reports back.

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

**Roster (effort levels):**
- `codex` — default, `medium` reasoning effort. Balanced for most reviews and second opinions.
- `codex-high` — default model, `high` reasoning effort. Deep analysis, complex codebases, subtle correctness issues, security-sensitive code.
- `codex-low` — default model, `low` reasoning effort. Fast spot-checks, lightweight reads, edge cases on known patterns.

**Per-call model and effort selection:**
- Use the base `codex` adapter with `dispatch(adapter:"codex", model:"<name>", effort:"low|medium|high", ...)` to select model and effort at call time.
- Example: `dispatch(adapter:"codex", model:"o3", effort:"high", prompt, cwd)` runs o3 with high reasoning effort.
- Per-call `model` and `effort` are **allowlisted** — NOT arbitrary `-c key=value` config. Arbitrary config could override `--sandbox` (e.g. `-c sandbox_mode=danger-full-access`), subverting the sandbox barricade; allowlist is the backstop.
- Pinned variants (`codex-high`, `codex-low`) ignore per-call `model`/`effort` (config is fixed at construction). To choose at call time, use the base `codex` adapter instead.

**Extending the roster with new models:**
- Add a model-specific variant anytime by dropping `${CLAUDE_PLUGIN_ROOT}/src/adapters/codex-<name>.ts` that calls `makeCodexVariant` from `${CLAUDE_PLUGIN_ROOT}/src/adapters/_codex-factory.ts`. No core plugin change needed — discovery auto-registers it on the next dispatch.
- The factory accepts `{name, model?, profile?, configOverrides?, mode?}` and returns an object of the port members; re-export them as **named** exports (discovery validates named exports, not a default). Mirror `codex-high.ts`:
  ```ts
  import { makeCodexVariant } from "./_codex-factory.ts";
  const variant = makeCodexVariant({ name: "codex-o3", model: "o3", configOverrides: { model_reasoning_effort: "high" } });
  export const name = variant.name;
  export const mode = variant.mode;
  export const binary = variant.binary;
  export const buildArgs = variant.buildArgs;
  export const injectContract = variant.injectContract;
  export const parseResult = variant.parseResult;
  ```
- `injectContract`/`parseResult` come straight from the base codex (single source of the output contract) — never re-implemented.

**Output contract & gotchas:**
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
- **Never Read the PNG back into context.** The adapter already `existsSync`-checked the file before reporting `done` — at most run `ls -l <path>` to confirm a non-trivial size (existence alone passes a zero-byte file), then report the path and stop. Loading pixels burns vision tokens on a "verification" the contract already performed. Read the image only when the user explicitly asks to see it or wants a critique.
- **Grill before you generate.** A vague request ("make me an image") wastes a whole generation round-trip on a guess. Ask 2–4 batched questions — subject & action, style/medium, composition/lighting/mood, aspect ratio & any in-image text — in one message, each with example answers. Skip the interview entirely when the request already carries subject + style + one of composition/lighting/mood, when the user says "just do it" / "surprise me", or when iterating on a prior image (change only what they asked). Fill unanswered slots with a sensible default silently; don't re-ask.
- **Write the prompt as a narrative scene, not keyword tags.** Nano Banana is built on Gemini's language understanding — a descriptive paragraph beats a Midjourney-style comma list (Google's own guidance: "describe the scene, don't just list keywords"). Anatomy: `[style/medium] [shot type] of [subject] [action], set in [setting], illuminated by [lighting], creating [mood]; [camera/lens for photos]; text "[quoted]" in [font style]; [aspect ratio] format.` Frame exclusions positively ("empty street", never "no cars"). Put any in-image text in quotes. State the aspect ratio in the prompt — it's prompt-driven (1:1, 16:9, 9:16, 4:3, 21:9, …).

## 4. Which adapter for which job

| Job | Adapter | mode |
|---|---|---|
| Code review, second opinion | `codex` or the read-review roster (`grok`, `kimi`, `qwen`, `mistral`) | `read` |
| Ensemble review (multi-model, parallel) | fan out `codex` + `grok`/`kimi`/`qwen`/`mistral` | `read` |
| Implement a change in the working tree | `agy` | `write` |
| Generate an image | `agy-image` | `read` |

The read-review roster (`codex`, `grok`, `kimi`, `qwen`, `mistral`) are interchangeable read-mode second-opinion harnesses sharing one output contract (`VERDICT:` + `## Findings`) — fan them out in parallel for an ensemble review. Full per-harness capability + auth detail: [`references/harnesses.md`](references/harnesses.md).

Call `list_adapters` before dispatching to confirm the adapter's underlying CLI is actually on `PATH` (`binaryPresent`) — dispatching to an adapter whose binary is missing fails at spawn time, not at discovery time.

### Presence ≠ usable: check before you rely

`list_adapters`' `binaryPresent` is a `PATH` check only — it cannot see login or subscription state, so an installed-but-unauthenticated harness looks identical to a working one until dispatch fails. Before relying on a harness you have **not** already exercised this session, call `check_adapter(name)`. It runs a minimal live probe through the normal dispatch path and returns one of `ok | failed | timeout | present_unverified | missing`:

- `ok` — installed **and** authenticated; the reliable green light.
- `failed` — installed but the probe failed; `detail` carries the CLI's own auth/quota/subscription error text.
- `timeout` — inconclusive (slow model, network, or hang); the probe job is cancelled — retry with a larger `timeoutMs`.
- `present_unverified` — the adapter opts out of automatic probing. Only `agy-image` (`probeable: false`, because a probe would bill a real generation) — confirm it by dispatching a real job.
- `missing` — binary not on `PATH`; not installed.

Full per-harness capability + auth table: [`references/harnesses.md`](references/harnesses.md).

## 5. Tool surface

`dispatch(adapter, prompt, cwd?, mode?, timeoutMs?) → jobId`, `status(jobId)`, `result(jobId)`, `wait(jobIds, timeoutMs?)`, `list_adapters()`, `cancel(jobId)`, `check_adapter(adapter, timeoutMs?, cwd?)`. Seven tools total. Full parameter and return-shape reference: the project [README](../../README.md).
