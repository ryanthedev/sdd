/**
 * jev adapter unit tests — parseResult driven by representative
 * stdout/stderr/exitCode triples, plus the buildArgs barricades.
 *
 * parseResult verifies the result file exists on disk, so the "happy path"
 * cases write a real temp JSON file and feed its path through the marker.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgs, injectContract, name, parseResult, probeable } from "../src/adapters/jev.ts";

let dir: string;
let jsonPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sdd-jev-test-"));
  jsonPath = join(dir, "ranked.json");
  writeFileSync(jsonPath, JSON.stringify({ items: 2, ok: 2, failed: 0, results: [] }));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const okStdout = (path: string) =>
  `SDD_JEV_SUMMARY:items=2 ok=2 failed=0 cost_usd=0.000071\nSDD_JEV_RESULT:${path}\n`;

describe("jev adapter identity", () => {
  test("dispatch key and probe policy", () => {
    expect(name).toBe("jev");
    expect(probeable).toBe(false);
  });

  test("injectContract is identity — the prompt IS the request path", () => {
    expect(injectContract("/tmp/req.json")).toBe("/tmp/req.json");
  });
});

describe("jev buildArgs", () => {
  test("runs the bundled script hermetically, flags before positionals", () => {
    const argv = buildArgs("/tmp/req.json", { outputPath: "/tmp/out.json" });
    expect(argv[0]).toBe("bun");
    // The job cwd's bunfig.toml (preload) and .env must never be read.
    const configFlag = argv.find((a) => a.startsWith("--config="));
    expect(configFlag?.endsWith("jev-bunfig.toml")).toBe(true);
    expect(argv).toContain("--no-env-file");

    const runIdx = argv.indexOf("run");
    const scriptIdx = argv.findIndex((a) => a.endsWith("jev-evaluate.ts"));
    expect(argv.indexOf("--no-env-file")).toBeLessThan(runIdx);
    expect(scriptIdx).toBe(runIdx + 1);
    expect(argv.slice(scriptIdx + 1)).toEqual(["/tmp/req.json", "/tmp/out.json"]);
  });

  test("rejects a request path that could be misread as an option", () => {
    expect(() => buildArgs("--help", { outputPath: "/tmp/out.json" })).toThrow(TypeError);
  });

  test("rejects an empty prompt", () => {
    expect(() => buildArgs("  ", { outputPath: "/tmp/out.json" })).toThrow(TypeError);
  });

  test("rejects a control character in either path", () => {
    expect(() => buildArgs(`/tmp/r${String.fromCharCode(10)}.json`, { outputPath: "/tmp/o.json" })).toThrow(TypeError);
    expect(() => buildArgs("/tmp/r.json", { outputPath: `/tmp/o${String.fromCharCode(0)}.json` })).toThrow(TypeError);
  });

  test("requires outputPath", () => {
    expect(() => buildArgs("/tmp/req.json", {})).toThrow(TypeError);
  });

  test("rejects relative paths that escape the job cwd", () => {
    expect(() => buildArgs("../req.json", { outputPath: "/tmp/o.json", cwd: "/tmp/work" })).toThrow(TypeError);
    expect(() => buildArgs("/tmp/req.json", { outputPath: "../o.json", cwd: "/tmp/work" })).toThrow(TypeError);
  });

  test("resolves contained relative paths against the job cwd", () => {
    const argv = buildArgs("jev/req.json", { outputPath: "jev/out.json", cwd: "/tmp/work" });
    expect(argv.slice(-2)).toEqual(["/tmp/work/jev/req.json", "/tmp/work/jev/out.json"]);
  });
});

describe("jev parseResult", () => {
  test("done with the results path as the artifact and the counts in the summary", () => {
    const res = parseResult(okStdout(jsonPath), "", 0);
    expect(res.status).toBe("done");
    expect(res.artifacts).toEqual([jsonPath]);
    expect(res.summary).toContain("items=2 ok=2 failed=0");
  });

  test("missing result marker fails even on exit 0", () => {
    const res = parseResult("SDD_JEV_SUMMARY:items=1 ok=1 failed=0 cost_usd=0\n", "", 0);
    expect(res.status).toBe("failed");
    expect(res.artifacts).toEqual([]);
  });

  test("a marker naming a file that does not exist fails", () => {
    const res = parseResult(okStdout(join(dir, "nope.json")), "", 0);
    expect(res.status).toBe("failed");
  });

  test("the LAST result marker wins over an earlier one", () => {
    const stdout = `SDD_JEV_RESULT:${join(dir, "nope.json")}\n${okStdout(jsonPath)}`;
    const res = parseResult(stdout, "", 0);
    expect(res.status).toBe("done");
    expect(res.artifacts).toEqual([jsonPath]);
  });

  test("non-zero exit surfaces the script's own error line, e.g. a missing key", () => {
    const stderr =
      "jev-evaluate: AI_GATEWAY_API_KEY is not set in the environment the sdd server was started from\n";
    const res = parseResult("", stderr, 1);
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("exited with code 1");
    expect(res.summary).toContain("AI_GATEWAY_API_KEY is not set");
  });

  test("non-zero exit fails even when the markers were printed (every item failed)", () => {
    const stderr = "jev-evaluate: every item failed; first error: HTTP 401: unauthorized\n";
    const res = parseResult(okStdout(jsonPath), stderr, 1);
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("every item failed");
  });

  test("non-zero exit with empty stderr still fails cleanly", () => {
    const res = parseResult("", "", 2);
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("(no stderr output)");
  });
});
