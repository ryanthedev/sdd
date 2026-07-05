/**
 * codex adapter — wraps the `codex exec` CLI as an Adapter (Phase 1 port).
 * Pure data + pure functions, no I/O: JobStore (Phase 2) spawns `buildArgs`'
 * argv and feeds the captured stdout/stderr/exitCode into `parseResult`.
 *
 * Read-only by default: `mode` is "read" (a review/second-opinion harness).
 * `buildArgs` maps to codex's sandbox flag: "read" -> --sandbox read-only,
 * "write" -> --sandbox workspace-write. `danger-full-access` is never emitted.
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

export const name = "codex";
export const mode: AdapterMode = "read";

const SANDBOX_BY_MODE: Record<AdapterMode, "read-only" | "workspace-write"> = {
  read: "read-only",
  write: "workspace-write",
};

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
 * `codex exec --sandbox <mode> <prompt>` as an argv array (argv[0] is the
 * `codex` binary itself — JobStore spawns argv[0] with the rest as args).
 * Resolves the effective mode itself (`opts.mode ?? mode`) because JobStore
 * calls buildArgs with the caller's original opts, not its own resolved mode.
 */
export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const effectiveMode: AdapterMode = opts.mode ?? mode;
  return ["codex", "exec", "--sandbox", SANDBOX_BY_MODE[effectiveMode], prompt];
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
