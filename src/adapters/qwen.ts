/**
 * qwen adapter — Alibaba Qwen Code CLI. Verified against `qwen --help`
 * (qwen-code, a gemini-cli lineage build): the non-interactive one-shot form is
 * `qwen -p/--prompt "<prompt>"`, answer on stdout in the default (text) output
 * format. Auth: DASHSCOPE_API_KEY in the environment (passed through by the
 * JobStore, never handled here).
 *
 * Defaults to WRITE mode: it emits `--yolo` so the agent can modify the repo
 * headlessly (write-mode jobs serialize per cwd via the JobStore guard). Pass
 * `opts.mode:"read"` for a review-only run — no approval flag is emitted. No
 * `danger-full-access`/full-access knob is ever emitted.
 */
import type { AdapterMode, AdapterResult, DispatchOpts } from "../types.ts";
import type { Adapter } from "./types.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "qwen";
export const mode: AdapterMode = "write";

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const effectiveMode: AdapterMode = opts.mode ?? mode;
  // The approval flag precedes `-p` so the prompt stays the LAST argv element.
  return effectiveMode === "write" ? ["qwen", "--yolo", "-p", prompt] : ["qwen", "-p", prompt];
}

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

const _check: Adapter = { name, mode, buildArgs, injectContract, parseResult };
void _check;
