/**
 * gemini adapter unit tests — both kinds' parseResult driven by representative
 * stdout/stderr/exitCode triples, the buildArgs barricades, and the bundled
 * scripts' request validation (which fails before any network call, so a fake
 * key is enough).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as gemini from "../src/adapters/gemini.ts";
import * as decide from "../src/adapters/_gemini-decide.ts";
import * as vision from "../src/adapters/_gemini-vision.ts";

let dir: string;
let jsonPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sdd-gemini-test-"));
  jsonPath = join(dir, "out.json");
  writeFileSync(jsonPath, JSON.stringify({ items: 1, ok: 1, failed: 0, results: [] }));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("gemini harness shape", () => {
  test("one name, two kinds, decisions by default, never probed", () => {
    expect(gemini.name).toBe("gemini");
    expect(gemini.binary).toBe("bun");
    expect(gemini.probeable).toBe(false);
    expect(Object.keys(gemini.capabilities).sort()).toEqual(["default", "vision"]);
    expect(gemini.defaultKind).toBe("default");
  });

  test("both contracts are identity (the prompt is a path or an instruction)", () => {
    expect(decide.injectContract("/tmp/req.json")).toBe("/tmp/req.json");
    expect(vision.injectContract("Fuse this video.")).toBe("Fuse this video.");
  });
});

describe("gemini decide buildArgs", () => {
  test("runs the bundled script hermetically, flags before positionals", () => {
    const argv = decide.buildArgs("/tmp/req.json", { outputPath: "/tmp/out.json" });
    expect(argv[0]).toBe("bun");
    expect(argv.find((a) => a.startsWith("--config="))?.endsWith("gemini-bunfig.toml")).toBe(true);
    expect(argv).toContain("--no-env-file");
    const runIdx = argv.indexOf("run");
    expect(argv.indexOf("--no-env-file")).toBeLessThan(runIdx);
    expect(argv[runIdx + 1]?.endsWith("gemini-decide.ts")).toBe(true);
    expect(argv.slice(runIdx + 2)).toEqual(["/tmp/req.json", "/tmp/out.json"]);
  });

  test("requires outputPath", () => {
    expect(() => decide.buildArgs("/tmp/req.json", {})).toThrow(/outputPath/);
  });

  test("rejects option-shaped, control-character, and cwd-escaping paths", () => {
    expect(() => decide.buildArgs("--help", { outputPath: "/tmp/out.json" })).toThrow(TypeError);
    expect(() => decide.buildArgs("/tmp/a\nb.json", { outputPath: "/tmp/out.json" })).toThrow(TypeError);
    expect(() => decide.buildArgs("../req.json", { outputPath: "/tmp/out.json", cwd: dir })).toThrow(/escapes/);
  });

  test("resolves a relative path inside the job cwd", () => {
    const argv = decide.buildArgs("req.json", { outputPath: "out.json", cwd: dir });
    expect(argv.slice(-2)).toEqual([join(dir, "req.json"), join(dir, "out.json")]);
  });
});

describe("gemini decide parseResult", () => {
  const ok = (p: string) =>
    `SDD_GEMINI_SUMMARY:items=1 ok=1 failed=0 input_tokens=2192 cost_usd=0.000219\nSDD_GEMINI_RESULT:${p}\n`;

  test("done with the results file as the artifact", () => {
    const r = decide.parseResult(ok(jsonPath), "", 0);
    expect(r.status).toBe("done");
    expect(r.artifacts).toEqual([jsonPath]);
    expect(r.summary).toContain("ok=1");
  });

  test("missing marker is failed even on exit 0", () => {
    expect(decide.parseResult("all good\n", "", 0).status).toBe("failed");
  });

  test("a marker naming a file that does not exist is failed", () => {
    expect(decide.parseResult(ok(join(dir, "nope.json")), "", 0).status).toBe("failed");
  });

  test("last marker wins", () => {
    const r = decide.parseResult(`SDD_GEMINI_RESULT:${join(dir, "nope.json")}\n${ok(jsonPath)}`, "", 0);
    expect(r.status).toBe("done");
  });

  test("non-zero exit surfaces the script's own error line", () => {
    const r = decide.parseResult("", "noise\ngemini-decide: GEMINI_API_KEY is not set\n", 1);
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("GEMINI_API_KEY is not set");
  });
});

describe("gemini vision buildArgs", () => {
  test("same opts as agy vision; cheapest model by default; instruction last", () => {
    const argv = vision.buildArgs("Fuse it.", { addDir: "/tmp/art", outputPath: "/tmp/art/fused.json" });
    const runIdx = argv.indexOf("run");
    expect(argv[runIdx + 1]?.endsWith("gemini-vision.ts")).toBe(true);
    expect(argv.slice(runIdx + 2)).toEqual(["/tmp/art", "/tmp/art/fused.json", vision.DEFAULT_VISION_MODEL, "Fuse it."]);
    expect(vision.DEFAULT_VISION_MODEL).toBe("gemini-3.1-flash-lite");
  });

  test("model override is validated", () => {
    const argv = vision.buildArgs("x", { addDir: "/tmp/a", outputPath: "/tmp/a/f.json", model: "gemini-3.5-flash-lite" });
    expect(argv).toContain("gemini-3.5-flash-lite");
    expect(() => vision.buildArgs("x", { addDir: "/tmp/a", outputPath: "/tmp/a/f.json", model: "--evil" })).toThrow(TypeError);
    expect(() => vision.buildArgs("x", { addDir: "/tmp/a", outputPath: "/tmp/a/f.json", model: "a b" })).toThrow(TypeError);
  });

  test("requires addDir and a .json outputPath", () => {
    expect(() => vision.buildArgs("x", { outputPath: "/tmp/f.json" })).toThrow(/addDir/);
    expect(() => vision.buildArgs("x", { addDir: "/tmp/a", outputPath: "/tmp/a/f.txt" })).toThrow(/\.json/);
    expect(() => vision.buildArgs("x", { addDir: "../up", outputPath: "f.json", cwd: dir })).toThrow(/escapes/);
  });

  test("an empty instruction gets a default rather than an empty argv element", () => {
    const argv = vision.buildArgs("   ", { addDir: "/tmp/a", outputPath: "/tmp/a/f.json" });
    expect(argv.at(-1)).toBe("Fuse this video.");
  });
});

describe("gemini vision parseResult", () => {
  test("done with the fused JSON as the artifact", () => {
    const out = `SDD_GEMINI_SUMMARY:model=gemini-3.1-flash-lite frames=35 input_tokens=11152 output_tokens=2668 cost_usd=0.006790\nSDD_GEMINI_VISION_SAVED:${jsonPath}\n`;
    const r = vision.parseResult(out, "", 0);
    expect(r.status).toBe("done");
    expect(r.artifacts).toEqual([jsonPath]);
    expect(r.summary).toContain("cost_usd=0.006790");
  });

  test("missing marker or missing file is failed", () => {
    expect(vision.parseResult("", "", 0).status).toBe("failed");
    expect(vision.parseResult(`SDD_GEMINI_VISION_SAVED:${join(dir, "nope.json")}\n`, "", 0).status).toBe("failed");
  });

  test("non-zero exit surfaces the reason", () => {
    const r = vision.parseResult("", "gemini-vision: no manifest.json in /x (run the ffmpeg-frames step first)\n", 1);
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("no manifest.json");
  });
});

/** Run a bundled script with a fake key; validation errors exit before any
 *  network call. */
