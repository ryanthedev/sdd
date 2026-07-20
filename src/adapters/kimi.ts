/**
 * kimi adapter — Moonshot Kimi CLI. Verified against `kimi --help`
 * (kimi-code 0.22.3): the non-interactive one-shot form is `kimi -p/--prompt
 * "<prompt>"` ("Run one prompt non-interactively and print the response"),
 * answer on stdout in the default (text) output format. Auth: MOONSHOT_API_KEY
 * in the environment (passed through by the JobStore, never handled here).
 *
 * NOTE: the earlier research claimed `kimi --print -p ... --quiet`; the installed
 * CLI has no `--print`/`--quiet` — `-p` alone is the headless one-shot flag.
 *
 * Always emits `--yolo` so the agent can act headlessly, which means it may
 * modify the tree it is dispatched into. Whether that is safe right now — and
 * whether two jobs may share one tree — is the CALLER's decision, not this
 * adapter's. No `danger-full-access`/full-access knob is ever emitted.
 */
import type { AdapterResult, DispatchOpts } from "../types.ts";
import type { Adapter } from "./types.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "kimi";

export function buildArgs(prompt: string, _opts: DispatchOpts): string[] {
  // The approval flag precedes `-p` so the prompt stays the LAST argv element.
  return ["kimi", "--yolo", "-p", prompt];
}

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

const _check: Adapter = { name, buildArgs, injectContract, parseResult };
void _check;
