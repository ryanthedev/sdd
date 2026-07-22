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
 * One metered quota window reported by a harness's account (e.g. codex's
 * rolling 7-day `codex` bucket). `usedPercent` is the only field a harness is
 * required to know; window length and reset time are nullable because not every
 * backend reports them, and a missing value must read as "unknown" rather than
 * as zero.
 */
export interface UsageWindow {
  /** Bucket label — the harness's own limit id/name, e.g. "codex". */
  name: string;
  /** Percent of the window's allowance consumed, 0-100. */
  usedPercent: number;
  /** Window length in minutes, or null when the harness doesn't report one. */
  windowMinutes: number | null;
  /** Unix epoch SECONDS at which the window resets, or null when unreported. */
  resetsAt: number | null;
}

/**
 * A normalized point-in-time read of one harness's account limits — the shape
 * `usage` and `check_adapter` return, identical across harnesses so a caller
 * never has to learn a per-vendor payload. Each harness's own payload is mapped
 * into this by its adapter's pure `parseLimits`.
 *
 * This is a SNAPSHOT, not a subscription: `fetchedAt` is when it was read, and
 * a cached snapshot may be up to the cache TTL stale.
 */
export interface UsageSnapshot {
  /** Adapter the snapshot was read for. */
  adapter: string;
  /** Plan tier as the harness names it (e.g. "plus"), or null if unreported. */
  plan: string | null;
  /** Every metered window the harness reports. May be empty. */
  windows: UsageWindow[];
  /** Pay-as-you-go credit state, when the harness has such a concept. */
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  /** Non-null when the harness reports a limit is CURRENTLY exceeded. */
  limitReached: string | null;
  /**
   * A per-user SPEND-CONTROL ceiling, distinct from the metered windows above —
   * null when the harness reports none (the common case on personal plans;
   * codex populates it on team/business accounts). `remainingPercent` is
   * percent REMAINING, not consumed — the inverse of `UsageWindow.usedPercent`,
   * deliberately kept in the vendor's own orientation so a reader can check it
   * against the raw payload without a mental flip.
   *
   * Like `limitReached`, this is COLLAPSED across buckets: the harness reports
   * it per bucket, and the first bucket reporting one wins. A caller needing
   * per-bucket spend controls will not get them from this shape.
   */
  individualLimit: {
    limit: string | null;
    remainingPercent: number | null;
    resetsAt: number | null;
    used: string | null;
  } | null;
  /**
   * True when a spend-control ceiling (not a rate-limit window) is currently
   * hit; null when the harness doesn't report the distinction. Collapsed across
   * buckets exactly like `limitReached`.
   */
  spendControlReached: boolean | null;
  /**
   * Redeemable quota-reset grants — the thing behind codex's "You have 3 usage
   * limit resets available. Run /usage to use one." Null when the harness has
   * no such concept. This was silently dropped from the payload until
   * 2026-07-21 even though the fixture that tested `parseLimits` already
   * contained it.
   *
   * `availableCount` is the harness's own count of redeemable resets;
   * `entries` carries the per-grant detail when reported. An empty `entries`
   * with a non-zero `availableCount` is normal and must NOT be read as zero —
   * report the count.
   */
  resetCredits: {
    availableCount: number | null;
    entries: Array<{
      id: string | null;
      status: string | null;
      title: string | null;
      expiresAt: string | null;
    }>;
  } | null;
  /** Unix epoch MILLISECONDS when this snapshot was read. */
  fetchedAt: number;
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
