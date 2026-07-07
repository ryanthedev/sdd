/**
 * codex-low adapter — pure-function unit tests, plus the list_adapters
 * integration check (DW-2.4) against the real adapters directory. Mirrors
 * `test/adapter-codex-high.test.ts` and `tools.test.ts`'s
 * `test_DW_3_3_list_adapters_reports_codex_from_real_adapters_dir`.
 */
import { expect, test } from "bun:test";
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as codex from "../src/adapters/codex.ts";
import * as codexLow from "../src/adapters/codex-low.ts";
import { discoverAdapters } from "../src/adapters/discover.ts";
import { createListAdaptersTool } from "../src/tools/list-adapters.ts";
import { createRuntime, type Runtime } from "../src/tools/runtime.ts";
import type { ToolResult } from "../src/tools/shared.ts";

function structured(result: ToolResult): Record<string, unknown> {
  return result.structuredContent ?? {};
}

const runtimes: Runtime[] = [];
const tmpDirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.jobStore.shutdown();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.2 (codex-low half): port shape + identity reuse of codex's contract.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_2_codex_low_exports_port_shape_and_reuses_codex_contract", () => {
  expect(codexLow.name).toBe("codex-low");
  expect(codexLow.mode).toBe("read");
  expect(codexLow.binary).toBe("codex");
  expect(typeof codexLow.buildArgs).toBe("function");
  expect(codexLow.injectContract).toBe(codex.injectContract);
  expect(codexLow.parseResult).toBe(codex.parseResult);
});

test("codex-low buildArgs pins low effort on the default model with no -m flag", () => {
  const argv = codexLow.buildArgs("review this", {});
  expect(argv).toEqual([
    "codex",
    "exec",
    "-c",
    "model_reasoning_effort=low",
    "--sandbox",
    "read-only",
    "review this",
  ]);
  expect(argv).not.toContain("-m");
});

test("codex-low ignores per-call model and effort just like codex-high", () => {
  const argv = codexLow.buildArgs("p", { model: "o3", effort: "high" });
  expect(argv).toEqual(["codex", "exec", "-c", "model_reasoning_effort=low", "--sandbox", "read-only", "p"]);
  expect(argv).not.toContain("o3");
  expect(argv).not.toContain("model_reasoning_effort=high");
});

test("codex-high and codex-low do not collide on name", () => {
  const names = discoverAdapters(join(import.meta.dir, "../src/adapters")).map((a) => a.name);
  const highCount = names.filter((n) => n === "codex-high").length;
  const lowCount = names.filter((n) => n === "codex-low").length;
  expect(highCount).toBe(1);
  expect(lowCount).toBe(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.4: list_adapters reports codex-high/codex-low with binaryPresent
// reflecting whether the real `codex` binary is on PATH.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_4_list_adapters_reports_variants_with_binary_present", async () => {
  const rt = createRuntime({ jobStoreOptions: { logDir: freshDir("sdd-codex-low-logs-") } }); // default adaptersDir = src/adapters
  runtimes.push(rt);
  const listAdapters = createListAdaptersTool(rt);

  const res = await listAdapters.handler({});
  const adapters = structured(res).adapters as { name: string; mode: string; binaryPresent: boolean }[];

  const highEntry = adapters.find((a) => a.name === "codex-high");
  const lowEntry = adapters.find((a) => a.name === "codex-low");
  expect(highEntry).toBeDefined();
  expect(lowEntry).toBeDefined();
  expect(highEntry!.mode).toBe("read");
  expect(lowEntry!.mode).toBe("read");
  // binaryPresent reflects `codex` on PATH (via binary:"codex"), same probe result as the base adapter.
  const codexEntry = adapters.find((a) => a.name === "codex");
  expect(highEntry!.binaryPresent).toBe(codexEntry!.binaryPresent);
  expect(lowEntry!.binaryPresent).toBe(codexEntry!.binaryPresent);
});
