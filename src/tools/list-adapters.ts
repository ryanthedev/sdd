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
  "Lists every adapter discovered under the adapters directory with a binaryPresent flag: whether the " +
  "adapter's underlying CLI is on PATH. Harnesses that can do more than one thing also report their " +
  "`kinds` — pass one as dispatch's `kind` (e.g. \"image\"). Call this before dispatch to see what's " +
  "available and whether the harness is actually installed.";

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
      }));
      // Only mention kinds for a harness that has more than one. Printing
      // "kinds: default" on every single-purpose adapter would train the caller
      // to pass a `kind` it never needs.
      const lines = adapters.map((a) => {
        const extra = a.kinds.length > 1 ? ` — kinds: ${a.kinds.join(", ")}` : "";
        return `${a.name} — binary ${a.binaryPresent ? "present" : "MISSING"} on PATH${extra}`;
      });
      return ok(lines.length > 0 ? lines.join("\n") : "no adapters discovered", { adapters });
    },
  };
}
