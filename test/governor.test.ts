import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGovernor, renderGovernor } from "../src/lib/governor.ts";
import { createRuntime, type Runtime } from "../src/tools/runtime.ts";
import { createUsageTool } from "../src/tools/usage.ts";

const dirs: string[] = [];
const rts: Runtime[] = [];
afterEach(async () => {
  for (const r of rts.splice(0)) await r.jobStore.shutdown();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "sdd-gov-"));
  dirs.push(d);
  return d;
};

const NOW = 1_800_000_000_000;
const state = (readAt: number) =>
  JSON.stringify({
    decision: "RUN",
    reason: "ok",
    meters: {
      all: { decision: "RUN", pct: 31, used_24h: 24, hard_stop: 90, daily_burst: 30 },
      fable: { decision: "STOP", pct: 95, used_24h: 5, hard_stop: 90, daily_burst: 10 },
      gemini: { decision: "RUN", usd_24h: 0.25, usd_month: 0.25, daily_usd: 5, monthly_usd: 50 },
      gemini_vision: { decision: "RUN", usd_24h: 0.5, usd_month: 0.5, daily_usd: 15, monthly_usd: 150 },
    },
    read_at: readAt,
  });

test("missing state file is null", () => {
  expect(readGovernor(fresh(), NOW)).toBeNull();
});

test("malformed or shapeless state is null", () => {
  const d = fresh();
  writeFileSync(join(d, "state.json"), "{not json");
  expect(readGovernor(d, NOW)).toBeNull();
  writeFileSync(join(d, "state.json"), JSON.stringify({ reason: "x" }));
  expect(readGovernor(d, NOW)).toBeNull();
  writeFileSync(join(d, "state.json"), "42");
  expect(readGovernor(d, NOW)).toBeNull();
});

test("fresh state parses meters and is not stale", () => {
  const d = fresh();
  writeFileSync(join(d, "state.json"), state(NOW / 1000 - 60));
  const v = readGovernor(d, NOW)!;
  expect(v.decision).toBe("RUN");
  expect(v.stale).toBe(false);
  expect(v.ageSeconds).toBe(60);
  expect(v.meters.map((m) => m.name)).toEqual(["all", "fable", "gemini", "gemini_vision"]);
  expect(v.meters[0]).toMatchObject({ pct: 31, used24h: 24, hardStop: 90, dailyBurst: 30 });
  expect(v.meters[2]).toMatchObject({ usd24h: 0.25, dailyUsd: 5 });
});

test("state older than 15 minutes, or without read_at, is stale", () => {
  const d = fresh();
  writeFileSync(join(d, "state.json"), state(NOW / 1000 - 16 * 60));
  expect(readGovernor(d, NOW)!.stale).toBe(true);
  writeFileSync(join(d, "state.json"), JSON.stringify({ decision: "RUN" }));
  const v = readGovernor(d, NOW)!;
  expect(v.stale).toBe(true);
  expect(v.ageSeconds).toBeNull();
});

test("renderGovernor omits the gemini and gemini_vision meters and flags staleness", () => {
  const d = fresh();
  writeFileSync(join(d, "state.json"), state(NOW / 1000 - 60));
  const out = renderGovernor(readGovernor(d, NOW)!);
  expect(out).toContain("all RUN weekly 31%");
  expect(out).toContain("fable STOP weekly 95%");
  expect(out).not.toContain("gemini");
  expect(out).not.toContain("gemini_vision");
  expect(out).not.toContain("STALE");
  writeFileSync(join(d, "state.json"), state(NOW / 1000 - 3600));
  expect(renderGovernor(readGovernor(d, NOW)!)).toContain("STALE");
});

function usageTool(governorDir?: string) {
  const rt = createRuntime({
    adaptersDir: fresh(),
    governorDir,
    ledgerPath: join(fresh(), "l.jsonl"),
    budgetPath: join(fresh(), "nb.json"),
    jobStoreOptions: { logDir: fresh() },
  });
  rts.push(rt);
  return createUsageTool(rt);
}

test("usage() includes the governor block when state.json exists", async () => {
  const d = fresh();
  writeFileSync(join(d, "state.json"), state(Date.now() / 1000 - 30));
  const r = await usageTool(d).handler({});
  expect(r.content[0]!.text).toContain("claude (usage governor): RUN");
  expect((r.structuredContent as any).governor.decision).toBe("RUN");
});

test("usage() omits the governor when state is absent or no dir is configured", async () => {
  for (const dir of [fresh(), undefined]) {
    const r = await usageTool(dir).handler({});
    expect(r.content[0]!.text).not.toContain("usage governor");
    expect((r.structuredContent as any).governor).toBeUndefined();
  }
});
