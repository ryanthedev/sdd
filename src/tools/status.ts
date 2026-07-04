/**
 * status — snapshot of a job's lifecycle state. Thin wrapper over
 * `JobStore.get`: JobStore itself is what decides `running` vs `done`/`failed`
 * (exit code AND parseResult marker validation, never pid-liveness alone —
 * DW-3.4); this handler only surfaces that decision, it never re-derives it.
 */
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import { err, ok, type ToolModule } from "./shared.ts";

export const name = "status";
export const title = "Check a job's lifecycle state";
export const description =
  "Returns a job's current state (running | done | failed) plus its adapter, mode, and exit code once " +
  "terminal. done/failed reflects the child's exit code AND the adapter's contract-marker validation — " +
  "never pid-liveness alone. Use result to collect the full structured output once terminal.";

export const inputShape = {
  jobId: z.string().min(1).describe("Job id returned by dispatch."),
};

type Input = z.output<z.ZodObject<typeof inputShape>>;

export function createStatusTool(rt: Runtime): ToolModule<typeof inputShape> {
  return {
    name,
    title,
    description,
    inputShape,
    handler: async (args: Input) => {
      const job = rt.jobStore.get(args.jobId);
      if (!job) {
        return err(`unknown job id "${args.jobId}"`, { code: "unknown_job" });
      }
      return ok(`job ${job.id} (${job.adapter}, ${job.mode}): ${job.state}`, {
        jobId: job.id,
        adapter: job.adapter,
        mode: job.mode,
        state: job.state,
        ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      });
    },
  };
}
