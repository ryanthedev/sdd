/**
 * Code-agent adapters (grok, qwen, kimi, mistral). These share the review
 * output contract (src/lib/review-contract.ts) and differ only in binary +
 * one-shot flag + approval flag. Each is unconditionally permissive: the
 * approval flag is ALWAYS emitted so the harness can act headlessly (whether
 * letting it edit a given tree is safe is the caller's call, not the
 * adapter's). No real CLI is spawned; buildArgs / injectContract / parseResult
 * are unit-tested directly, plus directory-scan discovery and the name≠binary
 * override. Live model calls need each provider's API key and are verified
 * out-of-band.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_KIND } from "../src/adapters/types.ts";
import { discoverAdapters } from "../src/adapters/discover.ts";
import * as grok from "../src/adapters/grok.ts";
import * as kimi from "../src/adapters/kimi.ts";
import * as mistral from "../src/adapters/mistral.ts";
import * as qwen from "../src/adapters/qwen.ts";

const REVIEW_ADAPTERS = [
  { mod: grok, name: "grok", binary: "grok", approve: "--always-approve" },
  { mod: qwen, name: "qwen", binary: "qwen", approve: "--yolo" },
  // kimi alone takes NO approval flag — kimi-code 0.22.3 exits 1 on
  // `--yolo`/`--auto` combined with `-p` ("Cannot combine --prompt with --yolo").
  { mod: kimi, name: "kimi", binary: "kimi", approve: null },
  { mod: mistral, name: "mistral", binary: "vibe", approve: "--auto-approve" },
] as const;

for (const { mod, name, binary, approve } of REVIEW_ADAPTERS) {
  test(`${name}: emits the approval flag before -p, prompt is last`, () => {
    expect(mod.name).toBe(name);
    const argv = mod.buildArgs("review this diff", {});
    const expected = approve
      ? [binary, approve, "-p", "review this diff"]
      : [binary, "-p", "review this diff"];
    expect(argv).toEqual(expected);
    expect(argv[argv.length - 1]).toBe("review this diff"); // prompt is LAST
    expect(argv[argv.length - 2]).toBe("-p"); // immediately after the one-shot flag
  });

  test(`${name}: the approval flag is ALWAYS emitted, whatever the opts`, () => {
    // Unconditionally permissive: no opt drops the approval flag. Deciding
    // whether the harness may edit this tree is the caller's job, not ours.
    // kimi is the exception — it REFUSES an approval flag in `-p` mode, so the
    // invariant there is the inverse: no approval flag is ever smuggled in.
    for (const opts of [{}, { timeoutMs: 1000 }, { cwd: "/tmp" }, { effort: "high" }]) {
      const argv = mod.buildArgs("review this diff", opts);
      if (approve) expect(argv).toContain(approve);
      else expect(argv.some((a) => /^--(yolo|auto|always-approve|auto-approve)$/.test(a))).toBe(false);
    }
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
    expect(typeof a!.capabilities[DEFAULT_KIND]!.buildArgs).toBe("function");
  }
  expect(found.find((x) => x.name === "mistral")!.binary).toBe("vibe");
});

// ─────────────────────────────────────────────────────────────────────────────
// grok's `image` kind. grok ships an `imagine` SKILL documenting compiled
// `image_gen`/`image_edit` tools — invisible to `grok --help`, which is why an
// earlier survey of this repo concluded grok couldn't make pictures. Verified
// live on grok 0.2.93: headless `-p` wrote a real 1024x1024 PNG to the absolute
// path named in the prompt and echoed the marker back.
// ─────────────────────────────────────────────────────────────────────────────

test("grok exposes a default and an image kind, defaulting to review", () => {
  expect(Object.keys(grok.capabilities).sort()).toEqual(["default", "image"]);
  expect(grok.defaultKind).toBe("default");
});

test("grok's image kind keeps the approval flag and the prompt-last guarantee", () => {
  const argv = grok.capabilities.image!.buildArgs("a green square", { outputPath: "/abs/out.png" });
  expect(argv[0]).toBe("grok");
  expect(argv).toContain("--always-approve");
  expect(argv[argv.length - 2]).toBe("-p");
  // The destination rides in the prompt — grok has no --out flag either.
  expect(argv[argv.length - 1]).toContain("/abs/out.png");
});

test("grok's image kind reuses the default kind's model validation", () => {
  const argv = grok.capabilities.image!.buildArgs("x", { outputPath: "/abs/o.png", model: "grok-4.5" });
  expect(argv).toContain("-m");
  expect(argv).toContain("grok-4.5");
  expect(() => grok.capabilities.image!.buildArgs("x", { outputPath: "/abs/o.png", model: "" })).toThrow(TypeError);
});

test("grok's image kind requires an outputPath and proves the file exists", () => {
  expect(() => grok.capabilities.image!.buildArgs("x", {})).toThrow(TypeError);
  expect(grok.capabilities.image!.parseResult("GROK_IMAGE_SAVED: /nope/missing.png", "", 0).status).toBe("failed");
});

test("grok still ignores effort — it does not validate the value, so a passthrough would lie", () => {
  // Measured: `grok --reasoning-effort definitely-not-valid -p "x"` is ACCEPTED
  // and runs. Forwarding would make the opt look honored while changing nothing.
  expect(grok.buildArgs("p", { effort: "high" })).toEqual(grok.buildArgs("p", {}));
  expect(grok.capabilities.image!.buildArgs("p", { outputPath: "/a/b.png", effort: "high" })).toEqual(
    grok.capabilities.image!.buildArgs("p", { outputPath: "/a/b.png" }),
  );
});
