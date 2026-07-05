/**
 * mistral adapter — Mistral Vibe CLI as a read-only second-opinion / review
 * harness. Verified against `vibe --help` (mistral-vibe): the non-interactive
 * one-shot form is `vibe -p/--prompt "<prompt>"` ("Run in programmatic mode"),
 * answer on stdout in the default (text) output format. Auth: MISTRAL_API_KEY in
 * the environment (passed through by the JobStore, never handled here).
 *
 * name≠binary: the adapter is named "mistral" (the provider) but its CLI binary
 * is `vibe`, so it sets the port's optional `binary` field so `list_adapters`
 * probes the right thing on PATH. `buildArgs` argv[0] is `vibe` to match.
 *
 * mode "read": a review harness — no --auto-approve / write flags emitted, so the
 * agent answers the prompt rather than editing the tree.
 */
import type { AdapterMode, AdapterResult, DispatchOpts } from "../types.ts";
import type { Adapter } from "./types.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "mistral";
export const binary = "vibe";
export const mode: AdapterMode = "read";

export function buildArgs(prompt: string, _opts: DispatchOpts): string[] {
  return ["vibe", "-p", prompt];
}

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

const _check: Adapter = { name, binary, mode, buildArgs, injectContract, parseResult };
void _check;
