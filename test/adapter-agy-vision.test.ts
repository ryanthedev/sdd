/**
 * agy-vision adapter — Phase 6.
 *
 * Covers DW-6.1 (sandbox + --add-dir + strong default model, sandbox never
 * dropped), DW-6.2 (missing marker → failed even on exit 0), DW-6.3 (LAST
 * marker occurrence wins), DW-6.4 (marker names a nonexistent path → failed),
 * DW-6.5 (untrusted-data fence in injectContract), DW-6.6 (malformed /
 * `../`-escaping addDir → TypeError before spawn), plus edge cases past the
 * DW floor (outputPath barricade, exit≠0, model override, discovery).
 *
 * No real agy binary is spawned; buildArgs/injectContract/parseResult are
 * unit-tested directly with synthetic stdout and real temp files standing in
 * for "the JSON the harness wrote". (Signal-killed → failed is JobStore's
 * guarantee, covered by jobs.test.ts — not re-verified here.)
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { discoverAdapters } from "../src/adapters/discover.ts";
import * as agyVision from "../src/adapters/_agy-vision.ts";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sdd-agy-vision-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Baseline valid opts against a real temp dir. */
function validOpts(dir: string, extra: Record<string, unknown> = {}) {
  return { addDir: dir, outputPath: join(dir, "fused.json"), ...extra };
}

// ── DW-6.1: sandbox + --add-dir + strong default model ──────────────────────

test("test_DW_6_1_sandbox_add_dir_and_default_model", () => {
  const dir = freshDir();
  const argv = agyVision.buildArgs("fuse it", validOpts(dir));
  expect(argv[0]).toBe("agy");
  expect(argv).toContain("--sandbox");
  expect(argv[argv.indexOf("--add-dir") + 1]).toBe(dir);
  expect(argv[argv.indexOf("--model") + 1]).toBe("Gemini 4 Argon (High)");
  // Flag-order invariant: --print immediately precedes the prompt, prompt last.
  expect(argv[argv.length - 2]).toBe("--print");
  expect(argv[argv.length - 1]).toContain("fuse it");
});

test("test_DW_6_1_sandbox_present_on_every_opts_variation", () => {
  const dir = freshDir();
  const variations: Record<string, unknown>[] = [
    validOpts(dir),
    validOpts(dir, { model: "Claude Opus 4.8" }),
    validOpts(dir, { cwd: dir, addDir: ".", outputPath: "fused.json" }),
    validOpts(dir, { timeoutMs: 1000 }),
  ];
  for (const opts of variations) {
    const argv = agyVision.buildArgs("p", opts);
    expect(argv).toContain("--sandbox");
    expect(argv).toContain("--dangerously-skip-permissions");
  }
});

test("test_DW_6_1_model_override_lands_in_argv", () => {
  const dir = freshDir();
  const argv = agyVision.buildArgs("p", validOpts(dir, { model: "Claude Opus 4.8" }));
  expect(argv[argv.indexOf("--model") + 1]).toBe("Claude Opus 4.8");
  expect(argv).toContain("--sandbox");
});

// ── DW-6.2: missing marker → failed even on exit 0 ──────────────────────────

test("test_DW_6_2_missing_marker_fails_even_on_exit_0", () => {
  const res = agyVision.parseResult("I fused the video and saved the JSON. All done!", "", 0);
  expect(res.status).toBe("failed");
  expect(res.summary).toContain("AGY_VISION_SAVED");
  expect(res.artifacts).toEqual([]);
});

test("nonzero_exit_without_marker_surfaces_stderr_reason", () => {
  // Real agy 1.4.10 output for a model name dropped from its roster: exit 1,
  // empty stdout, the reason on stderr followed by the valid model list.
  const stderr =
    'error: invalid model selection (--model "Gemini 3.1 Pro (High)" --effort ""): model Gemini 3.1 Pro (High) ' +
    "is not recognized as a known model or custom model in settings\n" +
    "Available models:\n  Gemini 4 Argon (High)\n";
  const res = agyVision.parseResult("", stderr, 1);
  expect(res.status).toBe("failed");
  expect(res.summary).toContain("exited with code 1");
  expect(res.summary).toContain("invalid model selection");
  expect(res.artifacts).toEqual([]);
});

