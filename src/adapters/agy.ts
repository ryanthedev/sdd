/**
 * agy adapter — general-purpose review/implement harness invoked as
 * `agy <flags...> --print <prompt>`.
 *
 * FLAG-ORDER LANDMINE: agy's `--print` swallows the single argv element that
 * immediately follows it as the prompt. Any flag placed AFTER `--print` is
 * silently absorbed into the prompt string instead of being parsed as a flag
 * — and agy exits 0 on this misparse, so a wrong flag order fails silently
 * with no non-zero exit code to catch it. `buildArgs` makes the correct order
 * structural rather than conventional: the prompt is always the LAST array
 * element pushed, and `--print` is always the element immediately before it.
 * There is no code path that can insert anything after the prompt.
 *
 * The exit-0 misparse is additionally backstopped by `parseResult`: a
 * required `AGY_RESULT:` marker (injected via `injectContract`) must be
 * present in stdout, or the job is classified `failed` regardless of exit
 * code — see Adapter port docs (src/adapters/types.ts).
 *
 * MARKER-COLLISION LANDMINE: `injectContract` embeds the literal strings
 * `AGY_RESULT: DONE` / `AGY_RESULT: FAILED` into the prompt as instructions.
 * A harness that echoes those instructions back (verbose logging, a nested
 * agent restating context) before printing its real, final verdict makes
 * BOTH strings appear in stdout — the earlier one is the echoed instruction,
 * not the outcome. The contract (see `injectContract` below) defines the
 * marker as "the last line of output," so `parseResult` must scan for the
 * LAST marker-shaped line, not the first — otherwise an echoed `DONE`
 * example can mask a real, later `FAILED` verdict. `lastMarkerMatch` below
 * scans every match and keeps the final one for exactly this reason.
 */
import type { Adapter } from "./types.ts";
import type { AdapterMode, AdapterResult, DispatchOpts } from "../types.ts";

export const name = "agy";

/**
 * Conservative default. agy can both review (read) and implement (write); the
 * JobStore write-write guard only serializes `mode: "write"` jobs in a given
 * cwd. Defaulting to "write" means an implement dispatch can never silently
 * bypass that guard by forgetting to declare itself — callers opt IN to
 * "read" via `opts.mode` for review-only jobs (JobStore already supports a
 * per-dispatch override: `opts.mode ?? adapter.mode`).
 */
export const mode: AdapterMode = "write";

/**
 * Marker line the harness must echo verbatim to confirm a real outcome.
 * Anchored to the WHOLE line (start-to-end, modulo surrounding whitespace) so
 * a marker mentioned mid-sentence doesn't collide; `g` so every occurrence in
 * stdout can be enumerated and the LAST one taken (see `lastMarkerMatch`).
 */
const RESULT_MARKER_RE = /^AGY_RESULT:\s*(DONE|FAILED)\s*$/gm;

/**
 * Scan every match of `re` in `text` and return the last one — never the
 * first. `re` must carry the `g` flag. This is the fix for the marker-
 * collision landmine documented at the top of this file: the harness's real
 * verdict is its LAST marker line, not the first marker-shaped line that
 * happens to appear (e.g. an echoed instruction).
 */
function lastMarkerMatch(re: RegExp, text: string): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(re)) last = m;
  return last;
}

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const flags: string[] = [];
  pushOptionalStringFlag(flags, opts, "model", "--model");
  pushOptionalStringFlag(flags, opts, "sandbox", "--sandbox");
  // Structural guard against the flag-order landmine: `--print` and the
  // prompt are always pushed last, in that order — nothing can land after
  // the prompt because nothing is pushed after this line.
  return ["agy", ...flags, "--print", prompt];
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
const _check: Adapter = { name, mode, buildArgs, injectContract, parseResult };
void _check;
