/**
 * usage — report how much of a harness's account quota is left, before you
 * spend it.
 *
 * This answers a question no other tool can: `list_adapters` sees PATH,
 * `check_adapter` sees auth, and neither sees whether you are about to run into
 * a weekly cap. Reading costs no tokens and runs no work unit (see
 * `src/lib/limits.ts`), so it is cheap to call before a fan-out.
 *
 * Not every harness can report this. Adapters that don't declare the capability
 * are listed as `unsupported` rather than omitted — "we can't see codex's quota"
 * and "codex has no quota" are different answers, and silently dropping the
 * adapter would conflate them.
 */
import { z } from "zod";
import { formatSnapshot, readAdapterLimits } from "../lib/limits.ts";
import type { UsageSnapshot } from "../types.ts";
import { findAdapter, listAdapters, type Runtime } from "./runtime.ts";
import { err, ok, type ToolModule } from "./shared.ts";

export const name = "usage";
export const title = "Report account quota/limits for a harness";
export const description =
  "Report how much of a harness's account quota is used and when it resets — e.g. codex's rolling weekly " +
  "window, plan tier, and credit balance. Costs no tokens and runs no work unit: it reads the CLI's own " +
  "account endpoint. Call it before a large fan-out, or when a job fails in a way that smells like a quota " +
  "wall. Omit `adapter` to report every harness that can answer; adapters that cannot are listed as " +
  "unsupported.";

export const inputShape = {
  adapter: z
    .string()
    .min(1)
    .optional()
    .describe("Adapter to report on, e.g. \"codex\". Omit to report every adapter that supports it."),
  refresh: z
    .boolean()
    .optional()
    .describe("Bypass the short-lived cache and force a live read. Default false (a cached snapshot may be up to a minute old)."),
};

type Input = z.output<z.ZodObject<typeof inputShape>>;

type Report =
  | { adapter: string; supported: true; ok: true; snapshot: UsageSnapshot }
  | { adapter: string; supported: true; ok: false; error: string }
  | { adapter: string; supported: false };

export function createUsageTool(rt: Runtime): ToolModule<typeof inputShape> {
  return {
    name,
    title,
    description,
    inputShape,
    handler: async (args: Input) => {
      // A named adapter that doesn't exist is a caller mistake worth erroring on;
      // a named adapter that exists but can't report quota is a legitimate answer.
      if (args.adapter !== undefined) {
        const adapter = findAdapter(rt, args.adapter);
        if (!adapter) {
          return err(`unknown adapter "${args.adapter}" — call list_adapters to see available adapters.`, {
            code: "unknown_adapter",
          });
        }
        const report = await reportFor(adapter, args.refresh === true);
        return ok(renderReport(report), { reports: [report] });
      }

      // Only adapters that declare the capability are probed — spawning every
      // harness on PATH to discover that most have no such endpoint would be
      // both slow and pointless.
      const all = listAdapters(rt);
      const capable = all.filter((a) => a.readLimits !== undefined && a.parseLimits !== undefined);
      if (capable.length === 0) {
        return ok("no discovered adapter reports account limits.", { reports: [] });
      }

      const reports = await Promise.all(capable.map((a) => reportFor(a, args.refresh === true)));
      const unsupported: Report[] = all
        .filter((a) => !capable.includes(a))
        .map((a) => ({ adapter: a.name, supported: false as const }));

      const lines = reports.map(renderReport);
      if (unsupported.length > 0) {
        lines.push(`no limits reporting: ${unsupported.map((u) => u.adapter).join(", ")}`);
      }
      return ok(lines.join("\n"), { reports: [...reports, ...unsupported] });
    },
  };
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
