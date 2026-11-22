---
name: subagent-driven-development
description: >-
  Orchestration doctrine for delegating scoped work units to CLI agent
  harnesses (codex, agy, grok, kimi, qwen, mistral) and the Gemini decision
  model through the sdd MCP server's eight tools (dispatch, status, result,
  wait, list_adapters, cancel, check_adapter, usage). Covers which adapter fits
  which job, the caller-owned concurrency rule, poll-vs-block waits, harness
  gotchas, auth health checks, and four recipes: quota-first routing, parallel
  writers in git worktrees, a five-vendor ensemble review ranked by agreement,
  and repo-scale targeting with the decision model. Use when delegating a task to a CLI
  harness, getting a second opinion or ensemble review, generating an image,
  fanning out or racing implementations, ranking or classifying a batch with
  the Gemini decision model (text or media), or checking
  a harness's quota or login.
  Not for: in-process Agent-tool subagents (use oberskills:agent), running a
  whole task as a multi-agent operation (use commander), or writing new MCP
  tools or adapters.
when_to_use: >-
  Trigger phrases: "get a second opinion", "review this with codex/agy", "have
  all the models review this", "ensemble review", "generate an image",
  "delegate this to a subagent", "fan this out", "have codex and agy both try
  it", "run these in parallel", "rank these with the decision model", "rank these with gemini", "classify these with gemini", "ask gemini about this video", "audit this whole repo",
  "how much codex quota is left", "is the harness logged in". Use before
  calling any sdd MCP tool.
---

# Subagent-driven development

The `sdd` MCP server delegates a scoped, fresh-context work unit (review, second opinion, implementation, image generation) to a CLI harness — `claude`, `codex`, `agy`, or one of their siblings — that runs as a child process in the current working tree. Nine tools: `dispatch`, `status`, `result`, `wait`, `list_adapters`, `list_models`, `cancel`, `check_adapter`, `usage`. Claude stays the brain and owns the diff; the harness does one bounded task and reports back.

## The honest value proposition

Async by itself isn't the differentiator — Bash can already background a process and poll it. What this MCP actually buys over hand-rolled Bash:

- **Structured, validated results.** Each adapter's `parseResult` extracts and validates an output-contract marker before calling a job `done`. A harness that exits 0 but never did the work (a misparsed flag, a silently-swallowed prompt) is caught and reported `failed` — a raw `bash &` + grep of stdout has no equivalent backstop.
- **Live job-state as a tool surface.** `status`/`result`/`wait`/`list_adapters` are typed, queryable tools instead of a one-off shell script you reinvent per task.

Don't oversell it as "async that Bash can't do" — that claim doesn't survive scrutiny and undermines trust in the rest of the doctrine.

## 1. Concurrency is YOUR job — the server serializes nothing

`dispatch` returns a `jobId` immediately; it never blocks, and it **never refuses a job for concurrency reasons**. Every dispatch runs, right now, in parallel with everything else already running. There is no write-write guard, no read-during-write interlock, no mode: the server does not model which jobs read the tree and which write it. **You do.**

By default every agent harness runs permissively (so it can edit the tree you hand it). For reviews and read-only analysis, pass `readOnly: true` on `dispatch` — `claude` (`--permission-mode plan`), `codex` (`--sandbox read-only`), `agy` (`--sandbox --mode plan`), `grok` (`--permission-mode plan`), and `mistral` (`--agent plan`) enforce read-only natively; `kimi` and `qwen` reject `readOnly: true` loudly rather than silently running permissively.

What follows is orchestration discipline you must apply yourself — advice, not a guarantee:

- **Fan out jobs that can't collide.** Reviews and second opinions against the same tree, image generation to an out-of-tree path, independent reads — dispatch several in the same turn, then `wait` on the batch. This is still the big win.
- **Serialize jobs that write the same tree.** Sequence them deliberately: `dispatch(implement) → wait → dispatch(review)`. Never two implementation harnesses in one `cwd` at once.
- **The failure mode is real and silent.** Dispatch two harnesses into the same tree and they both run: interleaved edits, one clobbering the other's file, a review reading a half-written tree. Nothing errors. Nothing warns. You get a corrupted diff and a confident summary.
- **When in doubt, give them separate trees.** Distinct `cwd`s (a worktree, a temp clone) make the collision structurally impossible instead of merely avoided. To run writers in parallel on purpose, including a bake-off where two harnesses attempt the same change, follow [recipe 2](references/recipes.md#2-parallel-writers-in-worktrees).

## 2. Poll-by-default wait

`wait(jobIds, timeoutMs?)` defaults to a short poll (~30s) and returns `{done, stillRunning, unknown}` — never partial results mistaken for complete ones.

- Pass a larger `timeoutMs` (clamped at a 10-minute cap) when you'd rather block once than repoll — useful for a lone long-running implementation job with nothing else to do meanwhile.
- The long block is safe under Claude Code's own ~28h `MCP_TOOL_TIMEOUT` default; other MCP clients with a shorter tool timeout should stay on the short poll (or raise their client's timeout) rather than risk a client-side cutoff mid-wait.
- Prefer the short poll in a loop when other tool calls are worth making in between; reach for the long block only when polling adds nothing.

