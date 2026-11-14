/**
 * usage — report how much of a harness's account quota is left, and what the
 * metered-by-the-call harnesses have SPENT, before you spend more.
 *
 * Two kinds of report, both free to read (no work unit runs):
 *   - quota: an adapter that declares `readLimits`/`parseLimits` is asked for its
 *     account windows (see `src/lib/limits.ts`);
 *   - spend: an adapter that bills per call (gemini, maybe jev) is summarized from
 *     the local ledger (`src/lib/ledger.ts`) against `~/.config/sdd/budget.json`.
 *
 * Not every harness can report either. Adapters that do neither are listed as
 * `unsupported` rather than omitted — "we can't see it" and "it has no limits"
 * are different answers. An UNKNOWN cost is never rendered or summed as $0.
 *
 * `recent: N` returns job history instead: the last N ledger rows.
 */
import { z } from "zod";
import type { Adapter } from "../adapters/types.ts";
import {
  type AdapterBudget,
  type LedgerEntry,
  loadBudget,
  readLedger,
  type SpendSummary,
  type SpendWindow,
  summarizeSpend,
} from "../lib/ledger.ts";
import { formatSnapshot, readAdapterLimits } from "../lib/limits.ts";
import { readGovernor, renderGovernor } from "../lib/governor.ts";
import type { UsageSnapshot } from "../types.ts";
import { findAdapter, listAdapters, type Runtime } from "./runtime.ts";
import { err, ok, type ToolModule } from "./shared.ts";

export const name = "usage";
export const title = "Report account quota, spend, and recent job history for a harness";
export const description =
  "Report how much of a harness's account quota is used and when it resets — e.g. codex's rolling weekly " +
  "window, plan tier, credit balance, any spend-control ceiling, and how many redeemable usage resets the " +
  "account is holding — and, for per-call-billed harnesses (gemini), SPEND from the local ledger: rolling 24h " +
  "and calendar-month dollars against the configured daily/monthly budget, job/failed/call/token counts, and " +
  "unknownCostJobs (jobs whose cost could not be determined; the dollar sums already charge each one a " +
  "fail-closed $0.25, so they are not lower bounds). Quota reads cost no tokens and run no work unit. Call it before a large fan-out, or when " +
  "a job fails in a way that smells like a quota wall or a budget refusal. Omit `adapter` to report every " +
  "harness that can answer; the rest are listed as unsupported, and, when the user's Claude usage governor is " +
  "installed, the output also leads with a governor block (Claude weekly %, 24h use, RUN/STOP, stale flag) so " +
  "Claude, Gemini and codex usage come from this one tool. Pass `recent` (1-50) to instead get job " +
  "history: the last N ledger rows (ts, adapter, kind, state, durationMs, costUsd, summary), optionally for one adapter.";

export const inputShape = {
  adapter: z
    .string()
    .min(1)
    .optional()
    .describe("Adapter to report on, e.g. \"codex\" or \"gemini\". Omit to report every adapter that supports it."),
  refresh: z
    .boolean()
    .optional()
    .describe("Bypass the short-lived cache and force a live read. Default false (a cached snapshot may be up to a minute old)."),
  recent: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Return the last N ledger rows (job history) instead of quota/spend reports. 1..50."),
};

type Input = z.output<z.ZodObject<typeof inputShape>>;

export interface SpendReport extends SpendWindow {
  adapter: string;
  /** Rolling 24h window (all fields). */
  last24h: SpendWindow;
  /** Calendar month, local time (all fields). */
  month: SpendWindow;
  budget: AdapterBudget | null;
}

type Report =
  | { adapter: string; supported: true; ok: true; snapshot: UsageSnapshot }
  | { adapter: string; supported: true; ok: false; error: string }
  | { adapter: string; supported: false };

type SpendEntry = { adapter: string; spend: SpendReport };

export function createUsageTool(rt: Runtime): ToolModule<typeof inputShape> {
  return {
    name,
    title,
    description,
    inputShape,
    handler: async (args: Input) => {
      if (args.recent !== undefined) return recentRows(rt, args.adapter, args.recent);

      const refresh = args.refresh === true;
      const now = Date.now();
      const budget = loadBudget(rt.budgetPath);
      const ledger = lazyLedger(rt);

      // A named adapter that doesn't exist is a caller mistake worth erroring on;
      // a named adapter that exists but reports nothing is a legitimate answer.
      if (args.adapter !== undefined) {
        const adapter = findAdapter(rt, args.adapter);
        if (!adapter) {
          return err(`unknown adapter "${args.adapter}" — call list_adapters to see available adapters.`, {
            code: "unknown_adapter",
          });
        }
        const reports: unknown[] = [];
        const lines: string[] = [];
        if (hasLimits(adapter)) {
          const r = await reportFor(adapter, refresh);
          reports.push(r);
          lines.push(renderReport(r));
        }
        if (hasSpend(adapter, budget, ledger())) {
          const s = spendFor(adapter.name, ledger(), budget, now);
          reports.push(s);
          lines.push(renderSpend(s.spend));
        }
        if (reports.length === 0) {
          const r: Report = { adapter: adapter.name, supported: false };
          return ok(renderReport(r), { reports: [r] });
        }
        return ok(lines.join("\n"), { reports });
      }

      // Only adapters that declare a capability are probed — spawning every
      // harness on PATH to discover that most have no such endpoint would be
      // both slow and pointless.
      const all = listAdapters(rt);
      const limitCapable = all.filter(hasLimits);
      const spendCapable = all.filter((a) => hasSpend(a, budget, ledger()));
      // The user's Claude usage governor, when installed: Claude, Gemini and codex in one answer.
      // Opt-in per runtime (server wiring passes the real dir), so tests never read the machine's governor.
      const governor = rt.governorDir ? readGovernor(rt.governorDir) : null;
      const govLines = governor ? [renderGovernor(governor)] : [];
      if (limitCapable.length === 0 && spendCapable.length === 0) {
        if (governor) return ok(govLines.join("\n"), { reports: [], governor });
        return ok("no discovered adapter reports account limits.", { reports: [] });
      }

      const limitReports = await Promise.all(limitCapable.map((a) => reportFor(a, refresh)));
      const spendReports = spendCapable.map((a) => spendFor(a.name, ledger(), budget, now));
      const unsupported: Report[] = all
        .filter((a) => !limitCapable.includes(a) && !spendCapable.includes(a))
        .map((a) => ({ adapter: a.name, supported: false as const }));

      const lines = [...govLines, ...limitReports.map(renderReport), ...spendReports.map((s) => renderSpend(s.spend))];
      if (unsupported.length > 0) {
        lines.push(`no limits reporting: ${unsupported.map((u) => u.adapter).join(", ")}`);
      }
      return ok(lines.join("\n"), { reports: [...limitReports, ...spendReports, ...unsupported], ...(governor ? { governor } : {}) });
    },
  };
}

