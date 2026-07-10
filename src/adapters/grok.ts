/**
 * grok adapter — xAI Grok Build CLI. Verified against `grok --help`
 * (Grok 0.2.93): the non-interactive one-shot form is `grok -p/--single
 * "<prompt>"`, with the answer on stdout in the default (text) output format.
 * Auth: XAI_API_KEY (or GROK_API_KEY / GROK_DEPLOYMENT_KEY) in the environment
 * (never handled here — the JobStore passes process.env through).
 *
 * Defaults to WRITE mode: it emits `--always-approve` so the agent can modify
 * the repo headlessly (write-mode jobs serialize per cwd via the JobStore
 * guard). Pass `opts.mode:"read"` for a review-only run — no approval flag is
 * emitted, so the agent answers the prompt rather than mutating the tree. No
 * `danger-full-access`/full-access knob is ever emitted.
 *
 * Model selection: `opts.model` (e.g. "grok-4.5") is passed through as
 * `-m <model>`. Omitting it keeps the CLI's default model
 * (grok-4.20-*-non-reasoning today). Available ids come from `grok models`.
 */
import type { AdapterMode, AdapterResult, DispatchOpts } from "../types.ts";
import type { Adapter } from "./types.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "grok";
export const mode: AdapterMode = "write";

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const effectiveMode: AdapterMode = opts.mode ?? mode;
  // All flags precede `-p` so the prompt stays the LAST argv element (a flag
  // placed after the prompt is absorbed as prompt text). Write mode emits the
  // approval flag; read mode omits it (the CLI then can't apply edits headless).
  const argv = ["grok"];
  if (effectiveMode === "write") argv.push("--always-approve");
  const { model } = opts;
  if (model !== undefined) {
    if (typeof model !== "string" || model.length === 0) {
      throw new TypeError(`grok: opts.model must be a non-empty string if provided, got ${typeof model}`);
    }
    argv.push("-m", model);
  }
  argv.push("-p", prompt);
  return argv;
}

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

const _check: Adapter = { name, mode, buildArgs, injectContract, parseResult };
void _check;
