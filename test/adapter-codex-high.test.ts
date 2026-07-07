/**
 * codex-high adapter + `makeCodexVariant` factory — pure-function unit tests.
 * No spawn, no real `codex` binary. Mirrors the header discipline in
 * `test/adapter-codex.test.ts`.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { makeCodexVariant } from "../src/adapters/_codex-factory.ts";
import * as codex from "../src/adapters/codex.ts";
import * as codexHigh from "../src/adapters/codex-high.ts";
import { discoverAdapters } from "../src/adapters/discover.ts";

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.1: makeCodexVariant's buildArgs delegates to buildCodexArgv correctly —
// configOverrides before --sandbox, prompt last.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_1_factory_buildArgs_emits_configOverrides_before_sandbox_prompt_last", () => {
  const variant = makeCodexVariant({ name: "x", configOverrides: { model_reasoning_effort: "high" } });
  expect(variant.buildArgs("p", {})).toEqual([
    "codex",
    "exec",
    "-c",
    "model_reasoning_effort=high",
    "--sandbox",
    "read-only",
    "p",
  ]);
});

test("makeCodexVariant defaults mode to read and never emits danger-full-access", () => {
  const variant = makeCodexVariant({ name: "x" });
  expect(variant.mode).toBe("read");
  expect(variant.buildArgs("p", {})).toEqual(["codex", "exec", "--sandbox", "read-only", "p"]);
});

test("makeCodexVariant honors an explicit write mode", () => {
  const variant = makeCodexVariant({ name: "x", mode: "write" });
  expect(variant.mode).toBe("write");
  expect(variant.buildArgs("p", {})).toEqual(["codex", "exec", "--sandbox", "workspace-write", "p"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.2 (codex-high half): port shape + identity reuse of codex's contract.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_2_codex_high_exports_port_shape_and_reuses_codex_contract", () => {
  expect(codexHigh.name).toBe("codex-high");
  expect(codexHigh.mode).toBe("read");
  expect(codexHigh.binary).toBe("codex");
  expect(typeof codexHigh.buildArgs).toBe("function");
  // Identity reuse, not re-implementation — same function reference as codex.ts.
  expect(codexHigh.injectContract).toBe(codex.injectContract);
  expect(codexHigh.parseResult).toBe(codex.parseResult);
});

test("codex-high buildArgs pins high effort on the default model with no -m flag", () => {
  expect(codexHigh.buildArgs("review this", {})).toEqual([
    "codex",
    "exec",
    "-c",
    "model_reasoning_effort=high",
    "--sandbox",
    "read-only",
    "review this",
  ]);
  expect(codexHigh.buildArgs("review this", {})).not.toContain("-m");
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.5: pinned variants ignore per-call model/effort from opts entirely.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_5_codex_high_ignores_per_call_model_and_effort", () => {
  const argv = codexHigh.buildArgs("p", { model: "o3", effort: "low" });
  expect(argv).toEqual(["codex", "exec", "-c", "model_reasoning_effort=high", "--sandbox", "read-only", "p"]);
  expect(argv).not.toContain("-m");
  expect(argv).not.toContain("o3");
  expect(argv).not.toContain("model_reasoning_effort=low");
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.6 (dirty): shell-metacharacter prompt through the factory path stays a
// single literal argv element — the barricade is inherited, not re-derived.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_6_shell_metachar_prompt_stays_single_literal_argv_element", () => {
  const dangerous = "review; rm -rf / && echo `whoami` $(id)";
  const variant = makeCodexVariant({ name: "x", configOverrides: { model_reasoning_effort: "high" } });
  const argv = variant.buildArgs(dangerous, {});
  expect(argv[argv.length - 1]).toBe(dangerous); // literal, single element — never shell-joined

  const argvViaVariantFile = codexHigh.buildArgs(dangerous, {});
  expect(argvViaVariantFile[argvViaVariantFile.length - 1]).toBe(dangerous);
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.3: discoverAdapters(real src/adapters) includes both variants, excludes
// the underscore-prefixed helper files.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_3_discovery_includes_variants_excludes_factory_and_shared", () => {
  const names = discoverAdapters(join(import.meta.dir, "../src/adapters")).map((a) => a.name);
  expect(names).toContain("codex-high");
  expect(names).toContain("codex-low");
  expect(names.some((n) => n.includes("codex-factory"))).toBe(false);
  expect(names.some((n) => n.includes("codex-shared"))).toBe(false);
});

test("discovered codex-high adapter round-trips through the Adapter port", () => {
  const adapters = discoverAdapters(join(import.meta.dir, "../src/adapters"));
  const found = adapters.find((a) => a.name === "codex-high");
  expect(found).toBeDefined();
  expect(found!.mode).toBe("read");
  expect(found!.binary).toBe("codex");
  expect(found!.buildArgs("p", {})).toEqual([
    "codex",
    "exec",
    "-c",
    "model_reasoning_effort=high",
    "--sandbox",
    "read-only",
    "p",
  ]);
});