## 3. Per-harness gotchas

### codex — review / second opinion

**One adapter, chosen per call.** There is no `codex-high`/`codex-low`/`codex-sol` roster to remember — those pinned variants were removed because `model` and `effort` on the dispatch call reach codex directly (verified against the CLI: an unknown `-c` key is rejected by name under `--strict-config`, so the effort override is genuinely applied, not silently swallowed).

| Want | Call |
|---|---|
| Balanced review / second opinion | `dispatch(adapter:"codex", readOnly:true, prompt, cwd)` — default model (`gpt-6.2-sol`), `medium` effort |
| Deep analysis, subtle correctness, security-sensitive code | add `effort:"high"` or `effort:"xhigh"` (up to `"max"` / `"ultra"`) |
| Fast/cheap spot-check | add `effort:"low"` (optionally `serviceTier:"priority"` or `"fast"`) |
| Hard coding on the flagship tier | add `model:"gpt-6.2-astra", effort:"xhigh"` (call `list_models("codex")` for the live catalog) |

**Per-call model, effort, readOnly, and serviceTier selection:**
- Call `list_models` to inspect live model IDs, default efforts, supported effort levels, and service tiers without guessing.
- Use `dispatch(adapter:"codex", model:"<name>", effort:"low|medium|high|xhigh|max|ultra", serviceTier?:"fast|flex|priority", readOnly?:true, ...)`.
- Per-call `model`, `effort`, and `serviceTier` are **allowlisted** — NOT arbitrary `-c key=value` config. `readOnly:true` switches codex to `--sandbox read-only`; otherwise it runs `--sandbox workspace-write`. `danger-full-access` is structurally unreachable.

**Checking quota before you spend it:**
- `usage(adapter:"codex")` reports the plan tier, each metered window's percent used, when it resets, and credit state. It reads codex's own account endpoint over the app-server protocol — **no model call, no tokens, no work unit** — so it is cheap to call before a fan-out.
- `check_adapter("codex")` now includes the same block, read *before* its live probe: when the probe fails, you see whether quota is the reason instead of guessing between "not logged in" and "out of quota".
- Snapshots are cached ~60s so a fan-out doesn't spawn one app-server per job; pass `refresh:true` when you need certainty.

**Output contract & gotchas:**
- stdout carries the final answer; stderr carries progress. `summary`/`raw` are built from stdout only — never treat stderr text as the result.
- Output contract: a `VERDICT:` line plus a `## Findings` section. Missing either, or a non-zero exit, is `failed` regardless of what else is in stdout.
- codex does its own web verification when a review needs it — no extra step required from the caller.

### claude — review / implement
- Invokes `claude -p <prompt>` with `--no-session-persistence` (never clutters `/resume`).
- Supports `model` (aliases `opus`, `sonnet`, `fable`, `haiku`, or any full model ID), `effort` (`low|medium|high|xhigh|max`, validated in the adapter because the CLI silently ignores unknown values), `addDir`, and `readOnly:true` (`--permission-mode plan` instead of `--dangerously-skip-permissions`).
- Shares the `VERDICT:` + `## Findings` output contract, so it plugs straight into ensemble reviews alongside `codex`, `grok`, `kimi`, `qwen`, and `mistral`.