async function runScript(script: string, args: string[]): Promise<{ code: number; stderr: string }> {
  const argv = [...(script === "decide" ? decide.buildArgs(args[0]!, { outputPath: args[1]! }) : vision.buildArgs(args[2] ?? "x", { addDir: args[0]!, outputPath: args[1]! }))];
  const proc = Bun.spawn(argv, { env: { ...process.env, GEMINI_API_KEY: "fake-key-for-tests" }, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  return { code, stderr: await new Response(proc.stderr).text() };
}

describe("bundled script validation (no network)", () => {
  test("decide rejects a YouTube URL with an actionable message", async () => {
    const req = join(dir, "yt.json");
    writeFileSync(req, JSON.stringify({
      questions: { q: { type: "noul", instructions: "Is it a cat?" } },
      items: [{ id: "a", input: [{ type: "video", uri: "https://www.youtube.com/watch?v=abc" }] }],
    }));
    const r = await runScript("decide", [req, join(dir, "r.json")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("YouTube URLs are not accepted");
  });

  test("decide rejects an unknown question type", async () => {
    const req = join(dir, "bad.json");
    writeFileSync(req, JSON.stringify({ questions: { q: { type: "rank", instructions: "x" } }, items: [{ id: "a", state: "t" }] }));
    const r = await runScript("decide", [req, join(dir, "r.json")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('needs type "noul"');
  });

  test("vision refuses a directory with no manifest", async () => {
    const r = await runScript("vision", [dir, join(dir, "fused.json")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no manifest.json");
  });

  test("vision refuses a manifest frame outside the artifact dir", async () => {
    const art = mkdtempSync(join(tmpdir(), "sdd-gemini-art-"));
    writeFileSync(join(art, "manifest.json"), JSON.stringify({ frames: [{ file: "/etc/hosts", tSeconds: 0 }] }));
    const r = await runScript("vision", [art, join(art, "fused.json")]);
    rmSync(art, { recursive: true, force: true });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("points outside");
  });
});
