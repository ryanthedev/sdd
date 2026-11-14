/**
 * gemini `default` kind — batch decision calls to the Gemini Decisions API
 * (`gemini-decision-1`). One request JSON in, one results JSON out at a
 * caller-named `opts.outputPath`, reported in `artifacts`. The request format
 * is documented in `assets/gemini-decide.ts`; a jev request runs unchanged.
 *
 * WHAT IT IS FOR: like jev it never writes text. It returns probabilities for
 * typed questions (`noul` yes/no, `choice`, `score`) in about a second at
 * $0.10 per million input tokens and $0 output, so it RANKS, ROUTES, and
 * CLASSIFIES at volume. Unlike jev it reads media: an item's input may hold
 * local images, video, audio, or PDFs, so it can answer closed questions
 * about a downloaded video directly.
 *
 * IDENTITY CONTRACT: the "prompt" IS the request file path, and JobStore
 * applies `injectContract` BEFORE `buildArgs`, so any non-identity contract
 * would corrupt the path (jev / shazam precedent).
 *
 * OUTPUT CONTRACT: the script prints `SDD_GEMINI_SUMMARY:items=… ok=…
 * failed=… input_tokens=… cost_usd=…` then `SDD_GEMINI_RESULT:<abs path>` as
 * its last lines. Markers are matched by LAST occurrence and the JSON's
 * existence is verified on disk before `done`. Per-item errors live in the
 * JSON and do not fail the job; if NO item succeeded the script exits 1.
 *
 * SECURITY: the request path (the prompt) and `opts.outputPath` become
 * positional argv after the bundled script path; a leading `-`, control
 * characters, and a relative path escaping the job cwd are rejected before
 * spawn. The script runs hermetically (see `_gemini-shared.ts`).
 *
 * DATA EGRESS: every item's input, including local files it names, goes to
 * Google. Do not put secrets in a request.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hermeticBunArgv, lastMatch, stderrReason, validatePath } from "./_gemini-shared.ts";
import type { Capability } from "./types.ts";
import type { AdapterResult, DispatchOpts } from "../types.ts";

const WHO = "gemini";
const SCRIPT_RELATIVE = join("assets", "gemini-decide.ts");
const RESULT_MARKER_RE = /^SDD_GEMINI_RESULT:(.+?)\r?$/gm;
const SUMMARY_MARKER_RE = /^SDD_GEMINI_SUMMARY:(.+?)\r?$/gm;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const requestPath = validatePath(prompt, opts, "prompt (request file path)", WHO);
  if (typeof opts.outputPath !== "string" || opts.outputPath.length === 0) {
    throw new TypeError(`${WHO}: opts.outputPath must be a non-empty string (where to write the results JSON)`);
  }
  const outPath = validatePath(opts.outputPath, opts, "opts.outputPath", WHO);
  return hermeticBunArgv(SCRIPT_RELATIVE, [requestPath, outPath]);
}

/** Identity — the prompt IS the request path; see header. */
export function injectContract(prompt: string): string {
  return prompt;
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  if (exitCode !== 0) {
    return {
      status: "failed",
      summary: `gemini: exited with code ${exitCode}: ${stderrReason(stderr, "gemini-decide")}`,
      artifacts: [],
      raw: stdout,
    };
  }
  const resultPath = lastMatch(RESULT_MARKER_RE, stdout)?.trim();
  if (!resultPath) {
    return {
      status: "failed",
      summary: "gemini: no SDD_GEMINI_RESULT marker in stdout (silent-misparse backstop)",
      artifacts: [],
      raw: stdout,
    };
  }
  if (!existsSync(resultPath)) {
    return { status: "failed", summary: `gemini: result file does not exist: ${resultPath}`, artifacts: [], raw: stdout };
  }
  const counts = lastMatch(SUMMARY_MARKER_RE, stdout)?.trim() ?? "no summary line";
  return { status: "done", summary: `gemini: ${counts} (results: ${resultPath})`, artifacts: [resultPath], raw: stdout };
}

const _check: Capability = { buildArgs, injectContract, parseResult };
void _check;
