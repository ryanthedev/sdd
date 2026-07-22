/**
 * agy adapter — Phase 4.
 *
 * agy may not be installed in this environment, so buildArgs and parseResult
 * are unit-tested directly against sample/stubbed stdout — no real agy
 * binary is spawned. Covers DW-4.1 (flag-order structural guard), DW-4.2
 * (exit-0 misparse backstop), and DW-4.4 (directory-scan discovery).
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_KIND } from "../src/adapters/types.ts";
import { discoverAdapters } from "../src/adapters/discover.ts";
import * as agy from "../src/adapters/agy.ts";

// ── DW-4.1: flags-before-`--print`, prompt is the immediately-following,
//    single, LAST argv element. ────────────────────────────────────────────

test("test_DW_4_1_no_extra_flags_prompt_immediately_after_print", () => {
  const argv = agy.buildArgs("review this diff", {});
  expect(argv).toEqual(["agy", "--sandbox", "--dangerously-skip-permissions", "--print", "review this diff"]);
  expect(argv[argv.length - 1]).toBe("review this diff"); // prompt is the LAST element
  expect(argv[argv.length - 2]).toBe("--print"); // immediately preceded by --print
});

test("test_DW_4_1_flags_all_precede_print_prompt_is_last_element", () => {
  const argv = agy.buildArgs("implement the feature", { model: "opus" });
  expect(argv).toEqual([
    "agy",
    "--sandbox",
    "--dangerously-skip-permissions",
    "--model",
    "opus",
    "--print",
    "implement the feature",
  ]);
  // Every flag/value pair sits strictly before "--print"; nothing after the prompt.
  const printIdx = argv.indexOf("--print");
  expect(printIdx).toBeGreaterThan(0);
  expect(argv.slice(printIdx + 1)).toEqual(["implement the feature"]);
  expect(argv.length - 1).toBe(printIdx + 1);
});

test("runs headless under --sandbox with auto-approved writes (defense-in-depth)", () => {
  // Security: --print is non-interactive, so a write/implement job must
  // auto-approve edits (--dangerously-skip-permissions) or hang; --sandbox
  // (terminal restrictions) contains that — an injected agent can't spawn a
  // shell or reach the network. --sandbox is boolean in agy 1.0.16 (no value).
  const argv = agy.buildArgs("implement the feature", {});
  expect(argv).toContain("--sandbox");
  expect(argv).toContain("--dangerously-skip-permissions");
  // --sandbox must NOT carry a value (it's a boolean flag): the element after it
  // is the next flag, never a sandbox-mode string.
  const sandboxIdx = argv.indexOf("--sandbox");
  expect(argv[sandboxIdx + 1]!.startsWith("--")).toBe(true);
});

test("buildArgs rejects a non-string opts.model rather than silently dropping it", () => {
  expect(() => agy.buildArgs("p", { model: 42 as unknown as string })).toThrow(TypeError);
});

// ── DW-4.2: exit-0 silent-misparse backstop — missing marker -> failed. ────

test("test_DW_4_2_missing_marker_on_exit_0_is_failed_misparse_backstop", () => {
  const result = agy.parseResult("some unrelated output with no marker at all", "", 0);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("missing AGY_RESULT marker");
});

test("test_DW_4_2_simulated_print_flag_self_answer_misparse_is_failed", () => {
  // Simulated real-world misparse: agy treats a flag as the prompt because it
  // landed after --print, and "answers" a question about its own --print flag.
  const misparseStdout =
    "The --print flag requires an argument immediately following it, which specifies " +
    "the prompt text agy should process. No further flags may appear after --print.\n";
  const result = agy.parseResult(misparseStdout, "", 0);
  expect(result.status).toBe("failed");
  expect(result.raw).toBe(misparseStdout);
});

test("test_DW_4_2_early_echoed_DONE_marker_followed_by_real_FAILED_marker_is_failed", () => {
  // Regression for the marker-collision misparse demonstrated in review: a
  // harness that echoes the injected instructions (which literally contain
  // "AGY_RESULT: DONE" and "AGY_RESULT: FAILED" as example forms) before its
  // real, final verdict must be classified by the LAST marker line, not the
  // first marker-shaped line encountered.
  const stdout =
    "Received instructions:\n" +
    "...in one of these two exact forms:\n" +
    "AGY_RESULT: DONE\n" +
    "AGY_RESULT: FAILED\n" +
    "Do not include this line unless it reflects the true outcome.\n\n" +
    "I could not complete the task: permission denied.\n" +
    "AGY_RESULT: FAILED\n";
  const result = agy.parseResult(stdout, "", 0);
  expect(result.status).toBe("failed");
});

test("marker present with DONE and exit 0 is done, with no artifacts", () => {
  const stdout = "Reviewed the diff, looks good.\nAGY_RESULT: DONE\n";
  const result = agy.parseResult(stdout, "", 0);
  expect(result.status).toBe("done");
  expect(result.artifacts).toEqual([]);
  expect(result.raw).toBe(stdout);
});

test("early echoed FAILED marker followed by a later real DONE marker is done", () => {
  // Symmetric case to the regression above: last-match-wins must also let a
  // genuinely successful run through even if an earlier line in stdout
  // happens to echo the FAILED example form.
  const stdout =
    "Instructions echoed:\nAGY_RESULT: DONE\nAGY_RESULT: FAILED\n\n" +
    "Review complete, no issues found.\nAGY_RESULT: DONE\n";
  const result = agy.parseResult(stdout, "", 0);
  expect(result.status).toBe("done");
});

test("marker present with FAILED is failed even on exit 0", () => {
  const stdout = "Could not complete the review: file not found.\nAGY_RESULT: FAILED\n";
  const result = agy.parseResult(stdout, "", 0);
  expect(result.status).toBe("failed");
});

test("marker present with DONE but non-zero exit code is failed", () => {
  const stdout = "Partial output before crash.\nAGY_RESULT: DONE\n";
  const result = agy.parseResult(stdout, "", 1);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("exited with code 1");
});

test("injectContract appends the AGY_RESULT marker instructions", () => {
  const contracted = agy.injectContract("do the thing");
  expect(contracted).toContain("do the thing");
  expect(contracted).toContain("AGY_RESULT: DONE");
  expect(contracted).toContain("AGY_RESULT: FAILED");
});

// ── DW-4.4: discovered via directory scan, no central registry edit. ───────

test("test_DW_4_4_agy_discovered_via_directory_scan", () => {
  const adapters = discoverAdapters(join(import.meta.dir, "..", "src", "adapters"));
  const found = adapters.find((a) => a.name === "agy");
  expect(found).toBeDefined();
  expect(typeof found!.capabilities[DEFAULT_KIND]!.buildArgs).toBe("function");
  expect(typeof found!.capabilities[DEFAULT_KIND]!.injectContract).toBe("function");
  expect(typeof found!.capabilities[DEFAULT_KIND]!.parseResult).toBe("function");
});
