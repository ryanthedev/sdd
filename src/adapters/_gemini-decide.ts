/**
 * gemini `default` kind — batch decision calls to the Gemini Decisions API
 * (`gemini-decision-1`). One request JSON in, one results JSON out, reported
 * in `artifacts`. The request format is documented in `assets/gemini-decide.ts`;
 * a jev request runs unchanged.
 *
 * WHAT IT IS FOR: like jev it never writes text. It returns probabilities for
 * typed questions (`noul` yes/no, `choice`, `score`) in about a second at
 * $0.10 per million input tokens and $0 output, so it RANKS, ROUTES, and
 * CLASSIFIES at volume. Unlike jev it reads media: an item's input may hold
 * local images, video, audio, or PDFs, so it can answer closed questions
 * about a downloaded video directly.
 *
 * IDENTITY CONTRACT: the "prompt" IS the request, and JobStore applies
 * `injectContract` BEFORE `buildArgs`, so any non-identity contract would
 * corrupt it (jev / shazam precedent). The prompt is either a path to a
 * `.json` request file, or (when its first non-space character is `{`) the
 * request JSON itself, passed as `--inline` (capped at ~100 KB; use a file
 * above that). Anything else is rejected here with the request shape, which
 * catches a natural-language question before it spawns a job.
 *
 * OUTPUT CONTRACT: the script prints `SDD_GEMINI_USAGE:{json}` (cumulative,
 * last wins; see `parseUsage`), `SDD_GEMINI_SUMMARY:items=… ok=… failed=…
 * input_tokens=… cost_usd=…`, optionally `SDD_GEMINI_ANSWERS:<compact json>`
 * (a headline per answer, <= 8 KB, surfaced in `summary` so a caller needs no
 * file read), then `SDD_GEMINI_RESULT:<abs path>` last. Markers are matched
 * by LAST occurrence and the JSON's existence is verified on disk before
 * `done`. Per-item errors live in the JSON and do not fail the job; if NO
 * item succeeded the script still writes the JSON, then exits 1 — and
 * `parseResult` still reports that file in `artifacts` (status `failed`).
 *
 * OPTS: `outputPath` is optional (absent = the script writes a fresh temp dir
 * and reports it in the result marker); `model` overrides the request's;
 * `timeoutMs` becomes the script's `--deadline-ms` (90% of it, so the script
 * flushes before the server's kill).
 *
 * SECURITY: the request path and `opts.outputPath` become positional argv
 * after the bundled script path; a leading `-`, control characters, and a
 * relative path escaping the job cwd are rejected before spawn. The inline
 * JSON and the flag values are argv elements too (no shell). The script runs
 * hermetically (see `_gemini-shared.ts`).
 *
 * DATA EGRESS: every item's input, including local files it names, goes to
 * Google. Do not put secrets in a request.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MODEL_RE, hermeticBunArgv, lastMatch, stderrReason, validatePath } from "./_gemini-shared.ts";
import { parseUsageMarker } from "./_usage-marker.ts";
import type { UsageRecord } from "../types.ts";
import type { Capability } from "./types.ts";
import type { AdapterResult, DispatchOpts } from "../types.ts";

const WHO = "gemini";
const SCRIPT_RELATIVE = join("assets", "gemini-decide.ts");
const RESULT_MARKER_RE = /^SDD_GEMINI_RESULT:(.+?)\r?$/gm;
const SUMMARY_MARKER_RE = /^SDD_GEMINI_SUMMARY:(.+?)\r?$/gm;
const ANSWERS_MARKER_RE = /^SDD_GEMINI_ANSWERS:(.+?)\r?$/gm;
/** argv is not a transport for big payloads. */
const INLINE_MAX_BYTES = 100 * 1024;
const REQUEST_SHAPE = '{"questions": {"<name>": {"type": "noul"|"choice"|"score", "instructions": "..."}}, "items": [{"id": "...", "input": "..."}]}';

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const flags: string[] = [];
  const positionals: string[] = [];

  if (opts.model !== undefined) {
    if (typeof opts.model !== "string" || !MODEL_RE.test(opts.model)) {
      throw new TypeError(`${WHO}: opts.model must be a Gemini model id like "gemini-decision-1", got: ${JSON.stringify(opts.model)}`);
    }
    flags.push("--model", opts.model);
  }
  if (typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
    flags.push("--deadline-ms", String(Math.max(1000, Math.floor(opts.timeoutMs * 0.9))));
  }

  const trimmed = typeof prompt === "string" ? prompt.trim() : "";
  if (trimmed.startsWith("{")) {
    if (Buffer.byteLength(trimmed) > INLINE_MAX_BYTES) {
      throw new TypeError(`${WHO}: inline request is over ${INLINE_MAX_BYTES / 1024} KB; write it to a .json file and pass the path`);
    }
    try {
      JSON.parse(trimmed);
    } catch (e) {
      throw new TypeError(`${WHO}: inline request is not valid JSON (${e instanceof Error ? e.message : String(e)}); expected ${REQUEST_SHAPE}`);
    }
    flags.push("--inline", trimmed);
  } else if (trimmed.toLowerCase().endsWith(".json")) {
    positionals.push(validatePath(prompt, opts, "prompt (request file path)", WHO));
  } else {
    throw new TypeError(
      `${WHO}: the prompt must be a request, not a question: either a path ending in .json or inline JSON like ${REQUEST_SHAPE}`,
    );
  }

  if (opts.outputPath === undefined || opts.outputPath === "") {
    flags.push("--out-auto");
  } else {
    positionals.push(validatePath(opts.outputPath, opts, "opts.outputPath", WHO));
  }
  return hermeticBunArgv(SCRIPT_RELATIVE, [...flags, ...positionals]);
}

/** Identity — the prompt IS the request; see header. */
export function injectContract(prompt: string): string {
  return prompt;
}

/** Cumulative usage from the script's `SDD_GEMINI_USAGE` marker (last wins). */
export function parseUsage(stdout: string): UsageRecord | null {
  return parseUsageMarker(stdout, "SDD_GEMINI_USAGE");
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  const resultPath = lastMatch(RESULT_MARKER_RE, stdout)?.trim();
  const counts = lastMatch(SUMMARY_MARKER_RE, stdout)?.trim();
  if (exitCode !== 0) {
    // The script writes the results file BEFORE it exits 1 on "every item
    // failed", so the per-item errors are still reachable.
    const artifacts = resultPath && existsSync(resultPath) ? [resultPath] : [];
    return {
      status: "failed",
      summary: `gemini: exited with code ${exitCode}: ${stderrReason(stderr, "gemini-decide")}${counts ? ` [${counts}]` : ""}${artifacts.length > 0 ? ` (results: ${resultPath})` : ""}`,
      artifacts,
      raw: stdout,
    };
  }
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
  const answers = lastMatch(ANSWERS_MARKER_RE, stdout)?.trim();
  return {
    status: "done",
    summary: `gemini: ${counts ?? "no summary line"} (results: ${resultPath})${answers ? ` answers=${answers}` : ""}`,
    artifacts: [resultPath],
    raw: stdout,
  };
}

const _check: Capability & { parseUsage: (stdout: string) => UsageRecord | null } = { buildArgs, injectContract, parseResult, parseUsage };
void _check;
