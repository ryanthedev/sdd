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
import type { FlatAdapterModule } from "./types.ts";
import { resolveOptionalAddDir, resolveReadOnly } from "../lib/path-barricade.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "kimi";
/** Verified against kimi-code 0.22.3: `kimi --plan -p` exits 1 ("Cannot combine --prompt with --plan."). */
export const supportsReadOnly = false;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  // Reject readOnly loudly: kimi refuses `--plan` alongside `-p`, so silently
  // dropping it would run permissively when the caller asked for read-only.
  resolveReadOnly(name, opts, false);
  const addDir = resolveOptionalAddDir(name, opts);

  // No approval flag: kimi refuses `--yolo`/`--auto` alongside `-p` (see header).
  // `-p` stays second-to-last so the prompt is the LAST argv element.
  const argv = ["kimi"];
  const { model } = opts;
  if (model !== undefined) {
    if (typeof model !== "string" || model.length === 0) {
      throw new TypeError(`kimi: opts.model must be a non-empty string if provided, got ${typeof model}`);
    }
    argv.push("-m", model);
  }
  if (addDir !== undefined) argv.push("--add-dir", addDir);
  argv.push("-p", prompt);
  return argv;
}

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

const _check: FlatAdapterModule = { name, supportsReadOnly, buildArgs, injectContract, parseResult };
void _check;
