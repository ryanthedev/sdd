/**
 * codex adapter — wraps the `codex exec` CLI as an Adapter (Phase 1 port).
 * Pure data + pure functions, no I/O: JobStore (Phase 2) spawns `buildArgs`'
 * argv and feeds the captured stdout/stderr/exitCode into `parseResult`.
 *
 * Write by default: `mode` is "write" so the harness can modify the repo
 * (write-mode jobs serialize per cwd via the JobStore guard). `buildArgs` maps
 * to codex's sandbox flag: "write" -> --sandbox workspace-write, and a per-call
 * `opts.mode:"read"` override -> --sandbox read-only for a review-only run.
 * `danger-full-access` is never emitted.
 *
 * Output split (verified against `codex exec --help` in this environment):
 * codex writes progress to STDERR and its final answer to STDOUT. `summary`/
 * `raw` are built from stdout ONLY — stderr progress must never leak into the
 * collected result (DW-3.2). `parseResult` also enforces the contract-marker
 * backstop: a missing `VERDICT:`/`## Findings` marker (or a non-zero exit
 * code) is `failed` regardless of what else is in stdout — the same
 * silent-misparse guard Phase 2 established for JobStore, applied here to
 * codex's own output contract.
 */
import type { AdapterMode, AdapterResult, DispatchOpts } from "../types.ts";
import { buildCodexArgv, type CodexArgvConfig } from "./_codex-shared.ts";

export const name = "codex";
export const mode: AdapterMode = "write";

/**
 * Per-call reasoning-effort allowlist. Mirrors the zod enum in
 * src/tools/dispatch.ts, re-checked here because JobStore.dispatch is also
 * callable programmatically (bypassing zod) and the sandbox barricade is
 * security-critical — defense-in-depth, not redundancy.
 */
const EFFORT_LEVELS = new Set(["low", "medium", "high"]);

const CONTRACT_SUFFIX =
  '\n\nWhen you are done, end your final answer with a line starting exactly with "VERDICT:" followed by a ' +
  'one-line verdict, then a "## Findings" section (write "## Findings\nNone." if there are none).';

// Tolerant of leading markdown the model may add despite the "exactly"
// instruction — bold (`**VERDICT:**`), headings, blockquote/list, whitespace —
// mirroring src/lib/review-contract.ts (verified needed against real grok output).
const MARKDOWN_PREFIX = "[ \\t]*(?:[*_#>-]+[ \\t]*)*";
const VERDICT_RE = new RegExp(`^${MARKDOWN_PREFIX}VERDICT:`, "im");
const FINDINGS_RE = new RegExp(`^${MARKDOWN_PREFIX}Findings\\b`, "im");

/** Wrap the caller's prompt with codex's output-contract markers. */
export function injectContract(prompt: string): string {
  return `${prompt}${CONTRACT_SUFFIX}`;
}

/**
 * `codex exec [...flags] --sandbox <mode> <prompt>` as an argv array (argv[0]
 * is the `codex` binary itself — JobStore spawns argv[0] with the rest as
 * args). Resolves the effective mode itself (`opts.mode ?? mode`) because
 * JobStore calls buildArgs with the caller's original opts, not its own
 * resolved mode. Flag assembly is delegated to the shared buildCodexArgv so
 * ordering and the sandbox barricade live in one place.
 *
 * SECURITY (per-call allowlist): this trust boundary reads ONLY `opts.model`
 * and `opts.effort` — never arbitrary configOverrides from opts. An open
 * `-c key=value` passthrough would let a caller emit
 * `-c sandbox_mode=danger-full-access` and subvert the `--sandbox` barricade.
 * `effort` maps to the single hardcoded key `model_reasoning_effort`, so a
 * caller can never choose the config key. Invalid values throw (loud failure
 * beats silently running at the wrong model/effort); the dispatch tool
 * surfaces the throw as a clean MCP error.
 */
export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const effectiveMode: AdapterMode = opts.mode ?? mode;

  const cfg: CodexArgvConfig = {};
  const { model, effort } = opts;
  if (model !== undefined) {
    if (typeof model !== "string" || model.length === 0) {
      throw new TypeError(`codex: opts.model must be a non-empty string if provided, got ${typeof model}`);
    }
    cfg.model = model;
  }
  if (effort !== undefined) {
    if (typeof effort !== "string" || !EFFORT_LEVELS.has(effort)) {
      throw new TypeError('codex: opts.effort must be "low" | "medium" | "high" if provided');
    }
    cfg.configOverrides = { model_reasoning_effort: effort };
  }

  return buildCodexArgv(prompt, effectiveMode, cfg);
}

/** Extract + validate the contract markers from stdout; stderr never contributes to summary/raw. */
export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  if (exitCode !== 0) {
    return { status: "failed", summary: `codex exited ${exitCode}`, artifacts: [], raw: stdout };
  }
  if (!VERDICT_RE.test(stdout) || !FINDINGS_RE.test(stdout)) {
    return {
      status: "failed",
      summary: "codex output is missing the required contract marker(s) (VERDICT:/## Findings)",
      artifacts: [],
      raw: stdout,
    };
  }
  return { status: "done", summary: stdout.trim(), artifacts: [], raw: stdout };
}