### agy — review / implement
- **Flag order:** all flags go before `--print`; the prompt is the single argv element immediately after it. The adapter enforces this structurally, and you should keep the order if you ever construct an agy call outside this MCP.
- `opts.effort` reaches agy as `--effort low|medium|high|xhigh|max` (verified against agy 1.5.14; `ultra` is rejected loudly). Call `list_models("agy")` for the live model roster.
- `opts.readOnly: true` runs agy with `--sandbox --mode plan` (no `--dangerously-skip-permissions`), structurally preventing writes. Without `readOnly: true`, agy runs with `--dangerously-skip-permissions` and may edit the tree.
- Output contract: the last line of output must be exactly `AGY_RESULT: DONE` or `AGY_RESULT: FAILED`. Parsing takes the **last** matching line, not the first — a harness that echoes the instruction back before its real verdict would otherwise fool a first-match parse.

### image generation — `kind: "image"` on agy or codex
- Always pass an absolute `outputPath` (or one that resolves inside the job cwd) ending in `.png`. A bare relative filename risks the harness searching broadly for a match instead of writing where you meant.
- The PNG lands at an explicit external artifact path, not inside the source tree — so it doesn't collide with a job working in the tree.
- The reported path is only trusted once the file's existence is verified on disk; a marker claiming success with no file on disk is `failed`.
- **Never Read the PNG back into context.** The adapter already `existsSync`-checked the file before reporting `done` — at most run `ls -l <path>` to confirm a non-trivial size (existence alone passes a zero-byte file), then report the path and stop. Loading pixels burns vision tokens on a "verification" the contract already performed. Read the image only when the user explicitly asks to see it or wants a critique.
- **Grill before you generate.** A vague request ("make me an image") wastes a whole generation round-trip on a guess. Ask 2–4 batched questions — subject & action, style/medium, composition/lighting/mood, aspect ratio & any in-image text — in one message, each with example answers. Skip the interview entirely when the request already carries subject + style + one of composition/lighting/mood, when the user says "just do it" / "surprise me", or when iterating on a prior image (change only what they asked). Fill unanswered slots with a sensible default silently; don't re-ask.
- **Write the prompt as a narrative scene, not keyword tags.** Nano Banana is built on Gemini's language understanding — a descriptive paragraph beats a Midjourney-style comma list (Google's own guidance: "describe the scene, don't just list keywords"). Anatomy: `[style/medium] [shot type] of [subject] [action], set in [setting], illuminated by [lighting], creating [mood]; [camera/lens for photos]; text "[quoted]" in [font style]; [aspect ratio] format.` Frame exclusions positively ("empty street", never "no cars"). Put any in-image text in quotes. State the aspect ratio in the prompt — it's prompt-driven (1:1, 16:9, 9:16, 4:3, 21:9, …).

## Ready-made codex subagents

For the common cases there are two plugin subagents that run the codex procedure for you (quota gate, baseline, dispatch, independent verification): `sdd:codex-builder` for scoped implementation (flags out-of-scope edits, runs tests itself, leaves the diff uncommitted) and `sdd:codex-reviewer` for a second-opinion review (verifies each finding, labels it CONFIRMED / UNCONFIRMED, confirms the tree is unchanged). Prefer them over hand-rolling the same dispatch sequence. Definitions: `agents/codex-builder.md`, `agents/codex-reviewer.md`.

## 4. Which adapter for which job

