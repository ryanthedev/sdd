/**
 * cancel — terminate a running job's process group. Thin wrapper over
 * `JobStore.cancel`, which is a no-op (returns false) for an unknown or
 * already-terminal job rather than throwing.
 */
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import { ok, type ToolModule } from "./shared.ts";

export const name = "cancel";
export const title = "Cancel a running job";
export const description =
  "Terminates a running job's entire process group. No-op (cancelled:false) for an unknown or already-" +
  "terminal job id — never throws.";

export const inputShape = {
  jobId: z.string().min(1).describe("Job id returned by dispatch."),
};

type Input = z.output<z.ZodObject<typeof inputShape>>;

export function createCancelTool(rt: Runtime): ToolModule<typeof inputShape> {
  return {
    name,
    title,
    description,
    inputShape,
    handler: async (args: Input) => {
      const cancelled = await rt.jobStore.cancel(args.jobId);
      return ok(cancelled ? `job ${args.jobId} cancelled` : `job ${args.jobId} not cancelled (unknown or already terminal)`, {
        jobId: args.jobId,
        cancelled,
      });
    },
  };
}
