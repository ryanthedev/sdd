/**
 * list_adapters — composes Phase 1's `discoverAdapters()` with a PATH
 * presence check for each adapter's underlying CLI. No JobStore involvement:
 * this is pure discovery + a synchronous `Bun.which` lookup, no subprocess.
 *
 * Assumption (documented, not solved generically): the adapter's `name`
 * doubles as its CLI binary name. True for `codex` (this phase's only
 * adapter); the frozen Adapter port (Phase 1, read-only here) has no separate
 * binary-name field.
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
        binaryPresent: Bun.which(a.name) !== null,
      }));
      const lines = adapters.map((a) => `${a.name} (${a.mode}) — binary ${a.binaryPresent ? "present" : "MISSING"} on PATH`);
      return ok(lines.length > 0 ? lines.join("\n") : "no adapters discovered", { adapters });
    },
  };
}
