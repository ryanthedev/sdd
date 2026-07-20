/**
 * codex adapter — pure-function unit tests. No spawn, no real `codex` binary:
 * `buildArgs`/`injectContract`/`parseResult` are plain functions fed synthetic
 * strings, per the dispatch prompt's explicit instruction (deterministic, no
 * network, no cost — this environment happens to have `codex` on PATH, but
 * the adapter contract must be verifiable without it).
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildCodexArgv } from "../src/adapters/_codex-shared.ts";
import * as codex from "../src/adapters/codex.ts";
import { discoverAdapters } from "../src/adapters/discover.ts";

test("codex adapter exports the Adapter port shape", () => {
  expect(codex.name).toBe("codex");
  expect(typeof codex.buildArgs).toBe("function");
  expect(typeof codex.injectContract).toBe("function");
  expect(typeof codex.parseResult).toBe("function");
});

// ─────────────────────────────────────────────────────────────────────────────
// buildArgs: argv array, the one hardcoded sandbox, never a shell string.
// ─────────────────────────────────────────────────────────────────────────────
test("buildArgs emits the workspace-write sandbox and returns a plain argv array", () => {
  const argv = codex.buildArgs("review this diff", {});
  expect(Array.isArray(argv)).toBe(true);
  expect(argv.every((a) => typeof a === "string")).toBe(true);
  expect(argv).toEqual(["codex", "exec", "--sandbox", "workspace-write", "review this diff"]);
});

test("buildArgs emits workspace-write unconditionally, whatever the opts", () => {
  // read-only is not reachable: codex always runs where it can edit the tree it
  // is dispatched into. Whether that is safe is the caller's call, not ours.
  for (const opts of [{}, { timeoutMs: 1000 }, { cwd: "/tmp" }, { model: "o3" }]) {
    const argv = codex.buildArgs("just review the fix", opts);
    expect(argv[argv.length - 2]).toBe("workspace-write");
    expect(argv).not.toContain("read-only");
  }
});

test("buildArgs never emits danger-full-access", () => {
  expect(codex.buildArgs("p", {})).not.toContain("danger-full-access");
  expect(codex.buildArgs("p", { model: "o3", effort: "high" })).not.toContain("danger-full-access");
});

test("buildArgs passes a shell-metacharacter prompt through as one literal argv element", () => {
  const dangerous = "review; rm -rf / && echo `whoami`";
  const argv = codex.buildArgs(dangerous, {});
  expect(argv[argv.length - 1]).toBe(dangerous); // literal, single element — never shell-joined
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 (codex model selection): shared buildCodexArgv — flag emission,
// ordering (caller flags BEFORE --sandbox, prompt LAST), barricade.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_1_1_buildCodexArgv_no_cfg_matches_codex_default_argv", () => {
  expect(buildCodexArgv("p")).toEqual(["codex", "exec", "--sandbox", "workspace-write", "p"]);
  // Regression guard: the shared builder and the adapter's no-cfg path agree.
  expect(buildCodexArgv("p")).toEqual(codex.buildArgs("p", {}));
});

test("test_DW_1_2_model_flag_precedes_sandbox_prompt_last", () => {
  expect(buildCodexArgv("p", { model: "o3" })).toEqual([
    "codex",
    "exec",
    "-m",
    "o3",
    "--sandbox",
    "workspace-write",
    "p",
  ]);
});

test("test_DW_1_2_configOverrides_emit_dash_c_before_sandbox", () => {
  expect(buildCodexArgv("p", { configOverrides: { model_reasoning_effort: "high" } })).toEqual([
    "codex",
    "exec",
    "-c",
    "model_reasoning_effort=high",
    "--sandbox",
    "workspace-write",
    "p",
  ]);
});

test("test_DW_1_7_profile_flag_precedes_sandbox", () => {
  expect(buildCodexArgv("p", { profile: "x" })).toEqual([
    "codex",
    "exec",
    "-p",
    "x",
    "--sandbox",
    "workspace-write",
    "p",
  ]);
});

test("buildCodexArgv combines model, profile, and overrides in fixed order, all before --sandbox", () => {
  expect(
    buildCodexArgv("p", {
      model: "o3",
      profile: "x",
      configOverrides: { model_reasoning_effort: "low", foo: "bar" },
    }),
  ).toEqual([
    "codex",
    "exec",
    "-m",
    "o3",
    "-p",
    "x",
    "-c",
    "model_reasoning_effort=low",
    "-c",
    "foo=bar",
    "--sandbox",
    "workspace-write",
    "p",
  ]);
});

test("buildCodexArgv skips empty-string model/profile instead of emitting a bare flag", () => {
  expect(buildCodexArgv("p", { model: "", profile: "" })).toEqual(buildCodexArgv("p"));
});

test("buildCodexArgv never emits danger-full-access even with flags present", () => {
  const argv = buildCodexArgv("p", { model: "o3", configOverrides: { k: "v" } });
  expect(argv).not.toContain("danger-full-access");
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: codex.buildArgs per-call allowlist (model + effort ONLY).
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_1_3_codex_buildArgs_emits_model_and_effort_flags", () => {
  expect(codex.buildArgs("p", { model: "o3", effort: "high" })).toEqual([
    "codex",
    "exec",
    "-m",
    "o3",
    "-c",
    "model_reasoning_effort=high",
    "--sandbox",
    "workspace-write",
    "p",
  ]);
});

test("test_DW_1_4_no_params_argv_is_workspace_write", () => {
  expect(codex.buildArgs("p", {})).toEqual(["codex", "exec", "--sandbox", "workspace-write", "p"]);
});

test("test_DW_1_6_shell_metachar_model_stays_single_literal_argv_element", () => {
  const dangerous = "o3; rm -rf / && echo `whoami` $(id)";
  const argv = codex.buildArgs("review this", { model: dangerous });
  const mIndex = argv.indexOf("-m");
  expect(mIndex).toBeGreaterThan(-1);
  expect(argv[mIndex + 1]).toBe(dangerous); // ONE literal element — never shell-joined or split
  expect(argv[argv.length - 1]).toBe("review this"); // prompt still last
});

test("codex.buildArgs with effort only emits -c but no -m", () => {
  const argv = codex.buildArgs("p", { effort: "low" });
  expect(argv).toEqual(["codex", "exec", "-c", "model_reasoning_effort=low", "--sandbox", "workspace-write", "p"]);
  expect(argv).not.toContain("-m");
});

// Defense-in-depth: JobStore.dispatch is callable programmatically (bypassing
// the dispatch tool's zod enum), so the adapter re-validates and fails LOUD.
test("codex.buildArgs throws TypeError on an out-of-enum effort (programmatic path)", () => {
  expect(() => codex.buildArgs("p", { effort: "max" })).toThrow(TypeError);
  expect(() => codex.buildArgs("p", { effort: 3 })).toThrow(TypeError);
});

test("codex.buildArgs throws TypeError on a non-string or empty model (programmatic path)", () => {
  expect(() => codex.buildArgs("p", { model: 42 })).toThrow(TypeError);
  expect(() => codex.buildArgs("p", { model: "" })).toThrow(TypeError);
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-1.8: the leading-underscore discovery exclusion holds for _codex-shared.ts
// against the REAL adapters directory.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_1_8_discovery_excludes_codex_shared_helper", () => {
  const names = discoverAdapters(join(import.meta.dir, "../src/adapters")).map((a) => a.name);
  expect(names).toContain("codex"); // sanity: the real dir was actually scanned
  expect(names.some((n) => n.includes("codex-shared"))).toBe(false);
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

// ─────────────────────────────────────────────────────────────────────────────
// Failure diagnostics: a non-zero exit surfaces stderr in the summary (never
// raw), and codex's git-repo refusal is recognized and given an actionable fix
// instead of being misread as an auth failure.
// ─────────────────────────────────────────────────────────────────────────────
test("parseResult recognizes codex's git-repo refusal and returns an actionable summary", () => {
  // The real CLI's exact line, on stderr, before it ever reaches the model.
  const stderr = "Not inside a trusted directory and --skip-git-repo-check was not specified";
  const result = codex.parseResult("", stderr, 1);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("git repo");
  expect(result.summary).toMatch(/git init/); // tells the caller how to fix it
  expect(result.summary).toMatch(/not an auth or quota failure/i); // and steers away from the misdiagnosis
});

test("parseResult recognizes the git-repo refusal by either half of the message", () => {
  for (const stderr of ["Not inside a trusted directory", "pass --skip-git-repo-check to override"]) {
    expect(codex.parseResult("", stderr, 1).summary).toMatch(/git init/);
  }
});

test("parseResult surfaces a bounded stderr tail for an unrecognized non-zero exit", () => {
  const stderr = "error: 401 Unauthorized — token expired";
  const result = codex.parseResult("", stderr, 1);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("codex exited 1");
  expect(result.summary).toContain("401 Unauthorized"); // the real error, not just the code
});

test("parseResult failure summary never leaks stderr into raw", () => {
  const stderr = "Not inside a trusted directory and --skip-git-repo-check was not specified";
  const stdout = "partial stdout";
  const result = codex.parseResult(stdout, stderr, 1);
  expect(result.raw).toBe(stdout); // raw stays stdout-only on the failure path too
  expect(result.raw).not.toContain("trusted directory");
});

test("parseResult falls back to the bare exit code when stderr is empty", () => {
  const result = codex.parseResult("", "   \n  ", 137);
  expect(result.summary).toBe("codex exited 137");
});
