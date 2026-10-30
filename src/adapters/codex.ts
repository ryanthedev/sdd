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
import type { AdapterResult, DispatchOpts, UsageSnapshot, UsageWindow } from "../types.ts";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { buildCodexArgv, type CodexArgvConfig } from "./_codex-shared.ts";
import { DEFAULT_KIND } from "./types.ts";
import type { Capability, LimitsProbe, MultiAdapterModule } from "./types.ts";
import {
  appendSavePath,
  injectImageContract,
  markerFor,
  parseImageResult,
  resolveImageOutputPath,
} from "../lib/image-contract.ts";

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
  return buildCodexArgv(prompt, toArgvConfig(opts));
}

/**
 * The per-call allowlist, shared by EVERY codex kind.
 *
 * Extracted so the image kind cannot drift into its own copy: this is the trust
 * boundary described above, and two copies means one of them eventually stops
 * rejecting `sandbox_mode=danger-full-access`.
 */
function toArgvConfig(opts: DispatchOpts): CodexArgvConfig {
  const cfg: CodexArgvConfig = {};
  if (inTempDir(opts.cwd)) cfg.skipGitRepoCheck = true;
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

  return cfg;
}

/**
 * codex refuses to run outside a git repository unless told `--skip-git-repo-check`. That guard exists so codex
 * never edits files git cannot give back, and outside the temp dirs it stays on. Inside them there is nothing to
 * give back: a dispatch into a scratch folder (a video-ingest run writing a report page into /tmp, 2026-10-29)
 * is the whole point, and refusing it made codex useless there. Lexical on purpose: adapters do no I/O, and a
 * symlink out of /tmp still lands under the workspace-write sandbox rooted at that cwd.
 */
const TEMP_ROOTS = [...new Set([tmpdir(), "/tmp", "/private/tmp"].map((p) => resolve(p)))];

export function inTempDir(cwd: unknown): boolean {
  // Only a cwd the caller NAMED: an omitted one is the server's own folder, and the guard stays on there.
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  return TEMP_ROOTS.some((root) => resolve(cwd).startsWith(root + sep));
}

/**
 * codex refuses to run outside a git repository, exiting non-zero with this line
 * on stderr BEFORE it ever contacts the model. Verified against the real CLI. It
 * is easy to misread as an auth/quota failure, so we recognize it explicitly and
 * hand back the fix. Matches either half of the message in case the wording drifts.
 */
const GIT_REPO_REFUSAL_RE = /not inside a trusted directory|skip-git-repo-check/i;

/**
 * Last chunk of CONTRACT_SUFFIX, used to find where codex's echo of the prompt
 * ends. Derived from the constant rather than hardcoded so it can never drift
 * out of sync when the contract wording changes.
 */
const CONTRACT_ECHO_TAIL = CONTRACT_SUFFIX.trimEnd().slice(-40);

/**
 * Strip codex's echo of the prompt from stderr.
 *
 * codex writes the full prompt it was handed — INCLUDING our injected contract
 * suffix — to stderr before it runs. Tailing raw stderr therefore spends the
 * bounded budget on our own instruction text and yields a summary that opens
 * mid-sentence ("codex exited 1: -line verdict, then a ...") with the real error
 * pushed toward the end. Cutting at the LAST occurrence of the echo tail leaves
 * only what codex emitted after the echo, which is where diagnostics live.
 *
 * LAST occurrence, not first — the same rule agy.ts documents: the prompt itself
 * may legitimately quote the contract text, so an early match is the quote and
 * the real end-of-echo is the final one. When the echo is absent (codex failed
 * before echoing, e.g. the git-repo refusal) stderr is returned untouched.
 *
 * NEVER discards everything: if nothing follows the echo, the diagnostics must
 * have preceded it, so the original stderr is returned. Losing the only error
 * text would be strictly worse than printing our own instruction back.
 */
function stripContractEcho(stderr: string): string {
  const idx = stderr.lastIndexOf(CONTRACT_ECHO_TAIL);
  if (idx === -1) return stderr;
  const after = stderr.slice(idx + CONTRACT_ECHO_TAIL.length);
  return after.trim() ? after : stderr;
}

/**
 * Bounded stderr tail, cut on a line boundary so a summary never opens mid-word.
 *
 * The line-boundary trim is cosmetic and must never cost content: when the
 * leading partial line is most of the window (one very long error line followed
 * by a short one), dropping it would throw the error away to gain tidiness. In
 * that case the raw tail wins — a summary that starts mid-word still carries the
 * diagnostic, and a tidy one that lost it does not.
 */
