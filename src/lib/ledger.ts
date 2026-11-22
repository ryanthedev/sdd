/**
 * The spend ledger (docs/usage-contract.md §3-4). This module is the ONLY writer:
 * one `appendFileSync` of ONE JSON line per terminal job, never rewritten or
 * truncated. Many servers append concurrently; a single short O_APPEND write is
 * the whole concurrency story, and readers skip torn/invalid lines.
 *
 * The ledger never contains prompts, request contents, or env — only the job's
 * identity, outcome, a short result summary (<= SUMMARY_MAX chars; for gemini
 * only counts/cost/stop status, never answers or error text), and its UsageRecord.
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

export const SUMMARY_MAX = 160;
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
      summary: ledgerSummary(entry.adapter, entry.summary),
      usage: entry.usage,
      host: hostname(),
    };
    // Private to the user: the ledger names project dirs and job summaries.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // mkdir's mode only applies on creation: tighten a pre-existing dir too.
    try { chmodSync(dirname(path), 0o700); } catch { /* best effort */ }
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best effort on an existing file */ }
  } catch (e) {
    if (warned) return;
    warned = true;
    log(`ledger: could not append to ${path}: ${e instanceof Error ? e.message : String(e)} (jobs are unaffected)`);
  }
}

/**
 * The summary as stored. Every adapter's is capped at SUMMARY_MAX. Gemini's
 * result summary can restate request content (`answers=`, `first_error=` quote
 * the model's output and the API's error text), so only its status tokens
 * (counts, cost, `stopped=`, a failed-id COUNT) are kept.
 */
export function ledgerSummary(adapter: string, summary: unknown): string {
  if (typeof summary !== "string") return "";
  if (adapter !== "gemini") return summary.slice(0, SUMMARY_MAX);
  const prefix = /^gemini(?: vision)?:/.exec(summary)?.[0] ?? "gemini:";
  const code = /exited with code (-?\d+)/.exec(summary)?.[1];
  let body = summary;
  if (code !== undefined) body = /\[([^\]]*)\]\s*(?:\(results:|$)/.exec(summary)?.[1] ?? "";
  body = body.split(" first_error=")[0]!.split(" answers=")[0]!;
  const keep = new Set(["model", "items", "ok", "failed", "skipped", "frames", "dry_run", "input_tokens", "output_tokens", "cost_usd", "est_input_tokens", "est_cost_usd", "problems", "stopped"]);
  const parts: string[] = code !== undefined ? [`exited with code ${code}`] : [];
  for (const m of body.matchAll(/\b([a-z_]+)=(\S*)/g)) {
    const [, k, v] = m;
    if (k === "failed_ids") parts.push(`failed_ids=${v ? v.split(",").length : 0}`);
    else if (keep.has(k!)) parts.push(`${k}=${v!.replace(/[)\]]+$/, "")}`);
  }
  return `${prefix} ${parts.join(" ")}`.trim().slice(0, SUMMARY_MAX);
}

export interface ReadLedgerOpts {
  path?: string;
  /** Keep only entries at or after this epoch-ms. */
  since?: number;
  adapter?: string;
}

/** All valid entries, oldest first. Missing file = []. Torn/invalid lines are skipped. */
export function readLedger(opts: ReadLedgerOpts = {}): LedgerEntry[] {
  return readLedgerChecked(opts).entries;
}

/** Like readLedger, but a read failure (anything but a missing file) is returned
 *  in `error` so callers can report spend as unavailable instead of as $0. */
