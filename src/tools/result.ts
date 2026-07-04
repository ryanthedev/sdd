/**
 * result — collect a job's structured AdapterResult. Critically: a still-
 * running job returns an explicit `{status:"running"}` marker, never a
 * partial/empty `summary`/`artifacts`/`raw` that a caller could mistake for a
 * completed-but-empty result (the plan's edge case: "result on a still-running
 * job returns running status, not a partial artifact").
 */
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import { err, ok, type ToolModule } from "./shared.ts";

export const name = "result";
export const title = "Collect a job's structured result";
export const description =
  "Collects the structured {status, summary, artifacts, raw} result of a terminal job (done | failed). " +
  "If the job is still running, returns {status:\"running\"} with no summary/artifacts/raw — never a " +
  "partial result. Poll status or use wait to know when a job is terminal.";

export const inputShape = {
  jobId: z.string().min(1).describe("Job id returned by dispatch."),
};

type Input = z.output<z.ZodObject<typeof inputShape>>;

export function createResultTool(rt: Runtime): ToolModule<typeof inputShape> {
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
      if (job.state === "running" || !job.result) {
        return ok(`job ${job.id} is still running`, { jobId: job.id, status: "running" as const });
      }
      const { status, summary, artifacts, raw } = job.result;
      return ok(`job ${job.id} ${status}: ${summary}`, { jobId: job.id, status, summary, artifacts, raw });
    },
  };
}
