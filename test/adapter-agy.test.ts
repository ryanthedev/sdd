/**
 * agy adapter — Phase 4.
 *
 * agy may not be installed in this environment, so buildArgs and parseResult
 * are unit-tested directly against sample/stubbed stdout — no real agy
 * binary is spawned. Covers DW-4.1 (flag-order structural guard), DW-4.2
 * (exit-0 misparse backstop), and DW-4.4 (directory-scan discovery).
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

test("agy supports low..max effort, rejects ultra/bogus, supports readOnly and addDir", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    expect(agy.buildArgs("p", { effort })).toContain(effort);
  }
  expect(() => agy.buildArgs("p", { effort: "ultra" })).toThrow(TypeError);
  expect(() => agy.buildArgs("p", { effort: "bogus" })).toThrow(TypeError);

  const ro = agy.buildArgs("review", { readOnly: true, addDir: "/abs/extra", effort: "xhigh" });
  expect(ro).toEqual([
    "agy",
    "--sandbox",
    "--mode",
    "plan",
    "--settings",
    agy.AGY_READ_ONLY_SETTINGS,
    "--effort",
    "xhigh",
    "--add-dir",
    "/abs/extra",
    "--print",
    agy.AGY_READ_ONLY_NOTICE + "review",
  ]);
  expect(ro).not.toContain("--dangerously-skip-permissions");

  expect(() => agy.buildArgs("p", { addDir: "../escape", cwd: "/tmp/work" })).toThrow(TypeError);
});

test("agy.parseModels parses `agy models` stdout in both piped (tab), TTY (padded), and CRLF forms", () => {
  const sample =
    "\r⠋ Fetching available models...\rgemini-4-neon-xhigh            Gemini 4 Neon (XHigh)\r\n" +
    "claude-opus-5-5-high\tClaude Opus 5.5 (High)\r\n" +
    "\r\n";
  expect(agy.parseModels(sample)).toEqual([
    {
      id: "gemini-4-neon-xhigh",
      displayName: "Gemini 4 Neon (XHigh)",
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "claude-opus-5-5-high",
      displayName: "Claude Opus 5.5 (High)",
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
  ]);
  expect(agy.parseModels(123)).toEqual([]);
});

test("agy image kind honors model/effort and rejects readOnly", () => {
  const argv = agy.capabilities.image!.buildArgs("draw a cat", {
    outputPath: "/abs/cat.png",
    model: "gemini-4-neon-high",
    effort: "xhigh",
  });
  expect(argv).toContain("--model");
  expect(argv).toContain("gemini-4-neon-high");
  expect(argv).toContain("--effort");
  expect(argv).toContain("xhigh");
  expect(() => agy.capabilities.image!.buildArgs("draw", { outputPath: "/abs/cat.png", readOnly: true })).toThrow(TypeError);
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
  // One harness, three kinds — image/vision are reached here, not via a
  // separate adapter name.
  expect(Object.keys(found!.capabilities).sort()).toEqual([DEFAULT_KIND, "image", "vision"].sort());
  expect(found!.defaultKind).toBe(DEFAULT_KIND);
});

// ── readOnly deny list, notice, and failure summaries (agy 1.5.14) ─────────

const fixture = (f: string): string => readFileSync(join(import.meta.dir, "fixtures", "agy", f), "utf8");
/** What `wait` renders of a summary. */
const waitView = (summary: string): string => summary.replace(/\s+/g, " ").slice(0, 300);
const JETSKI = (perm: string): string =>
  `jetski: no output produced — a tool required the "${perm}" permission that headless mode cannot prompt for, so it was auto-denied.\n`;

test("test_DW_1_1_readOnly_argv_carries_settings_deny_list_and_notice", () => {
  const argv = agy.buildArgs("review", { readOnly: true, effort: "xhigh", addDir: "/abs/extra" });
  expect(argv).toEqual([
    "agy", "--sandbox", "--mode", "plan", "--settings", agy.AGY_READ_ONLY_SETTINGS,
    "--effort", "xhigh", "--add-dir", "/abs/extra", "--print", agy.AGY_READ_ONLY_NOTICE + "review",
  ]);
  const parsed = JSON.parse(agy.AGY_READ_ONLY_SETTINGS);
  expect(parsed).toEqual({
    permissions: {
      deny: ["command(*)", "write_file(*)", "mcp(*)", "read_url(*)", "execute_url(*)", "download_url(*)", "unsandboxed(*)"],
    },
  });
  expect("allow" in parsed.permissions).toBe(false);
  expect(argv).not.toContain("--dangerously-skip-permissions");
  // Writable argv carries no settings.
  expect(agy.buildArgs("p", {})).not.toContain("--settings");
});

