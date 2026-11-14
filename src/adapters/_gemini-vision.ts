/**
 * gemini `vision` kind — the API-key fallback for agy's `vision` kind in the
 * video-ingest pipeline. Same inputs, same output: `opts.addDir` is the
 * artifact directory holding `manifest.json` + frames (ffmpeg-frames) and
 * `transcript.srt`/`.txt` (whisper); `opts.outputPath` is where the fused
 * `{summary, moments:[{tSeconds, spoken, visual, isVisualGag}]}` JSON lands.
 * A caller swaps `dispatch(agy, kind:"vision", …)` for
 * `dispatch(gemini, kind:"vision", …)` with the same opts.
 *
 * HOW: one `generateContent` call (bundled `assets/gemini-vision.ts`) with the
 * transcript text and the keyframes at LOW media resolution, constrained by a
 * JSON response schema. No agent loop, so the "weak tier loops on the frames"
 * failure agy's Flash-Low showed cannot happen here.
 *
 * MODEL DEFAULT: `gemini-3.1-flash-lite` — the cheapest generative model this
 * API key can call (gemini-2.5-flash-lite returns 404 "no longer available to
 * new users", verified 2026-11-13), at $0.25 in / $1.50 out per 1M tokens.
 * A ~1-minute reel with 20 frames costs well under one cent. `opts.model`
 * overrides with any generateContent model id.
 *
 * SECURITY: the caller's prompt is the last positional argv element (no shell;
 * the script parses positionals by index, never as flags). Transcript text and
 * frame pixels are untrusted and are fenced as data in the system instruction;
 * the call has no tools, so an injected instruction has no shell, network, or
 * file write to reach. `addDir`/`outputPath` get the shared path barricade;
 * the script also refuses manifest frames that point outside `addDir`.
 *
 * `probeable = false` for the whole harness: a probe needs files a generic
 * health check cannot supply.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MODEL_RE, hermeticBunArgv, lastMatch, stderrReason, validatePath } from "./_gemini-shared.ts";
import { parseUsageMarker } from "./_usage-marker.ts";
import type { UsageRecord } from "../types.ts";
import type { Capability } from "./types.ts";
import type { AdapterResult, DispatchOpts } from "../types.ts";

const WHO = "gemini vision";
const SCRIPT_RELATIVE = join("assets", "gemini-vision.ts");
export const DEFAULT_VISION_MODEL = "gemini-3.1-flash-lite";
const SAVED_MARKER_RE = /^SDD_GEMINI_VISION_SAVED:(.+?)\r?$/gm;
const SUMMARY_MARKER_RE = /^SDD_GEMINI_SUMMARY:(.+?)\r?$/gm;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  if (typeof opts.addDir !== "string" || opts.addDir.length === 0) {
    throw new TypeError(`${WHO}: opts.addDir must be the video-ingest artifact directory (manifest.json, frames, transcript)`);
  }
  const addDir = validatePath(opts.addDir, opts, "opts.addDir", WHO);
  if (typeof opts.outputPath !== "string" || !opts.outputPath.toLowerCase().endsWith(".json")) {
    throw new TypeError(`${WHO}: opts.outputPath must be a path ending in .json`);
  }
  const outPath = validatePath(opts.outputPath, opts, "opts.outputPath", WHO);
  const model = opts.model === undefined ? DEFAULT_VISION_MODEL : opts.model;
  if (typeof model !== "string" || !MODEL_RE.test(model)) {
    throw new TypeError(`${WHO}: opts.model must be a Gemini model id like "gemini-3.1-flash-lite", got: ${JSON.stringify(model)}`);
  }
  const instruction = prompt.trim().length > 0 ? prompt : "Fuse this video.";
  return hermeticBunArgv(SCRIPT_RELATIVE, [addDir, outPath, model, instruction]);
}

/** Identity — the fusion contract and schema live in the bundled script's
 *  system instruction, not in the prompt. */
export function injectContract(prompt: string): string {
  return prompt;
}

/** Cumulative usage from the script's `SDD_GEMINI_USAGE` marker (last wins). The
 *  script prints it as soon as the reply arrives, so a MAX_TOKENS or bad-JSON
 *  (failed) job still reports what it was billed. */
export function parseUsage(stdout: string): UsageRecord | null {
  return parseUsageMarker(stdout, "SDD_GEMINI_USAGE");
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  if (exitCode !== 0) {
    return {
      status: "failed",
      summary: `gemini vision: exited with code ${exitCode}: ${stderrReason(stderr, "gemini-vision")}`,
      artifacts: [],
      raw: stdout,
    };
  }
  const savedPath = lastMatch(SAVED_MARKER_RE, stdout)?.trim();
  if (!savedPath) {
    return {
      status: "failed",
      summary: "gemini vision: no SDD_GEMINI_VISION_SAVED marker in stdout (silent-misparse backstop)",
      artifacts: [],
      raw: stdout,
    };
  }
  if (!existsSync(savedPath)) {
    return {
      status: "failed",
      summary: `gemini vision: reported output file does not exist: ${savedPath} (silent-success guard)`,
      artifacts: [],
      raw: stdout,
    };
  }
  const counts = lastMatch(SUMMARY_MARKER_RE, stdout)?.trim() ?? "no summary line";
  return {
    status: "done",
    summary: `gemini vision: saved fused understanding to ${savedPath} (${counts})`,
    artifacts: [savedPath],
    raw: stdout,
  };
}

const _check: Capability & { parseUsage: (stdout: string) => UsageRecord | null } = { buildArgs, injectContract, parseResult, parseUsage };
void _check;