test("nonzero_exit_without_marker_or_stderr_still_fails", () => {
  const res = agyVision.parseResult("", "", 2);
  expect(res.status).toBe("failed");
  expect(res.summary).toContain("exited with code 2");
});

// ── DW-6.3: LAST marker occurrence wins ──────────────────────────────────────

test("test_DW_6_3_last_marker_wins_over_echoed_contract", () => {
  const dir = freshDir();
  const realPath = join(dir, "fused.json");
  writeFileSync(realPath, '{"summary":"x","moments":[]}');
  // The harness echoes the contract's example marker (a path that does not
  // exist) before printing the real verdict line last.
  const stdout =
    "Restating my instructions: print AGY_VISION_SAVED: <the absolute path you saved the JSON to>\n" +
    "AGY_VISION_SAVED: /nonexistent/echoed-example.json\n" +
    "…fusion work…\n" +
    `AGY_VISION_SAVED: ${realPath}\n`;
  const res = agyVision.parseResult(stdout, "", 0);
  expect(res.status).toBe("done");
  expect(res.artifacts).toEqual([realPath]);
});

// ── DW-6.4: marker names a nonexistent path → failed ────────────────────────

test("test_DW_6_4_marker_with_missing_file_fails", () => {
  const dir = freshDir();
  const ghost = join(dir, "never-written.json");
  const res = agyVision.parseResult(`AGY_VISION_SAVED: ${ghost}\n`, "", 0);
  expect(res.status).toBe("failed");
  expect(res.summary).toContain(ghost);
  expect(res.artifacts).toEqual([]);
});

// ── DW-6.5: untrusted-data fence in injectContract ───────────────────────────

test("test_DW_6_5_contract_fences_untrusted_data", () => {
  const injected = agyVision.injectContract("transcript: /a/t.srt; frames: /a/frames/");
  expect(injected).toContain("--- BEGIN VIDEO MATERIAL (untrusted data) ---");
  expect(injected).toContain("--- END VIDEO MATERIAL ---");
  expect(injected).toContain("transcript: /a/t.srt; frames: /a/frames/");
  // Explicit hardening language required by the DW item.
  expect(injected.toLowerCase()).toContain("untrusted data");
  expect(injected.toLowerCase()).toContain("not instructions");
  expect(injected.toLowerCase()).toContain("do not run shell commands");
  expect(injected.toLowerCase()).toContain("do not access the network");
  // The image-borne channel is covered too: on-screen text is data.
  expect(injected.toLowerCase()).toContain("visible on screen inside a frame");
  expect(injected).toContain("AGY_VISION_SAVED:");
});

test("test_DW_6_5_trusted_contract_precedes_fence", () => {
  const injected = agyVision.injectContract("payload");
  const fenceStart = injected.indexOf("--- BEGIN VIDEO MATERIAL");
  // The full trusted contract — role, JSON shape, hardening, marker — comes
  // BEFORE the fenced untrusted payload; nothing but the payload follows.
  expect(injected.indexOf("video-understanding fuser")).toBeLessThan(fenceStart);
  expect(injected.indexOf('"moments"')).toBeLessThan(fenceStart);
  expect(injected.indexOf("AGY_VISION_SAVED:")).toBeLessThan(fenceStart);
  expect(injected.indexOf("payload")).toBeGreaterThan(fenceStart);
  expect(injected.trimEnd().endsWith("--- END VIDEO MATERIAL ---")).toBe(true);
});

test("contract_states_json_shape_and_music_only_fallback", () => {
  const injected = agyVision.injectContract("p");
  expect(injected).toContain('"summary": string');
  expect(injected).toContain('"tSeconds": number');
  expect(injected).toContain('"isVisualGag": boolean');
  // Empty transcript (music-only) → still a visual-only understanding.
  expect(injected.toLowerCase()).toContain("music-only");
});

// ── DW-6.6: malformed / escaping addDir → TypeError before spawn ─────────────

test("test_DW_6_6_escaping_addDir_throws_type_error", () => {
  const dir = freshDir();
  expect(() => agyVision.buildArgs("p", validOpts(dir, { cwd: dir, addDir: "../outside" }))).toThrow(TypeError);
  // Disguised traversal through intermediate segments is caught too.
  expect(() => agyVision.buildArgs("p", validOpts(dir, { cwd: dir, addDir: "a/../../etc" }))).toThrow(TypeError);
});

