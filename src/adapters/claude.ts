/**
 * claude adapter — Anthropic Claude Code CLI (`claude -p <prompt>`).
 * Verified against Claude Code 2.1.330 (`claude --help` and live `-p` runs).
 *
 * Non-interactive posture:
 *   - Default (writable): `--dangerously-skip-permissions` so headless jobs
 *     never hang waiting on a TTY permission prompt.
 *   - `opts.readOnly: true`: `--permission-mode plan` (structurally non-writing;
 *     `--dangerously-skip-permissions` is NOT emitted).
 *   - Always emits `--no-session-persistence` so one-shot sdd jobs do not
 *     clutter the user's `/resume` session list.
 *
 * Effort allowlist (verified against Claude Code 2.1.330):
 *   `low | medium | high | xhigh | max`.
 *   CRITICAL: the `claude` CLI prints a warning and SILENTLY IGNORES an unknown
 *   `--effort` value instead of exiting non-zero — so validating `opts.effort`
 *   here and throwing `TypeError` on invalid values is load-bearing.
 *
 * Output contract: joins the shared review contract (`VERDICT:` + `## Findings`,
 * `src/lib/review-contract.ts`) so `claude` drops directly into ensemble reviews
 * alongside `codex`, `grok`, `kimi`, `qwen`, and `mistral`.
 *
 * No `readLimits` / governor coupling here by design — Claude's usage governor
 * is kept separate.
 */
import type { AdapterResult, DispatchOpts, ModelInfo } from "../types.ts";
import type { FlatAdapterModule } from "./types.ts";
import { resolveOptionalAddDir, resolveReadOnly } from "../lib/path-barricade.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";

export const name = "claude";

/** Verified against Claude Code 2.1.330 (`--effort` help & live validation). */
export const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
const CLAUDE_EFFORT_LEVELS: ReadonlySet<string> = new Set(effortLevels);

export const supportsReadOnly = true;

/**
 * Curated CLI aliases documented by `claude --help` (`--model`). Full model IDs
 * (e.g. `claude-opus-5-5`) are also accepted directly via `opts.model`.
 */
export const models: readonly ModelInfo[] = [
  { id: "opus", displayName: "Claude Opus (latest alias)", effortLevels: [...effortLevels] },
  { id: "sonnet", displayName: "Claude Sonnet (latest alias)", effortLevels: [...effortLevels] },
  { id: "fable", displayName: "Claude Fable (latest alias)", effortLevels: [...effortLevels] },
  { id: "haiku", displayName: "Claude Haiku (latest alias)", effortLevels: [...effortLevels] },
];

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const readOnly = resolveReadOnly(name, opts, true);
  const addDir = resolveOptionalAddDir(name, opts);

  const argv: string[] = ["claude"];
  if (readOnly) {
    argv.push("--permission-mode", "plan");
  } else {
    argv.push("--dangerously-skip-permissions");
  }
  argv.push("--no-session-persistence");

  const { model, effort } = opts;
  if (model !== undefined) {
    if (typeof model !== "string" || model.length === 0) {
      throw new TypeError(`claude: opts.model must be a non-empty string if provided, got ${typeof model}`);
    }
    argv.push("--model", model);
  }
  if (effort !== undefined) {
    if (typeof effort !== "string" || !CLAUDE_EFFORT_LEVELS.has(effort)) {
      throw new TypeError(
        `claude: opts.effort must be ${effortLevels.map((e) => `"${e}"`).join(" | ")} if provided, got: ${JSON.stringify(effort)}`,
      );
    }
    argv.push("--effort", effort);
  }
  if (addDir !== undefined) {
    argv.push("--add-dir", addDir);
  }

  // Structural flag order: `-p` and prompt are ALWAYS last.
  argv.push("-p", prompt);
  return argv;
}

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

const _check: FlatAdapterModule = {
  name,
  effortLevels,
  supportsReadOnly,
  models,
  buildArgs,
  injectContract,
  parseResult,
};
void _check;
