/**
 * check_adapter — a liveness + auth health check for an adapter. `list_adapters`
 * reports `binaryPresent` via `Bun.which`, which is a PATH check only: it cannot
 * see whether the CLI is logged in or has an active subscription. This tool
 * closes that gap by running a minimal real work unit through the normal dispatch
 * path and reporting what actually happened.
 *
 * Every determinable health verdict (missing / present_unverified / ok / failed /
 * timeout) is returned via `ok(...)` — mirroring how list_adapters reports
 * `binaryPresent: false` as a successful determination, not an error. `err(...)`
 * is reserved for the two cases that are genuinely not health verdicts: an
 * unknown adapter name, and a synchronous throw from the probe dispatch itself.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Job } from "../types.ts";
import { findAdapter, type Runtime } from "./runtime.ts";
import { err, friendlyMessage, ok, type ToolModule } from "./shared.ts";

export const name = "check_adapter";
export const title = "Health-check an adapter (liveness + auth)";
export const description =
  "Check whether an adapter's CLI is not just installed but actually usable — logged in, with an active " +
  "subscription. list_adapters' binaryPresent is a PATH check only and cannot see auth state; this tool runs a " +
  "minimal live probe through the normal dispatch path and returns a status: ok | failed | timeout | " +
  "present_unverified | missing. Use it before relying on a harness you haven't exercised this session.";

/** A trivial, side-effect-free work unit whose returned contract marker proves the harness ran and is authed. */
const PROBE_PROMPT =
  "Health check only. Do not read files, run tools, or make changes. " +
  "Reply with a single short sentence confirming you are operational.";
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

export const inputShape = {
  adapter: z.string().min(1).describe("Adapter name as reported by list_adapters, e.g. \"codex\"."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("How long to wait for the probe, in ms (default 60000). Clamped to the JobStore wait cap."),
  cwd: z.string().optional().describe("Working directory for the probe child process. Defaults to the server's cwd."),
};

type Input = z.output<z.ZodObject<typeof inputShape>>;

export function createCheckTool(rt: Runtime): ToolModule<typeof inputShape> {
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

      const binaryName = adapter.binary ?? adapter.name;
      const binaryPresent = Bun.which(binaryName) !== null;

      if (!binaryPresent) {
        return ok(`${adapter.name}: status missing — CLI "${binaryName}" is not on PATH. Install it, then re-check.`, {
          adapter: adapter.name,
          status: "missing",
          binaryPresent: false,
        });
      }

      if (adapter.probeable === false) {
        return ok(
          `${adapter.name}: status present_unverified — binary "${binaryName}" is on PATH, but this adapter opts ` +
            "out of automatic probing (a live probe would incur real cost). Dispatch a real job to confirm it is authenticated.",
          { adapter: adapter.name, status: "present_unverified", binaryPresent: true },
        );
      }

      // Live probe: run PROBE_PROMPT through the normal dispatch path.
      //
      // `mode:"read"` skips the write-write guard and, for adapters that HONOR
      // opts.mode (e.g. codex, which selects a read-only sandbox), keeps the probe
      // read-only. But write-capable harnesses like agy IGNORE opts.mode — agy's
      // buildArgs always emits `--dangerously-skip-permissions`, so mode alone
      // cannot stop it mutating the tree. Probe isolation therefore comes
      // STRUCTURALLY from the cwd, not from mode: when the caller supplies no cwd,
      // run the probe in a fresh throwaway temp dir so anything a write-capable
      // harness might write during a health check lands in a disposable location,
      // never the user's tree. A liveness/auth probe needs no repo context. If the
      // caller DID pass a cwd, honor their explicit choice and leave it untouched.
      const ownsTempCwd = args.cwd === undefined;
      const probeCwd = args.cwd ?? mkdtempSync(join(tmpdir(), "sdd-check-"));
      try {
        let jobId: string;
        try {
          jobId = rt.jobStore.dispatch(adapter, PROBE_PROMPT, { mode: "read", cwd: probeCwd });
        } catch (e) {
          return err(`${adapter.name}: probe dispatch failed: ${friendlyMessage(e)}`, {
            adapter: adapter.name,
            status: "failed",
            binaryPresent: true,
            code: "probe_dispatch_failed",
          });
        }

        const timeoutMs = args.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
        await rt.jobStore.wait([jobId], timeoutMs);
        const job = rt.jobStore.get(jobId);

        if (job?.state === "done") {
          return ok(`${adapter.name}: status ok — live probe completed; the harness ran and is authenticated.`, {
            adapter: adapter.name,
            status: "ok",
            binaryPresent: true,
            jobId,
          });
        }

        if (job?.state === "failed") {
          const detail = probeFailureDetail(job);
          return ok(
            `${adapter.name}: status failed — the CLI is installed but the probe did not succeed. This usually means ` +
              "it is not logged in, the subscription/quota is inactive, or the harness errored. Detail: " +
              detail,
            { adapter: adapter.name, status: "failed", binaryPresent: true, jobId, detail },
          );
        }

        // Still running (or unknown) after the timeout — inconclusive. Cancel the
        // child so a slow/hung probe doesn't leak.
        await rt.jobStore.cancel(jobId);
        return ok(
          `${adapter.name}: status timeout — the probe was still running after ${timeoutMs}ms and was cancelled. ` +
            "Inconclusive (slow model, network, or a hang); retry with a larger timeoutMs.",
          { adapter: adapter.name, status: "timeout", binaryPresent: true, jobId },
        );
      } finally {
        // Best-effort cleanup of the throwaway probe cwd on every exit path
        // (ok / failed / timeout-after-cancel / dispatch-throw). The per-job LOG
        // lives in JobStore's logDir, NOT this cwd, so removing it never touches
        // the log probeFailureDetail reads. Cleanup must never throw out of the
        // handler. Only remove a dir WE created — a caller-supplied cwd is theirs.
        if (ownsTempCwd) {
          try {
            rmSync(probeCwd, { recursive: true, force: true });
          } catch {
            // best-effort — a leftover temp dir is harmless
          }
        }
      }
    },
  };
}

/**
 * Build a bounded human-readable failure detail. The auth error usually lands on
 * stderr, which `result.raw` drops (adapters build raw from stdout only) but the
 * per-job log retains — so we tail the log to surface it. The log file never
 * contains secrets (JobStore invariant), so tailing it is safe. Reading the log
 * must never throw out of the handler: on any read failure we fall back to the
 * summary alone.
 */
function probeFailureDetail(job: Job): string {
  const summary = job.result?.summary ?? "";
  let logTail = "";
  try {
    logTail = readFileSync(job.logPath, "utf8").slice(-800).trim();
  } catch {
    // A missing/unreadable log is an acceptable fallback — summary alone stands.
  }
  const combined = summary + (logTail ? " — " + logTail : "");
  return (combined.trim() || "no output captured").slice(0, 1200);
}
