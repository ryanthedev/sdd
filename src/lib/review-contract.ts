/**
 * Shared output contract for the "second-opinion / review" adapters (grok,
 * qwen, kimi, mistral). Review is the job they are ASKED to do, not a limit on
 * what they can do — each runs headlessly permissive and may edit the tree it
 * is given. These CLIs differ only in their binary and one-shot flag; the
 * contract they must satisfy — a `VERDICT:` line plus a `## Findings` section —
 * is identical, so it lives here rather than being copy-pasted four times. Mirrors the codex adapter's contract exactly (codex
 * predates this helper and keeps its own inline copy).
 *
 * Kept in src/lib/ (NOT src/adapters/) on purpose: the adapter directory scan
 * (discover.ts) would otherwise try to load this as an adapter, fail the port
 * validation, and log a spurious warning on every startup.
 */
import type { AdapterResult } from "../types.ts";

const CONTRACT_SUFFIX =
  '\n\nWhen you are done, end your final answer with a line starting exactly with "VERDICT:" followed by a ' +
  'one-line verdict, then a "## Findings" section (write "## Findings\nNone." if there are none).';

// Tolerant of leading markdown the model adds despite the "exactly" instruction:
// bold/italic (`**VERDICT:**`), headings (`### VERDICT:`), blockquote/list
// prefixes, and leading whitespace. Verified against real grok output, which
// emitted `**VERDICT:**` and would otherwise fail a strict `^VERDICT:` match.
const MARKDOWN_PREFIX = "[ \\t]*(?:[*_#>-]+[ \\t]*)*";
const VERDICT_RE = new RegExp(`^${MARKDOWN_PREFIX}VERDICT:`, "im");
const FINDINGS_RE = new RegExp(`^${MARKDOWN_PREFIX}Findings\\b`, "im");

/** Append the review output-contract markers to a caller's prompt. */
export function injectReviewContract(prompt: string): string {
  return `${prompt}${CONTRACT_SUFFIX}`;
}

/**
 * Validate a finished review CLI's stdout against the contract. A non-zero exit
 * or a missing `VERDICT:`/`## Findings` marker yields `failed` — the same
 * silent-misparse backstop codex uses, so a harness that exits 0 without
 * actually producing a structured review is caught rather than trusted. `name`
 * is the adapter name, only used to phrase the failure summary.
 */
export function parseReviewResult(name: string, stdout: string, exitCode: number): AdapterResult {
  if (exitCode !== 0) {
    return { status: "failed", summary: `${name} exited ${exitCode}`, artifacts: [], raw: stdout };
  }
  if (!VERDICT_RE.test(stdout) || !FINDINGS_RE.test(stdout)) {
    return {
      status: "failed",
      summary: `${name} output is missing the required contract marker(s) (VERDICT:/## Findings)`,
      artifacts: [],
      raw: stdout,
    };
  }
  return { status: "done", summary: stdout.trim(), artifacts: [], raw: stdout };
}
