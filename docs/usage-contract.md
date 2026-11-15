# Usage & spend contract (v0.9.0)

Status: 0.8.0 implemented one gemini pool; 0.9.0 splits it into decision and vision pools (section 4).

Shared contract between the sdd server, the gemini scripts, and the usage governor
(`~/repos/usage-governor`). Every part below is a cross-repo interface: change it here first.

## 1. Usage record (pure data)

```ts
interface UsageRecord {
  model: string | null;        // model actually called, e.g. "gemini-decision-1"
  calls: number;               // billed API calls made (attempts that reached the API and returned usage)
  items: number | null;        // decide: items in the batch; vision: null
  ok: number | null;
  failed: number | null;
  inputTokens: number | null;  // null = unknown (never 0 for "unknown")
  outputTokens: number | null;
  costUsd: number | null;      // list price x tokens; null = unknown, NEVER rendered as $0
  unknownCalls?: number;       // calls priced at the flat $0.25 fail-closed charge (already inside costUsd); each such job counts as unknownCostJobs
  costIsEstimate: true;        // it is an estimate from list price, not a bill
}
```

Added to the Capability port as an OPTIONAL pure function, separate from `parseResult`:

```ts
parseUsage?(stdout: string, stderr: string): UsageRecord | null;
```

JobStore calls it on EVERY settle — done, failed, signal-killed, cancelled — inside a try (a throw = null).
It never changes the job's terminal status (signal-killed stays `failed`). This is how billed-but-killed
jobs still get counted.

## 2. Script marker

Scripts print, on its own line, the LATEST cumulative usage (may print several times; the LAST wins):

```
SDD_GEMINI_USAGE:{"model":"gemini-decision-1","calls":3,"items":3,"ok":3,"failed":0,"inputTokens":6576,"outputTokens":0,"costUsd":0.000658,"costIsEstimate":true}
```

When it is printed:
- after the run, before the final `SDD_GEMINI_SUMMARY` / result markers;
- in a SIGTERM handler (flush what was spent so far, then exit 143);
- vision: right after the API reply is received, BEFORE validating it (a MAX_TOKENS / bad-JSON reply was still billed);
- on any `die()` after at least one billed call.

The existing `SDD_GEMINI_SUMMARY:` and `SDD_GEMINI_RESULT:` / `SDD_GEMINI_VISION_SAVED:` markers stay unchanged
(back-compat: a 0.7.0 server running new scripts must still parse them).

## 3. Ledger

- Path: `${XDG_STATE_HOME:-~/.local/state}/sdd/ledger.jsonl`. Override with env `SDD_LEDGER_PATH` (tests).
- Only writer: the sdd server (`src/lib/ledger.ts`), one `appendFileSync` of ONE line per terminal job, every
  adapter, every terminal state. Never rewritten or truncated. Many servers (one per Claude session) append
  concurrently; a single short `write` with O_APPEND is the concurrency story. Readers skip torn/invalid lines.
- Never contains prompts, request contents, or env.
- Callers of that writer: the MCP server (`src/register.ts`) and, as a second caller, the `decide` command
  (`src/cli/decide.ts`, section 3a). Both go through `JobStore` with `appendLedger` as its sink, so the one-line-per-job
  rule and everything above hold for both.

### 3a. `decide` command (second caller)

For programs that are not MCP clients (for example a CLI tool such as [alsp](https://github.com/ryanthedev/agent-lsp)):

```
bun run <sdd>/src/cli/decide.ts [--timeout-ms N] [--model M] [--] <request.json> [<results.json>]
```

- Runs the gemini adapter's `default` kind through the same `JobStore` the server uses, so the budget check (section 4,
  enforced by the script), hermetic spawn, usage parsing and the single ledger line per job are the existing code. It adds
  no budget logic and changes no limits.
- Request and results formats: `assets/gemini-decide.ts` (`"dryRun": true` validates and estimates, calls nothing, and
  records a `calls: 0` line). The request must be a file path (not inline JSON); the adapter's path rules apply (no leading
  `-`, no control characters, a relative path may not escape the cwd).
- stdout: the absolute results path, on success only. stderr: diagnostics.
- Exit codes: `0` done; `1` the job failed (stderr carries the script's reason, e.g. `budget exceeded: ...`, and no API
  call is made when the budget is already spent), also on timeout and on SIGTERM/SIGINT (the job is terminated, the script
  flushes its usage marker and the ledger line is still written); `2` usage error (nothing spawned, nothing recorded).