function hasLimits(a: Adapter): boolean {
  return a.readLimits !== undefined && a.parseLimits !== undefined;
}

/** Spend-capable: some capability parses usage, a budget is configured, or the ledger holds usage for it. */
function hasSpend(a: Adapter, budget: Record<string, AdapterBudget>, entries: LedgerEntry[]): boolean {
  if (Object.values(a.capabilities).some((c) => typeof c.parseUsage === "function")) return true;
  if (budget[a.name] !== undefined) return true;
  return entries.some((e) => e.adapter === a.name && e.usage !== null);
}

function lazyLedger(rt: Runtime): () => LedgerEntry[] {
  let cache: LedgerEntry[] | undefined;
  return () => (cache ??= readLedger({ path: rt.ledgerPath }));
}

function spendFor(adapter: string, entries: LedgerEntry[], budget: Record<string, AdapterBudget>, now: number): SpendEntry {
  const s: SpendSummary = summarizeSpend(entries, { now, adapter, budget });
  // Flat fields mirror the rolling-24h window (the one a pre-dispatch gate cares about).
  return { adapter, spend: { adapter, ...s.last24h, last24h: s.last24h, month: s.month, budget: s.budget } };
}

async function reportFor(adapter: { name: string }, refresh: boolean): Promise<Report> {
  const full = adapter as Parameters<typeof readAdapterLimits>[0];
  if (full.readLimits === undefined || full.parseLimits === undefined) {
    return { adapter: adapter.name, supported: false };
  }
  const result = await readAdapterLimits(full, { refresh });
  return result.ok
    ? { adapter: adapter.name, supported: true, ok: true, snapshot: result.snapshot }
    : { adapter: adapter.name, supported: true, ok: false, error: result.error };
}

function renderReport(report: Report): string {
  if (!report.supported) return `${report.adapter}: does not report account limits`;
  if (!report.ok) return `${report.adapter}: could not read limits — ${report.error}`;
  return formatSnapshot(report.snapshot);
}

/** Dollars for display. A known tiny cost keeps its precision; it is never rounded to look free. */
export function usd(n: number): string {
  if (n > 0 && n < 0.0001) return `$${n.toFixed(6)}`; // never round a real cost to a free-looking $0.0000
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function renderSpend(s: SpendReport): string {
  const day = s.budget?.dailyUsd !== undefined ? ` of ${usd(s.budget.dailyUsd)} daily` : "";
  const mon = s.budget?.monthlyUsd !== undefined ? ` of ${usd(s.budget.monthlyUsd)}` : "";
  const failed = s.last24h.failedJobs > 0 ? ` (${s.last24h.failedJobs} failed)` : "";
  const parts = [
    `${usd(s.last24h.costUsd)} in 24h${day}`,
    `${usd(s.month.costUsd)} this month${mon}`,
    `${s.last24h.jobs} jobs${failed}`,
    `${s.last24h.unknownCostJobs} unknown-cost`,
  ];
  let out = `${s.adapter} spend: ${parts.join(" · ")}`;
  if (s.last24h.unknownCostJobs > 0 || s.month.unknownCostJobs > 0) {
    out += " (each unknown-cost job is charged $0.25 against the budget)";
  }
  return out;
}

function recentRows(rt: Runtime, adapter: string | undefined, n: number) {
  const entries = readLedger({ path: rt.ledgerPath, adapter });
  const rows = entries.slice(-n).reverse().map((e) => ({
    ts: e.ts,
    jobId: e.jobId,
    adapter: e.adapter,
    kind: e.kind,
    state: e.state,
    durationMs: e.durationMs,
    costUsd: e.usage?.costUsd ?? null,
    summary: e.summary,
  }));
  if (rows.length === 0) {
    return ok(`no ledger rows${adapter ? ` for ${adapter}` : ""}.`, { rows });
  }
  const lines = rows.map((r) => {
    const cost = r.costUsd === null ? "cost unknown" : usd(r.costUsd);
    const summary = r.summary.replace(/\s+/g, " ").slice(0, 120);
    return `${new Date(r.ts).toISOString()} ${r.adapter}/${r.kind} ${r.state} ${r.durationMs}ms ${cost} — ${summary}`;
  });
  return ok(lines.join("\n"), { rows });
}
