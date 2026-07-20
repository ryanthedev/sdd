/**
 * Core domain types for SDD — the inner layer of the ports-and-adapters design.
 *
 * Clean Architecture dependency rule: these types import nothing from the
 * adapters boundary or from any infrastructure (spawn, MCP SDK, filesystem).
 * The Adapter port (src/adapters/types.ts) and the JobStore (Phase 2) depend
 * inward on these; nothing here depends outward.
 */

/**
 * Lifecycle state of a dispatched job. A job is `running` until its child
 * process exits AND the adapter's parseResult has classified the output;
 * `done` and `failed` are terminal. `failed` reflects the exit code OR a
 * failed contract-marker validation (the exit-0 silent-misparse backstop) —
 * it is never inferred from pid-liveness alone.
 */
export type JobState = "running" | "done" | "failed";

/**
 * Structured result an adapter produces from a finished child process. This is
 * what a caller ultimately collects instead of a raw stdout blob: a normalized
 * status, a human summary, any produced artifact paths, and the raw text kept
 * for debugging.
 */
export interface AdapterResult {
  status: "done" | "failed";
  summary: string;
  artifacts: string[];
  raw: string;
}

/**
 * Options threaded from a dispatch call down into an adapter's buildArgs. The
 * base fields are common to every adapter; the open index signature lets each
 * adapter read its own adapter-specific keys (model, effort, …) without this
 * core type having to know about them.
 */
export interface DispatchOpts {
  cwd?: string;
  timeoutMs?: number;
  [k: string]: unknown;
}

/**
 * A dispatched work unit tracked by the JobStore (Phase 2). Identifies the
 * adapter that ran it, where it ran (cwd), its lifecycle state, and the path to
 * its per-job log. `exitCode` and `result` are populated once the child exits.
 */
export interface Job {
  id: string;
  adapter: string;
  cwd: string;
  state: JobState;
  logPath: string;
  createdAt: number;
  exitCode?: number;
  result?: AdapterResult;
}
