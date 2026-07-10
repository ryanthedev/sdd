/**
 * Code-agent adapters (grok, qwen, kimi, mistral). These share the review
 * output contract (src/lib/review-contract.ts) and differ only in binary +
 * one-shot flag + write-approval flag. They DEFAULT to write mode (emit their
 * approval flag so they can modify the repo); a per-call `opts.mode:"read"`
 * override drops the approval flag for a review-only run. No real CLI is
 * spawned; buildArgs / injectContract / parseResult are unit-tested directly,
 * plus directory-scan discovery and the name≠binary override. Live model calls
 * need each provider's API key and are verified out-of-band.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { discoverAdapters } from "../src/adapters/discover.ts";
import * as grok from "../src/adapters/grok.ts";
import * as kimi from "../src/adapters/kimi.ts";
import * as mistral from "../src/adapters/mistral.ts";
import * as qwen from "../src/adapters/qwen.ts";

const REVIEW_ADAPTERS = [
  { mod: grok, name: "grok", binary: "grok", approve: "--always-approve" },
  { mod: qwen, name: "qwen", binary: "qwen", approve: "--yolo" },
  { mod: kimi, name: "kimi", binary: "kimi", approve: "--yolo" },
  { mod: mistral, name: "mistral", binary: "vibe", approve: "--auto-approve" },
] as const;

for (const { mod, name, binary, approve } of REVIEW_ADAPTERS) {
  test(`${name}: write mode by default, emits approval flag before -p, prompt is last`, () => {
    expect(mod.mode).toBe("write");
    expect(mod.name).toBe(name);
    const argv = mod.buildArgs("review this diff", {});
    expect(argv).toEqual([binary, approve, "-p", "review this diff"]);
    expect(argv[argv.length - 1]).toBe("review this diff"); // prompt is LAST
    expect(argv[argv.length - 2]).toBe("-p"); // immediately after the one-shot flag
  });

  test(`${name}: opts.mode:"read" override omits the approval flag (review-only run)`, () => {
    const argv = mod.buildArgs("review this diff", { mode: "read" });
    expect(argv).toEqual([binary, "-p", "review this diff"]);
    expect(argv).not.toContain(approve);
    expect(argv[argv.length - 1]).toBe("review this diff"); // prompt still LAST
  });

  test(`${name}: injectContract appends the VERDICT/Findings contract to the prompt`, () => {
    const contracted = mod.injectContract("look at X");
    expect(contracted).toContain("look at X");
    expect(contracted).toContain("VERDICT:");
    expect(contracted).toContain("## Findings");
  });

  test(`${name}: parseResult enforces markers + exit 0 (silent-misparse backstop)`, () => {
    expect(mod.parseResult("no markers at all", "", 0).status).toBe("failed");
    expect(mod.parseResult("VERDICT: ok\n## Findings\nNone.", "", 1).status).toBe("failed");
    const good = mod.parseResult("Reviewed it.\nVERDICT: solid\n## Findings\nNone.", "", 0);
    expect(good.status).toBe("done");
    expect(good.artifacts).toEqual([]);
    expect(good.raw).toContain("VERDICT:");
  });

  test(`${name}: parseResult tolerates markdown-formatted markers (real grok output shape)`, () => {
    // Regression for live grok output: it emitted `**VERDICT:**` and `## Findings`,
    // which a strict `^VERDICT:` regex missed. Markers may carry markdown emphasis.
    const md = "**Review Summary**\n\n**VERDICT:** Incorrect implementation\n\n## Findings\n- Function subtracts.";
    expect(mod.parseResult(md, "", 0).status).toBe("done");
  });
}

test("grok: opts.model is passed through as -m <model> before -p (prompt stays last)", () => {
  const argv = grok.buildArgs("do it", { model: "grok-4.5" });
  expect(argv).toEqual(["grok", "--always-approve", "-m", "grok-4.5", "-p", "do it"]);
  expect(argv[argv.length - 1]).toBe("do it"); // prompt is LAST, after -m
});

test("grok: opts.model works in read mode (no approval flag, -m still before -p)", () => {
  const argv = grok.buildArgs("review it", { mode: "read", model: "grok-4.5" });
  expect(argv).toEqual(["grok", "-m", "grok-4.5", "-p", "review it"]);
});

test("grok: omitting opts.model preserves the default (no -m flag emitted)", () => {
  const argv = grok.buildArgs("do it", {});
  expect(argv).not.toContain("-m");
});

test("grok: a non-empty-string opts.model throws (loud failure, never silent)", () => {
  expect(() => grok.buildArgs("x", { model: "" })).toThrow(TypeError);
  expect(() => grok.buildArgs("x", { model: 42 as unknown as string })).toThrow(TypeError);
});

test("name≠binary: only mistral overrides binary (to vibe); others omit it", () => {
  expect(mistral.binary).toBe("vibe");
  // grok/qwen/kimi keep name==binary and don't export a binary override
  expect((grok as { binary?: string }).binary).toBeUndefined();
  expect((qwen as { binary?: string }).binary).toBeUndefined();
  expect((kimi as { binary?: string }).binary).toBeUndefined();
});

test("all four code-agent adapters are discovered via directory scan, binary override flows through", () => {
  const found = discoverAdapters(join(import.meta.dir, "..", "src", "adapters"));
  for (const { name } of REVIEW_ADAPTERS) {
    const a = found.find((x) => x.name === name);
    expect(a).toBeDefined();
    expect(a!.mode).toBe("write");
  }
  expect(found.find((x) => x.name === "mistral")!.binary).toBe("vibe");
});
