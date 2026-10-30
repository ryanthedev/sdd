/**
 * jev adapter — batch decision calls to TypeSafe Jev. One request JSON in
 * (`questions` shared by every item, `items[{id, state}]`), one results JSON
 * out at a caller-named `opts.outputPath`, reported in `artifacts`.
 *
 * WHAT JEV IS FOR HERE: Jev never writes text. It returns probabilities for
 * typed questions (`boolean`, `choice`, `score`) at about 0.3 s and
 * $0.042 per million input tokens, so it RANKS and ROUTES at volume. It is
 * not an agent: it cannot read the tree, edit it, explain, or locate. Measured
 * in tellme (Oct 2026): good at ranking routines by likely security defect
 * (AUC 0.84 on 125 unseen repos) and mutants by "tests will kill it" (0.82);
 * poor at judging whether another model's finding is true (0.54-0.64, below
 * the reviewer's own severity at 0.74). Raw probabilities are uncalibrated —
 * rank by them, never threshold them. The skill's recipes carry this.
 *
 * HARNESS: `bun`, running the repo-bundled `assets/jev-evaluate.ts` (the
 * Vercel AI Gateway client, ported from tellme's `grade()`). The sdd server
 * already runs on bun, so there is nothing extra to install. The key is
 * `AI_GATEWAY_API_KEY` from the environment the server inherited (the env-key
 * shape of grok/kimi/qwen/mistral), else from the user-level
 * `~/.config/sdd/.env`, which the script reads by path on every job.
 *
 * HERMETIC RUN: `bun run` from the job cwd would read that cwd's
 * `bunfig.toml` (whose `preload` executes code before the script) and its
 * `.env` files. Verified on bun 1.4.4: both fire on a plain `bun run`, and
 * `--config=<empty bundled bunfig> --no-env-file` stops both. The tree being
 * worked on must never be able to run code inside this job or supply its key.
 *
 * IDENTITY CONTRACT: the "prompt" IS the request file path, and JobStore
 * applies `injectContract` BEFORE `buildArgs` (src/lib/jobs.ts), so any
 * non-identity contract would corrupt the path (shazam / whisper precedent).
 *
 * OUTPUT CONTRACT: the script prints `SDD_JEV_SUMMARY:items=… ok=… failed=…
 * cost_usd=…` then `SDD_JEV_RESULT:<abs json path>` as its last lines.
 * Markers are matched by LAST occurrence (repo convention) and the JSON's
 * existence is verified on disk before `done`. Per-item errors live in the
 * JSON and do not fail the job; if NO item succeeded the script exits 1 and
 * the job is `failed`, with the script's stderr reason in the summary.
 *
 * SECURITY BARRICADES (untrusted MCP-client input, validated at entry):
 * - The request path (the prompt) and `opts.outputPath` become positional argv
 *   elements after the script path: a leading `-` and control characters are
 *   rejected before spawn, and a relative path must stay inside the job cwd
 *   (shazam's `resolveContained` semantics).
 * - The script path and bunfig path are author-controlled, never caller input.
 * - The script reads the key from the environment and never prints it.
 *
 * DATA EGRESS: every item's `state` is sent to TypeSafe through Vercel. Do not
 * put secrets in a state.
 *
 * `probeable = false`: check_adapter's generic probe prompt is not a request
 * file and carries no outputPath, so buildArgs would throw and every probe
 * would read as a failure; a real probe would also spend from a capped key.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FlatAdapterModule } from "./types.ts";
import type { AdapterResult, DispatchOpts } from "../types.ts";

export const name = "jev";
/** CLI binary is `bun` — it runs the bundled gateway client. */
export const binary = "bun";
/** Opt OUT of check_adapter's automatic live probe — see header. */
export const probeable = false;

const SCRIPT_RELATIVE = join("assets", "jev-evaluate.ts");
const BUNFIG_RELATIVE = join("assets", "jev-bunfig.toml");

