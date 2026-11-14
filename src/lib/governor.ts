/**
 * Read-only view of the user's Claude usage governor, when one is installed.
 *
 * The governor (a separate tool) reads Claude Code's weekly usage every few
 * minutes and writes `state.json` (`$USAGE_GOVERNOR_DIR`, default
 * `~/.claude/usage-governor`). Surfacing it in `usage` puts Claude, Gemini and
 * codex spend behind ONE tool, so an agent never needs shell permission to run
 * `ugov status`. Absent or unreadable state = null (nothing is reported); this
 * module never writes and never throws.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GovernorMeter {
  name: string;
  decision: string;
  pct: number | null;
  used24h: number | null;
  hardStop: number | null;
  dailyBurst: number | null;
  usd24h?: number | null;
  usdMonth?: number | null;
  dailyUsd?: number | null;
  monthlyUsd?: number | null;
}

export interface GovernorView {
  decision: string;
  reason: string;
  readAt: number | null; // epoch seconds
  ageSeconds: number | null;
  stale: boolean; // the governor's own gate treats state older than 15 min as STOP
  meters: GovernorMeter[];
}

const STALE_SECONDS = 15 * 60;

export function governorDir(): string {
  return process.env.USAGE_GOVERNOR_DIR || join(homedir(), ".claude", "usage-governor");
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function readGovernor(dir: string = governorDir(), nowMs: number = Date.now()): GovernorView | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const st = raw as Record<string, unknown>;
  if (typeof st.decision !== "string") return null;
  const readAt = num(st.read_at);
  const age = readAt === null ? null : Math.max(0, Math.round(nowMs / 1000 - readAt));
  const meters: GovernorMeter[] = [];
  if (typeof st.meters === "object" && st.meters !== null) {
    for (const [name, m] of Object.entries(st.meters as Record<string, unknown>)) {
      if (typeof m !== "object" || m === null) continue;
      const r = m as Record<string, unknown>;
      meters.push({
        name,
        decision: typeof r.decision === "string" ? r.decision : "unknown",
        pct: num(r.pct),
        used24h: num(r.used_24h),
        hardStop: num(r.hard_stop),
        dailyBurst: num(r.daily_burst),
        usd24h: num(r.usd_24h),
        usdMonth: num(r.usd_month),
        dailyUsd: num(r.daily_usd),
        monthlyUsd: num(r.monthly_usd),
      });
    }
  }
  return {
    decision: st.decision,
    reason: typeof st.reason === "string" ? st.reason : "",
    readAt,
    ageSeconds: age,
    stale: age === null || age > STALE_SECONDS,
    meters,
  };
}

const pct = (v: number | null) => (v === null ? "?" : `${v}%`);

/** Dollar-spend meters (decision and vision pools): reported by sdd's own spend line, never as Claude quota. */
const SPEND_METERS = new Set(["gemini", "gemini_vision"]);

/** One line per Claude meter (all, fable). */
export function renderGovernor(v: GovernorView): string {
  const age = v.ageSeconds === null ? "age unknown" : `read ${Math.round(v.ageSeconds / 60)}m ago`;
  const head = `claude (usage governor): ${v.decision}${v.stale ? " (STALE state: the governor treats this as STOP)" : ""} · ${age}`;
  const parts = v.meters
    .filter((m) => !SPEND_METERS.has(m.name))
    .map((m) => `${m.name} ${m.decision} weekly ${pct(m.pct)} (stop ${pct(m.hardStop)}), 24h ${pct(m.used24h)} of ${pct(m.dailyBurst)}`);
  return [head, ...parts.map((p) => `  ${p}`)].join("\n");
}
