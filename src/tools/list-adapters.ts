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
import { listAdapters, type Runtime } from "./runtime.ts";
import { ok, type ToolModule } from "./shared.ts";

export const name = "list_adapters";
export const title = "List discovered adapters";
export const description =
  "Lists every adapter discovered under the adapters directory, with its mode (read|write) and a " +
  "binaryPresent flag: whether the adapter's underlying CLI is on PATH. Call this before dispatch to see " +
  "what's available and whether the harness is actually installed.";

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
        mode: a.mode,
        binaryPresent: Bun.which(a.binary ?? a.name) !== null,
      }));
      const lines = adapters.map((a) => `${a.name} (${a.mode}) — binary ${a.binaryPresent ? "present" : "MISSING"} on PATH`);
      return ok(lines.length > 0 ? lines.join("\n") : "no adapters discovered", { adapters });
    },
  };
}
