/**
 * kimi adapter — Moonshot Kimi CLI as a read-only second-opinion / review
 * harness. Verified against `kimi --help` (kimi-code 0.22.3): the non-interactive
 * one-shot form is `kimi -p/--prompt "<prompt>"` ("Run one prompt
 * non-interactively and print the response"), answer on stdout in the default
 * (text) output format. Auth: MOONSHOT_API_KEY in the environment (passed
 * through by the JobStore, never handled here).
 *
 * NOTE: the earlier research claimed `kimi --print -p ... --quiet`; the installed
 * CLI has no `--print`/`--quiet` — `-p` alone is the headless one-shot flag.
 *
 * mode "read": a review harness — no write-approval flags emitted.
 */
import type { AdapterMode, AdapterResult, DispatchOpts } from "../types.ts";
import type { Adapter } from "./types.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "kimi";
export const mode: AdapterMode = "read";

export function buildArgs(prompt: string, _opts: DispatchOpts): string[] {
  return ["kimi", "-p", prompt];
}

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

const _check: Adapter = { name, mode, buildArgs, injectContract, parseResult };
void _check;
