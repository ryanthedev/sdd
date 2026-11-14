/**
 * The spend ledger (docs/usage-contract.md §3-4). This module is the ONLY writer:
 * one `appendFileSync` of ONE JSON line per terminal job, never rewritten or
 * truncated. Many servers append concurrently; a single short O_APPEND write is
 * the whole concurrency story, and readers skip torn/invalid lines.
 *
 * The ledger never contains prompts, request contents, or env — only the job's
 * identity, outcome, a truncated result summary, and its UsageRecord.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type { UsageRecord } from "../types.ts";
import { log } from "./log.ts";

export interface LedgerEntry {
  v: 1;
  ts: number;
  jobId: string;
  adapter: string;
  kind: string;
  cwd: string;
  state: "done" | "failed";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  summary: string;
  usage: UsageRecord | null;
  host: string;
}

/** What a writer supplies; `v` and `host` are stamped by appendLedger. */
export type LedgerInput = Omit<LedgerEntry, "v" | "host">;

export const SUMMARY_MAX = 300;
const DAY_MS = 86_400_000;

/** `$SDD_LEDGER_PATH`, else `${XDG_STATE_HOME:-~/.local/state}/sdd/ledger.jsonl`. */
export function ledgerPath(): string {
  const override = process.env.SDD_LEDGER_PATH;
  if (override) return override;
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "sdd", "ledger.jsonl");
}

let warned = false;

/** Append one line. Never throws; a failure is reported once to stderr. */
export function appendLedger(entry: LedgerInput, path: string = ledgerPath()): void {
  try {
    const line: LedgerEntry = {
      v: 1,
      ts: entry.ts,
      jobId: entry.jobId,
      adapter: entry.adapter,
      kind: entry.kind,
      cwd: entry.cwd,
      state: entry.state,
      exitCode: entry.exitCode,
      signal: entry.signal,
      durationMs: entry.durationMs,
      summary: typeof entry.summary === "string" ? entry.summary.slice(0, SUMMARY_MAX) : "",
      usage: entry.usage,
      host: hostname(),
    };
    // Private to the user: the ledger names project dirs and job summaries.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best effort on an existing file */ }
  } catch (e) {
    if (warned) return;
    warned = true;
    log(`ledger: could not append to ${path}: ${e instanceof Error ? e.message : String(e)} (jobs are unaffected)`);
  }
}

export interface ReadLedgerOpts {
  path?: string;
  /** Keep only entries at or after this epoch-ms. */
  since?: number;
  adapter?: string;
}

