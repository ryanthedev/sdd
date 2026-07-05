/**
 * qwen adapter — Alibaba Qwen Code CLI as a read-only second-opinion / review
 * harness. Verified against `qwen --help` (qwen-code, a gemini-cli lineage
 * build): the non-interactive one-shot form is `qwen -p/--prompt "<prompt>"`,
 * answer on stdout in the default (text) output format. Auth: DASHSCOPE_API_KEY
 * in the environment (passed through by the JobStore, never handled here).
 *
 * mode "read": a review harness — no --yolo / write-approval flags are emitted.
 */
import type { AdapterMode, AdapterResult, DispatchOpts } from "../types.ts";
import type { Adapter } from "./types.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "qwen";
export const mode: AdapterMode = "read";

export function buildArgs(prompt: string, _opts: DispatchOpts): string[] {
  return ["qwen", "-p", prompt];
}

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

const _check: Adapter = { name, mode, buildArgs, injectContract, parseResult };
void _check;
