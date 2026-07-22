/**
 * `_agy-shared.ts` — Phase 2 (multi-platform-video-ingestion plan).
 *
 * Covers DW-2.3 (buildAgyArgv's `--print`-second-to-last / prompt-last
 * structural guarantee across representative flag sets, including the
 * empty-flags edge case) and DW-2.4 (discovery excludes the leading-
 * underscore helper file). DW-2.1/DW-2.2 (no local copies remain in
 * agy.ts/agy-image.ts; existing suites pass unchanged) are proven by
 * `test/adapter-agy.test.ts` and `test/adapter-agy-image.test.ts` continuing
 * to pass unmodified against the refactored implementations.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildAgyArgv, lastMarkerMatch } from "../src/adapters/_agy-shared.ts";
import { discoverAdapters } from "../src/adapters/discover.ts";

// ── DW-2.3: --print is second-to-last, prompt is last, across flag sets. ───

test("test_DW_2_3_empty_subcommand_flags_still_yields_valid_argv", () => {
  const argv = buildAgyArgv([], "do the thing");
  expect(argv).toEqual(["agy", "--print", "do the thing"]);
  expect(argv[argv.length - 1]).toBe("do the thing");
  expect(argv[argv.length - 2]).toBe("--print");
});

test("test_DW_2_3_single_flag_print_second_to_last_prompt_last", () => {
  const argv = buildAgyArgv(["--sandbox"], "review this diff");
  expect(argv).toEqual(["agy", "--sandbox", "--print", "review this diff"]);
  expect(argv[argv.length - 1]).toBe("review this diff");
  expect(argv[argv.length - 2]).toBe("--print");
});

test("test_DW_2_3_multi_flag_set_mirrors_agy_ts_shape_print_second_to_last_prompt_last", () => {
  // Representative of agy.ts's real call: fixed sandbox flags + an optional
  // --model pair in the middle.
  const argv = buildAgyArgv(["--sandbox", "--dangerously-skip-permissions", "--model", "opus"], "implement it");
  expect(argv).toEqual([
    "agy",
    "--sandbox",
    "--dangerously-skip-permissions",
    "--model",
    "opus",
    "--print",
    "implement it",
  ]);
  expect(argv[argv.length - 1]).toBe("implement it");
  expect(argv[argv.length - 2]).toBe("--print");
});

test("test_DW_2_3_agy_image_shape_two_fixed_flags_no_model_slot", () => {
  // Representative of agy-image.ts's real call: fixed sandbox flags only,
  // no --model slot.
  const argv = buildAgyArgv(["--sandbox", "--dangerously-skip-permissions"], "a cat wearing a hat");
  expect(argv).toEqual(["agy", "--sandbox", "--dangerously-skip-permissions", "--print", "a cat wearing a hat"]);
  expect(argv[argv.length - 1]).toBe("a cat wearing a hat");
  expect(argv[argv.length - 2]).toBe("--print");
});

test("buildAgyArgv never places anything after the prompt, regardless of flag count", () => {
  const argv = buildAgyArgv(["--a", "1", "--b", "2", "--c", "3"], "prompt text");
  const printIdx = argv.indexOf("--print");
  expect(printIdx).toBeGreaterThan(0);
  expect(argv.slice(printIdx + 1)).toEqual(["prompt text"]);
  expect(argv.length - 1).toBe(printIdx + 1);
});

test("buildAgyArgv always prepends the agy binary as argv[0]", () => {
  const argv = buildAgyArgv(["--sandbox"], "p");
  expect(argv[0]).toBe("agy");
});

// ── lastMarkerMatch: last-occurrence-wins semantics preserved after move. ──

test("lastMarkerMatch returns undefined when there is no match", () => {
  const re = /^MARK:\s*(DONE|FAILED)\s*$/gm;
  expect(lastMarkerMatch(re, "no marker here")).toBeUndefined();
});

test("lastMarkerMatch returns the LAST match, not the first, on multiple occurrences", () => {
  const re = /^MARK:\s*(DONE|FAILED)\s*$/gm;
  const text = "MARK: DONE\nsome text\nMARK: FAILED\n";
  const match = lastMarkerMatch(re, text);
  expect(match).toBeDefined();
  expect(match![1]).toBe("FAILED");
});

test("lastMarkerMatch returns the single match when there is only one", () => {
  const re = /^MARK:\s*(DONE|FAILED)\s*$/gm;
  const match = lastMarkerMatch(re, "irrelevant\nMARK: DONE\n");
  expect(match).toBeDefined();
  expect(match![1]).toBe("DONE");
});

// ── DW-2.4: discovery excludes the underscore-prefixed shared helper. ──────

test("test_DW_2_4_discovery_excludes_agy_shared_helper", () => {
  const names = discoverAdapters(join(import.meta.dir, "../src/adapters")).map((a) => a.name);
  // Sanity: the real adapters directory was actually scanned and both real
  // consumers of _agy-shared.ts are present.
  expect(names).toContain("agy");
  // Both consumers of _agy-shared.ts now live under the single "agy" adapter as
  // kinds, so there is no separate "agy-image" name to find.
  expect(names).not.toContain("agy-image");
  expect(names.some((n) => n.includes("agy-shared"))).toBe(false);
});
