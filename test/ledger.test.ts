/**
 * Ledger, spend windows, usage-marker parsing, JobStore usage capture, and the
 * usage / wait tools' spend + results output. Every ledger path is a temp file
 * or an injected sink: nothing here touches the real ~/.local/state.
 */
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUsageMarker } from "../src/adapters/_usage-marker.ts";
import { discoverAdapters } from "../src/adapters/discover.ts";
import type { WorkUnit } from "../src/adapters/types.ts";
import { JobStore } from "../src/lib/jobs.ts";
import {
  appendLedger,
  type LedgerEntry,
  type LedgerInput,
  loadBudget,
  readLedger,
  summarizeSpend,
} from "../src/lib/ledger.ts";
import { createRuntime } from "../src/tools/runtime.ts";
import { createUsageTool } from "../src/tools/usage.ts";
import { createWaitTool } from "../src/tools/wait.ts";
import type { UsageRecord } from "../src/types.ts";

const BUN = process.execPath;
const tmpDirs: string[] = [];
const stores: JobStore[] = [];
const fresh = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sdd-ledger-"));
  tmpDirs.push(d);
  return d;
};
afterEach(async () => {
  for (const s of stores.splice(0)) await s.shutdown();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const usage = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  model: "gemini-decision-1",
  calls: 1,
  items: null,
  ok: null,
  failed: null,
  inputTokens: 100,
  outputTokens: 10,
  costUsd: 0.5,
  costIsEstimate: true,
  ...over,
});

const input = (over: Partial<LedgerInput> = {}): LedgerInput => ({
  ts: Date.now(),
  jobId: "j1",
  adapter: "gemini",
  kind: "default",
  cwd: "/x",
  state: "done",
  exitCode: 0,
  signal: null,
  durationMs: 5,
  summary: "ok",
  usage: usage(),
  ...over,
});

const entry = (over: Partial<LedgerInput> = {}): LedgerEntry => ({ v: 1, host: "h", ...input(over) });

// ── ledger ──────────────────────────────────────────────────────────────────

test("appendLedger writes one line, truncates summary, stamps v and host; readLedger round-trips", () => {
  const path = join(fresh(), "deep", "dir", "ledger.jsonl"); // mkdir -p
  appendLedger(input({ summary: "x".repeat(1000) }), path);
  appendLedger(input({ jobId: "j2" }), path);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  expect(lines.length).toBe(2);
  const first = JSON.parse(lines[0]!);
  expect(first.v).toBe(1);
  expect(first.summary.length).toBe(300);
  expect(typeof first.host).toBe("string");
  expect(readLedger({ path }).map((e) => e.jobId)).toEqual(["j1", "j2"]);
});

test("appendLedger honours SDD_LEDGER_PATH and never throws on an unwritable path", () => {
  const dir = fresh();
  const prev = process.env.SDD_LEDGER_PATH;
  try {
    process.env.SDD_LEDGER_PATH = join(dir, "env.jsonl");
    appendLedger(input());
    expect(existsSync(join(dir, "env.jsonl"))).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.SDD_LEDGER_PATH;
    else process.env.SDD_LEDGER_PATH = prev;
  }
  writeFileSync(join(dir, "file"), "");
  expect(() => appendLedger(input(), join(dir, "file", "sub", "l.jsonl"))).not.toThrow(); // parent is a file
});

test("readLedger tolerates torn and invalid lines and a missing file", () => {
  const path = join(fresh(), "l.jsonl");
  expect(readLedger({ path })).toEqual([]);
  appendLedger(input({ jobId: "good1" }), path);
  appendFileSync(path, '{"v":1,"ts":12,"adapter":"gem\n'); // torn
  appendFileSync(path, "not json\n[1,2]\n{}\n");
  appendLedger(input({ jobId: "good2" }), path);
  expect(readLedger({ path }).map((e) => e.jobId)).toEqual(["good1", "good2"]);
});

// ── spend windows ───────────────────────────────────────────────────────────

const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime(); // local 15 Jun 2026 noon
const H = 3_600_000;

