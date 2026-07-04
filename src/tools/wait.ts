/**
 * wait — opt-in blocking poll over a fan-out of jobs. Thin wrapper over
 * `JobStore.wait`, which already never blocks past its (clamped) timeout and
 * reports unknown ids instead of throwing; this handler just shapes the args
 * and the reply.
 */
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import { ok, type ToolModule } from "./shared.ts";

export const name = "wait";
export const title = "Block until a set of jobs is terminal, or a timeout elapses";
export const description =
  "Blocks until every job in jobIds is terminal (done|failed) or timeoutMs elapses, whichever comes first — " +
  "never blocks past the timeout. Returns a partial classification: done, stillRunning, and unknown " +
  "(ids that name no tracked job — reported, not thrown).";

export const inputShape = {
  jobIds: z.array(z.string().min(1)).min(1).describe("Job ids to wait on."),
  timeoutMs: z.number().int().positive().optional().describe("Max time to block, in ms. Defaults to a short poll-friendly timeout."),
};

type Input = z.output<z.ZodObject<typeof inputShape>>;

export function createWaitTool(rt: Runtime): ToolModule<typeof inputShape> {
  return {
    name,
    title,
    description,
    inputShape,
    handler: async (args: Input) => {
      const result = await rt.jobStore.wait(args.jobIds, args.timeoutMs);
      return ok(
        `done: ${result.done.length}, stillRunning: ${result.stillRunning.length}, unknown: ${result.unknown.length}`,
        { ...result },
      );
    },
  };
}
