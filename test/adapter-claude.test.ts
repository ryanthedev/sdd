/**
 * claude adapter unit tests — pure argv/contract/discovery verification, no
 * live `claude` CLI spawned.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import * as claude from "../src/adapters/claude.ts";
import { discoverAdapters } from "../src/adapters/discover.ts";

test("claude default buildArgs emits --dangerously-skip-permissions, --no-session-persistence, and -p last", () => {
  const argv = claude.buildArgs("review this diff", {});
  expect(argv).toEqual([
    "claude",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "-p",
    "review this diff",
  ]);
  expect(argv.at(-2)).toBe("-p");
  expect(argv.at(-1)).toBe("review this diff");
});

test("claude readOnly:true emits --permission-mode plan and omits --dangerously-skip-permissions", () => {
  const argv = claude.buildArgs("review this diff", { readOnly: true });
  expect(argv).toEqual([
    "claude",
    "--permission-mode",
    "plan",
    "--no-session-persistence",
    "-p",
    "review this diff",
  ]);
  expect(argv).not.toContain("--dangerously-skip-permissions");
});

test("claude threads model, effort (low..max), and addDir before -p", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const argv = claude.buildArgs("do it", { model: "opus", effort, addDir: "/abs/extra" });
    expect(argv).toEqual([
      "claude",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--model",
      "opus",
      "--effort",
      effort,
      "--add-dir",
      "/abs/extra",
      "-p",
      "do it",
    ]);
  }
});

test("claude rejects unsupported effort (including ultra), bad model, bad readOnly, and escaping addDir", () => {
  expect(() => claude.buildArgs("p", { effort: "ultra" })).toThrow(TypeError);
  expect(() => claude.buildArgs("p", { effort: "bogus" })).toThrow(TypeError);
  expect(() => claude.buildArgs("p", { model: "" })).toThrow(TypeError);
  expect(() => claude.buildArgs("p", { model: 42 })).toThrow(TypeError);
  expect(() => claude.buildArgs("p", { readOnly: "yes" as unknown as boolean })).toThrow(TypeError);
  expect(() => claude.buildArgs("p", { addDir: "../escape", cwd: "/tmp/work" })).toThrow(TypeError);
});

test("claude uses the shared VERDICT:/## Findings review contract", () => {
  const contracted = claude.injectContract("check auth");
  expect(contracted).toContain("VERDICT:");
  expect(contracted).toContain("## Findings");

  expect(claude.parseResult("no markers", "", 0).status).toBe("failed");
  expect(claude.parseResult("VERDICT: ok\n## Findings\nNone.", "", 1).status).toBe("failed");
  expect(claude.parseResult("VERDICT: ok\n## Findings\nNone.", "", 0).status).toBe("done");
});

test("claude is discovered via directory scan with effortLevels, supportsReadOnly, and static models", () => {
  const found = discoverAdapters(join(import.meta.dir, "..", "src", "adapters")).find((a) => a.name === "claude");
  expect(found).toBeDefined();
  expect(found!.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(found!.supportsReadOnly).toBe(true);
  expect(found!.models?.map((m) => m.id)).toEqual(["opus", "sonnet", "fable", "haiku"]);
  expect(found!.readLimits).toBeUndefined();
});