test("summarizeSpend: rolling 24h boundary is exclusive at exactly 24h", () => {
  const s = summarizeSpend(
    [
      entry({ ts: NOW - 24 * H, usage: usage({ costUsd: 1 }) }), // exactly 24h old: out
      entry({ ts: NOW - 24 * H + 1, usage: usage({ costUsd: 2 }) }), // in
      entry({ ts: NOW - 1, usage: usage({ costUsd: 4 }), state: "failed" }),
    ],
    { now: NOW, adapter: "gemini" },
  );
  expect(s.last24h.costUsd).toBe(6);
  expect(s.last24h.jobs).toBe(2);
  expect(s.last24h.failedJobs).toBe(1);
  expect(s.month.costUsd).toBe(7);
  expect(s.month.jobs).toBe(3);
});

test("summarizeSpend: calendar month uses LOCAL month start", () => {
  const monthStart = new Date(2026, 5, 1, 0, 0, 0, 0).getTime();
  const s = summarizeSpend(
    [
      entry({ ts: monthStart - 1, usage: usage({ costUsd: 10 }) }), // last month
      entry({ ts: monthStart, usage: usage({ costUsd: 3 }) }),
    ],
    { now: NOW, adapter: "gemini" },
  );
  expect(s.month.costUsd).toBe(3);
  expect(s.month.jobs).toBe(1);
  expect(s.last24h.jobs).toBe(0); // 14 days old
});

test("summarizeSpend: unknown cost is counted as unknown, never as $0; other adapters ignored; tokens/calls summed", () => {
  const s = summarizeSpend(
    [
      entry({ ts: NOW - H, usage: usage({ costUsd: 0.25, calls: 2, inputTokens: 10, outputTokens: 1 }) }),
      entry({ ts: NOW - H, usage: usage({ costUsd: null, inputTokens: null }) }),
      entry({ ts: NOW - H, usage: null, state: "failed" }), // killed before any marker
      entry({ ts: NOW - H, adapter: "codex", usage: null }),
    ],
    { now: NOW, adapter: "gemini", budget: { gemini: { dailyUsd: 5 } } },
  );
  expect(s.last24h.costUsd).toBe(0.25);
  expect(s.last24h.jobs).toBe(3);
  expect(s.last24h.unknownCostJobs).toBe(2);
  expect(s.last24h.calls).toBe(3);
  expect(s.last24h.inputTokens).toBe(10);
  expect(s.budget).toEqual({ dailyUsd: 5 });
});

test("loadBudget: defaults when missing or garbage, file values otherwise", () => {
  const dir = fresh();
  expect(loadBudget(join(dir, "none.json"))).toEqual({ gemini: { dailyUsd: 5, monthlyUsd: 50 } });
  writeFileSync(join(dir, "bad.json"), "{nope");
  expect(loadBudget(join(dir, "bad.json")).gemini?.dailyUsd).toBe(5);
  writeFileSync(join(dir, "b.json"), JSON.stringify({ gemini: { dailyUsd: 1, monthlyUsd: "x" } }));
  expect(loadBudget(join(dir, "b.json"))).toEqual({ gemini: { dailyUsd: 1 } });
});

// ── usage marker ────────────────────────────────────────────────────────────

const M = "SDD_GEMINI_USAGE";
const line = (o: object): string => `${M}:${JSON.stringify(o)}`;

test("parseUsageMarker: the LAST marker wins", () => {
  const out = [line({ calls: 1, costUsd: 0.1 }), "noise", line({ model: "m", calls: 3, costUsd: 0.3, inputTokens: 5 })].join("\n");
  const u = parseUsageMarker(out, M)!;
  expect(u.calls).toBe(3);
  expect(u.costUsd).toBe(0.3);
  expect(u.model).toBe("m");
  expect(u.costIsEstimate).toBe(true);
});

test("parseUsageMarker: missing numbers are null, not 0; malformed or absent is null; never throws", () => {
  const u = parseUsageMarker(line({ calls: 2 }), M)!;
  expect(u.inputTokens).toBeNull();
  expect(u.outputTokens).toBeNull();
  expect(u.costUsd).toBeNull();
  expect(u.items).toBeNull();
  expect(parseUsageMarker(`${M}:{not json`, M)).toBeNull();
  expect(parseUsageMarker(`${M}:[1]`, M)).toBeNull();
  expect(parseUsageMarker(line({ model: "m" }), M)).toBeNull(); // no calls
  expect(parseUsageMarker("nothing here", M)).toBeNull();
  expect(parseUsageMarker(line({ calls: 1 }) + `\n${M}:{broken`, M)).toBeNull(); // last line is the verdict
  expect(parseUsageMarker(line({ calls: "x", costUsd: "1" }), M)).toBeNull();
});

