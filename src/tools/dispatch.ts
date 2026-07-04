/**
 * dispatch — spawn a work unit on a named adapter. Thin wrapper: all spawn/
 * lifecycle/guard logic lives in JobStore (Phase 2); this handler only
 * resolves the adapter name, shapes DispatchOpts, and translates JobStore's
 * thrown errors (unknown-adapter is caught earlier here; write-write conflict,
 * bad cwd, etc. are caught from the JobStore call) into a clean MCP result.
 */
import { z } from "zod";
import type { DispatchOpts } from "../types.ts";
import { findAdapter, type Runtime } from "./runtime.ts";
import { err, friendlyMessage, ok, type ToolModule } from "./shared.ts";

export const name = "dispatch";
export const title = "Dispatch a work unit to an adapter";
export const description =
  "Spawn a scoped work-unit prompt on a named adapter (see list_adapters for available names/modes) as a " +
  "child process in the given cwd. Returns immediately with a jobId — dispatch never blocks; poll with " +
  "status/result or block with wait. write-mode jobs are serialized per cwd: a second concurrent write in " +
  "the same cwd is rejected with an actionable error.";

export const inputShape = {
  adapter: z.string().min(1).describe('Adapter name as reported by list_adapters, e.g. "codex".'),
  prompt: z.string().min(1).describe("The work-unit prompt sent to the harness."),
  cwd: z.string().optional().describe("Working directory for the child process. Defaults to the server's cwd."),
  mode: z
    .enum(["read", "write"])
    .optional()
    .describe("Override the adapter's default mode. write jobs are serialized per cwd; read jobs run concurrently."),
  timeoutMs: z.number().int().positive().optional().describe("Adapter-specific advisory timeout in ms."),
};

type Input = z.output<z.ZodObject<typeof inputShape>>;

export function createDispatchTool(rt: Runtime): ToolModule<typeof inputShape> {
  return {
    name,
    title,
    description,
    inputShape,
    handler: async (args: Input) => {
      const adapter = findAdapter(rt, args.adapter);
      if (!adapter) {
        return err(`unknown adapter "${args.adapter}" — call list_adapters to see available adapters.`, {
          code: "unknown_adapter",
        });
      }

      const opts: DispatchOpts = {
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      };

      try {
        const jobId = rt.jobStore.dispatch(adapter, args.prompt, opts);
        return ok(`dispatched "${adapter.name}" as ${jobId} (mode ${opts.mode ?? adapter.mode})`, { jobId });
      } catch (e) {
        return err(`dispatch failed: ${friendlyMessage(e)}`, { code: "dispatch_failed" });
      }
    },
  };
}
