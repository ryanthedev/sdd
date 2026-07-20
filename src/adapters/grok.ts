/**
 * grok adapter — xAI Grok Build CLI. Verified against `grok --help`
 * (Grok 0.2.93): the non-interactive one-shot form is `grok -p/--single
 * "<prompt>"`, with the answer on stdout in the default (text) output format.
 * Auth: XAI_API_KEY (or GROK_API_KEY / GROK_DEPLOYMENT_KEY) in the environment
 * (never handled here — the JobStore passes process.env through).
 *
 * Always emits `--always-approve` so the agent can act headlessly, which means
 * it may modify the tree it is dispatched into. Whether that is safe right now
 * — and whether two jobs may share one tree — is the CALLER's decision, not
 * this adapter's. No `danger-full-access`/full-access knob is ever emitted.
 *
 * Model selection: `opts.model` (e.g. "grok-4.5") is passed through as
 * `-m <model>`. Omitting it keeps the CLI's default model
 * (grok-4.20-*-non-reasoning today). Available ids come from `grok models`.
 */
import type { AdapterResult, DispatchOpts } from "../types.ts";
import type { Adapter } from "./types.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "grok";

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  // All flags precede `-p` so the prompt stays the LAST argv element (a flag
  // placed after the prompt is absorbed as prompt text).
  const argv = ["grok", "--always-approve"];
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

const _check: Adapter = { name, buildArgs, injectContract, parseResult };
void _check;
