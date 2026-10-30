/**
 * shazam adapter unit tests — parseResult driven by representative
 * stdout/stderr/exitCode triples, plus the buildArgs barricades.
 *
 * parseResult verifies the result file exists on disk, so the "happy path"
 * cases write a real temp JSON file and feed its path through the marker.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgs, injectContract, name, parseResult, probeable } from "../src/adapters/shazam.ts";

let dir: string;
let jsonPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sdd-shazam-test-"));
  jsonPath = join(dir, "song.json");
  writeFileSync(jsonPath, JSON.stringify({ matched: true, title: "Братва", artist: "Vibera" }));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("shazam adapter identity", () => {
  test("dispatch key and probe policy", () => {
    expect(name).toBe("shazam");
    expect(probeable).toBe(false);
  });

  test("injectContract is identity — the prompt IS the audio path", () => {
    expect(injectContract("/tmp/a.wav")).toBe("/tmp/a.wav");
  });
});

describe("shazam buildArgs", () => {
  test("puts uv flags before the script and positionals, and is an argv array", () => {
    const argv = buildArgs("/tmp/a.wav", { outputPath: "/tmp/out.json" });
    expect(Array.isArray(argv)).toBe(true);
    expect(argv[0]).toBe("uv");
    expect(argv[1]).toBe("run");
    expect(argv).toContain("--quiet");
    // Hermetic: must never adopt the job cwd's pyproject.toml.
    expect(argv).toContain("--no-project");

    const scriptIdx = argv.findIndex((a) => a.endsWith("shazam-recognize.py"));
    expect(scriptIdx).toBeGreaterThan(0);
    // Every uv flag precedes the script; the two positionals follow it in order.
    expect(argv.indexOf("--no-project")).toBeLessThan(scriptIdx);
    expect(argv.slice(scriptIdx + 1)).toEqual(["/tmp/a.wav", "/tmp/out.json"]);
  });

  test("rejects an audio path that could be misread as an option", () => {
    expect(() => buildArgs("-rf", { outputPath: "/tmp/out.json" })).toThrow(TypeError);
  });

  test("rejects an empty prompt", () => {
    expect(() => buildArgs("   ", { outputPath: "/tmp/out.json" })).toThrow(TypeError);
  });

  test("rejects a control character in the audio path", () => {
    expect(() => buildArgs(`/tmp/a${String.fromCharCode(10)}b.wav`, { outputPath: "/tmp/o.json" })).toThrow(TypeError);
  });

  test("requires outputPath", () => {
    expect(() => buildArgs("/tmp/a.wav", {})).toThrow(TypeError);
  });

  test("rejects a relative outputPath that escapes the job cwd", () => {
    expect(() => buildArgs("/tmp/a.wav", { outputPath: "../escape.json", cwd: "/tmp/work" })).toThrow(TypeError);
  });

  test("resolves a contained relative outputPath against the job cwd", () => {
    const argv = buildArgs("/tmp/a.wav", { outputPath: "out/song.json", cwd: "/tmp/work" });
    expect(argv.at(-1)).toBe("/tmp/work/out/song.json");
  });
});

describe("shazam parseResult", () => {
  test("match -> done, with the identity in the summary and the JSON as the artifact", () => {
    const stdout = [
      "SDD_SHAZAM_TITLE:Братва",
      "SDD_SHAZAM_ARTIST:Vibera",
      `SDD_SHAZAM_RESULT:${jsonPath}`,
      "",
    ].join("\n");
    const r = parseResult(stdout, "", 0);
    expect(r.status).toBe("done");
    expect(r.summary).toContain("Братва");
    expect(r.summary).toContain("Vibera");
    expect(r.artifacts).toEqual([jsonPath]);
  });

  test("no match -> done (a real answer), not failed", () => {
    const stdout = ["SDD_SHAZAM_NOMATCH:1", `SDD_SHAZAM_RESULT:${jsonPath}`].join("\n");
    const r = parseResult(stdout, "", 0);
    expect(r.status).toBe("done");
    expect(r.summary).toContain("no match");
    expect(r.artifacts).toEqual([jsonPath]);
  });

  test("markers are read by LAST occurrence, so an echoed line cannot win", () => {
    const stdout = [
      "SDD_SHAZAM_TITLE:Echoed Instruction",
      "SDD_SHAZAM_ARTIST:Nobody",
      "SDD_SHAZAM_TITLE:Братва",
      "SDD_SHAZAM_ARTIST:Vibera",
      `SDD_SHAZAM_RESULT:${jsonPath}`,
    ].join("\n");
    const r = parseResult(stdout, "", 0);
    expect(r.summary).toContain("Братва — Vibera");
    expect(r.summary).not.toContain("Echoed Instruction");
  });

  test("non-zero exit -> failed, with a stderr tail", () => {
    const r = parseResult("", "ffmpeg could not decode /tmp/a.wav", 1);
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("exited with code 1");
    expect(r.summary).toContain("ffmpeg could not decode");
    expect(r.artifacts).toEqual([]);
  });

  test("exit 0 with no marker -> failed (silent-success backstop)", () => {
    const r = parseResult("uv provisioned an environment and did nothing\n", "", 0);
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("SDD_SHAZAM_RESULT");
    expect(r.artifacts).toEqual([]);
  });

  test("marker naming a file that does not exist -> failed", () => {
    const r = parseResult(`SDD_SHAZAM_TITLE:x\nSDD_SHAZAM_RESULT:${join(dir, "absent.json")}\n`, "", 0);
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("does not exist");
  });

  test("result marker with neither title nor artist -> failed (broken run)", () => {
    const r = parseResult(`SDD_SHAZAM_RESULT:${jsonPath}\n`, "", 0);
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("neither title nor artist");
  });

  test("CRLF stdout is parsed", () => {
    const stdout = `SDD_SHAZAM_TITLE:Братва\r\nSDD_SHAZAM_ARTIST:Vibera\r\nSDD_SHAZAM_RESULT:${jsonPath}\r\n`;
    const r = parseResult(stdout, "", 0);
    expect(r.status).toBe("done");
    expect(r.artifacts).toEqual([jsonPath]);
  });
});