test("test_DW_1_2_notice_is_byte_exact_first_and_contract_last", () => {
  expect(agy.AGY_READ_ONLY_NOTICE).toBe(fixture("agy-read-only-notice.txt"));
  const last = agy.buildArgs(agy.injectContract("p"), { readOnly: true }).at(-1)!;
  expect(last.startsWith(agy.AGY_READ_ONLY_NOTICE)).toBe(true);
  expect(last.endsWith("Do not include this line unless it reflects the true outcome.")).toBe(true);
});

test("test_DW_1_3_auto_deny_command_log_names_permission_and_workaround", () => {
  const r = agy.parseResult("", fixture("agy-auto-deny-command.log"), 0);
  expect(r.status).toBe("failed");
  const view = waitView(r.summary);
  expect(view).toContain('"command" permission');
  expect(view).toContain("If this job ran readOnly");
  expect(view).toContain("exact files");
  expect(r.summary).not.toContain("flag-order");
  expect(r.summary.length).toBeLessThanOrEqual(300);
});

test("test_DW_1_4_auto_deny_write_file", () => {
  const r = agy.parseResult("", fixture("agy-auto-deny-write_file.stderr"), 0);
  expect(r.summary).toContain('"write_file" permission');
  expect(r.summary).toContain("file writes are blocked");
});

test("test_DW_1_5_jetski_sentence_quoted_at_end_of_stdout_is_not_an_auto_deny", () => {
  // The quote ENDS stdout, so it lands in the 70-char stdout tail unless redacted.
  const quoted = `The tool said: "${JETSKI("command").trim()}" so I stopped.`;
  const bare = `The tool said: ${JETSKI("command").trim()}`;
  const sent = JETSKI("command").trim();
  const variants = [
    `The tool said: ${sent.replace("auto-denied", "_auto-denied_")}`,
    '> jetski: no output produced — a tool required the\n> "command" permission that headless mode cannot prompt for.',
    'Agy said a tool required the\n"command" permission and stopped.',
    'Agy said a tool required the  "command" permission and stopped.',
    'Agy said a tool required the\u00a0"command"\u00a0permission and stopped.',
    'Agy said a tool required the\t"command"\tpermission and stopped.',
    `The tool said: ${sent.replace("auto-denied", "auto\u2011denied")}`,
    `The tool said: ${sent.replace("auto-denied", "AUTO-DENIED")}`,
  ];
  for (const stdout of [...variants, quoted, bare, quoted + " and then I kept going for a long while, never finishing the task at all."]) {
    const r = agy.parseResult(stdout, "", 0);
    expect(r.status).toBe("failed");
    expect(r.summary).not.toContain("auto-denied");
    expect(r.summary).not.toContain('"command" permission');
    expect(r.summary).not.toContain("stopped with no verdict");
    expect(r.summary).toContain("missing AGY_RESULT marker (exit 0)");
    expect(r.summary.length).toBeLessThanOrEqual(390);
  }
});

test("last auto-deny line decides: an overlong or non-[a-z_] name there gives unknown, not an earlier permission", () => {
  expect(agy.parseResult("", JETSKI("command") + JETSKI("a".repeat(21)), 0).summary).toContain('"unknown" permission');
  expect(agy.parseResult("", JETSKI("command") + JETSKI("Read-URL"), 0).summary).toContain('"unknown" permission');
  expect(agy.parseResult("", JETSKI("Read-URL"), 0).summary).toContain('"unknown" permission');
  expect(agy.parseResult("", JETSKI("Read-URL") + JETSKI("command"), 0).summary).toContain('"command" permission');
});

test("excerpt and tails never split a surrogate pair", () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  for (let pad = 0; pad < 4; pad++) {
    const emoji = "😀".repeat(200);
    const failed = agy.parseResult("x".repeat(pad) + emoji + "\nAGY_RESULT: FAILED\n", "", 0);
    expect(lone.test(failed.summary)).toBe(false);
    const generic = agy.parseResult("x".repeat(pad) + emoji, emoji, 0);
    expect(lone.test(generic.summary)).toBe(false);
  }
});

test("test_DW_1_5b_other_permission_clause_and_overlong_name_fallback", () => {
  const url = agy.parseResult("", JETSKI("read_url"), 0);
  expect(url.summary).toContain('"read_url" permission');
  expect(url.summary).toContain("that tool is blocked there");
  const long = agy.parseResult("", JETSKI("a".repeat(21)), 0);
  expect(long.summary).toContain('"unknown" permission');
  const longest = agy.parseResult("", JETSKI("a".repeat(20)), 0);
  for (const r of [url, long, longest]) expect(r.summary.length).toBeLessThanOrEqual(300);
  // Bare "auto-denied" with no recognizable permission also falls back to unknown.
  expect(agy.parseResult("", "tool was auto-denied", 0).summary).toContain('"unknown" permission');
});