// ── discovery ───────────────────────────────────────────────────────────────

test("discovery accepts parseUsage flat and per-capability, and skips a non-function parseUsage", () => {
  const dir = fresh();
  const base = `export const name = "NAME"; export function buildArgs(){return ["true"]}
export function injectContract(p){return p}
export function parseResult(){return {status:"done",summary:"",artifacts:[],raw:""}}\n`;
  writeFileSync(join(dir, "withusage.ts"), `${base.replace("NAME", "withusage")}export function parseUsage(){return null}\n`);
  writeFileSync(join(dir, "plain.ts"), base.replace("NAME", "plain"));
  writeFileSync(join(dir, "badusage.ts"), `${base.replace("NAME", "badusage")}export const parseUsage = 3;\n`);
  writeFileSync(
    join(dir, "multi.ts"),
    `export const name="multi"; const c = (u) => ({buildArgs(){return ["true"]}, injectContract(p){return p}, parseResult(){return {status:"done",summary:"",artifacts:[],raw:""}}, ...(u?{parseUsage(){return null}}:{})});
export const capabilities = { default: c(true), other: c(false) };\n`,
  );
  writeFileSync(
    join(dir, "multibad.ts"),
    `export const name="multibad"; export const capabilities = { default: {buildArgs(){return ["true"]}, injectContract(p){return p}, parseResult(){}, parseUsage: "no"} };\n`,
  );
  const found = Object.fromEntries(discoverAdapters(dir).map((a) => [a.name, a]));
  expect(Object.keys(found).sort()).toEqual(["multi", "plain", "withusage"]);
  expect(typeof found.withusage!.capabilities.default!.parseUsage).toBe("function");
  expect(found.plain!.capabilities.default!.parseUsage).toBeUndefined();
  expect(typeof found.multi!.capabilities.default!.parseUsage).toBe("function");
  expect(found.multi!.capabilities.other!.parseUsage).toBeUndefined();
});

// ── JobStore ────────────────────────────────────────────────────────────────

function store(sink: LedgerInput[], killGraceMs?: number): JobStore {
  const s = new JobStore({ logDir: fresh(), ledger: (e) => sink.push(e), killGraceMs });
  stores.push(s);
  return s;
}

const unit = (over: Partial<WorkUnit> & Pick<WorkUnit, "buildArgs">): WorkUnit => ({
  name: "gemini",
  kind: "vision",
  injectContract: (p) => p,
  parseResult: (stdout) => ({ status: "done", summary: stdout.trim(), artifacts: [], raw: stdout }),
  ...over,
});

test("JobStore: a signal-killed job still has parseUsage called and a ledger line, and stays failed", async () => {
  const sink: LedgerInput[] = [];
  const s = store(sink);
  let seen = "";
  const id = s.dispatch(
    unit({
      // prints the marker, then kills itself with SIGKILL (no handler can run)
      buildArgs: () => [BUN, "-e", `console.log(${JSON.stringify(line({ calls: 2, costUsd: 0.2 }))}); process.kill(process.pid, "SIGKILL")`],
      parseUsage: (stdout) => {
        seen = stdout;
        return parseUsageMarker(stdout, M);
      },
    }),
    "p",
  );
  await s.wait([id], 10_000);
  const job = s.get(id)!;
  expect(job.state).toBe("failed");
  expect(job.kind).toBe("vision");
  expect(job.finishedAt).toBeGreaterThan(0);
  expect(seen).toContain(M);
  expect(sink.length).toBe(1);
  expect(sink[0]!.state).toBe("failed");
  expect(sink[0]!.signal).toBe("SIGKILL");
  expect(sink[0]!.kind).toBe("vision");
  expect(sink[0]!.usage?.costUsd).toBe(0.2);
});