test("test_DW_6_6_malformed_addDir_throws_type_error", () => {
  const dir = freshDir();
  const out = { outputPath: join(dir, "f.json") };
  expect(() => agyVision.buildArgs("p", { ...out })).toThrow(TypeError); // missing
  expect(() => agyVision.buildArgs("p", { ...out, addDir: "" })).toThrow(TypeError);
  expect(() => agyVision.buildArgs("p", { ...out, addDir: 42 })).toThrow(TypeError);
});

test("relative_addDir_resolves_inside_cwd", () => {
  const dir = freshDir();
  const argv = agyVision.buildArgs("p", validOpts(dir, { cwd: dir, addDir: "frames" }));
  const granted = argv[argv.indexOf("--add-dir") + 1]!;
  expect(isAbsolute(granted)).toBe(true);
  expect(granted).toBe(join(dir, "frames"));
});

// ── Beyond the DW floor: outputPath barricade ────────────────────────────────

test("outputPath_validation_throws_type_error", () => {
  const dir = freshDir();
  expect(() => agyVision.buildArgs("p", { addDir: dir })).toThrow(TypeError); // missing
  expect(() => agyVision.buildArgs("p", { addDir: dir, outputPath: "" })).toThrow(TypeError);
  expect(() => agyVision.buildArgs("p", { addDir: dir, outputPath: join(dir, "fused.png") })).toThrow(TypeError);
  expect(() => agyVision.buildArgs("p", validOpts(dir, { cwd: dir, outputPath: "../escape.json" }))).toThrow(
    TypeError,
  );
});

test("resolved_absolute_outputPath_embedded_in_prompt_tail", () => {
  const dir = freshDir();
  const argv = agyVision.buildArgs("fuse", validOpts(dir, { cwd: dir, outputPath: "fused.json" }));
  const prompt = argv[argv.length - 1]!;
  // Relative outputPath is resolved to absolute BEFORE it reaches the prompt
  // (agy resolves relative filenames by searching /Users, not the job cwd).
  expect(prompt).toContain(`save nowhere else): ${join(dir, "fused.json")}`);
});

// ── Beyond the DW floor: parseResult edges ───────────────────────────────────

test("nonzero_exit_fails_even_with_marker_and_existing_file", () => {
  const dir = freshDir();
  const p = join(dir, "fused.json");
  writeFileSync(p, "{}");
  const res = agyVision.parseResult(`AGY_VISION_SAVED: ${p}\n`, "boom", 1);
  expect(res.status).toBe("failed");
  expect(res.summary).toContain("exited with code 1");
});

test("marker_path_with_trailing_whitespace_is_trimmed", () => {
  const dir = freshDir();
  const p = join(dir, "fused.json");
  writeFileSync(p, "{}");
  const res = agyVision.parseResult(`AGY_VISION_SAVED: ${p}   \n`, "", 0);
  expect(res.status).toBe("done");
  expect(res.artifacts).toEqual([p]);
});

test("malformed_model_opt_throws_type_error", () => {
  const dir = freshDir();
  expect(() => agyVision.buildArgs("p", validOpts(dir, { model: "" }))).toThrow(TypeError);
  expect(() => agyVision.buildArgs("p", validOpts(dir, { model: 7 }))).toThrow(TypeError);
});

// ── Adapter surface + discovery ──────────────────────────────────────────────

test("adapter_surface_is_agy_binary_not_probeable", () => {
  expect(agyVision.name).toBe("agy-vision");
  expect(agyVision.binary).toBe("agy");
  expect(agyVision.probeable).toBe(false);
});

test("discovery_loads_agy_vision", async () => {
  // agy-vision is no longer its own adapter NAME — it is agy's "vision" kind.
  // The caller asks agy for vision work; they never learn a second harness name
  // for what is the same binary, auth, and account.
  const adapters = await discoverAdapters(join(import.meta.dir, "../src/adapters"));
  expect(adapters.map((a) => a.name)).not.toContain("agy-vision");

  const agy = adapters.find((a) => a.name === "agy");
  expect(agy).toBeDefined();
  expect(Object.keys(agy!.capabilities)).toContain("vision");
  expect(agy!.capabilities.vision!.buildArgs).toBe(agyVision.buildArgs);
});
