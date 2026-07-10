/**
 * codex-sol adapter — pure-function unit tests. No spawn, no real `codex`
 * binary. Mirrors the header discipline in `test/adapter-codex-high.test.ts`.
 * Pins the GPT-5.6 "Sol" model via `-m gpt-5.6-sol` at high effort.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import * as codex from "../src/adapters/codex.ts";
import * as codexSol from "../src/adapters/codex-sol.ts";
import { discoverAdapters } from "../src/adapters/discover.ts";

const EXPECTED_ARGV = (prompt: string) => [
  "codex",
  "exec",
  "-m",
  "gpt-5.6-sol",
  "-c",
  "model_reasoning_effort=high",
  "--sandbox",
  "workspace-write",
  prompt,
];

test("codex-sol exports the port shape and reuses codex's contract by identity", () => {
  expect(codexSol.name).toBe("codex-sol");
  expect(codexSol.mode).toBe("write");
  expect(codexSol.binary).toBe("codex");
  expect(typeof codexSol.buildArgs).toBe("function");
  expect(codexSol.injectContract).toBe(codex.injectContract);
  expect(codexSol.parseResult).toBe(codex.parseResult);
});

test("codex-sol buildArgs pins -m gpt-5.6-sol at high effort under workspace-write", () => {
  expect(codexSol.buildArgs("do the thing", {})).toEqual(EXPECTED_ARGV("do the thing"));
});

test("codex-sol ignores per-call model/effort — the pin is the whole point", () => {
  const argv = codexSol.buildArgs("p", { model: "o3", effort: "low" });
  expect(argv).toEqual(EXPECTED_ARGV("p"));
  expect(argv).not.toContain("o3");
  expect(argv).not.toContain("model_reasoning_effort=low");
});

test("codex-sol ignores a per-call opts.mode — the variant mode is pinned (DW-2.5)", () => {
  // Unlike the base `codex` adapter, a pinned variant does NOT honor opts.mode;
  // it always emits its constructed workspace-write sandbox.
  expect(codexSol.buildArgs("p", { mode: "read" })).toEqual(EXPECTED_ARGV("p"));
});

test("codex-sol never emits danger-full-access", () => {
  expect(codexSol.buildArgs("p", {})).not.toContain("danger-full-access");
  expect(codexSol.buildArgs("p", { mode: "read" })).not.toContain("danger-full-access");
});

test("discovery picks up codex-sol from the adapters dir", () => {
  const adaptersDir = join(import.meta.dir, "..", "src", "adapters");
  const found = discoverAdapters(adaptersDir).find((a) => a.name === "codex-sol");
  expect(found).toBeDefined();
  expect(found!.mode).toBe("write");
});
