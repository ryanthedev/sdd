/**
 * The Adapter port — the single outbound-adapter boundary of the hexagon.
 *
 * A harness (codex, agy, agy-image) is an Adapter: pure data + pure functions,
 * no process spawning. The JobStore (Phase 2) owns spawning; it calls buildArgs
 * to get an argv array, spawns it without a shell, then calls parseResult on the
 * captured output. Keeping adapters free of I/O is what lets them be unit-tested
 * by feeding stdout/stderr/exitCode straight into parseResult.
 *
 * Dependency direction (Clean Architecture): this boundary imports the core
 * domain types inward. Nothing in the core imports this port.
 */
import type { AdapterResult, DispatchOpts, UsageSnapshot } from "../types.ts";

/**
 * Pure DATA describing how to read a harness's account limits. The adapter
 * declares the call; `src/lib/limits.ts` performs it. That split is what keeps
 * this port I/O-free: an adapter never spawns anything, so `readLimits` can be
 * asserted in a unit test by inspecting the literal.
 *
 * SECURITY: every field here is author-written code, never caller input, and
 * `limits.ts` spawns `[binary, ...args]` with `shell:false` and no prompt — so
 * unlike a dispatch argv there is no caller-controlled element at all.
 *
 * `transport: "app-server-jsonrpc"` is the only transport implemented today:
 * spawn the binary, exchange newline-delimited JSON-RPC over stdio, send
 * `initialize`, then call `method` with null params. A future harness needing a
 * different shape adds a transport tag here and a branch in limits.ts.
 */
export interface LimitsProbe {
  transport: "app-server-jsonrpc";
  /** Binary to spawn, e.g. "codex". */
  binary: string;
  /** Fixed args placed after the binary, e.g. ["app-server"]. */
  args: string[];
  /** JSON-RPC method to call after initialize, e.g. "account/rateLimits/read". */
  method: string;
}

/**
 * ONE thing a harness can be asked to do — the triple that turns a prompt into
 * an argv, wraps it in an output contract, and validates what comes back.
 *
 * A capability is the unit the JobStore runs. Splitting it out from `Adapter`
 * is what lets one harness expose several contracts (agy reviews, generates
 * images, and fuses video frames; codex reviews and generates images) WITHOUT
 * the caller having to know which file implements which — previously that was
 * encoded as separate adapter names (`agy-image`, `agy-vision`), leaking an
 * internal taxonomy into the public dispatch surface.
 *
 * Marker validation stays exactly as strict as before: each capability owns its
 * own contract and parser, so "one output contract per unit" still holds. That
 * invariant lives here now instead of in the filename.
 */
export interface Capability {
  /**
   * Build the child-process argv for this work unit.
   *
   * MUST return a `string[]` (argv array), never a shell string. This is the
   * type-level guardrail against command injection: because the JobStore spawns
   * this array directly with no shell, a prompt containing shell metacharacters
   * is passed as literal argument text and can never be evaluated.
   */
  buildArgs(prompt: string, opts: DispatchOpts): string[];

  /**
   * Wrap the caller's prompt with this capability's output-contract markers so
   * the harness is instructed to emit a parseable, validatable response.
   */
  injectContract(prompt: string): string;

  /**
   * Turn a finished child's output into a structured AdapterResult. Extracts and
   * VALIDATES the contract markers: a missing marker yields `status: "failed"`
   * regardless of exitCode (the backstop for a harness that exits 0 but never
   * actually did the work).
   */
  parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult;
}

/**
 * A capability bound to the harness that runs it — the only shape the JobStore
 * ever sees. Keeping this narrower than `Adapter` means the spawning layer has
 * no notion of capability selection at all: resolution happens once, at the
 * tool boundary, and the dangerous component keeps receiving exactly what it
 * always received.
 */
export interface WorkUnit extends Capability {
  /** Harness name, for job records and error messages. */
  name: string;
}

/** Capability key used when an adapter exposes a single, unnamed capability. */
export const DEFAULT_KIND = "default";

export interface Adapter {
  /** Unique adapter name — also the on-disk filename stem and the dispatch key. */
  name: string;

  /**
   * CLI binary name to probe on PATH for `list_adapters`' binaryPresent check,
   * when it differs from `name` (e.g. the "mistral" adapter's binary is `vibe`).
   * Optional — defaults to `name` when omitted. This is ONLY the presence probe;
   * it does not affect dispatch, where `buildArgs` still controls argv[0].
   */
  binary?: string;

  /**
   * Live-probe policy for the `check_adapter` health tool. Omit (the default) to
   * let `check_adapter` run a generic liveness probe — a trivial work unit through
   * the normal dispatch path whose contract marker, when it comes back, proves the
   * harness actually ran and is authenticated. Set `false` to opt OUT of automatic
   * probing for adapters where a probe would incur real cost or side effects
   * (agy-image bills a real image generation and needs an output path a health
   * check can't supply) — `check_adapter` then reports binary presence only.
   */
  probeable?: boolean;