function stderrTail(stderr: string, cap: number): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= cap) return trimmed;
  const tail = trimmed.slice(-cap);
  const nl = tail.indexOf("\n");
  if (nl === -1) return tail.trim();
  const trimmedTail = tail.slice(nl + 1).trim();
  return trimmedTail.length >= cap / 2 ? trimmedTail : tail.trim();
}

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
      "dispatch codex with a git-repo cwd, or dispatch it in a folder under /tmp (where the check is skipped)."
    );
  }
  const tail = stderrTail(stripContractEcho(stderr), 600);
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

/**
 * Account-limits capability (see `LimitsProbe` and `src/lib/limits.ts`).
 *
 * `codex exec --json` reports per-turn TOKEN counts only — it carries no plan
 * quota — so usage cannot be scraped off a dispatch. The app-server protocol is
 * the only surface that exposes it: `account/rateLimits/read` takes null params,
 * runs no model, and costs nothing. Method name and payload shape verified
 * against `codex app-server generate-json-schema --experimental` and against a
 * live call — originally on codex-cli 0.144.1, re-verified unchanged on 0.145.0
 * (2026-07-21).
 */
export const readLimits: LimitsProbe = {
  transport: "app-server-jsonrpc",
  binary: "codex",
  args: ["app-server"],
  method: "account/rateLimits/read",
};

/** Narrow an unknown to an indexable record without asserting its contents. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Map one codex `RateLimitWindow` into a UsageWindow. Returns null when the
 * window is absent or carries no `usedPercent` — the one field that makes a
 * window meaningful. A window we cannot quantify is dropped rather than reported
 * as 0% used, which would read as "plenty left" on a payload we didn't understand.
 */
function toWindow(raw: unknown, name: string): UsageWindow | null {
  const w = asRecord(raw);
  if (!w) return null;
  const usedPercent = asNumber(w.usedPercent);
  if (usedPercent === null) return null;
  return {
    name,
    usedPercent,
    windowMinutes: asNumber(w.windowDurationMins),
    resetsAt: asNumber(w.resetsAt),
  };
}

/**
 * Normalize codex's `GetAccountRateLimitsResponse` into a UsageSnapshot.
 *
 * Two views of the same data come back: `rateLimits` (a single backward-compatible
 * bucket) and `rateLimitsByLimitId` (per-model buckets, e.g. `codex` and
 * `codex_bengalfox`). The multi-bucket view is preferred because it is strictly
 * more informative — an account can be fine on one model's quota and exhausted on
 * another — falling back to the single bucket when the map is absent.
 *
 * Tolerant by contract: every field is probed, never asserted. An unrecognized
 * payload yields an empty-window snapshot, not a throw.
 */
export function parseLimits(raw: unknown): Omit<UsageSnapshot, "adapter" | "fetchedAt"> {
  const root = asRecord(raw);
  const primaryBucket = asRecord(root?.rateLimits);
  const byId = asRecord(root?.rateLimitsByLimitId);

  // The MAP KEY is the bucket's identity, so it is carried alongside the value
  // and used as the last-resort label. Dropping it (Object.values) means two
  // buckets whose payload omits limitName/limitId both render as "codex" — two
  // identically-named windows with contradictory percentages, and no way to tell
  // which model is nearly exhausted. That is exactly the degraded-payload path
  // this normalizer exists to survive.
  const buckets: { bucket: Record<string, unknown>; key: string | null }[] = [];
  if (byId) {
    for (const [key, value] of Object.entries(byId)) {
      const bucket = asRecord(value);
      if (bucket) buckets.push({ bucket, key });
    }
  }
  if (buckets.length === 0 && primaryBucket) buckets.push({ bucket: primaryBucket, key: null });

  const windows: UsageWindow[] = [];
  for (const { bucket, key } of buckets) {
    const label = asString(bucket.limitName) ?? asString(bucket.limitId) ?? asString(key) ?? "codex";
    const primary = toWindow(bucket.primary, label);
    if (primary) windows.push(primary);
    const secondary = toWindow(bucket.secondary, `${label} (secondary)`);
    if (secondary) windows.push(secondary);
  }

  const creditsRaw = asRecord(primaryBucket?.credits) ?? asRecord(buckets[0]?.bucket.credits);
  const credits =
    creditsRaw && typeof creditsRaw.hasCredits === "boolean"
      ? {
          hasCredits: creditsRaw.hasCredits,
          unlimited: creditsRaw.unlimited === true,
          balance: asString(creditsRaw.balance),
        }
      : null;

  const reachedSource = buckets.find((b) => asString(b.bucket.rateLimitReachedType) !== null)?.bucket ?? primaryBucket;

  return {
    plan: asString(primaryBucket?.planType) ?? asString(buckets[0]?.bucket.planType),
    windows,
    credits,
    limitReached: asString(reachedSource?.rateLimitReachedType),
    individualLimit: toIndividualLimit(buckets),
    spendControlReached: toSpendControlReached(buckets, primaryBucket),
    resetCredits: toResetCredits(root?.rateLimitResetCredits),
  };
}