test("test_DW_1_6_last_auto_deny_line_wins", () => {
  const r = agy.parseResult("", JETSKI("command") + JETSKI("write_file"), 0);
  expect(r.summary).toContain('"write_file" permission');
  expect(r.summary).not.toContain('"command" permission');
});

test("test_DW_1_7_narration_only_no_marker_is_generic_failure_with_stdout_tail", () => {
  const r = agy.parseResult("I will now look at the files and think about it.", "", 0);
  expect(r.status).toBe("failed");
  expect(r.summary).toContain("missing AGY_RESULT marker (exit 0)");
  expect(r.summary).toContain("If this job ran readOnly");
  expect(r.summary).toContain("stdout: I will now look at the files and think about it.");
  expect(r.summary).not.toContain("flag-order");
});

test("test_DW_1_8_writable_failure_keeps_exit_code_and_stderr_cause_in_300_chars", () => {
  const r = agy.parseResult("", "Error: not logged in", 1);
  const view = waitView(r.summary);
  expect(view).toContain("exit 1");
  expect(view).toContain("not logged in");
});

test("test_DW_1_9_generic_summary_stays_within_caps_on_huge_streams", () => {
  const big = "x".repeat(10_000);
  const r = agy.parseResult(big, big, 0);
  expect(r.summary.length).toBeLessThanOrEqual(390);
  const logTail800 = "L".repeat(800);
  expect((r.summary + " — " + logTail800).slice(0, 1200).endsWith(logTail800)).toBe(true);
});

test("test_DW_1_10_reported_FAILED_excerpt_keeps_refusal_and_request", () => {
  const todo = agy.parseResult(fixture("agy-readonly-failed-todo-list.stdout"), "", 0);
  const commit = agy.parseResult(fixture("agy-readonly-failed-commit-review.stdout"), "", 0);
  for (const r of [todo, commit]) {
    expect(r.status).toBe("failed");
    expect(r.summary.startsWith("agy: reported FAILED: ")).toBe(true);
    expect(r.summary.length).toBeLessThanOrEqual(300);
  }
  expect(todo.summary).toContain("cannot be completed");
  expect(commit.summary).toContain("cannot review");
  expect(todo.summary).toMatch(/rg -n|git grep/);
  expect(commit.summary).toContain("git show HEAD");
});

test("reported FAILED: short cause is used whole; no text before the marker gives the bare summary", () => {
  expect(agy.parseResult("File not found.\nAGY_RESULT: FAILED\n", "", 0).summary).toBe("agy: reported FAILED: File not found.");
  expect(agy.parseResult("AGY_RESULT: FAILED\n", "", 0).summary).toBe("agy: reported FAILED");
});

test("generic summary has no double space when the stderr tail cut lands on a space", () => {
  const r = agy.parseResult("", "z " + "y".repeat(129), 3);
  expect(r.summary).toContain("(exit 3): y");
  expect(r.summary).not.toMatch(/ {2}/);
});

test("reported FAILED: a single huge unbroken token still fits the 300-char cap", () => {
  const r = agy.parseResult("y".repeat(5000) + "\nAGY_RESULT: FAILED\n", "", 0);
  expect(r.summary.length).toBeLessThanOrEqual(300);
});

test("test_DW_1_11_echoed_notice_without_marker_line_is_failed", () => {
  const r = agy.parseResult(agy.AGY_READ_ONLY_NOTICE + "Okay, understood.", "", 0);
  expect(r.status).toBe("failed");
  expect(r.summary).toContain("missing AGY_RESULT marker");
});

test("test_DW_1_12_real_final_marker_beats_jetski_line", () => {
  const r = agy.parseResult("All good.\nAGY_RESULT: DONE\n", JETSKI("command"), 0);
  expect(r.status).toBe("done");
});

test("test_DW_1_13_readOnlyNote_is_exposed_by_discovery", () => {
  const found = discoverAdapters(join(import.meta.dir, "..", "src", "adapters")).find((a) => a.name === "agy");
  expect(found!.readOnlyNote).toBe(agy.readOnlyNote);
  expect(agy.readOnlyNote).toContain("exact path");
});

test("test_DW_1_14_comment_block_has_no_stale_claims", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "adapters", "agy.ts"), "utf8");
  expect(src).not.toContain("structurally non-writing");
  expect(src).not.toContain("exits 0 cleanly");
  expect(src).not.toContain("flag-order misparse");
  expect(src).toContain("agy 1.5.14, 2026-11-22");
});

test("auto-deny summary says shell commands are blocked for the command permission", () => {
  expect(agy.parseResult("", JETSKI("command"), 0).summary).toContain("shell commands are blocked there");
});

test("narration stdout without permission wording keeps its tail; a quoting tail is replaced by a placeholder", () => {
  expect(agy.parseResult("just thinking aloud", "", 0).summary).toContain("stdout: just thinking aloud");
  expect(agy.parseResult("it needs permission to go on", "", 0).summary).toContain("stdout tail omitted");
});
