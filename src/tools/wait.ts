/**
 * wait — opt-in blocking poll over a fan-out of jobs. Thin wrapper over
 * `JobStore.wait`, which already never blocks past its (clamped) timeout and
 * reports unknown ids instead of throwing; this handler shapes the args and the
 * reply, and attaches each terminal job's result (minus `raw`) so a caller needs
 * no follow-up `result` call.
 */
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import { ok, type ToolModule } from "./shared.ts";

export const name = "wait";
export const title = "Block until a set of jobs is terminal, or a timeout elapses";
export const description =
  "Blocks until every job in jobIds is terminal (done|failed) or timeoutMs elapses, whichever comes first — " +
  "never blocks past the timeout. Returns a partial classification: done, stillRunning, and unknown " +
  "(ids that name no tracked job — reported, not thrown), plus `results` for every terminal job " +
  "({jobId, adapter, kind, status, summary, artifacts}, no raw output) so no extra `result` call is needed; " +
  "call `result` only when you need the raw output.";

export const inputShape = {
  jobIds: z.array(z.string().min(1)).min(1).describe("Job ids to wait on."),
  timeoutMs: z.number().int().positive().optional().describe("Max time to block, in ms. Defaults to a short poll-friendly timeout."),
};

type Input = z.output<z.ZodObject<typeof inputShape>>;

const SUMMARY_TEXT_MAX = 300;

export function createWaitTool(rt: Runtime): ToolModule<typeof inputShape> {
  return {
    name,
    title,
    description,
    inputShape,
    handler: async (args: Input) => {
      const result = await rt.jobStore.wait(args.jobIds, args.timeoutMs);
      const results = result.done.flatMap((jobId) => {
        const job = rt.jobStore.get(jobId);
        if (!job) return [];
        return [
          {
            jobId,
            adapter: job.adapter,
            kind: job.kind,
            status: job.result?.status ?? job.state,
            summary: job.result?.summary ?? "",
            artifacts: job.result?.artifacts ?? [],
          },
        ];
      });
      const head = `done: ${result.done.length}, stillRunning: ${result.stillRunning.length}, unknown: ${result.unknown.length}`;
      const lines = results.map(
        (r) => `- ${r.jobId} [${r.adapter}/${r.kind}] ${r.status}: ${r.summary.replace(/\s+/g, " ").slice(0, SUMMARY_TEXT_MAX)}`,
      );
      return ok(lines.length > 0 ? `${head}\n${lines.join("\n")}` : head, { ...result, results });
    },
  };
}