/**
 * Bucket-level spend-control ceiling, collapsed to the first bucket that
 * reports one (mirroring how `limitReached` collapses `rateLimitReachedType`).
 * Absent on personal plans, so `null` is the overwhelmingly common answer and
 * must not be mistaken for "no limit remaining".
 */
function toIndividualLimit(
  buckets: { bucket: Record<string, unknown> }[],
): UsageSnapshot["individualLimit"] {
  for (const { bucket } of buckets) {
    const raw = asRecord(bucket.individualLimit);
    if (!raw) continue;
    return {
      limit: asString(raw.limit),
      remainingPercent: asNumber(raw.remainingPercent),
      resetsAt: asNumber(raw.resetsAt),
      used: asString(raw.used),
    };
  }
  return null;
}

/**
 * Whether a spend-control ceiling is currently hit. Tri-state on purpose:
 * `null` means the harness never reported the field (an older payload), which
 * is NOT the same as `false` ("reported, and not hit"). Collapsing those two
 * would let an unrecognized payload read as "you're fine".
 */
function toSpendControlReached(
  buckets: { bucket: Record<string, unknown> }[],
  primaryBucket: Record<string, unknown> | null,
): boolean | null {
  for (const { bucket } of buckets) {
    if (typeof bucket.spendControlReached === "boolean") return bucket.spendControlReached;
  }
  return typeof primaryBucket?.spendControlReached === "boolean" ? primaryBucket.spendControlReached : null;
}

/**
 * Redeemable quota-reset grants — the source of codex's "You have N usage limit
 * resets available" line. Root-level in the payload (sibling of `rateLimits`),
 * NOT inside a bucket.
 *
 * `entries` is frequently `[]` while `availableCount` is non-zero — the live
 * payload behaves exactly that way. Callers must report the COUNT and never
 * infer "none available" from an empty entries array.
 */
function toResetCredits(raw: unknown): UsageSnapshot["resetCredits"] {
  const rec = asRecord(raw);
  if (!rec) return null;
  const availableCount = asNumber(rec.availableCount);
  const list = Array.isArray(rec.credits) ? rec.credits : [];
  const entries = list.flatMap((item) => {
    const entry = asRecord(item);
    if (!entry) return [];
    return [
      {
        id: asString(entry.id),
        status: asString(entry.status),
        title: asString(entry.title),
        expiresAt: asString(entry.expiresAt),
      },
    ];
  });
  if (availableCount === null && entries.length === 0) return null;
  return { availableCount, entries };
}

/**
 * Image generation — codex's second kind.
 *
 * VERIFIED, not assumed (2026-07-21, codex-cli 0.145.0). This adapter used to
 * be documented as text-only on the strength of `codex --help`, whose only
 * image flag is `-i/--image <FILE>` (images IN). That was wrong: codex ships a
 * SYSTEM SKILL at `~/.codex/skills/.system/imagegen/` exposing a built-in
 * `image_gen` tool, and skills are invisible to `--help`. Measured end-to-end
 * in headless `codex exec`: it generated a real 512x512 PNG, wrote it to the
 * absolute path named in the prompt (NOT to `$CODEX_HOME/generated_images`,
 * which is only the default when no destination is given), and echoed the
 * marker line back.
 *
 * That last detail is why no output-path flag is needed and why the shared
 * image contract works unchanged here: the destination travels in the prompt,
 * and `parseImageResult` stats the file rather than trusting the harness.
 *
 * Sandbox: `workspace-write` (the same as the default kind, via
 * `buildCodexArgv`) is what lets the child write the PNG at all. An absolute
 * `outputPath` outside the cwd is the caller's explicit choice; the barricade
 * in `resolveImageOutputPath` only stops a RELATIVE path from escaping.
 */
const IMAGE_MARKER = "CODEX_IMAGE_SAVED";
const IMAGE_MARKER_RE = markerFor(IMAGE_MARKER);

function buildImageArgs(prompt: string, opts: DispatchOpts): string[] {
  const outPath = resolveImageOutputPath(name, opts);
  // Model/effort still apply — image work is driven by the agent, so a caller
  // can still choose which model orchestrates it.
  return buildCodexArgv(appendSavePath(prompt, outPath), toArgvConfig(opts));
}

export const capabilities: Record<string, Capability> = {
  [DEFAULT_KIND]: { buildArgs, injectContract, parseResult },
  image: {
    buildArgs: buildImageArgs,
    injectContract: (prompt: string) => injectImageContract(prompt, IMAGE_MARKER),
    parseResult: (stdout: string, _stderr: string, exitCode: number) =>
      parseImageResult(name, IMAGE_MARKER_RE, stdout, exitCode),
  },
};

/** Review/implement is what `codex` means with no `kind`. */
export const defaultKind = DEFAULT_KIND;

const _check: MultiAdapterModule = { name, capabilities, defaultKind, readLimits, parseLimits };
void _check;
