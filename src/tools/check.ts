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
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { resolveWorkUnit } from "../adapters/types.ts";
import type { Adapter } from "../adapters/types.ts";
import { formatSnapshot, readAdapterLimits } from "../lib/limits.ts";
import type { Job, UsageSnapshot } from "../types.ts";
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

/**
 * Ceiling on the account-limits addendum. Deliberately far below the probe
 * timeout: the limits read is a nice-to-have on a health verdict, so a slow or
 * broken endpoint must degrade to "unavailable" quickly rather than hold up the
 * answer the caller actually asked for.
 */
const LIMITS_TIMEOUT_MS = 5_000;

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

      // Read account limits BEFORE the live probe, not after: the probe spends a
      // real model request, and when it fails, "82% of your weekly window is
      // gone" is the difference between a useful diagnosis and a guess. Costs no
      // tokens; a harness that can't report limits contributes nothing here.
      const limits = await readLimitsAddendum(adapter, args.timeoutMs);

      if (adapter.probeable === false) {
        return ok(
          `${adapter.name}: status present_unverified — binary "${binaryName}" is on PATH, but this adapter opts ` +
            "out of automatic probing (a live probe would incur real cost). Dispatch a real job to confirm it is authenticated." +
            limits.text,
          { adapter: adapter.name, status: "present_unverified", binaryPresent: true, ...limits.structured },
        );
      }

      // Live probe: run PROBE_PROMPT through the normal dispatch path.
      //
      // Isolation is STRUCTURAL, and unconditional. A probeable adapter is an
      // agent harness launched with its approval flag on (codex `--sandbox
      // workspace-write`, agy `--dangerously-skip-permissions`, the API-key CLIs
      // `--yolo`/`--auto-approve`), so nothing in the prompt can stop one from
      // mutating whatever tree it lands in — only the cwd we hand it can. When
      // the caller names no cwd, the probe therefore runs in a fresh throwaway
      // temp dir, so any write lands off-tree rather than in the user's working
      // directory. A caller-supplied cwd is always honored (their explicit
      // choice); no temp dir is created, git-initialized, or cleaned in that case.
      const ownsTempCwd = args.cwd === undefined;
      const probeCwd = args.cwd ?? makeProbeCwd();
      try {
        let jobId: string;
        try {
          // Probe the harness's DEFAULT capability. A liveness check answers
          // "is this harness installed and authenticated", which any capability
          // would prove — so use the cheapest, and never a side-effecting one
          // like image generation.
          const unit = resolveWorkUnit(adapter);
          if ("error" in unit) {
            return err(`${adapter.name}: ${unit.error}`, {
              adapter: adapter.name,
              status: "failed",
              binaryPresent: true,
              code: "probe_dispatch_failed",
            });
          }
          jobId = rt.jobStore.dispatch(unit, PROBE_PROMPT, { cwd: probeCwd });
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
          return ok(
            `${adapter.name}: status ok — live probe completed; the harness ran and is authenticated.` + limits.text,
            {
              adapter: adapter.name,
              status: "ok",
              binaryPresent: true,
              jobId,
              ...limits.structured,
            },
          );
        }

        if (job?.state === "failed") {
          const detail = probeFailureDetail(job);
          return ok(
            `${adapter.name}: status failed — the CLI is installed but the probe did not succeed. This usually means ` +
              "it is not logged in, the subscription/quota is inactive, or the harness errored. Detail: " +
              detail +
              limits.text,
            { adapter: adapter.name, status: "failed", binaryPresent: true, jobId, detail, ...limits.structured },
          );
        }

        // Still running (or unknown) after the timeout — inconclusive. Cancel the
        // child so a slow/hung probe doesn't leak.
        await rt.jobStore.cancel(jobId);
        return ok(
          `${adapter.name}: status timeout — the probe was still running after ${timeoutMs}ms and was cancelled. ` +
            "Inconclusive (slow model, network, or a hang); retry with a larger timeoutMs." +
            limits.text,
          { adapter: adapter.name, status: "timeout", binaryPresent: true, jobId, ...limits.structured },
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
 * Best-effort account-limits read, rendered as an addendum to whatever health
 * verdict the caller gets.
 *
 * "Best-effort" is the whole point: check_adapter's job is the health verdict,
 * and a limits endpoint that is missing, slow, or broken must never change that
 * verdict or fail the call. A failed read degrades to a short note; an adapter
 * without the capability adds nothing at all.
 */
async function readLimitsAddendum(
  adapter: Adapter,
  callerTimeoutMs: number | undefined,
): Promise<{ text: string; structured: { limits?: UsageSnapshot; limitsError?: string } }> {
  if (adapter.readLimits === undefined || adapter.parseLimits === undefined) {
    return { text: "", structured: {} };
  }
  // The addendum must never dominate the call it is attached to. It gets its own
  // short ceiling, further capped by whatever the caller allowed for the health
  // check itself — otherwise a harness with a broken limits endpoint turns a 3s
  // check_adapter into a 15s one, because the default read timeout is unrelated
  // to the caller's budget.
  const timeoutMs = Math.min(LIMITS_TIMEOUT_MS, callerTimeoutMs ?? LIMITS_TIMEOUT_MS);
  const result = await readAdapterLimits(adapter, { timeoutMs });
  if (!result.ok) return { text: ` (account limits unavailable: ${result.error})`, structured: { limitsError: result.error } };
  return { text: `\nAccount limits — ${formatSnapshot(result.snapshot)}`, structured: { limits: result.snapshot } };
}

/**
 * Create the throwaway cwd the probe runs in, as a git repo.
 *
 * The `git init` is load-bearing, not hygiene: codex refuses to run in a
 * directory that is not a git repo ("Not inside a trusted directory and
 * --skip-git-repo-check was not specified", verified against the real CLI) — in
 * a bare temp dir it exits without ever contacting the model, which check_adapter
 * would then report as `failed` and read as "codex is not authenticated". A
 * git-initialized dir probes clean. Best-effort: if `git` is missing the temp dir
 * still stands, and harnesses that don't care (agy, the API-key CLIs) run in it fine.
 */
function makeProbeCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdd-check-"));
  spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  return dir;
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
