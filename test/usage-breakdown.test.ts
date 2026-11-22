/**
 * Usage breakdown: the pure `breakdownSpend` / `projectOf` aggregation over the
 * spend ledger, and the `usage` tool's `breakdown` mode that renders it.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLedger,
  breakdownSpend,
  type LedgerEntry,
  type LedgerInput,
  projectOf,
  UNKNOWN_COST_CHARGE_USD,
} from "../src/lib/ledger.ts";
import { createRuntime, type Runtime } from "../src/tools/runtime.ts";
import { createUsageTool } from "../src/tools/usage.ts";
import type { UsageRecord } from "../src/types.ts";

const tmpDirs: string[] = [];
const runtimes: Runtime[] = [];
const fresh = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sdd-breakdown-"));
  tmpDirs.push(d);
  return d;
};
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.jobStore.shutdown();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const usage = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  model: "gemini-decision-1",
  calls: 3,
  items: 3,
  ok: 3,
  failed: 0,
  inputTokens: 1000,
  outputTokens: 0,
  costUsd: 0.1,
  costIsEstimate: true,
  ...over,
});
const input = (over: Partial<LedgerInput> = {}): LedgerInput => ({
  ts: Date.now(),
  jobId: "j",
  adapter: "gemini",
  kind: "default",
  cwd: "/home/u/repos/app",
  state: "done",
  exitCode: 0,
  signal: null,
  durationMs: 5,
  summary: "ok",
  usage: usage(),
  ...over,
});
const entry = (over: Partial<LedgerInput> = {}): LedgerEntry => ({ v: 1, host: "h", ...input(over) });

const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime(); // local 15 Jun 2026 noon
const at = (day: number, hour = 12) => new Date(2026, 5, day, hour, 0, 0).getTime();
const HOME = "/home/u";

// ── projectOf ───────────────────────────────────────────────────────────────

test("projectOf folds in-repo worktrees into the repo and groups temp dirs", () => {
  expect(projectOf("/home/u/repos/omni/build/wt/n2p4", HOME)).toBe("~/repos/omni");
  expect(projectOf("/home/u/repos/omni", HOME)).toBe("~/repos/omni");
  expect(projectOf("/home/u/loops/omni/reports/x", HOME)).toBe("~/loops/omni");
  expect(projectOf("/home/u", HOME)).toBe("~");
  expect(projectOf("/home/u/", HOME + "/")).toBe("~");
  expect(projectOf("/home/user2/x/y", HOME)).toBe("/home/user2"); // a prefix match is not a home match
  expect(projectOf("/tmp", HOME)).toBe("(temp)");
  expect(projectOf("/private/tmp/claude-501/-Users-r-loops-omni/abc/scratchpad", HOME)).toBe("(temp)");
  expect(projectOf("/var/folders/xy/T/run", HOME)).toBe("(temp)");
  expect(projectOf("/tmpfoo/a", HOME)).toBe("/tmpfoo/a");
  expect(projectOf("/opt/work/repo/sub", HOME)).toBe("/opt/work");
  expect(projectOf("/", HOME)).toBe("/");
  expect(projectOf("", HOME)).toBe("(unknown)");
});

// ── breakdownSpend ──────────────────────────────────────────────────────────

test("breakdownSpend buckets by local day, includes empty days, and ignores out-of-window rows", () => {
  const b = breakdownSpend(
    [
      entry({ ts: at(8, 23), usage: usage({ costUsd: 9 }) }), // before the 7-day window (starts 9 Jun 00:00)
      entry({ ts: at(9, 0), usage: usage({ costUsd: 1 }) }), // exactly at local midnight: in
      entry({ ts: at(13), usage: usage({ costUsd: 2, items: 10, calls: 10, inputTokens: 5000 }) }),
      entry({ ts: at(13, 18), state: "failed", usage: usage({ costUsd: 0.5 }) }),
      entry({ ts: NOW + 1, usage: usage({ costUsd: 100 }) }), // future: out
      entry({ ts: at(14), adapter: "codex", usage: usage({ costUsd: 50 }) }), // other adapter: out
    ],
    { now: NOW, adapter: "gemini", days: 7, home: HOME },
  );
  expect(b.days).toBe(7);
  expect(b.since).toBe(at(9, 0));
  expect(b.byDay.map((d) => d.date)).toEqual([
    "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15",
  ]);
  expect(b.byDay[0]!.costUsd).toBe(1);
  expect(b.byDay[1]!.jobs).toBe(0);
  const d13 = b.byDay[4]!;
  expect(d13.jobs).toBe(2);
  expect(d13.failedJobs).toBe(1);
  expect(d13.items).toBe(13);
  expect(d13.calls).toBe(13);
  expect(d13.inputTokens).toBe(6000);
  expect(d13.costUsd).toBeCloseTo(2.5, 10);
  expect(b.total.jobs).toBe(3);
  expect(b.total.costUsd).toBeCloseTo(3.5, 10);
});

test("breakdownSpend charges unknown costs like the budget, treats calls:0 as free, and splits pools", () => {
  const rows = [
    entry({ usage: null, ts: at(15, 9) }), // unknown: charged
    entry({ usage: usage({ costUsd: null }), ts: at(15, 9) }), // unknown: charged
    entry({ usage: usage({ calls: 0, costUsd: null, items: 0 }), ts: at(15, 9) }), // nothing billed: free
    entry({ kind: "vision", usage: usage({ costUsd: 4, items: null }), ts: at(15, 9) }),
  ];
  const decision = breakdownSpend(rows, { now: NOW, adapter: "gemini", days: 1, pool: "decision", home: HOME });
  expect(decision.pool).toBe("decision");
  expect(decision.total.jobs).toBe(3);
  expect(decision.total.unknownCostJobs).toBe(2);
  expect(decision.total.costUsd).toBeCloseTo(2 * UNKNOWN_COST_CHARGE_USD, 10);
  const vision = breakdownSpend(rows, { now: NOW, adapter: "gemini", days: 1, pool: "vision", home: HOME });
  expect(vision.total.jobs).toBe(1);
  expect(vision.total.items).toBe(0); // vision has no batch size
  expect(vision.total.costUsd).toBe(4);
  const all = breakdownSpend(rows, { now: NOW, adapter: "gemini", days: 1, home: HOME });
  expect(all.pool).toBeUndefined();
  expect(all.total.jobs).toBe(4);
});

test("breakdownSpend groups projects, most expensive first, and clamps days", () => {
  const b = breakdownSpend(
    [
      entry({ cwd: "/home/u/repos/omni/build/wt/a", usage: usage({ costUsd: 0.2 }), ts: at(15, 9) }),
      entry({ cwd: "/home/u/repos/omni/build/wt/b", usage: usage({ costUsd: 0.3 }), ts: at(15, 9) }),
      entry({ cwd: "/tmp", usage: usage({ costUsd: 0.1 }), ts: at(15, 9) }),
      entry({ cwd: "/home/u/loops/x", usage: usage({ costUsd: 1 }), ts: at(15, 9) }),
    ],
    { now: NOW, adapter: "gemini", days: 0, home: HOME },
  );
  expect(b.days).toBe(1);
  expect(b.byProject.map((p) => [p.project, p.jobs])).toEqual([
    ["~/loops/x", 1],
    ["~/repos/omni", 2],
    ["(temp)", 1],
  ]);
  expect(b.byProject[1]!.costUsd).toBeCloseTo(0.5, 10);
  expect(breakdownSpend([], { now: NOW, adapter: "gemini", days: 1000 }).days).toBe(90);
});

// ── usage tool ──────────────────────────────────────────────────────────────

const PLAIN = (name: string): string => `
export const name = ${JSON.stringify(name)};
export function buildArgs() { return ["true"]; }
export function injectContract(p) { return p; }
export function parseResult() { return { status: "done", summary: "", artifacts: [], raw: "" }; }
`;

function toolFor(ledger: string) {
  const dir = fresh();
  writeFileSync(join(dir, "gemini.ts"), PLAIN("gemini"));
  writeFileSync(join(dir, "codex.ts"), PLAIN("codex"));
  const rt = createRuntime({ adaptersDir: dir, ledgerPath: ledger, budgetPath: join(fresh(), "nobudget.json") });
  runtimes.push(rt);
  return createUsageTool(rt);
}

test("usage({breakdown}) renders the decision pool by day and project, and omits an unused vision pool", async () => {
  const ledger = join(fresh(), "l.jsonl");
  const now = Date.now();
  appendLedger(input({ ts: now - 1000, usage: usage({ costUsd: 0.25, items: 26, calls: 26, inputTokens: 2_300_000 }) }), ledger);
  appendLedger(input({ ts: now - 2000, cwd: "/tmp", state: "failed", usage: null }), ledger);
  const tool = toolFor(ledger);

  const r = await tool.handler({ breakdown: true, days: 3 });
  expect(r.isError).toBeUndefined();
  const text = r.content[0]!.text;
  expect(text).toContain("gemini decision usage, last 3 days (local dates): 2 jobs (1 failed) · 26 items · 26 calls · 2.3M in-tok · $0.50 · 1 unknown-cost");
  expect(text).toContain("each unknown-cost job is charged $0.25");
  expect(text).toContain("by day:");
  expect(text).toContain("(temp)");
  expect(text).not.toContain("vision usage");
  expect(text).not.toContain("codex"); // codex records no per-call usage
  const bs = r.structuredContent!.breakdowns as { pool: string; byDay: unknown[]; total: { jobs: number } }[];
  expect(bs).toHaveLength(1);
  expect(bs[0]!.pool).toBe("decision");
  expect(bs[0]!.byDay).toHaveLength(3);
});

test("usage({breakdown}) shows the vision pool once it has jobs", async () => {
  const ledger = join(fresh(), "l.jsonl");
  appendLedger(input({ kind: "vision", usage: usage({ costUsd: 0.01, items: null }) }), ledger);
  const r = await toolFor(ledger).handler({ breakdown: true, adapter: "gemini" });
  const text = r.content[0]!.text;
  expect(text).toContain("gemini decision usage, last 7 days");
  expect(text).toContain("gemini vision usage, last 7 days (local dates): 1 jobs");
});

test("usage rejects breakdown with recent, days without breakdown, an unknown adapter and an unreadable ledger", async () => {
  const ledger = join(fresh(), "l.jsonl");
  const tool = toolFor(ledger);
  expect((await tool.handler({ breakdown: true, recent: 5 })).isError).toBe(true);
  expect((await tool.handler({ days: 5 })).isError).toBe(true);
  expect((await tool.handler({ breakdown: true, adapter: "nope" })).isError).toBe(true);
  const unreadable = toolFor(fresh()); // a directory is not a readable ledger file
  const r = await unreadable.handler({ breakdown: true });
  expect(r.isError).toBe(true);
  expect(r.content[0]!.text).toContain("not $0");
});
