/**
 * TEMPORARY STUB (gemini worktree). The core agent's `src/adapters/_usage-marker.ts`
 * and `UsageRecord` in `src/types.ts` supersede this file at merge.
 */
/** docs/usage-contract.md section 1. */
export interface UsageRecord {
  model: string | null;
  calls: number;
  items: number | null;
  ok: number | null;
  failed: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costIsEstimate: true;
}

/** Last `<marker>:{json}` line wins; null when absent or unparseable. */
export function parseUsageMarker(stdout: string, marker: string): UsageRecord | null {
  let last: string | undefined;
  for (const line of stdout.split("\n")) {
    const l = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (l.startsWith(`${marker}:{`)) last = l.slice(marker.length + 1);
  }
  if (last === undefined) return null;
  try {
    const v = JSON.parse(last) as Partial<UsageRecord>;
    if (typeof v !== "object" || v === null || typeof v.calls !== "number") return null;
    return {
      model: typeof v.model === "string" ? v.model : null,
      calls: v.calls,
      items: typeof v.items === "number" ? v.items : null,
      ok: typeof v.ok === "number" ? v.ok : null,
      failed: typeof v.failed === "number" ? v.failed : null,
      inputTokens: typeof v.inputTokens === "number" ? v.inputTokens : null,
      outputTokens: typeof v.outputTokens === "number" ? v.outputTokens : null,
      costUsd: typeof v.costUsd === "number" ? v.costUsd : null,
      costIsEstimate: true,
    };
  } catch {
    return null;
  }
}
