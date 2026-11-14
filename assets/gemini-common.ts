/**
 * Shared plumbing for the bundled gemini scripts (`gemini-decide.ts`,
 * `gemini-vision.ts`): API-key resolution, the spend budget (docs/usage-contract.md
 * section 4), the usage marker (section 2), and Retry-After parsing.
 *
 * HERMETIC: this file imports only node builtins. Assets run standalone under
 * `bun --config=<empty> --no-env-file run`, so nothing here may import from
 * `src/`. It is READ-ONLY with respect to the ledger and the budget file: the
 * sdd server is the ledger's only writer.
 */
import { readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MARKER = "SDD_GEMINI_USAGE";

/** Cumulative usage, the contract's `UsageRecord` (section 1). */
export interface UsageRecord {
  model: string | null;
  calls: number;
  items: number | null;
  ok: number | null;
  failed: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costIsEstimate: true;
}

/** Print the LATEST cumulative usage on its own line (the last one wins).
 *  writeSync so it still lands inside a SIGTERM handler right before exit. */
export function emitUsage(rec: UsageRecord): void {
  const line = `${MARKER}:${JSON.stringify(rec)}\n`;
  try {
    writeSync(1, line);
  } catch {
    process.stdout.write(line);
  }
}

/** `GEMINI_API_KEY` from the env, else the user-level sdd `.env`. Never the
 *  job cwd's. Returns the key (or null) and the file consulted. */
export function resolveKey(): { key: string | null; file: string } {
  const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "sdd", ".env");
  const fromEnv = process.env.GEMINI_API_KEY;
  if (fromEnv) return { key: fromEnv, file };
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // Missing file reads the same as a missing line.
  }
  const m = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/m.exec(text);
  return { key: m?.[1] ?? null, file };
}

export interface GeminiBudget {
  dailyUsd: number;
  monthlyUsd: number;
  /** Opt-in to models with no known price (their cost is unknown, charged at
   *  UNKNOWN_COST_CHARGE_USD per job against the budget). Default false. */
  allowUnpricedModels: boolean;
}
const DEFAULT_BUDGET: GeminiBudget = { dailyUsd: 5, monthlyUsd: 50, allowUnpricedModels: false };

/** A billed job whose cost is unknown is charged this much against the budget
 *  (fail closed): an unknown cost must never read as free. */
export const UNKNOWN_COST_CHARGE_USD = 0.25;

/** Refusal text for a model with no known price, or null when it may run. */
export function unpricedModelRefusal(model: string, priced: (m: string) => boolean, who: string): string | null {
  if (priced(model) || readBudget(who).allowUnpricedModels) return null;
  return `model "${model}" has no known price, so its spend can't be tracked; use a priced model or ask the user to set "allowUnpricedModels": true in the gemini block of ~/.config/sdd/budget.json`;
}

function configHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

export function ledgerPath(): string {
  const o = process.env.SDD_LEDGER_PATH;
  if (o) return o;
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "sdd", "ledger.jsonl");
}

/** `~/.config/sdd/budget.json`'s `gemini` block; missing or partial = defaults.
 *  An unparseable file also falls back to defaults (warned on stderr): the
 *  spend ledger still bounds the job. */
export function readBudget(who: string): GeminiBudget {
  const file = join(configHome(), "sdd", "budget.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ...DEFAULT_BUDGET };
  }
  try {
    const g = (JSON.parse(text) as { gemini?: { dailyUsd?: unknown; monthlyUsd?: unknown; allowUnpricedModels?: unknown } }).gemini;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
    return {
      dailyUsd: num(g?.dailyUsd, DEFAULT_BUDGET.dailyUsd),
      monthlyUsd: num(g?.monthlyUsd, DEFAULT_BUDGET.monthlyUsd),
      allowUnpricedModels: g?.allowUnpricedModels === true,
    };
  } catch {
    process.stderr.write(`${who}: ${file} is not valid JSON; using default budget\n`);
    return { ...DEFAULT_BUDGET };
  }
}

export interface Spend {
  usd24h: number;
  usdMonth: number;
  unknownCostJobs: number;
}

/** Sum gemini `usage.costUsd` from the ledger over the rolling 24h and the
 *  local calendar month. Missing file = $0; torn/invalid lines are skipped;
 *  a null cost counts as `unknownCostJobs`, never as 0. */
export function readSpend(now: number = Date.now()): Spend {
  const spend: Spend = { usd24h: 0, usdMonth: 0, unknownCostJobs: 0 };
  let text: string;
  try {
    text = readFileSync(ledgerPath(), "utf8");
  } catch {
    return spend;
  }
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const dayStart = now - 24 * 3600 * 1000;
  for (const line of text.split("\n")) {
    if (!line.includes('"gemini"')) continue;
    let rec: { adapter?: unknown; ts?: unknown; usage?: { costUsd?: unknown; calls?: unknown } | null };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.adapter !== "gemini" || typeof rec.ts !== "number") continue;
    const inMonth = rec.ts >= monthStart;
    const inDay = rec.ts >= dayStart;
    if (!inMonth && !inDay) continue;
    const raw = rec.usage?.costUsd;
    let cost: number;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      cost = raw;
    } else {
      // Fail closed: a job that made billed calls but reports no cost is charged a
      // conservative flat amount. A job with no usage record at all (killed before
      // any marker, or a 0.7.0 script) is charged too, unless it says calls: 0.
      const calls = rec.usage?.calls;
      if (calls === 0) continue;
      if (inDay) spend.unknownCostJobs++;
      cost = UNKNOWN_COST_CHARGE_USD;
    }
    if (inDay) spend.usd24h += cost;
    if (inMonth) spend.usdMonth += cost;
  }
  return spend;
}

/** The refusal message when either limit is already reached, else null. */
export function budgetRefusal(who: string, now: number = Date.now()): string | null {
  const b = readBudget(who);
  const s = readSpend(now);
  if (s.usd24h >= b.dailyUsd) return `budget exceeded: $${s.usd24h.toFixed(4)} in 24h of $${b.dailyUsd} daily`;
  if (s.usdMonth >= b.monthlyUsd) return `budget exceeded: $${s.usdMonth.toFixed(4)} this month of $${b.monthlyUsd} monthly`;
  return null;
}

/** Retry-After (delta-seconds or HTTP-date) in ms, capped at 60s; null when absent. */
export function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 60_000)) : null;
}