- `--timeout-ms` (default 600000) is passed to the script as its deadline and enforced by the command, which cancels the job
  at the limit. `--model` overrides the request's model.

```jsonc
{"v":1,"ts":1794639003485,"jobId":"…","adapter":"gemini","kind":"default","cwd":"/abs",
 "state":"done","exitCode":0,"signal":null,"durationMs":1234,
 "summary":"≤160 chars; for gemini only status tokens (counts, cost, stopped=, failed_ids=N), never answers or error text","usage":{…UsageRecord…}|null,"host":"my-machine.local"}
```

## 4. Budget

- File: `~/.config/sdd/budget.json` (`$XDG_CONFIG_HOME/sdd/budget.json`). Missing = defaults.
- Default: `{"gemini": {"dailyUsd": 5, "monthlyUsd": 50, "vision": {"dailyUsd": 15, "monthlyUsd": 150}}}`.
- TWO POOLS, each with its own limits and its own spend; neither can use up the other:
  - **decision** pool = gemini ledger lines whose `kind` is anything but `"vision"` (including a missing `kind`).
    Limits: the top-level `gemini.dailyUsd` / `gemini.monthlyUsd`. Enforced by `gemini-decide.ts`.
  - **vision** pool = gemini ledger lines with `kind == "vision"` (video fusion). Limits: `gemini.vision.dailyUsd` /
    `gemini.vision.monthlyUsd`. Enforced by `gemini-vision.ts`.
  - Per-field merge over defaults in both blocks: `{"gemini":{"dailyUsd":8}}` keeps vision at $15/$150; an invalid,
    negative or non-finite value falls back to that field's default. `allowUnpricedModels` stays top-level and covers both.
- Windows: daily = rolling 24 h by ledger `ts`; monthly = calendar month in LOCAL time.
- Spend (per pool) = sum of `usage.costUsd` over that pool's ledger lines with `adapter == "gemini"`. FAIL CLOSED: a line whose cost is
  unknown (usage null, or `costUsd` null) is charged **$0.25** and counted in `unknownCostJobs`; a line whose usage
  says `calls: 0` is free. Scripts always print a usage marker (with `calls: 0` when nothing was billed) so harmless
  failures are recorded as $0. The scripts, the sdd `usage` tool and the governor all use this same rule and value.
- Models without a known price are refused unless the budget file's gemini block sets `"allowUnpricedModels": true`.
- Enforced in TWO places:
  1. The gemini scripts check it before the first API call and refuse (`exit 1`, stderr
     `gemini-…: budget exceeded: $X in 24h of $5 daily` etc.). This also covers ska/vana, which have no governor.
     Per-job cap: min(request `maxCostUsd` (default 1.00), daily remaining, monthly remaining); unknown-cost calls
     count $0.25 each toward it; it stops scheduling new items (and retries) once crossed. Residual race: N jobs that
     start before the ledger records each other can together overshoot by up to ~N x the remaining budget.
  2. The usage governor computes a `gemini` meter from the same ledger + budget file and its PreToolUse gate
     blocks gemini dispatches only. A gemini STOP must NEVER make the governor's overall `decision` STOP
     (that would block every tool in every session).

## 5. Governor state.json addition

```jsonc
"meters": { …, "gemini": {"decision":"RUN"|"STOP","reason":"…","usd_24h":0.42,"usd_month":3.1,
                           "daily_usd":5,"monthly_usd":50,"jobs_24h":12,"failed_24h":1,"unknown_cost_24h":0},
             "gemini_vision": { …same fields, vision pool, daily_usd 15, monthly_usd 150… } }
```

`meters.gemini` is the DECISION pool (unchanged field names, so older readers keep working); `meters.gemini_vision` is
the vision pool. The gate picks the meter by what is being started: an sdd `dispatch` with `adapter: "gemini"` and
`kind: "vision"`, or a Bash run of `gemini-vision.ts`, checks `gemini_vision`; any other gemini dispatch (missing kind =
default) or a Bash run of `gemini-decide.ts` checks `gemini`. Neither pool's STOP ever blocks the other, or anything else.

Missing ledger = $0, RUN. Unreadable budget/ledger = gemini meter STOP only.