  /**
   * Everything this harness can be asked to do, keyed by `kind` — the value a
   * caller passes to `dispatch`. A harness that does one thing exposes a single
   * `DEFAULT_KIND` entry (discovery builds that automatically from a module
   * that exports `buildArgs`/`injectContract`/`parseResult` flat, so simple
   * adapters stay one-file-drop-in with no extra ceremony).
   */
  capabilities: Record<string, Capability>;

  /**
   * Which `kind` to run when the caller doesn't name one. Optional: with a
   * single capability that one is the default, so this only matters for a
   * multi-capability harness.
   */
  defaultKind?: string;

  /**
   * OPTIONAL account-limits capability, declared as pure data (see LimitsProbe).
   * Present only on harnesses whose CLI can report quota without running a work
   * unit. Omit it and the adapter simply reports no usage — `usage` skips it and
   * `check_adapter` returns exactly what it always did.
   *
   * `readLimits` and `parseLimits` are a PAIR: declaring one without the other is
   * a malformed adapter and discovery rejects the file (a probe with no parser
   * could only ever produce an unusable raw blob).
   */
  readLimits?: LimitsProbe;

  /**
   * Map this harness's own limits payload into the normalized UsageSnapshot.
   * PURE — it receives the already-fetched JSON-RPC `result` and returns a
   * snapshot, so a vendor payload shape can be regression-tested from a fixture
   * with no process and no network.
   *
   * MUST tolerate a payload that does not match expectations (fields absent,
   * null, or the wrong type) by omitting them, never by throwing: a harness that
   * changes its schema should degrade to a thinner snapshot, not break `usage`.
   * `adapter` and `fetchedAt` are stamped by limits.ts, not by this function.
   */
  parseLimits?(raw: unknown): Omit<UsageSnapshot, "adapter" | "fetchedAt">;
}

/**
 * What an adapter FILE exports, for the compile-time `_check` proof each one
 * carries. Two accepted shapes, both normalized into `Adapter` by discovery:
 *
 *   - FLAT — export `buildArgs`/`injectContract`/`parseResult` at module level.
 *     The one-thing-one-harness case (grok, kimi, qwen, yt-dlp, …). Discovery
 *     wraps them as a single `DEFAULT_KIND` capability, so a simple adapter is
 *     still a single file with no extra ceremony.
 *   - MULTI — export a `capabilities` record. For a harness that genuinely does
 *     more than one thing under one binary (agy, codex).
 *
 * Both are valid; neither is preferred. Adding a second capability to a flat
 * adapter is a local edit to that file, not a migration.
 */
export interface FlatAdapterModule extends Capability {
  name: string;
  binary?: string;
  probeable?: boolean;
  readLimits?: LimitsProbe;
  parseLimits?(raw: unknown): Omit<UsageSnapshot, "adapter" | "fetchedAt">;
}

export interface MultiAdapterModule {
  name: string;
  capabilities: Record<string, Capability>;
  defaultKind?: string;
  binary?: string;
  probeable?: boolean;
  readLimits?: LimitsProbe;
  parseLimits?(raw: unknown): Omit<UsageSnapshot, "adapter" | "fetchedAt">;
}

export type AdapterModule = FlatAdapterModule | MultiAdapterModule;

/**
 * Resolve `adapter` + an optional caller-supplied `kind` into the single
 * WorkUnit the JobStore will run. Returns a plain error string rather than
 * throwing, because "you asked for a kind this harness doesn't have" is a
 * routine caller mistake that deserves a listing of the real options, not a
 * stack trace.
 *
 * Resolution order:
 *   1. an explicit `kind` — must exist, no silent fallback to the default. A
 *      typo'd kind quietly running the review contract instead of generating
 *      an image is exactly the class of failure this port exists to prevent.
 *   2. no kind, exactly one capability — that one.
 *   3. no kind, `defaultKind` declared — that one.
 *   4. otherwise — ambiguous; make the caller choose.
 */
export function resolveWorkUnit(adapter: Adapter, kind?: string): WorkUnit | { error: string } {
  const kinds = Object.keys(adapter.capabilities);
  const listing = kinds.length > 0 ? kinds.join(", ") : "(none)";

  if (kind !== undefined) {
    const chosen = adapter.capabilities[kind];
    if (!chosen) {
      return { error: `adapter "${adapter.name}" has no kind "${kind}" — available: ${listing}` };
    }
    return { name: adapter.name, ...chosen };
  }

  if (kinds.length === 1) {
    const only = adapter.capabilities[kinds[0]!]!;
    return { name: adapter.name, ...only };
  }

  const fallback = adapter.defaultKind !== undefined ? adapter.capabilities[adapter.defaultKind] : undefined;
  if (fallback) return { name: adapter.name, ...fallback };

  return { error: `adapter "${adapter.name}" needs an explicit kind — available: ${listing}` };
}
