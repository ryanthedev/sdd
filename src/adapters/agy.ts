/**
 * agy adapter — general-purpose review/implement harness invoked as
 * `agy <flags...> --print <prompt>`.
 *
 * FLAG ORDER: `--print` takes the single argv element immediately following
 * it as the prompt, so `buildArgs` keeps that pairing structural rather than
 * conventional — the prompt is always the LAST array element pushed and
 * `--print` always the element immediately before it, with no code path able
 * to insert anything after the prompt.
 *
 * CORRECTION (verified against agy 1.1.5, 2026-07-21): this header used to
 * call the above a "LANDMINE", asserting a trailing flag is "silently
 * absorbed into the prompt string" and that "agy exits 0 on this misparse".
 * Both halves are false for 1.1.5 — measured, agy rejects an unknown trailing
 * flag with "flags provided but not defined" and exit 2, and an invalid value
 * with exit 1, both before any model call. The ordering rule stays because it
 * is the house rule for every adapter, not because agy misbehaves.
 *
 * `parseResult` still requires the `AGY_RESULT:` marker (injected via
 * `injectContract`) and classifies a job `failed` without it regardless of
 * exit code — the general silent-misparse backstop for any harness that exits
 * clean without doing the work. See the Adapter port docs
 * (src/adapters/types.ts).
 *
 * MARKER-COLLISION LANDMINE: `injectContract` embeds the literal strings
 * `AGY_RESULT: DONE` / `AGY_RESULT: FAILED` into the prompt as instructions.
 * A harness that echoes those instructions back (verbose logging, a nested
 * agent restating context) before printing its real, final verdict makes
 * BOTH strings appear in stdout — the earlier one is the echoed instruction,
 * not the outcome. The contract (see `injectContract` below) defines the
 * marker as "the last line of output," so `parseResult` must scan for the
 * LAST marker-shaped line, not the first — otherwise an echoed `DONE`
 * example can mask a real, later `FAILED` verdict. `lastMarkerMatch`
 * (`_agy-shared.ts`) scans every match and keeps the final one for exactly
 * this reason.
 *
 * The argv-order guarantee and `lastMarkerMatch` live in `_agy-shared.ts`
 * (shared with `agy-image.ts`) so the flag-order and marker-collision fixes
 * exist exactly once.
 */
import { buildAgyArgv, lastMarkerMatch } from "./_agy-shared.ts";
import type { FlatAdapterModule } from "./types.ts";
import type { AdapterResult, DispatchOpts } from "../types.ts";

export const name = "agy";

/**
 * Marker line the harness must echo verbatim to confirm a real outcome.
 * Anchored to the WHOLE line (start-to-end, modulo surrounding whitespace) so
 * a marker mentioned mid-sentence doesn't collide; `g` so every occurrence in
 * stdout can be enumerated and the LAST one taken (see `lastMarkerMatch`).
 */
const RESULT_MARKER_RE = /^AGY_RESULT:\s*(DONE|FAILED)\s*$/gm;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const flags: string[] = [];
  pushOptionalStringFlag(flags, opts, "model", "--model");
  pushEffortFlag(flags, opts);
  // SECURITY / headless posture (mirrors agy-image, see that file's header):
  // agy's `--print` is non-interactive, so an implement (write) job cannot be
  // asked to confirm its edits at a TTY — without auto-approval it hangs until
  // the print timeout. agy 1.1.5 has no per-tool allowlist, so we use the blunt
  // knobs as defense-in-depth: `--sandbox` restricts the terminal (an agent
  // steered by an injected task cannot spawn a shell or reach the network) and
  // `--dangerously-skip-permissions` auto-approves the edits INSIDE that
  // sandbox. `--sandbox` is a BOOLEAN flag (takes no value) and is always on
  // here. Unlike agy-image, the prompt is NOT fenced as untrusted data — for a
  // review/implement harness the prompt legitimately IS the task the agent must
  // follow; the injection risk is inherent to delegating a task and is the
  // accepted v1 posture (same-cwd, real env).
  //
  // NOT "only two permission knobs" (a claim this file used to make): agy 1.1.5
  // also exposes `--mode {accept-edits,plan}` and `--agent`. `--mode plan` is a
  // genuine non-writing mode and is the obvious way to offer a read-only
  // dispatch — deliberately NOT emitted here, because this adapter's contract
  // is "may edit the tree" and silently making it read-only would break callers
  // who dispatch agy to implement. Adding a read-only mode is a product
  // decision, not something to smuggle in via a flag.
  //
  // Structural flag order: `buildAgyArgv` always pushes `--print` and the
  // prompt last, in that order — nothing lands after the prompt.
  return buildAgyArgv(["--sandbox", "--dangerously-skip-permissions", ...flags], prompt);
}

export function injectContract(prompt: string): string {
  return (
    `${prompt}\n\n` +
    "When you have completed the review/implementation above, end your response " +
    "with exactly one line, the last line of output, in one of these two exact forms:\n" +
    "AGY_RESULT: DONE\n" +
    "AGY_RESULT: FAILED\n" +
    "Do not include this line unless it reflects the true outcome."
  );
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  const match = lastMarkerMatch(RESULT_MARKER_RE, stdout);
  if (!match) {
    return {
      status: "failed",
      summary: "agy: missing AGY_RESULT marker in output (silent-misparse backstop — likely a --print flag-order misparse)",
      artifacts: [],
      raw: stdout,
    };
  }
  if (exitCode !== 0) {
    return { status: "failed", summary: `agy: exited with code ${exitCode}`, artifacts: [], raw: stdout };
  }
  if (match[1] === "FAILED") {
    return { status: "failed", summary: "agy: reported FAILED", artifacts: [], raw: stdout };
  }
  return { status: "done", summary: stdout.trim(), artifacts: [], raw: stdout };
}

/**
 * Append `flag <value>` to `flags` when `opts[key]` is present. Present but
 * malformed (non-string / empty) throws — this is untrusted external input
 * (an MCP client's opts), validated at entry rather than silently ignored.
 */
/**
 * Append `--effort <level>` when `opts.effort` is present. agy 1.1.5 accepts
 * `--effort low|medium|high`; this adapter previously ignored `opts.effort`
 * entirely, so a caller asking for high effort silently got the default. An
 * out-of-range value throws rather than being dropped — a job that quietly ran
 * at the wrong effort is worse than one that refuses to start.
 */
function pushEffortFlag(flags: string[], opts: DispatchOpts): void {
  const effort = opts.effort;
  if (effort === undefined) return;
  if (typeof effort !== "string" || !AGY_EFFORT_LEVELS.has(effort)) {
    throw new TypeError(`agy: opts.effort must be "low" | "medium" | "high" if provided, got: ${JSON.stringify(effort)}`);
  }
  flags.push("--effort", effort);
}

/** Mirrors agy 1.1.5's `--effort` allowlist (low|medium|high), verified via `agy --help`. */
const AGY_EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high"]);

function pushOptionalStringFlag(flags: string[], opts: DispatchOpts, key: string, flag: string): void {
  const value = opts[key];
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`agy: opts.${key} must be a non-empty string if provided, got: ${JSON.stringify(value)}`);
  }
  flags.push(flag, value);
}

// Compile-time-only proof that this module's plain exports satisfy the
// Adapter port — discoverAdapters duck-types at runtime, so this is the only
// place a signature drift would be caught by tsc.
const _check: FlatAdapterModule = { name, buildArgs, injectContract, parseResult };
void _check;
