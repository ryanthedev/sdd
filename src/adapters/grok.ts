/**
 * grok adapter — xAI Grok Build CLI. Verified against `grok --help`
 * (Grok 0.2.82): the non-interactive one-shot form is `grok -p/--single
 * "<prompt>"`, with the answer on stdout in the default (text) output format.
 * Auth: GROK_API_KEY / GROK_DEPLOYMENT_KEY in the environment (never handled
 * here — the JobStore passes process.env through).
 *
 * Defaults to WRITE mode: it emits `--always-approve` so the agent can modify
 * the repo headlessly (write-mode jobs serialize per cwd via the JobStore
 * guard). Pass `opts.mode:"read"` for a review-only run — no approval flag is
 * emitted, so the agent answers the prompt rather than mutating the tree. No
 * `danger-full-access`/full-access knob is ever emitted.
 */
import type { AdapterMode, AdapterResult, DispatchOpts } from "../types.ts";
import type { Adapter } from "./types.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "grok";
export const mode: AdapterMode = "write";

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const effectiveMode: AdapterMode = opts.mode ?? mode;
  // `-p` (alias of `--single`) takes the prompt as its value and runs headless.
  // The write-approval flag precedes `-p` so the prompt stays the LAST argv
  // element. Read mode omits it (the CLI then can't apply edits headlessly).
  return effectiveMode === "write" ? ["grok", "--always-approve", "-p", prompt] : ["grok", "-p", prompt];
}

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

const _check: Adapter = { name, mode, buildArgs, injectContract, parseResult };
void _check;
