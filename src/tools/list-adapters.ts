/**
 * list_adapters — composes Phase 1's `discoverAdapters()` with a PATH
 * presence check for each adapter's underlying CLI. No JobStore involvement:
 * this is pure discovery + a synchronous `Bun.which` lookup, no subprocess.
 *
 * The PATH probe targets the adapter's `binary` field when set, falling back to
 * `name` (they match for codex/agy/grok/qwen/kimi; the "mistral" adapter's CLI
 * is `vibe`, so it sets `binary: "vibe"`). The Adapter port carries the optional
 * `binary` field for exactly this name≠binary case.
 */
import { z } from "zod";
import { hasModelDiscovery } from "../lib/models.ts";
import { listAdapters, type Runtime } from "./runtime.ts";
import { ok, type ToolModule } from "./shared.ts";

export const name = "list_adapters";
export const title = "List discovered adapters";
export const description =
  "Lists every adapter discovered under the adapters directory with binaryPresent (whether the CLI is on PATH), " +
  "kinds (when a harness supports more than one), supported effortLevels, supportsReadOnly, and supportsModels " +
  "(call list_models to see live model ids). Call this before dispatch to see what's available.";

export const inputShape = {};

export function createListAdaptersTool(rt: Runtime): ToolModule<typeof inputShape> {
  return {
    name,
    title,
    description,
    inputShape,
    handler: async () => {
      const adapters = listAdapters(rt).map((a) => ({
        name: a.name,
        binaryPresent: Bun.which(a.binary ?? a.name) !== null,
        kinds: Object.keys(a.capabilities),
        ...(a.effortLevels !== undefined ? { effortLevels: [...a.effortLevels] } : {}),
        ...(a.supportsReadOnly !== undefined ? { supportsReadOnly: a.supportsReadOnly } : {}),
        ...(a.readOnlyNote !== undefined ? { readOnlyNote: a.readOnlyNote } : {}),
        supportsModels: hasModelDiscovery(a),
      }));
      // Only mention extras that are non-trivial so single-purpose adapters stay
      // concise. Keep the `<name> — binary <present|MISSING> on PATH` prefix intact.
      const lines = adapters.map((a) => {
        const extras: string[] = [];
        if (a.kinds.length > 1) extras.push(`kinds: ${a.kinds.join(", ")}`);
        if (a.effortLevels && a.effortLevels.length > 0) extras.push(`effort: ${a.effortLevels.join("|")}`);
        if (a.supportsReadOnly === true) extras.push(a.readOnlyNote ? `readOnly (${a.readOnlyNote})` : "readOnly");
        if (a.supportsModels) extras.push("models");
        const suffix = extras.length > 0 ? ` — ${extras.join(" · ")}` : "";
        return `${a.name} — binary ${a.binaryPresent ? "present" : "MISSING"} on PATH${suffix}`;
      });
      return ok(lines.length > 0 ? lines.join("\n") : "no adapters discovered", { adapters });
    },
  };
}
