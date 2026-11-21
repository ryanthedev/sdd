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
import * as agyImage from "./_agy-image.ts";
import * as agyVision from "./_agy-vision.ts";
import { AGY_EFFORT_LEVELS, buildAgyArgv, lastMarkerMatch, pushAgyEffortFlag, pushAgyOptionalStringFlag } from "./_agy-shared.ts";
import { DEFAULT_KIND } from "./types.ts";
import type { Capability, ModelsProbe, MultiAdapterModule } from "./types.ts";
import type { AdapterResult, DispatchOpts, ModelInfo } from "../types.ts";
import { resolveOptionalAddDir, resolveReadOnly } from "../lib/path-barricade.ts";

export const name = "agy";

/** Verified against agy 1.5.14 (`agy --help`). */
export const effortLevels = AGY_EFFORT_LEVELS;
export const supportsReadOnly = true;

/**
 * Marker line the harness must echo verbatim to confirm a real outcome.
 * Anchored to the WHOLE line (start-to-end, modulo surrounding whitespace) so
 * a marker mentioned mid-sentence doesn't collide; `g` so every occurrence in
 * stdout can be enumerated and the LAST one taken (see `lastMarkerMatch`).
 */
const RESULT_MARKER_RE = /^AGY_RESULT:\s*(DONE|FAILED)\s*$/gm;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const readOnly = resolveReadOnly(name, opts, true);
  const addDir = resolveOptionalAddDir(name, opts);
  const flags: string[] = [];
  pushAgyOptionalStringFlag(flags, opts, "model", "--model");
  pushAgyEffortFlag(flags, opts);
  if (addDir !== undefined) flags.push("--add-dir", addDir);

  // SECURITY / headless posture:
  //   - Default (writable): `--sandbox --dangerously-skip-permissions`
  //   - `readOnly: true`: `--sandbox --mode plan` (structurally non-writing;
  //     verified against agy 1.5.14: exits 0 cleanly in --print mode without
  //     needing --dangerously-skip-permissions).
  // Structural flag order: `buildAgyArgv` always pushes `--print` and the
  // prompt last, in that order — nothing lands after the prompt.
  const modeFlags = readOnly ? ["--sandbox", "--mode", "plan"] : ["--sandbox", "--dangerously-skip-permissions"];
  return buildAgyArgv([...modeFlags, ...flags], prompt);
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
 * Live model-catalog probe via `agy models`. Pure data; executed by
 * `src/lib/models.ts`. Verified against agy 1.5.14.
 */
export const readModels: ModelsProbe = {
  transport: "cli-stdout",
  binary: "agy",
  args: ["models"],
};

/**
 * Parse `agy models` stdout (`<id>   <Display Name>` per line, stripping any
 * leading `\r`-delimited spinner frames). Tolerant: skips non-matching lines.
 */
export function parseModels(raw: unknown): ModelInfo[] {
  if (typeof raw !== "string") return [];
  const out: ModelInfo[] = [];
  for (const rawLine of raw.split("\n")) {
    // Strip trailing \r (CRLF) before splitting on spinner \r frames so the
    // final segment is never empty on CRLF input.
    const segment = rawLine.replace(/\r+$/, "").split("\r").at(-1)?.trim() ?? "";
    if (!segment) continue;
    const match = /^([a-z0-9][a-z0-9._-]+)(?:\t|\s{2,})(.+)$/.exec(segment);
    if (!match) continue;
    const id = match[1]!;
    const displayName = match[2]!.trim();
    out.push({ id, displayName, effortLevels: [...effortLevels] });
  }
  return out;
}

/**
 * Everything agy can be asked for, under ONE adapter name.
 *
 * These used to be three separate adapters — `agy`, `agy-image`, `agy-vision` —
 * which meant a caller had to know that "generate a picture with agy" was
 * spelled as a different harness. That is an internal file-layout detail, not
 * something the caller should carry. Same binary, same auth, same account: one
 * name, three kinds.
 *
 * The implementations still live in their own modules (`_agy-image.ts`,
 * `_agy-vision.ts`) — each is a few hundred lines of path barricades and
 * contract parsing, and the leading `_` keeps discovery from loading them as
 * adapters in their own right. Splitting the FILES was never the problem;
 * splitting the NAMES was.
 */
export const capabilities: Record<string, Capability> = {
  [DEFAULT_KIND]: { buildArgs, injectContract, parseResult },
  image: { buildArgs: agyImage.buildArgs, injectContract: agyImage.injectContract, parseResult: agyImage.parseResult },
  vision: {
    buildArgs: agyVision.buildArgs,
    injectContract: agyVision.injectContract,
    parseResult: agyVision.parseResult,
  },
};

/** Review/implement is what `agy` means with no `kind` — the other two are opt-in. */
export const defaultKind = DEFAULT_KIND;

// Compile-time-only proof that this module's exports satisfy the multi-
// capability port shape — discoverAdapters duck-types at runtime, so this is
// the only place a signature drift would be caught by tsc.
const _check: MultiAdapterModule = {
  name,
  capabilities,
  defaultKind,
  effortLevels,
  supportsReadOnly,
  readModels,
  parseModels,
};
void _check;
