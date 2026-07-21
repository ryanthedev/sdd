/**
 * The `usage` MCP tool over a shared Runtime. Fixture adapters are written as
 * real files into a fresh temp adapters dir (same technique as tools.test.ts),
 * so the tool exercises real directory-scan discovery; the capable fixture
 * points its probe at a fake `bun -e` app-server rather than at codex, so the
 * suite never depends on a real CLI being installed or authenticated.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearLimitsCache } from "../src/lib/limits.ts";
import { createRuntime, type Runtime } from "../src/tools/runtime.ts";
import type { ToolResult } from "../src/tools/shared.ts";
import { createUsageTool } from "../src/tools/usage.ts";

const BUN = process.execPath;
const tmpDirs: string[] = [];
const runtimes: Runtime[] = [];

afterEach(async () => {
  clearLimitsCache();
  for (const rt of runtimes.splice(0)) await rt.jobStore.shutdown();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sdd-usage-"));
  tmpDirs.push(d);
  return d;
}

function newRuntime(adaptersDir: string): Runtime {
  const rt = createRuntime({ adaptersDir, jobStoreOptions: { logDir: freshDir() } });
  runtimes.push(rt);
  return rt;
}

const PLAIN_ADAPTER = (name: string) => `
export const name = ${JSON.stringify(name)};
export function buildArgs() { return ["true"]; }
export function injectContract(p) { return p; }
export function parseResult() { return { status: "done", summary: "", artifacts: [], raw: "" }; }
`;

/** A fake app-server that answers initialize then the limits method. */
const FAKE_SERVER = `
  const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  let buf = "";
  process.stdin.on("data", (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.method === "initialize") send({ id: msg.id, result: {} });
      if (msg.method === "limits/read") send({ id: msg.id, result: { plan: "plus", used: 42 } });
    }
  });
`;

const CAPABLE_ADAPTER = (name: string) => `${PLAIN_ADAPTER(name)}
export const readLimits = {
  transport: "app-server-jsonrpc",
  binary: ${JSON.stringify(BUN)},
  args: ["-e", ${JSON.stringify(FAKE_SERVER)}],
  method: "limits/read",
};
export function parseLimits(raw) {
  return {
    plan: raw?.plan ?? null,
    windows: [{ name: "w", usedPercent: raw?.used ?? 0, windowMinutes: 10080, resetsAt: null }],
    credits: null,
    limitReached: null,
  };
}
`;

function write(dir: string, file: string, body: string): void {
  writeFileSync(join(dir, file), body, "utf8");
}

const text = (r: ToolResult): string => r.content[0]!.text;

test("an unknown adapter name is an error, not an empty report", async () => {
  const tool = createUsageTool(newRuntime(freshDir()));
  const r = await tool.handler({ adapter: "nope" });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("unknown adapter");
});

test("reports a capable adapter's snapshot", async () => {
  const dir = freshDir();
  write(dir, "capable.ts", CAPABLE_ADAPTER("capable"));
  const tool = createUsageTool(newRuntime(dir));

  const r = await tool.handler({ adapter: "capable" });
  expect(r.isError).toBeUndefined();
  expect(text(r)).toContain("capable (plan plus)");
  expect(text(r)).toContain("42% used of 7d");

  const reports = r.structuredContent?.reports as { ok: boolean; snapshot: { plan: string } }[];
  expect(reports[0]!.ok).toBe(true);
  expect(reports[0]!.snapshot.plan).toBe("plus");
});

test("a named adapter that cannot report limits is a real answer, not an error", async () => {
  const dir = freshDir();
  write(dir, "plain.ts", PLAIN_ADAPTER("plain"));
  const tool = createUsageTool(newRuntime(dir));

  const r = await tool.handler({ adapter: "plain" });
  expect(r.isError).toBeUndefined();
  expect(text(r)).toContain("does not report account limits");
});

test("with no adapter named, every capable adapter is reported and the rest are listed as unsupported", async () => {
  const dir = freshDir();
  write(dir, "capable.ts", CAPABLE_ADAPTER("capable"));
  write(dir, "plain-a.ts", PLAIN_ADAPTER("plain-a"));
  write(dir, "plain-b.ts", PLAIN_ADAPTER("plain-b"));
  const tool = createUsageTool(newRuntime(dir));

  const r = await tool.handler({});
  const out = text(r);
  expect(out).toContain("capable (plan plus)");
  // Unsupported adapters are NAMED — "we can't see it" must not look like "it has no limits".
  expect(out).toContain("no limits reporting: plain-a, plain-b");
  expect((r.structuredContent?.reports as unknown[]).length).toBe(3);
});

test("an adapters dir with nothing capable says so instead of returning an empty report", async () => {
  const dir = freshDir();
  write(dir, "plain.ts", PLAIN_ADAPTER("plain"));
  const tool = createUsageTool(newRuntime(dir));

  expect(text(await tool.handler({}))).toContain("no discovered adapter reports account limits");
});

test("a capable adapter whose binary is missing degrades to an error line, not a throw", async () => {
  const dir = freshDir();
  write(
    dir,
    "broken.ts",
    CAPABLE_ADAPTER("broken").replace(JSON.stringify(BUN), JSON.stringify("definitely-not-installed-xyz")),
  );
  const tool = createUsageTool(newRuntime(dir));

  const r = await tool.handler({ adapter: "broken" });
  expect(r.isError).toBeUndefined();
  expect(text(r)).toContain("could not read limits");
  expect(text(r)).toContain("not on PATH");
});
