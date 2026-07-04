/**
 * codex adapter — pure-function unit tests. No spawn, no real `codex` binary:
 * `buildArgs`/`injectContract`/`parseResult` are plain functions fed synthetic
 * strings, per the dispatch prompt's explicit instruction (deterministic, no
 * network, no cost — this environment happens to have `codex` on PATH, but
 * the adapter contract must be verifiable without it).
 */
import { expect, test } from "bun:test";
import * as codex from "../src/adapters/codex.ts";

test("codex adapter exports the Adapter port shape", () => {
  expect(codex.name).toBe("codex");
  expect(codex.mode).toBe("read");
  expect(typeof codex.buildArgs).toBe("function");
  expect(typeof codex.injectContract).toBe("function");
  expect(typeof codex.parseResult).toBe("function");
});

// ─────────────────────────────────────────────────────────────────────────────
// buildArgs: argv array, sandbox mode mapping, never a shell string.
// ─────────────────────────────────────────────────────────────────────────────
test("buildArgs defaults to read-only sandbox and returns a plain argv array", () => {
  const argv = codex.buildArgs("review this diff", {});
  expect(Array.isArray(argv)).toBe(true);
  expect(argv.every((a) => typeof a === "string")).toBe(true);
  expect(argv).toEqual(["codex", "exec", "--sandbox", "read-only", "review this diff"]);
});

test("buildArgs uses workspace-write sandbox only when opts.mode is write", () => {
  const argv = codex.buildArgs("implement the fix", { mode: "write" });
  expect(argv).toEqual(["codex", "exec", "--sandbox", "workspace-write", "implement the fix"]);
});

test("buildArgs never emits danger-full-access", () => {
  const readArgv = codex.buildArgs("p", {});
  const writeArgv = codex.buildArgs("p", { mode: "write" });
  expect(readArgv).not.toContain("danger-full-access");
  expect(writeArgv).not.toContain("danger-full-access");
});

test("buildArgs passes a shell-metacharacter prompt through as one literal argv element", () => {
  const dangerous = "review; rm -rf / && echo `whoami`";
  const argv = codex.buildArgs(dangerous, {});
  expect(argv[argv.length - 1]).toBe(dangerous); // literal, single element — never shell-joined
});

// ─────────────────────────────────────────────────────────────────────────────
// injectContract: appends the VERDICT:/## Findings instruction.
// ─────────────────────────────────────────────────────────────────────────────
test("injectContract appends contract instructions after the original prompt", () => {
  const contracted = codex.injectContract("please review src/foo.ts");
  expect(contracted.startsWith("please review src/foo.ts")).toBe(true);
  expect(contracted).toContain("VERDICT:");
  expect(contracted).toContain("## Findings");
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-3.2: parseResult — answer from stdout only, stderr progress never leaks.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_3_2_parseResult_summary_and_raw_from_stdout_only", () => {
  const stdout = "Looked at the diff, it's fine.\nVERDICT: approve\n## Findings\nNone.";
  const stderr = "thinking...\nreading files...\nrunning tests...";
  const result = codex.parseResult(stdout, stderr, 0);

  expect(result.status).toBe("done");
  expect(result.summary).toContain("VERDICT: approve");
  expect(result.raw).toBe(stdout);
});

test("test_DW_3_2_stderr_progress_never_leaks_into_summary", () => {
  const stdout = "VERDICT: reject\n## Findings\n- off-by-one in loop bound";
  const stderr = "SECRET_PROGRESS_TOKEN_DO_NOT_LEAK reading 40 files...";
  const result = codex.parseResult(stdout, stderr, 0);

  expect(result.summary).not.toContain("SECRET_PROGRESS_TOKEN_DO_NOT_LEAK");
  expect(result.raw).not.toContain("SECRET_PROGRESS_TOKEN_DO_NOT_LEAK");
});

test("parseResult fails when VERDICT: marker is missing even on exit 0", () => {
  const stdout = "Looks fine to me.\n## Findings\nNone.";
  const result = codex.parseResult(stdout, "", 0);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("missing");
});

test("parseResult fails when ## Findings marker is missing even on exit 0", () => {
  const stdout = "VERDICT: approve\nEverything looks fine.";
  const result = codex.parseResult(stdout, "", 0);
  expect(result.status).toBe("failed");
});

test("parseResult fails on non-zero exit code regardless of markers", () => {
  const stdout = "VERDICT: approve\n## Findings\nNone.";
  const result = codex.parseResult(stdout, "codex: fatal error", 1);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("1");
});
