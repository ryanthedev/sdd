/**
 * Shared, pure parser for the `<MARKER>:{json}` usage line a script prints
 * (docs/usage-contract.md §2). `_`-prefixed so discovery never loads it as an
 * adapter. Degrades, never throws: anything it cannot trust is `null`, and a
 * missing number is `null` (unknown), never 0.
 */
import type { UsageRecord } from "../types.ts";

/** The LAST `<marker>:{json}` line of `stdout`, validated; null if absent or malformed. */
export function parseUsageMarker(stdout: string, marker: string): UsageRecord | null {
  try {
    if (typeof stdout !== "string" || typeof marker !== "string" || marker.length === 0) return null;
    const prefix = `${marker}:`;
    let payload: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith(prefix)) payload = t.slice(prefix.length); // last wins (cumulative; may print several times)
    }
    if (payload === undefined) return null;

    const raw: unknown = JSON.parse(payload);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;

    // `calls` is the one non-nullable number: without it the record is meaningless.
    const calls = num(o.calls);
    if (calls === null || calls < 0) return null;

    return {
      model: typeof o.model === "string" && o.model.length > 0 ? o.model : null,
      calls,
      items: num(o.items),
      ok: num(o.ok),
      failed: num(o.failed),
      inputTokens: num(o.inputTokens),
      outputTokens: num(o.outputTokens),
      costUsd: num(o.costUsd),
      ...unknownCallsOf(o.unknownCalls),
      costIsEstimate: true,
    };
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `{unknownCalls}` only when it is a positive count; absent otherwise. */
function unknownCallsOf(v: unknown): { unknownCalls?: number } {
  const n = num(v);
  return n !== null && n > 0 ? { unknownCalls: n } : {};
}
