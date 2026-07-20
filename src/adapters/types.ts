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
import type { AdapterResult, DispatchOpts } from "../types.ts";

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
   * Build the child-process argv for this work unit.
   *
   * MUST return a `string[]` (argv array), never a shell string. This is the
   * type-level guardrail against command injection: because the JobStore spawns
   * this array directly with no shell, a prompt containing shell metacharacters
   * is passed as literal argument text and can never be evaluated.
   */
  buildArgs(prompt: string, opts: DispatchOpts): string[];

  /**
   * Wrap the caller's prompt with this adapter's output-contract markers so the
   * harness is instructed to emit a parseable, validatable response. The result
   * is what actually gets sent to the harness.
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
