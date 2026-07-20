/**
 * qwen adapter — Alibaba Qwen Code CLI. Verified against `qwen --help`
 * (qwen-code, a gemini-cli lineage build): the non-interactive one-shot form is
 * `qwen -p/--prompt "<prompt>"`, answer on stdout in the default (text) output
 * format. Auth: DASHSCOPE_API_KEY in the environment (passed through by the
 * JobStore, never handled here).
 *
 * Always emits `--yolo` so the agent can act headlessly, which means it may
 * modify the tree it is dispatched into. Whether that is safe right now — and
 * whether two jobs may share one tree — is the CALLER's decision, not this
 * adapter's. No `danger-full-access`/full-access knob is ever emitted.
 */
import type { AdapterResult, DispatchOpts } from "../types.ts";
import type { Adapter } from "./types.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "qwen";

export function buildArgs(prompt: string, _opts: DispatchOpts): string[] {
  // The approval flag precedes `-p` so the prompt stays the LAST argv element.
  return ["qwen", "--yolo", "-p", prompt];
}

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

const _check: Adapter = { name, buildArgs, injectContract, parseResult };
void _check;
