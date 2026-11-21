/**
 * Unit tests for `src/lib/models.ts` and the `list_models` MCP tool.
 * Uses synthetic fixture adapters (no real codex/agy/grok calls) to verify
 * static models, live cli-stdout probes, live jsonrpc probes, caching, refresh,
 * and error containment.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearModelsCache, formatModelsSnapshot, readAdapterModels } from "../src/lib/models.ts";
import { createListModelsTool } from "../src/tools/list-models.ts";
import { createRuntime, type Runtime } from "../src/tools/runtime.ts";

const BUN = process.execPath;
const tmpDirs: string[] = [];
const runtimes: Runtime[] = [];

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function newRuntime(adaptersDir: string): Runtime {
  const rt = createRuntime({
    adaptersDir,
    jobStoreOptions: { logDir: freshDir("sdd-models-logs-") },
  });
  runtimes.push(rt);
  return rt;
}

afterEach(async () => {
  clearModelsCache();
  for (const rt of runtimes.splice(0)) await rt.jobStore.shutdown();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("readAdapterModels returns static models without spawning", async () => {
  const res = await readAdapterModels({
    name: "claude",
    models: [{ id: "opus", displayName: "Claude Opus", effortLevels: ["low", "max"] }],
  });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.snapshot.source).toBe("static");
    expect(res.snapshot.models[0]!.id).toBe("opus");
    expect(formatModelsSnapshot(res.snapshot)).toContain("opus (Claude Opus; effort: low|max)");
  }
});

test("readAdapterModels executes cli-stdout probe and caches until refresh:true", async () => {
  const counterFile = join(freshDir("sdd-models-cnt-"), "count.txt");
  const script = `
    const fs = require("node:fs");
    const n = fs.existsSync(${JSON.stringify(counterFile)}) ? Number(fs.readFileSync(${JSON.stringify(counterFile)}, "utf8")) + 1 : 1;
    fs.writeFileSync(${JSON.stringify(counterFile)}, String(n));
    process.stdout.write("model-" + n + "\\n");
  `;
  const adapter = {
    name: "fake-cli",
    readModels: { transport: "cli-stdout" as const, binary: BUN, args: ["-e", script] },
    parseModels: (raw: unknown) =>
      typeof raw === "string"
        ? raw
            .trim()
            .split("\n")
            .map((id) => ({ id }))
        : [],
  };

  const first = await readAdapterModels(adapter);
  expect(first.ok).toBe(true);
  if (first.ok) expect(first.snapshot.models).toEqual([{ id: "model-1" }]);

  // Cached hit does not re-run the script
  const second = await readAdapterModels(adapter);
  expect(second.ok).toBe(true);
  if (second.ok) expect(second.snapshot.models).toEqual([{ id: "model-1" }]);

  // refresh:true forces a live re-read
  const third = await readAdapterModels(adapter, { refresh: true });
  expect(third.ok).toBe(true);
  if (third.ok) expect(third.snapshot.models).toEqual([{ id: "model-2" }]);
});

test("readAdapterModels executes app-server-jsonrpc probe cleanly", async () => {
  const serverScript = `
    const rl = require("node:readline").createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
      if (msg.method === "model/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { data: [{ id: "gpt-6.2-sol", isDefault: true }] } }) + "\\n");
    });
  `;
  const res = await readAdapterModels({
    name: "fake-rpc",
    readModels: {
      transport: "app-server-jsonrpc",
      binary: BUN,
      args: ["-e", serverScript],
      method: "model/list",
      params: {},
    },
    parseModels: (raw: unknown) => {
      const data = (raw as { data?: Array<{ id: string; isDefault?: boolean }> })?.data ?? [];
      return data.map((m) => ({ id: m.id, ...(m.isDefault ? { isDefault: true } : {}) }));
    },
  });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.snapshot.source).toBe("live");
    expect(res.snapshot.models).toEqual([{ id: "gpt-6.2-sol", isDefault: true }]);
  }
});

test("list_models tool reports known adapters, unsupported adapters, and errors on unknown adapter", async () => {
  const dir = freshDir("sdd-list-models-");
  writeFileSync(
    join(dir, "static-a.ts"),
    `export const name = "static-a";
     export const models = [{ id: "m1", isDefault: true }];
     export function buildArgs(p) { return ["echo", p]; }
     export function injectContract(p) { return p; }
     export function parseResult(o) { return { status: "done", summary: o, artifacts: [], raw: o }; }`,
  );
  writeFileSync(
    join(dir, "plain-b.ts"),
    `export const name = "plain-b";
     export function buildArgs(p) { return ["echo", p]; }
     export function injectContract(p) { return p; }
     export function parseResult(o) { return { status: "done", summary: o, artifacts: [], raw: o }; }`,
  );
  const rt = newRuntime(dir);
  const tool = createListModelsTool(rt);

  const all = await tool.handler({});
  expect(all.isError).toBeUndefined();
  expect(all.content[0]!.text).toContain("static-a (static, 1 model):");
  expect(all.content[0]!.text).toContain("no model listing: plain-b");

  const missing = await tool.handler({ adapter: "nope" });
  expect(missing.isError).toBe(true);
  expect(missing.content[0]!.text).toContain('unknown adapter "nope"');
});

test("readAdapterModels handles cli-stdout timeout, missing binary, and throwing parseModels", async () => {
  const hung = await readAdapterModels(
    {
      name: "hung-cli",
      readModels: { transport: "cli-stdout", binary: BUN, args: ["-e", "setInterval(()=>{}, 1e9)"] },
      parseModels: () => [],
    },
    { timeoutMs: 150 },
  );
  expect(hung.ok).toBe(false);
  if (!hung.ok) expect(hung.error).toContain("timed out");

  const absent = await readAdapterModels({
    name: "missing-bin",
    readModels: { transport: "cli-stdout", binary: "definitely-not-a-real-binary-xyz123", args: [] },
    parseModels: () => [],
  });
  expect(absent.ok).toBe(false);
  if (!absent.ok) expect(absent.error).toContain("not on PATH");

  const broken = await readAdapterModels({
    name: "broken-parser",
    readModels: { transport: "cli-stdout", binary: BUN, args: ["-e", "process.stdout.write('ok')"] },
    parseModels: () => {
      throw new Error("boom");
    },
  });
  expect(broken.ok).toBe(false);
  if (!broken.ok) expect(broken.error).toContain("boom");
});
