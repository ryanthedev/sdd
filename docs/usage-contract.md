# Usage & spend contract (v0.8.0)

Status: implemented in sdd 0.8.0 and usage-governor (gemini meter).

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

```jsonc
{"v":1,"ts":1794639003485,"jobId":"…","adapter":"gemini","kind":"default","cwd":"/abs",
 "state":"done","exitCode":0,"signal":null,"durationMs":1234,
 "summary":"≤300 chars of result.summary","usage":{…UsageRecord…}|null,"host":"Ryans-Mac-Studio.local"}
```

## 4. Budget

- File: `~/.config/sdd/budget.json` (`$XDG_CONFIG_HOME/sdd/budget.json`). Missing = defaults.
- Default: `{"gemini": {"dailyUsd": 5, "monthlyUsd": 50}}`.
- Windows: daily = rolling 24 h by ledger `ts`; monthly = calendar month in LOCAL time.
- Spend = sum of `usage.costUsd` over ledger lines with `adapter == "gemini"`. FAIL CLOSED: a line whose cost is
  unknown (usage null, or `costUsd` null) is charged **$0.25** and counted in `unknownCostJobs`; a line whose usage
  says `calls: 0` is free. Scripts always print a usage marker (with `calls: 0` when nothing was billed) so harmless
  failures are recorded as $0. The scripts, the sdd `usage` tool and the governor all use this same rule and value.
- Models without a known price are refused unless the budget file's gemini block sets `"allowUnpricedModels": true`.
- Enforced in TWO places:
  1. The gemini scripts check it before the first API call and refuse (`exit 1`, stderr
     `gemini-…: budget exceeded: $X in 24h of $5 daily` etc.). This also covers ska/vana, which have no governor.
     Per-job cap: request field `maxCostUsd` (default 1.00) stops scheduling new items once crossed.
  2. The usage governor computes a `gemini` meter from the same ledger + budget file and its PreToolUse gate
     blocks gemini dispatches only. A gemini STOP must NEVER make the governor's overall `decision` STOP
     (that would block every tool in every session).

## 5. Governor state.json addition

```jsonc
"meters": { …, "gemini": {"decision":"RUN"|"STOP","reason":"…","usd_24h":0.42,"usd_month":3.1,
                           "daily_usd":5,"monthly_usd":50,"jobs_24h":12,"failed_24h":1,"unknown_cost_24h":0} }
```

Missing ledger = $0, RUN. Unreadable budget/ledger = gemini meter STOP only.