/** All valid entries, oldest first. Missing file = []. Torn/invalid lines are skipped. */
export function readLedger(opts: ReadLedgerOpts = {}): LedgerEntry[] {
  const path = opts.path ?? ledgerPath();
  let text: string;
  try {
    if (!existsSync(path)) return [];
    text = readFileSync(path, "utf8");
  } catch (e) {
    log(`ledger: could not read ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // torn line from a concurrent/interrupted writer
    }
    const e = coerceEntry(o);
    if (!e) continue;
    if (opts.since !== undefined && e.ts < opts.since) continue;
    if (opts.adapter !== undefined && e.adapter !== opts.adapter) continue;
    out.push(e);
  }
  return out;
}

function coerceEntry(o: unknown): LedgerEntry | null {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return null;
  if (typeof r.adapter !== "string" || r.adapter.length === 0) return null;
  const usage = r.usage;
  let u: UsageRecord | null = null;
  if (typeof usage === "object" && usage !== null && !Array.isArray(usage)) {
    const x = usage as Record<string, unknown>;
    const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    u = {
      model: typeof x.model === "string" ? x.model : null,
      calls: n(x.calls) ?? 0,
      items: n(x.items),
      ok: n(x.ok),
      failed: n(x.failed),
      inputTokens: n(x.inputTokens),
      outputTokens: n(x.outputTokens),
      costUsd: n(x.costUsd),
      costIsEstimate: true,
    };
  }
  return {
    v: 1,
    ts: r.ts,
    jobId: typeof r.jobId === "string" ? r.jobId : "",
    adapter: r.adapter,
    kind: typeof r.kind === "string" ? r.kind : "default",
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    state: r.state === "done" ? "done" : "failed",
    exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
    signal: typeof r.signal === "string" ? r.signal : null,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
    summary: typeof r.summary === "string" ? r.summary : "",
    usage: u,
    host: typeof r.host === "string" ? r.host : "",
  };
}

// ── Budget ──────────────────────────────────────────────────────────────────

export interface AdapterBudget {
  dailyUsd?: number;
  monthlyUsd?: number;
}
export type Budget = Record<string, AdapterBudget>;

export const DEFAULT_BUDGET: Budget = { gemini: { dailyUsd: 5, monthlyUsd: 50 } };

/** `$XDG_CONFIG_HOME/sdd/budget.json` (default `~/.config/sdd/budget.json`). */
export function budgetPath(): string {
  const cfg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(cfg, "sdd", "budget.json");
}

/** The budget file, or the defaults when it is missing or unusable. Never throws. */
export function loadBudget(path: string = budgetPath()): Budget {
  const defaults = (): Budget => structuredClone(DEFAULT_BUDGET);
  let parsed: unknown;
  try {
    if (!existsSync(path)) return defaults();
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    log(`budget: could not read ${path}: ${e instanceof Error ? e.message : String(e)}; using defaults`);
    return defaults();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaults();
  const out: Budget = {};
  for (const [adapter, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const b = v as Record<string, unknown>;
    const entry: AdapterBudget = {};
    if (typeof b.dailyUsd === "number" && Number.isFinite(b.dailyUsd)) entry.dailyUsd = b.dailyUsd;
    if (typeof b.monthlyUsd === "number" && Number.isFinite(b.monthlyUsd)) entry.monthlyUsd = b.monthlyUsd;
    out[adapter] = entry;
  }
  return out;
}

// ── Spend summary (pure) ────────────────────────────────────────────────────

/** A billed job whose cost is unknown is charged this much (fail closed). Must
 *  equal the scripts' value (assets/gemini-common.ts) and the usage governor's,
 *  so every view of spend agrees with what the budget enforces. */
export const UNKNOWN_COST_CHARGE_USD = 0.25;

export interface SpendWindow {
  /** Known costs plus UNKNOWN_COST_CHARGE_USD per unknown-cost job: the figure the budget enforces. */
  costUsd: number;
  jobs: number;
  failedJobs: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Billed jobs whose cost is unknown (no usage, or a null cost with calls != 0); each is charged UNKNOWN_COST_CHARGE_USD. */
  unknownCostJobs: number;
}

export interface SpendSummary {
  adapter: string;
  last24h: SpendWindow;
  month: SpendWindow;
  budget: AdapterBudget | null;
}

function emptyWindow(): SpendWindow {
  return { costUsd: 0, jobs: 0, failedJobs: 0, calls: 0, inputTokens: 0, outputTokens: 0, unknownCostJobs: 0 };
}

function addTo(w: SpendWindow, e: LedgerEntry): void {
  w.jobs += 1;
  if (e.state === "failed") w.failedJobs += 1;
  const u = e.usage;
  if (u) {
    w.calls += u.calls;
    if (u.inputTokens !== null) w.inputTokens += u.inputTokens;
    if (u.outputTokens !== null) w.outputTokens += u.outputTokens;
  }
  if (u && u.costUsd !== null) w.costUsd += u.costUsd;
  else if (u && u.calls === 0) return; // nothing was billed
  else {
    w.unknownCostJobs += 1;
    w.costUsd += UNKNOWN_COST_CHARGE_USD;
  }
}

/**
 * Rolling-24h (ts > now - 24h) and calendar-month (local time, ts >= first of
 * this month 00:00 local) totals for one adapter. Pure.
 */
export function summarizeSpend(
  entries: LedgerEntry[],
  opts: { now: number; adapter: string; budget?: Budget },
): SpendSummary {
  const dayStart = opts.now - DAY_MS;
  const d = new Date(opts.now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
  const last24h = emptyWindow();
  const month = emptyWindow();
  for (const e of entries) {
    if (e.adapter !== opts.adapter || e.ts > opts.now) continue;
    if (e.ts > dayStart) addTo(last24h, e);
    if (e.ts >= monthStart) addTo(month, e);
  }
  return { adapter: opts.adapter, last24h, month, budget: opts.budget?.[opts.adapter] ?? null };
}