test("JobStore: ledger line on done, on parseResult throwing, and a throwing parseUsage means null usage", async () => {
  const sink: LedgerInput[] = [];
  const s = store(sink);
  const ok = s.dispatch(unit({ buildArgs: () => [BUN, "-e", "console.log('fine')"], parseUsage: () => usage() }), "p");
  const threw = s.dispatch(
    unit({
      buildArgs: () => [BUN, "-e", "console.log('x')"],
      parseResult: () => {
        throw new Error("boom");
      },
      parseUsage: () => usage({ costUsd: 0.9 }),
    }),
    "p",
  );
  const badUsage = s.dispatch(
    unit({
      buildArgs: () => [BUN, "-e", "console.log('x')"],
      parseUsage: () => {
        throw new Error("nope");
      },
    }),
    "p",
  );
  await s.wait([ok, threw, badUsage], 10_000);
  expect(s.get(ok)!.state).toBe("done");
  expect(s.get(threw)!.state).toBe("failed");
  expect(s.get(badUsage)!.state).toBe("done");
  const by = Object.fromEntries(sink.map((e) => [e.jobId, e]));
  expect(by[ok]!.state).toBe("done");
  expect(by[ok]!.usage?.costUsd).toBe(0.5);
  expect(by[threw]!.state).toBe("failed");
  expect(by[threw]!.usage?.costUsd).toBe(0.9);
  expect(by[badUsage]!.usage).toBeNull();
});