const RESULT_MARKER_RE = /^SDD_JEV_RESULT:(.+?)\r?$/gm;
const SUMMARY_MARKER_RE = /^SDD_JEV_SUMMARY:(.+?)\r?$/gm;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const requestPath = validatePath(prompt, opts, "prompt (request file path)");
  const outPath = resolveOutputPath(opts);

  return [
    "bun",
    // Hermetic: ignore the job cwd's bunfig.toml and .env files — see header.
    `--config=${bundledPath(BUNFIG_RELATIVE)}`,
    "--no-env-file",
    "run",
    bundledPath(SCRIPT_RELATIVE),
    // Flags before positionals (repo convention).
    requestPath,
    outPath,
  ];
}

/** Identity — the prompt IS the request path and must reach buildArgs
 *  unchanged; Jev is a decision API, not an NL-instructable harness. */
export function injectContract(prompt: string): string {
  return prompt;
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  if (exitCode !== 0) {
    return {
      status: "failed",
      summary: `jev: exited with code ${exitCode}: ${stderrReason(stderr)}`,
      artifacts: [],
      raw: stdout,
    };
  }

  const resultPath = lastMatch(RESULT_MARKER_RE, stdout)?.trim();
  if (!resultPath) {
    return {
      status: "failed",
      summary: `jev: no SDD_JEV_RESULT marker in stdout (silent-misparse backstop)`,
      artifacts: [],
      raw: stdout,
    };
  }
  if (!existsSync(resultPath)) {
    return {
      status: "failed",
      summary: `jev: result file does not exist: ${resultPath}`,
      artifacts: [],
      raw: stdout,
    };
  }

  const counts = lastMatch(SUMMARY_MARKER_RE, stdout)?.trim() ?? "no summary line";
  return {
    status: "done",
    summary: `jev: ${counts} (results: ${resultPath})`,
    artifacts: [resultPath],
    raw: stdout,
  };
}

/**
 * Absolute path to a bundled asset. Prefers $CLAUDE_PLUGIN_ROOT when running
 * inside Claude Code, falling back to a path relative to this module for tests
 * and manual `bun run` (shazam / register.ts:readVersion precedent).
 */
function bundledPath(rel: string): string {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (typeof root === "string" && root.length > 0) {
    const candidate = join(root, rel);
    if (existsSync(candidate)) return candidate;
  }
  return fileURLToPath(new URL(`../../${rel}`, import.meta.url));
}

function resolveOutputPath(opts: DispatchOpts): string {
  const raw = opts.outputPath;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError("jev: opts.outputPath must be a non-empty string (where to write the results JSON)");
  }
  return validatePath(raw, opts, "opts.outputPath");
}

/** Non-empty, no leading `-`, no control characters, contained in the job cwd
 *  when relative; returned absolute. */
function validatePath(raw: string, opts: DispatchOpts, label: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new TypeError(`jev: ${label} must be a non-empty path`);
  }
  const path = raw.trim();
  if (path.startsWith("-")) {
    throw new TypeError(`jev: ${label} must not start with '-' (option-injection risk), got: ${truncate(path)}`);
  }
  if (hasControlChar(path)) {
    throw new TypeError(`jev: ${label} must not contain control characters, got: ${truncate(path)}`);
  }
  if (isAbsolute(path)) return path;
  const base = typeof opts.cwd === "string" && opts.cwd.length > 0 ? resolve(opts.cwd) : process.cwd();
  const resolved = resolve(base, path);
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError(`jev: ${label} escapes the job cwd via '..': ${path} (resolved: ${resolved}, cwd: ${base})`);
  }
  return resolved;
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function truncate(s: string): string {
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** Scan every match of `re` and return the last one — never the first. */
function lastMatch(re: RegExp, text: string): string | undefined {
  let last: string | undefined;
  for (const m of text.matchAll(re)) last = m[1];
  return last;
}

/** The script's own `jev-evaluate:` error line if present, else the last
 *  non-empty stderr line; capped so a noisy stderr can't flood the summary. */
function stderrReason(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const line = lines.findLast((l) => l.startsWith("jev-evaluate:")) ?? lines.at(-1) ?? "(no stderr output)";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

const _check: FlatAdapterModule = { name, binary, probeable, buildArgs, injectContract, parseResult };
void _check;
