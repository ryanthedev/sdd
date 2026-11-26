/**
 * Shared agy helpers — the single place that owns the agy argv-order
 * guarantee and the last-occurrence marker-match scan. `agy.ts` and
 * `_agy-image.ts` both delegate here so the flag-order landmine fix and the
 * marker-collision fix exist exactly once (`_agy-vision.ts` consumes this
 * too).
 *
 * Leading `_` in the filename: adapter discovery (`discover.ts`'s
 * `isCandidate`) skips underscore-prefixed files, so this helper is never
 * loaded as an adapter.
 *
 * FLAG ORDER (see agy.ts's header): `--print` takes the single argv element
 * immediately following it as the prompt, so that pairing must stay intact.
 * `buildAgyArgv` makes it structural rather than conventional: the prompt is
 * always the LAST array element, `--print` always the element immediately
 * before it, and no code path can insert anything after the prompt.
 *
 * CORRECTION (verified against agy 1.1.5, 2026-07-21): an earlier version of
 * this comment claimed a flag placed after the prompt is "silently absorbed
 * into the prompt string" and that "agy exits 0 on this misparse". That is
 * FALSE for 1.1.5 and the exit-0 half was never demonstrated at all.
 * Measured: `agy --sandbox --print "reply with just OK" --nope` prints
 * "flags provided but not defined: -nope" and exits 2; an invalid value
 * (`--effort bogus`) exits 1. Both reject BEFORE any model call. The ordering
 * guarantee is kept anyway — it is the house rule for every adapter (some
 * harnesses genuinely do absorb a trailing flag), and structural ordering
 * costs nothing — but it is a convention, not a fix for an agy bug.
 *
 * TRUST BOUNDARY: `subcommandFlags` is caller-assembled and must already be
 * validated by the caller (e.g. `agy.ts`'s `pushOptionalStringFlag` throws on
 * a malformed `opts.model` before it ever reaches here) — this function only
 * guarantees ordering, it does not itself validate untrusted input.
 */
import type { DispatchOpts } from "../types.ts";

/** Verified against agy 1.5.14 (`agy --help`: low|medium|high|xhigh|max). */
export const AGY_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const AGY_EFFORT_SET: ReadonlySet<string> = new Set(AGY_EFFORT_LEVELS);

export function buildAgyArgv(subcommandFlags: string[], prompt: string): string[] {
  return ["agy", ...subcommandFlags, "--print", prompt];
}

/** Validate and append `--effort <level>` for any agy capability. */
export function pushAgyEffortFlag(flags: string[], opts: DispatchOpts, label = "agy"): void {
  const effort = opts.effort;
  if (effort === undefined) return;
  if (typeof effort !== "string" || !AGY_EFFORT_SET.has(effort)) {
    throw new TypeError(
      `${label}: opts.effort must be ${AGY_EFFORT_LEVELS.map((e) => `"${e}"`).join(" | ")} if provided, got: ${JSON.stringify(effort)}`,
    );
  }
  flags.push("--effort", effort);
}

/** Validate and append `<flag> <value>` when `opts[key]` is present. */
export function pushAgyOptionalStringFlag(
  flags: string[],
  opts: DispatchOpts,
  key: string,
  flag: string,
  label = "agy",
): void {
  const value = opts[key];
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label}: opts.${key} must be a non-empty string if provided, got: ${JSON.stringify(value)}`);
  }
  flags.push(flag, value);
}

/**
 * MARKER-COLLISION LANDMINE: a harness may echo the injected contract
 * instructions (which literally contain example marker lines) before its
 * real, final verdict — making both the echoed example and the real marker
 * appear in stdout. The contract defines the marker as "the last line of
 * output," so callers must scan for the LAST marker-shaped match, not the
 * first — otherwise an echoed example can mask a real, later verdict.
 *
 * Scan every match of `re` in `text` and return the last one — never the
 * first. `re` must carry the `g` flag.
 */
export function lastMarkerMatch(re: RegExp, text: string): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(re)) last = m;
  return last;
}

/**
 * agy's account quota wall, recognised from its own error line. Observed
 * 2026-11-26 in real sdd job logs (agy 1.5.x), exit 3, no result marker:
 *
 *   AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Third-party quota reached. Please switch to Gemini models ... Resets in 3h8m40s.","status":"RESOURCE_EXHAUSTED","error_code":429,...}
 *   AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade ... Resets in 1h24m41s.",...}
 *
 * "Third-party" is the pool for non-Google models on agy (Claude, GPT-OSS):
 * Gemini models still run. "Individual" is the whole account. Only a line that
 * STARTS with `AGY_ERROR: ` and parses as JSON counts, and only on a non-zero
 * exit with no success marker, so a model quoting the text mid-answer can't
 * trip it. Both streams are scanned (stderr first, last occurrence wins)
 * because which stream agy uses for this line has not been pinned down.
 */
export interface AgyQuotaError {
  scope: "third-party" | "individual" | "unknown";
  resetsIn?: string;
  message: string;
}

const AGY_ERROR_LINE_RE = /^AGY_ERROR: (\{.*\})\s*$/gm;

function lastAgyError(text: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  for (const m of text.matchAll(AGY_ERROR_LINE_RE)) {
    try {
      const parsed: unknown = JSON.parse(m[1] ?? "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) found = parsed as Record<string, unknown>;
    } catch {
      // not JSON: not agy's structured error line
    }
  }
  return found;
}

export function agyQuotaError(stdout: string, stderr: string, exitCode: number): AgyQuotaError | undefined {
  if (exitCode === 0) return undefined;
  const err = lastAgyError(stderr) ?? lastAgyError(stdout);
  if (!err) return undefined;
  const message = typeof err.short_error === "string" ? err.short_error : "";
  if (err.status !== "RESOURCE_EXHAUSTED" && err.error_code !== 429) return undefined;
  const scope = /third-party quota/i.test(message) ? "third-party" : /individual quota/i.test(message) ? "individual" : "unknown";
  const resetsIn = /resets in ([0-9hms]+)/i.exec(message)?.[1];
  return { scope, ...(resetsIn ? { resetsIn } : {}), message };
}

/**
 * The failure summary for a quota wall. It starts with the stable token
 * `QUOTA_EXHAUSTED` so callers (the subagent-driven-development skill's
 * fallback recipe) can branch on it, and names what still works.
 */
export function agyQuotaSummary(label: string, q: AgyQuotaError): string {
  const reset = q.resetsIn ? ` resets_in=${q.resetsIn}` : "";
  const next =
    q.scope === "third-party"
      ? "Non-Google models (Claude) on agy are out; Gemini models on agy still run. For a Claude model, re-dispatch on the claude adapter."
      : q.scope === "individual"
        ? "Every agy model is out until the reset. Re-dispatch on another harness (claude, codex, or gemini for vision)."
        : "Re-dispatch on another harness.";
  return `${label}: QUOTA_EXHAUSTED scope=${q.scope}${reset}. ${next}`;
}