test("JobStore.cancel sends SIGTERM first so a script can flush its usage, then reports failed", async () => {
  const sink: LedgerInput[] = [];
  const s = store(sink, 5000);
  const script = `process.on("SIGTERM", () => { console.log(${JSON.stringify(line({ calls: 1, costUsd: 0.07 }))}); process.exit(143); });
console.log("ready"); setInterval(() => {}, 1000);`;
  const id = s.dispatch(
    unit({ buildArgs: () => [BUN, "-e", script], parseUsage: (o) => parseUsageMarker(o, M) }),
    "p",
  );
  const start = Date.now();
  while (!readFileSync(s.get(id)!.logPath, "utf8").includes("ready")) {
    if (Date.now() - start > 5000) throw new Error("child never became ready");
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(await s.cancel(id)).toBe(true);
  expect(s.get(id)!.state).toBe("failed"); // a cancelled job is failed even though it exited 143 on its own
  expect(sink[0]!.usage?.costUsd).toBe(0.07);
});

test("JobStore.cancel escalates to SIGKILL after the grace when SIGTERM is ignored", async () => {
  const sink: LedgerInput[] = [];
  const s = store(sink, 150);
  const id = s.dispatch(
    unit({ buildArgs: () => [BUN, "-e", `process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);`] }),
    "p",
  );
  const start = Date.now();
  while (!readFileSync(s.get(id)!.logPath, "utf8").includes("ready")) {
    if (Date.now() - start > 5000) throw new Error("child never became ready");
    await new Promise((r) => setTimeout(r, 20));
  }
  await s.cancel(id);
  expect(s.get(id)!.state).toBe("failed");
  expect(sink[0]!.signal).toBe("SIGKILL");
});

// ── usage tool ──────────────────────────────────────────────────────────────

function toolRuntime(adaptersDir: string, ledgerPath: string, budgetPath?: string) {
  const rt = createRuntime({ adaptersDir, ledgerPath, budgetPath: budgetPath ?? join(fresh(), "nobudget.json") });
  return { rt, tool: createUsageTool(rt) };
}

const PLAIN = (name: string): string => `
export const name = ${JSON.stringify(name)};
export function buildArgs() { return ["true"]; }
export function injectContract(p) { return p; }
export function parseResult() { return { status: "done", summary: "", artifacts: [], raw: "" }; }
`;

test("usage({adapter:'gemini'}) returns the spend report with the documented rendering", async () => {
  const dir = fresh();
  writeFileSync(join(dir, "gemini.ts"), PLAIN("gemini"));
  const ledger = join(fresh(), "l.jsonl");
  const now = Date.now();
  appendLedger(input({ ts: now - H, usage: usage({ costUsd: 0.42 }) }), ledger);
  appendLedger(input({ ts: now - 2 * H, state: "failed", usage: usage({ costUsd: null }) }), ledger);
  const { tool } = toolRuntime(dir, ledger);

  const r = await tool.handler({ adapter: "gemini" });
  expect(r.isError).toBeUndefined();
  const text = r.content[0]!.text;
  expect(text).toContain("gemini spend: $0.42 in 24h of $5.00 daily");
  expect(text).toContain("of $50.00");
  expect(text).toContain("2 jobs (1 failed)");
  expect(text).toContain("1 unknown-cost");
  expect(text).not.toContain("does not report account limits");
  const reports = r.structuredContent!.reports as { adapter: string; spend: Record<string, unknown> }[];
  const spend = reports[0]!.spend as { costUsd: number; unknownCostJobs: number; jobs: number; budget: { dailyUsd: number } };
  expect(reports[0]!.adapter).toBe("gemini");
  expect(spend.costUsd).toBe(0.42);
  expect(spend.unknownCostJobs).toBe(1);
  expect(spend.jobs).toBe(2);
  expect(spend.budget.dailyUsd).toBe(5);
  expect(spend).toHaveProperty("last24h");
  expect(spend).toHaveProperty("month");
});

test("usage spend never renders an unknown cost as $0, and an empty ledger is a $0.00 known-nothing report", async () => {
  const dir = fresh();
  writeFileSync(join(dir, "gemini.ts"), PLAIN("gemini"));
  const ledger = join(fresh(), "l.jsonl");
  appendLedger(input({ usage: null, state: "failed" }), ledger);
  const { tool } = toolRuntime(dir, ledger);
  const text = (await tool.handler({ adapter: "gemini" })).content[0]!.text;
  expect(text).toContain("1 unknown-cost");
  expect(text).toContain("lower bound");

  const empty = toolRuntime(dir, join(fresh(), "missing.jsonl"));
  expect((await empty.tool.handler({ adapter: "gemini" })).content[0]!.text).toContain("0 jobs");
});

test("usage with no adapter includes spend alongside the unsupported list; a plain adapter stays unsupported", async () => {
  const dir = fresh();
  writeFileSync(join(dir, "gemini.ts"), PLAIN("gemini"));
  writeFileSync(join(dir, "plain.ts"), PLAIN("plain"));
  const { tool } = toolRuntime(dir, join(fresh(), "l.jsonl"));
  const r = await tool.handler({});
  expect(r.content[0]!.text).toContain("gemini spend:");
  expect(r.content[0]!.text).toContain("no limits reporting: plain");
});

test("usage({recent}) returns the last N ledger rows newest first, optionally per adapter", async () => {
  const dir = fresh();
  writeFileSync(join(dir, "plain.ts"), PLAIN("plain"));
  const ledger = join(fresh(), "l.jsonl");
  for (let i = 0; i < 5; i++) appendLedger(input({ jobId: `j${i}`, ts: 1000 + i, summary: `s${i}` }), ledger);
  appendLedger(input({ jobId: "other", adapter: "codex", ts: 2000, usage: null }), ledger);
  const { tool } = toolRuntime(dir, ledger);

  const r = await tool.handler({ recent: 3 });
  const rows = r.structuredContent!.rows as { jobId: string; costUsd: number | null }[];
  expect(rows.map((x) => x.jobId)).toEqual(["other", "j4", "j3"]);
  expect(rows[0]!.costUsd).toBeNull();
  expect(r.content[0]!.text).toContain("cost unknown");

  const g = await tool.handler({ recent: 2, adapter: "gemini" });
  expect((g.structuredContent!.rows as unknown[]).length).toBe(2);
  expect((await tool.handler({ recent: 1, adapter: "nobody" })).content[0]!.text).toContain("no ledger rows");
});

// ── wait results ────────────────────────────────────────────────────────────

test("wait includes results for terminal jobs (no raw) in structured content and text", async () => {
  const dir = fresh();
  writeFileSync(
    join(dir, "echo.ts"),
    `export const name = "echo";
export function buildArgs() { return [${JSON.stringify(BUN)}, "-e", "console.log('hello result')"]; }
export function injectContract(p) { return p; }
export function parseResult(o) { return { status: "done", summary: o.trim(), artifacts: ["/a.png"], raw: o }; }
`,
  );
  const rt = createRuntime({ adaptersDir: dir, jobStoreOptions: { logDir: fresh() } });
  stores.push(rt.jobStore);
  const adapter = discoverAdapters(dir)[0]!;
  const { resolveWorkUnit } = await import("../src/adapters/types.ts");
  const u = resolveWorkUnit(adapter) as WorkUnit;
  const id = rt.jobStore.dispatch(u, "p");
  const r = await createWaitTool(rt).handler({ jobIds: [id], timeoutMs: 10_000 });
  const results = r.structuredContent!.results as Record<string, unknown>[];
  expect(results).toEqual([
    { jobId: id, adapter: "echo", kind: "default", status: "done", summary: "hello result", artifacts: ["/a.png"] },
  ]);
  expect(results[0]).not.toHaveProperty("raw");
  expect(r.content[0]!.text).toContain("hello result");
  expect(r.content[0]!.text).toContain("echo/default");
});
