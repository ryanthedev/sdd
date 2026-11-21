/**
 * mistral adapter — Mistral Vibe CLI. Verified against `vibe --help`
 * (mistral-vibe): the non-interactive one-shot form is `vibe -p/--prompt
 * "<prompt>"` ("Run in programmatic mode"), answer on stdout in the default
 * (text) output format. Auth: MISTRAL_API_KEY in the environment (passed
 * through by the JobStore, never handled here).
 *
 * name≠binary: the adapter is named "mistral" (the provider) but its CLI binary
 * is `vibe`, so it sets the port's optional `binary` field so `list_adapters`
 * probes the right thing on PATH. `buildArgs` argv[0] is `vibe` to match.
 *
 * Always emits `--auto-approve` so the agent can act headlessly, which means it
 * may modify the tree it is dispatched into. Whether that is safe right now —
 * and whether two jobs may share one tree — is the CALLER's decision, not this
 * adapter's. No `danger-full-access`/full-access knob is ever emitted.
 */
import type { AdapterResult, DispatchOpts } from "../types.ts";
import type { FlatAdapterModule } from "./types.ts";
import { resolveOptionalAddDir, resolveReadOnly } from "../lib/path-barricade.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "mistral";
export const binary = "vibe";
/** Verified against vibe 2.19.0: `--agent plan` selects the builtin non-writing plan agent. */
export const supportsReadOnly = true;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const readOnly = resolveReadOnly(name, opts, true);
  const addDir = resolveOptionalAddDir(name, opts);
  // All flags precede `-p` so the prompt stays the LAST argv element.
  const argv = readOnly ? ["vibe", "--agent", "plan"] : ["vibe", "--auto-approve"];
  if (addDir !== undefined) argv.push("--add-dir", addDir);
  argv.push("-p", prompt);
  return argv;
}

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

const _check: FlatAdapterModule = { name, binary, supportsReadOnly, buildArgs, injectContract, parseResult };
void _check;