| Job | Adapter |
|---|---|
| Code review, second opinion | `claude`, `codex`, or the review roster (`grok`, `kimi`, `qwen`, `mistral`); pass `readOnly:true` on harnesses that support it |
| Deep review — subtle correctness, security-sensitive code | `codex` with `effort:"high"`/`"xhigh"`/`"max"` (add `model:"gpt-6.2-astra"` for flagship) or `claude` with `model:"opus", effort:"high"` |
| Fast/cheap spot-check | `codex` with `effort:"low"` (optionally `serviceTier:"priority"`) |
| What models & effort levels exist right now? | `list_models` — live catalog, no tokens, no work unit |
| Am I about to hit a quota wall? | `usage` — no tokens, no work unit |
| How much is the decision model being used, and by which project? | `usage({breakdown:true, days:N})` — per-day and per-project jobs, items, tokens, dollars |
| Ensemble review (multi-model, parallel) | fan out `claude` + `codex` + `grok`/`kimi`/`qwen`/`mistral`, then rank with [recipe 3](references/recipes.md#3-ensemble-review-ranked) |
| Implement a change in the working tree | `claude`, `agy`, or `codex` |
| Generate an image | `agy`, `codex`, or `grok` with `kind: "image"` + `outputPath` |
| Fuse a transcript + keyframes into one understanding JSON | `agy` with `kind: "vision"`; `gemini` with `kind: "vision"` (same opts) when agy is out of quota or down |
| Ingest a video from a URL | the `video-ingest` skill (`yt-dlp` → `whisper` ∥ `ffmpeg-frames` → agy `kind:"vision"`) |
| Rank, route, or classify a batch at volume — text **or media** (which files to audit, which videos match a brief, which images show damage) | `gemini` (default kind) with a request file + `outputPath`: the Decisions API, $0.10 per million input tokens, reads images/video/audio/PDF. Never writes or edits. Legacy `state` / `boolean` request fields are accepted |

The review roster (`codex`, `grok`, `kimi`, `qwen`, `mistral`) are interchangeable second-opinion harnesses sharing one output contract (`VERDICT:` + `## Findings`) — fan them out in parallel for an ensemble review. They are *scoped* to reviewing by their prompt, not sandboxed to it: each still runs permissively and could touch the tree, so don't overlap them with an implementation job in the same `cwd`. Full per-harness capability + auth detail: [`references/harnesses.md`](references/harnesses.md).

The video-pipeline adapters (`yt-dlp`, `whisper`, `ffmpeg-frames`, `shazam`) wrap real CLIs, not instructable agents — their "prompt" *is* the URL or file path. Don't hand-sequence them from here; the [`video-ingest`](../video-ingest/SKILL.md) skill owns that pipeline, its preflight gate, and its per-platform auth.

Call `list_adapters` before dispatching to confirm the adapter's underlying CLI is actually on `PATH` (`binaryPresent`) — dispatching to an adapter whose binary is missing fails at spawn time, not at discovery time.

### Presence ≠ usable: check before you rely

`list_adapters`' `binaryPresent` is a `PATH` check only — it cannot see login or subscription state, so an installed-but-unauthenticated harness looks identical to a working one until dispatch fails. Before relying on a harness you have **not** already exercised this session, call `check_adapter(name)`. It runs a minimal live probe through the normal dispatch path — in a fresh throwaway temp dir when you name no `cwd`, so a permissive harness can't scribble on your working tree while being health-checked — and returns one of `ok | failed | timeout | present_unverified | missing`:

- `ok` — installed **and** authenticated; the reliable green light.
- `failed` — installed but the probe failed; `detail` carries the CLI's own auth/quota/subscription error text.
- `timeout` — inconclusive (slow model, network, or hang); the probe job is cancelled — retry with a larger `timeoutMs`.
- `present_unverified` — the adapter opts out of automatic probing (`probeable: false`): `yt-dlp`, `whisper`, `ffmpeg-frames`, `shazam`, because a probe would bill a real generation, hit the network, or run a slow transcode — and a generic health-check prompt can't supply the `outputPath`/`outputDir`/`addDir` they require. Confirm these by dispatching a real job. Every agent harness is probeable and gets the real liveness+auth probe.
- `missing` — binary not on `PATH`; not installed.

Full per-harness capability + auth table: [`references/harnesses.md`](references/harnesses.md).

## 5. Tool surface

`dispatch(adapter, prompt, cwd?, timeoutMs?, model?, effort?, readOnly?, serviceTier?, addDir?, ...) → jobId`, `status(jobId)`, `result(jobId)`, `wait(jobIds, timeoutMs?)`, `list_adapters()`, `list_models(adapter?, refresh?)`, `cancel(jobId)`, `check_adapter(adapter, timeoutMs?, cwd?)`, `usage(adapter?, refresh?)`. Nine tools total. Full parameter and return-shape reference: the project [README](../../README.md).

## 6. Recipes: running it at full strength

[`references/recipes.md`](references/recipes.md) turns the tools into four bigger moves. Read the recipe before running it; each one says what was measured and what is still a bet.

| Recipe | One line |
|---|---|
| **Quota-first routing** | Call `usage("codex")` before a fan-out; spend prepaid quota that resets anyway before metered keys |
| **Parallel writers in worktrees** | One `git worktree` per writer, so implementations run in parallel or race each other; Claude reviews and merges |
| **Ensemble review, ranked** | Five vendors, one fixed finding format, findings clustered and ranked by agreement, then reviewer severity, then (as an experiment) the decision model |
| **Repo-scale targeting** | `gemini` ranks every routine by likely defect (unmeasured); reviewers read the top 20–30%. Never for pruning a PR review |

Two decision-model rules hold everywhere: **rank by its probabilities, never threshold them** (calibration is unmeasured), and **never use it to judge whether a finding is true** (untested; the reviewer's own severity and agreement outrank it).