export function readLedgerChecked(opts: ReadLedgerOpts = {}): { entries: LedgerEntry[]; error: string | null } {
  const path = opts.path ?? ledgerPath();
  let text: string;
  try {
    if (!existsSync(path)) return { entries: [], error: null };
    text = readFileSync(path, "utf8");
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`ledger: could not read ${path}: ${error}`);
    return { entries: [], error };
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
  return { entries: out, error: null };
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
    // A record with no `calls` (and no cost) must not read as "0 calls = free":
    // treat it as no usage at all, which the spend rule charges (fail closed).
    const calls = n(x.calls);
    u = calls === null && n(x.costUsd) === null ? null : {
      model: typeof x.model === "string" ? x.model : null,
      calls: calls ?? 0,
      items: n(x.items),
      ok: n(x.ok),
      failed: n(x.failed),
      inputTokens: n(x.inputTokens),
      outputTokens: n(x.outputTokens),
      costUsd: n(x.costUsd),
      ...((n(x.unknownCalls) ?? 0) > 0 ? { unknownCalls: n(x.unknownCalls)! } : {}),
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

export interface PoolLimits {
  dailyUsd?: number;
  monthlyUsd?: number;
}
/** `dailyUsd`/`monthlyUsd` are the DECISION pool (every ledger kind but "vision");
 *  the nested `vision` block is the VISION pool (kind "vision"). Contract section 4. */
export interface AdapterBudget extends PoolLimits {
  vision?: PoolLimits;
}
export type Budget = Record<string, AdapterBudget>;
/** Which slice of an adapter's ledger lines a summary covers. */
export type Pool = "decision" | "vision";

export const DEFAULT_BUDGET: Budget = { gemini: { dailyUsd: 5, monthlyUsd: 50, vision: { dailyUsd: 15, monthlyUsd: 150 } } };

/** Does this ledger entry belong to the pool? Vision = kind "vision"; decision = anything else. */
export function inPool(e: { kind: string }, pool: Pool): boolean {
  return (e.kind === "vision") === (pool === "vision");
}

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
  // Per-field merge over the defaults, like the scripts' readBudget: a file with
  // no gemini block (or `{"gemini":{}}`) still enforces $5/$50; negative or
  // non-finite values are ignored in favour of the default.
  const out: Budget = defaults();
  const limit = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  for (const [adapter, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    const b = v as Record<string, unknown>;
    const entry: AdapterBudget = { ...out[adapter] };
    const d = limit(b.dailyUsd);
    const m = limit(b.monthlyUsd);
    if (d !== undefined) entry.dailyUsd = d;
    if (m !== undefined) entry.monthlyUsd = m;
    // Nested vision pool, merged per field over the vision defaults (or over nothing for other adapters).
    const vb = b.vision;
    if (typeof vb === "object" && vb !== null && !Array.isArray(vb)) {
      const v = vb as Record<string, unknown>;
      const vd = limit(v.dailyUsd);
      const vm = limit(v.monthlyUsd);
      entry.vision = { ...entry.vision };
      if (vd !== undefined) entry.vision.dailyUsd = vd;
      if (vm !== undefined) entry.vision.monthlyUsd = vm;
    }
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
  /** Set when the summary covers one pool only. */
  pool?: Pool;
  last24h: SpendWindow;
  month: SpendWindow;
  /** The limits that apply to this summary: the pool's own (vision block for "vision"), else the adapter's top-level. */
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
  if (u && u.costUsd !== null) {
    w.costUsd += u.costUsd; // already includes the flat charge for any unknown-cost calls
    if ((u.unknownCalls ?? 0) > 0) w.unknownCostJobs += 1;
  } else if (u && u.calls === 0) return; // nothing was billed
  else {
    w.unknownCostJobs += 1;
    w.costUsd += UNKNOWN_COST_CHARGE_USD;
  }
}

/**
 * Rolling-24h (ts > now - 24h) and calendar-month (local time, ts >= first of
 * this month 00:00 local) totals for one adapter. Pure. With `pool`, only that
 * pool's entries count ("vision" = kind "vision", "decision" = every other kind)
 * and `budget` carries that pool's limits.
 */
export function summarizeSpend(
  entries: LedgerEntry[],
  opts: { now: number; adapter: string; budget?: Budget; pool?: Pool },
): SpendSummary {
  const dayStart = opts.now - DAY_MS;
  const d = new Date(opts.now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
  const last24h = emptyWindow();
  const month = emptyWindow();
  for (const e of entries) {
    if (e.adapter !== opts.adapter || e.ts > opts.now) continue;
    if (opts.pool !== undefined && !inPool(e, opts.pool)) continue;
    if (e.ts > dayStart) addTo(last24h, e);
    if (e.ts >= monthStart) addTo(month, e);
  }
  const ab = opts.budget?.[opts.adapter] ?? null;
  const budget = opts.pool === "vision" ? (ab?.vision ?? null) : opts.pool === "decision" && ab ? { dailyUsd: ab.dailyUsd, monthlyUsd: ab.monthlyUsd } : ab;
  return { adapter: opts.adapter, ...(opts.pool ? { pool: opts.pool } : {}), last24h, month, budget };
}

// ── Usage breakdown (pure) ──────────────────────────────────────────────────

/** A SpendWindow plus the decide batch size (`usage.items`, null for vision) summed. */
export interface UsageWindow extends SpendWindow {
  items: number;
}

export interface UsageBreakdown {
  adapter: string;
  pool?: Pool;
  /** Local calendar days covered, oldest first: today and the `days - 1` before it. */
  days: number;
  /** Local midnight that starts the window (ms). */
  since: number;
  total: UsageWindow;
  /** One row per local date in the window, oldest first, including days with no jobs. */
  byDay: Array<{ date: string } & UsageWindow>;
  /** One row per project (see `projectOf`), most expensive first. */
  byProject: Array<{ project: string } & UsageWindow>;
}

export const BREAKDOWN_MAX_DAYS = 90;

function emptyUsage(): UsageWindow {
  return { ...emptyWindow(), items: 0 };
}

function addUsage(w: UsageWindow, e: LedgerEntry): void {
  addTo(w, e); // same counting and fail-closed $0.25 rule as the budget
  if (e.usage?.items != null) w.items += e.usage.items;
}

function localDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

/**
 * A HEURISTIC project label for a job's cwd, for grouping only. The ledger
 * records cwd, not who asked, and most callers run in git worktrees or temp
 * scratch dirs, so this is approximate by design:
 *   - anything under a temp root (/tmp, /private/tmp, /var/folders) is "(temp)";
 *   - under `home`, the first two path segments ("~/repos/omni"), which folds a
 *     repo's in-tree worktrees (repos/omni/build/wt/x) into the repo;
 *   - elsewhere, the first two segments ("/opt/work").
 * Worktrees kept outside the repo they belong to are NOT folded back into it.
 */
export function projectOf(cwd: string, home: string = homedir()): string {
  if (cwd === "") return "(unknown)";
  if (TEMP_ROOTS.some((r) => cwd === r || cwd.startsWith(`${r}/`))) return "(temp)";
  const h = home.replace(/\/+$/, "");
  if (h !== "" && (cwd === h || cwd.startsWith(`${h}/`))) {
    const rest = cwd.slice(h.length).split("/").filter(Boolean).slice(0, 2);
    return rest.length === 0 ? "~" : `~/${rest.join("/")}`;
  }
  const segs = cwd.split("/").filter(Boolean).slice(0, 2);
  return segs.length === 0 ? "/" : `/${segs.join("/")}`;
}

/**
 * Per-day and per-project usage for one adapter over the last `days` LOCAL
 * calendar days (today included; clamped to 1..BREAKDOWN_MAX_DAYS). Pure, apart
 * from `projectOf`'s default home dir (pass `home` to pin it). Costs follow the
 * budget's rules exactly (an unknown cost is charged $0.25), so a breakdown
 * always adds up to what the budget enforces.
 */
export function breakdownSpend(
  entries: LedgerEntry[],
  opts: { now: number; adapter: string; days: number; pool?: Pool; home?: string },
): UsageBreakdown {
  const days = Math.min(BREAKDOWN_MAX_DAYS, Math.max(1, Math.floor(opts.days)));
  const today = new Date(opts.now);
  const since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1), 0, 0, 0, 0).getTime();

  const byDay = new Map<string, UsageWindow>();
  for (let i = 0; i < days; i++) {
    byDay.set(localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1) + i, 12).getTime()), emptyUsage());
  }
  const byProject = new Map<string, UsageWindow>();
  const total = emptyUsage();

  for (const e of entries) {
    if (e.adapter !== opts.adapter || e.ts < since || e.ts > opts.now) continue;
    if (opts.pool !== undefined && !inPool(e, opts.pool)) continue;
    addUsage(total, e);
    const day = byDay.get(localDate(e.ts));
    if (day) addUsage(day, e);
    const key = projectOf(e.cwd, opts.home);
    let p = byProject.get(key);
    if (!p) byProject.set(key, (p = emptyUsage()));
    addUsage(p, e);
  }

  return {
    adapter: opts.adapter,
    ...(opts.pool ? { pool: opts.pool } : {}),
    days,
    since,
    total,
    byDay: [...byDay].map(([date, w]) => ({ date, ...w })),
    byProject: [...byProject]
      .map(([project, w]) => ({ project, ...w }))
      .sort((a, b) => b.costUsd - a.costUsd || b.jobs - a.jobs || a.project.localeCompare(b.project)),
  };
}
