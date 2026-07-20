/**
 * codex adapter — wraps the `codex exec` CLI as an Adapter (Phase 1 port).
 * Pure data + pure functions, no I/O: JobStore (Phase 2) spawns `buildArgs`'
 * argv and feeds the captured stdout/stderr/exitCode into `parseResult`.
 *
 * The harness always runs under `--sandbox workspace-write`: it may edit the
 * tree it is dispatched into, and nothing outside it. `danger-full-access` is
 * never emitted. Whether it is safe to let codex edit a given tree right now —
 * and whether two jobs may share one — is the CALLER's decision, not this
 * adapter's.
 *
 * Output split (verified against `codex exec --help` in this environment):
 * codex writes progress to STDERR and its final answer to STDOUT. `raw` is
 * built from stdout ONLY — stderr progress must never leak into a SUCCESSFUL
 * result (DW-3.2). The one exception is a FAILED result's `summary`: codex's
 * diagnostics (auth, quota, and the git-repo refusal below) land on stderr, so
 * on a non-zero exit `parseResult` surfaces a recognized signature or a bounded
 * stderr tail there — turning a bare "codex exited 1" into something actionable.
 * `raw` stays stdout-only on every path. `parseResult` also enforces the
 * contract-marker backstop: a missing `VERDICT:`/`## Findings` marker (or a
 * non-zero exit code) is `failed` regardless of what else is in stdout — the
 * same silent-misparse guard Phase 2 established for JobStore, applied here to
 * codex's own output contract.
 */
import type { AdapterResult, DispatchOpts } from "../types.ts";
import { buildCodexArgv, type CodexArgvConfig } from "./_codex-shared.ts";

export const name = "codex";

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
 * `codex exec [...flags] --sandbox workspace-write <prompt>` as an argv array
 * (argv[0] is the `codex` binary itself — JobStore spawns argv[0] with the rest
 * as args). Flag assembly is delegated to the shared buildCodexArgv so ordering
 * and the sandbox barricade live in one place.
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

  return buildCodexArgv(prompt, cfg);
}

/**
 * codex refuses to run outside a git repository, exiting non-zero with this line
 * on stderr BEFORE it ever contacts the model. Verified against the real CLI. It
 * is easy to misread as an auth/quota failure, so we recognize it explicitly and
 * hand back the fix. Matches either half of the message in case the wording drifts.
 */
const GIT_REPO_REFUSAL_RE = /not inside a trusted directory|skip-git-repo-check/i;

/**
 * Human-readable summary for a non-zero codex exit. stderr is where codex's real
 * diagnostics live, so we surface them here (summary only — never `raw`). A
 * recognized signature gets an actionable message; anything else gets a bounded
 * stderr tail so the caller sees the actual error instead of just the exit code.
 */
function codexFailureSummary(stderr: string, exitCode: number): string {
  if (GIT_REPO_REFUSAL_RE.test(stderr)) {
    return (
      "codex failed: its working directory is not a git repository. codex refuses to run outside a git repo " +
      '("Not inside a trusted directory and --skip-git-repo-check was not specified") and exits before ever ' +
      "reaching the model — this is NOT an auth or quota failure. Fix: run `git init` in the dispatch cwd, " +
      "dispatch codex with a git-repo cwd, or have the caller allow --skip-git-repo-check."
    );
  }
  const tail = stderr.trim().slice(-600).trim();
  return tail ? `codex exited ${exitCode}: ${tail}` : `codex exited ${exitCode}`;
}

/** Extract + validate the contract markers from stdout; `raw` is always stdout-only (see header). */
export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  if (exitCode !== 0) {
    return { status: "failed", summary: codexFailureSummary(stderr, exitCode), artifacts: [], raw: stdout };
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
