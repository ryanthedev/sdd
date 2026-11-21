/**
 * list_models — report the models (and per-model effort levels / service tiers)
 * each harness advertises, without running a work unit.
 *
 * Uses each adapter's declarative `readModels` + `parseModels` live probe
 * (`codex app-server` `model/list`, `agy models`, `grok models`) or static
 * `models` list (`claude` aliases). Cached ~5 minutes; pass `refresh: true` to
 * force a live read.
 */
import { z } from "zod";
import type { Adapter } from "../adapters/types.ts";
import { formatModelsSnapshot, hasModelDiscovery, readAdapterModels } from "../lib/models.ts";
import type { ModelsSnapshot } from "../types.ts";
import { findAdapter, listAdapters, type Runtime } from "./runtime.ts";
import { err, ok, type ToolModule } from "./shared.ts";

export const name = "list_models";
export const title = "List available models and effort levels per adapter";
export const description =
  "Report the models each harness supports — live from the CLI where available (codex via app-server model/list, " +
  "agy via `agy models`, grok via `grok models`) or static aliases (claude). Includes per-model default flag, " +
  "supported effort levels, and service tiers when reported. Costs no tokens and runs no work unit; cached ~5m " +
  "(pass refresh: true to force a live read). Omit `adapter` to query every model-capable adapter.";

export const inputShape = {
  adapter: z
    .string()
    .min(1)
    .optional()
    .describe('Adapter to query, e.g. "codex", "agy", "grok", or "claude". Omit to query all model-capable adapters.'),
  refresh: z
    .boolean()
    .optional()
    .describe("Bypass the cache and force a live read. Default false (cached up to 5 minutes)."),
};

type Input = z.output<z.ZodObject<typeof inputShape>>;

type Report =
  | { adapter: string; supported: true; ok: true; snapshot: ModelsSnapshot }
  | { adapter: string; supported: true; ok: false; error: string }
  | { adapter: string; supported: false };

export function createListModelsTool(rt: Runtime): ToolModule<typeof inputShape> {
  return {
    name,
    title,
    description,
    inputShape,
    handler: async (args: Input) => {
      const refresh = args.refresh === true;

      if (args.adapter !== undefined) {
        const adapter = findAdapter(rt, args.adapter);
        if (!adapter) {
          return err(`unknown adapter "${args.adapter}" — call list_adapters to see available adapters.`, {
            code: "unknown_adapter",
          });
        }
        const report = await reportFor(adapter, refresh);
        return ok(renderReport(report), { reports: [report] });
      }

      const all = listAdapters(rt);
      const capable = all.filter(hasModelDiscovery);
      if (capable.length === 0) {
        return ok("no discovered adapter reports available models.", { reports: [] });
      }

      const reports = await Promise.all(capable.map((a) => reportFor(a, refresh)));
      const unsupported: Report[] = all
        .filter((a) => !capable.includes(a))
        .map((a) => ({ adapter: a.name, supported: false as const }));

      const lines = reports.map(renderReport);
      if (unsupported.length > 0) {
        lines.push(`no model listing: ${unsupported.map((u) => u.adapter).join(", ")}`);
      }
      return ok(lines.join("\n\n"), { reports: [...reports, ...unsupported] });
    },
  };
}

async function reportFor(adapter: Adapter, refresh: boolean): Promise<Report> {
  if (!hasModelDiscovery(adapter)) {
    return { adapter: adapter.name, supported: false };
  }
  const result = await readAdapterModels(adapter, { refresh });
  return result.ok
    ? { adapter: adapter.name, supported: true, ok: true, snapshot: result.snapshot }
    : { adapter: adapter.name, supported: true, ok: false, error: result.error };
}

function renderReport(report: Report): string {
  if (!report.supported) return `${report.adapter}: does not report available models`;
  if (!report.ok) return `${report.adapter}: could not list models — ${report.error}`;
  return formatModelsSnapshot(report.snapshot);
}
