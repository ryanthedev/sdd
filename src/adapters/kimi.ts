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
 * Emits NO approval flag, and this is not an oversight: kimi-code 0.22.3
 * REJECTS the combination outright — `kimi --yolo -p "…"` exits 1 with
 * "error: Cannot combine --prompt with --yolo." (`--auto` is refused the same
 * way). `-p` is its own mode; approval flags belong to the interactive TUI.
 * A prior version of this adapter emitted `--yolo`, which meant every kimi
 * dispatch failed before the model was ever reached.
 *
 * The flags are refused because `-p` ALREADY forces a permissive mode, not
 * because it is read-only. `forcePromptPermission` (kimi's own prompt-mode
 * runner) sets permission mode to `auto` for the duration of the run and
 * restores the previous mode afterwards. Per kimi's permission picker, `auto`
 * means "Run fully non-interactively. Tool actions are approved automatically,
 * and agent questions are skipped so it can decide on its own" — note that in
 * kimi this is MORE autonomous than `yolo`, which "can still ask you explicit
 * questions". So kimi is as permissive as the rest and may modify the tree it
 * is dispatched into. Whether that is safe right now — and whether two jobs may
 * share one tree — is the CALLER's decision, not this adapter's. No
 * `danger-full-access`/full-access knob is ever emitted.
 */
import type { AdapterResult, DispatchOpts } from "../types.ts";
import type { Adapter } from "./types.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "kimi";

export function buildArgs(prompt: string, _opts: DispatchOpts): string[] {
  // No approval flag: kimi refuses `--yolo`/`--auto` alongside `-p` (see header).
  // `-p` stays second-to-last so the prompt is the LAST argv element.
  return ["kimi", "-p", prompt];
}

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

const _check: Adapter = { name, buildArgs, injectContract, parseResult };
void _check;
