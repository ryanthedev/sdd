/**
 * gemini adapter unit tests — both kinds' parseResult driven by representative
 * stdout/stderr/exitCode triples, the buildArgs barricades, and the bundled
 * scripts' request validation (which fails before any network call, so a fake
 * key is enough).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  test("outputPath is optional: --out-auto flag, request path stays positional", () => {
    const argv = decide.buildArgs("/tmp/req.json", {});
    const runIdx = argv.indexOf("run");
    expect(argv.slice(runIdx + 2)).toEqual(["--out-auto", "/tmp/req.json"]);
  });

  test("an inline request goes through --inline, flags before positionals", () => {
    const req = '  {"questions":{"q":{"type":"noul","instructions":"x"}},"items":[{"id":"a","input":"t"}]}';
    const argv = decide.buildArgs(req, { outputPath: "/tmp/out.json" });
    const runIdx = argv.indexOf("run");
    expect(argv.slice(runIdx + 2)).toEqual(["--inline", req.trim(), "/tmp/out.json"]);
  });

  test("model and timeoutMs become leading flags", () => {
    const argv = decide.buildArgs("/tmp/req.json", { outputPath: "/tmp/o.json", model: "gemini-decision-1", timeoutMs: 100_000 });
    const runIdx = argv.indexOf("run");
    expect(argv.slice(runIdx + 2)).toEqual(["--model", "gemini-decision-1", "--deadline-ms", "90000", "/tmp/req.json", "/tmp/o.json"]);
    expect(() => decide.buildArgs("/tmp/req.json", { outputPath: "/tmp/o.json", model: "--evil" })).toThrow(TypeError);
    expect(() => decide.buildArgs("/tmp/req.json", { outputPath: "/tmp/o.json", model: "a b" })).toThrow(TypeError);
  });

  test("rejects a natural-language prompt, bad inline JSON, and an oversized inline request", () => {
    expect(() => decide.buildArgs("Is this video a cooking video?", { outputPath: "/tmp/o.json" })).toThrow(/must be a request/);
    expect(() => decide.buildArgs("{not json", { outputPath: "/tmp/o.json" })).toThrow(/not valid JSON/);
    const big = JSON.stringify({ questions: {}, items: [{ id: "a", input: "x".repeat(101 * 1024) }] });
    expect(() => decide.buildArgs(big, { outputPath: "/tmp/o.json" })).toThrow(/KB/);
  });

  test("rejects option-shaped, control-character, and cwd-escaping paths", () => {
    expect(() => decide.buildArgs("--help", { outputPath: "/tmp/out.json" })).toThrow(TypeError);
    expect(() => decide.buildArgs("/tmp/a\nb.json", { outputPath: "/tmp/out.json" })).toThrow(TypeError);
    expect(() => decide.buildArgs("../req.json", { outputPath: "/tmp/out.json", cwd: dir })).toThrow(/escapes/);
  });

  test("resolves a relative path inside the job cwd", () => {
    const argv = decide.buildArgs("req.json", { outputPath: "out.json", cwd: dir });
    expect(argv.slice(-2)).toEqual([join(dir, "req.json"), join(dir, "out.json")]);
    expect(decide.buildArgs("req.json", { cwd: dir }).slice(-2)).toEqual(["--out-auto", join(dir, "req.json")]);
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
    expect(r.artifacts).toEqual([]);
  });

  test("all-failed exit 1 still reports the results file it wrote, status failed", () => {
    const out = `SDD_GEMINI_SUMMARY:items=2 ok=0 failed=2 input_tokens=unknown cost_usd=unknown failed_ids=a,b first_error=HTTP 400: bad\nSDD_GEMINI_RESULT:${jsonPath}\n`;
    const r = decide.parseResult(out, "gemini-decide: every item failed; first error: HTTP 400: bad\n", 1);
    expect(r.status).toBe("failed");
    expect(r.artifacts).toEqual([jsonPath]);
    expect(r.summary).toContain("every item failed");
  });

  test("the ANSWERS headline rides in the summary", () => {
    const answers = '{"a":{"q":0.91,"c":{"choice":"x","p":0.5}},"b":{"error":"HTTP 400"}}';
    const r = decide.parseResult(`${ok(jsonPath)}SDD_GEMINI_ANSWERS:${answers}\nSDD_GEMINI_RESULT:${jsonPath}\n`, "", 0);
    expect(r.status).toBe("done");
    expect(r.summary).toContain(`answers=${answers}`);
  });
});

describe("parseUsage (usage marker, last wins)", () => {
  const rec = (calls: number, cost: number | null) =>
    `SDD_GEMINI_USAGE:${JSON.stringify({ model: "gemini-decision-1", calls, items: 3, ok: calls, failed: 0, inputTokens: calls * 100, outputTokens: 0, costUsd: cost, costIsEstimate: true })}\n`;

  test("both kinds parse the cumulative marker; the last line wins", () => {
    const out = `${rec(1, 0.00001)}noise\n${rec(3, 0.00003)}`;
    for (const cap of Object.values(gemini.capabilities)) {
      const u = cap.parseUsage?.(out, "");
      expect(u?.calls).toBe(3);
      expect(u?.costUsd).toBe(0.00003);
    }
    expect(decide.parseUsage(rec(2, null))?.costUsd).toBeNull();
  });

  test("no marker or a torn one is null", () => {
    expect(decide.parseUsage("SDD_GEMINI_SUMMARY:items=1\n")).toBeNull();
    expect(vision.parseUsage('SDD_GEMINI_USAGE:{"model":"x","calls":')).toBeNull();
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

/** Spawn argv with a fake key and hermetic ledger/config locations; validation
 *  and budget errors exit before any network call. */
async function spawn(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, GEMINI_API_KEY: "fake-key-for-tests", SDD_LEDGER_PATH: join(dir, "no-ledger.jsonl"), XDG_CONFIG_HOME: join(dir, "no-config"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

async function runScript(script: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = script === "decide" ? decide.buildArgs(args[0]!, { outputPath: args[1]! }) : vision.buildArgs(args[2] ?? "x", { addDir: args[0]!, outputPath: args[1]! });
  return spawn(argv, env);
}

// Mock fetch preload: any decide run that reaches the network gets a canned answer, never the real API.
const mockBody = `globalThis.fetch = (async (url) => {
  if (String(url).includes(":generateContent")) {
    const fused = JSON.stringify({ summary: "s", moments: [] });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: fused }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }));
  }
  return new Response(JSON.stringify({ model: "gemini-decision-1", answers: { q: { type: "noul", noul: 0.9, confidence: 0.9 } }, usage: { total_input_tokens: 1000 } }));
}) as typeof fetch;\n`;

/** Run a bundled script non-dry with fetch mocked (no network). */
async function runMocked(script: "decide" | "vision", args: [string, string], env: Record<string, string> = {}) {
  const mockFetch = join(dir, "mock-fetch.ts");
  writeFileSync(mockFetch, mockBody);
  const argv = script === "decide" ? decide.buildArgs(args[0], { outputPath: args[1] }) : vision.buildArgs("x", { addDir: args[0], outputPath: args[1] });
  argv.splice(argv.indexOf("run") + 1, 0, "--preload", mockFetch);
  return spawn(argv, { GEMINI_API_KEY: "fake", ...env });
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

  test("decide rejects a media path outside the request dir and cwd, unless allowed", async () => {
    const reqDir = mkdtempSync(join(tmpdir(), "sdd-gemini-req-"));
    const outside = mkdtempSync(join(tmpdir(), "sdd-gemini-outside-"));
    writeFileSync(join(outside, "pic.png"), "x");
    const body = (extra: object) =>
      JSON.stringify({
        questions: { q: { type: "noul", instructions: "x" } },
        items: [{ id: "a", input: [{ type: "image", path: join(outside, "pic.png") }] }],
        dryRun: true,
        ...extra,
      });
    writeFileSync(join(reqDir, "req.json"), body({}));
    const denied = await runScript("decide", [join(reqDir, "req.json"), join(reqDir, "o.json")]);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("outside the request directory");
    writeFileSync(join(reqDir, "req2.json"), body({ allowOutsidePaths: true }));
    const allowed = await runScript("decide", [join(reqDir, "req2.json"), join(reqDir, "o2.json")]);
    expect(allowed.code).toBe(0);
    rmSync(reqDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("decide dryRun: stats media, estimates, calls nothing, writes a results file saying dryRun", async () => {
    const reqDir = mkdtempSync(join(tmpdir(), "sdd-gemini-dry-"));
    writeFileSync(join(reqDir, "pic.png"), "x".repeat(1000));
    writeFileSync(
      join(reqDir, "req.json"),
      JSON.stringify({
        questions: { q: { type: "noul", instructions: "x" } },
        items: [
          { id: "a", input: [{ type: "image", path: "pic.png" }] },
          { id: "b", input: "hello there" },
          { id: "c", input: [{ type: "image", path: "missing.png" }] },
        ],
        dryRun: true,
      }),
    );
    // No key at all: a dry run must not need one.
    const r = await runScript("decide", [join(reqDir, "req.json"), join(reqDir, "o.json")], { GEMINI_API_KEY: "" });
    expect(r.code).toBe(0);
    const resultPath = /^SDD_GEMINI_RESULT:(.+)$/m.exec(r.stdout)?.[1];
    expect(resultPath).toBe(join(reqDir, "o.json"));
    const res = JSON.parse(readFileSync(resultPath!, "utf8"));
    expect(res.dryRun).toBe(true);
    expect(res.items).toBe(3);
    expect(res.estimate.inputTokens).toBeGreaterThan(600);
    expect(res.problems).toHaveLength(1);
    expect(r.stdout).toContain("SDD_GEMINI_SUMMARY:dry_run=1 items=3");
    // A dry run bills nothing, but must still say so: no marker would be charged as an unknown cost.
    expect(decide.parseUsage(r.stdout)).toMatchObject({ calls: 0, costUsd: 0 });
    rmSync(reqDir, { recursive: true, force: true });
  });

  test("decide --inline with --out-auto writes a temp results file and reports it", async () => {
    const req = JSON.stringify({ questions: { q: { type: "noul", instructions: "x" } }, items: [{ id: "a", input: "t" }], dryRun: true });
    const r = await spawn(decide.buildArgs(req, {}));
    expect(r.code).toBe(0);
    const resultPath = /^SDD_GEMINI_RESULT:(.+)$/m.exec(r.stdout)?.[1];
    expect(resultPath).toBeTruthy();
    expect(JSON.parse(readFileSync(resultPath!, "utf8")).dryRun).toBe(true);
    rmSync(dirname(resultPath!), { recursive: true, force: true });
  });
});

describe("spend budget (hermetic ledger + config)", () => {
  const request = JSON.stringify({ questions: { q: { type: "noul", instructions: "x" } }, items: [{ id: "a", input: "t" }] });
  const line = (cost: number | null, ageMs: number, adapter = "gemini", kind?: string) =>
    `${JSON.stringify({ v: 1, ts: Date.now() - ageMs, adapter, ...(kind ? { kind } : {}), usage: cost === null ? null : { calls: 1, costUsd: cost } })}\n`;
  const limits = (name: string, gemini: object): string => {
    const cfg = join(dir, name);
    mkdirSync(join(cfg, "sdd"), { recursive: true });
    writeFileSync(join(cfg, "sdd", "budget.json"), JSON.stringify({ gemini }));
    return cfg;
  };

  test("refuses before any API call when the 24h spend reaches the default daily limit", async () => {
    const ledger = join(dir, "ledger-daily.jsonl");
    // $3 + $2.5 in 24h (>= $5), a torn line, another adapter's spend, and old spend that must not count.
    writeFileSync(ledger, line(3, 1000) + "{torn\n" + line(2.5, 3600_000) + line(99, 1000, "codex") + line(99, 40 * 24 * 3600_000));
    const r = await spawn(decide.buildArgs(request, {}), { SDD_LEDGER_PATH: ledger });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("budget exceeded: $5.5000 in 24h of $5 daily");
    // A refused job reports zero billed calls, so the ledger records $0, not an unknown (charged) cost.
    expect(decide.parseUsage(r.stdout)).toMatchObject({ calls: 0, costUsd: 0 });
  });

  test("unknown-cost jobs are charged conservatively (fail closed), calls:0 jobs are free", async () => {
    const ledger = join(dir, "ledger-unknown.jsonl");
    // 20 unknown-cost jobs x $0.25 = $5 >= the $5 daily default; a calls:0 job adds nothing.
    const unknown = (age: number) => `${JSON.stringify({ v: 1, ts: Date.now() - age, adapter: "gemini", usage: { calls: 1, costUsd: null } })}\n`;
    const free = `${JSON.stringify({ v: 1, ts: Date.now() - 1000, adapter: "gemini", usage: { calls: 0, costUsd: null } })}\n`;
    writeFileSync(ledger, Array.from({ length: 20 }, (_, i) => unknown(1000 + i)).join("") + free);
    const r = await spawn(decide.buildArgs(request, {}), { SDD_LEDGER_PATH: ledger });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("budget exceeded");
  });

  test("a model with no known price is refused unless the user opts in", async () => {
    const ledger = join(dir, "ledger-empty.jsonl");
    writeFileSync(ledger, "");
    const r = await spawn(decide.buildArgs(request, { model: "gemini-9-mystery" }), { SDD_LEDGER_PATH: ledger, XDG_CONFIG_HOME: limits("cfg-unpriced", {}) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("has no known price");
  });

  test("the config overrides the defaults; the monthly limit is enforced too", async () => {
    const ledger = join(dir, "ledger-month.jsonl");
    writeFileSync(ledger, line(0.6, 1000));
    const r = await spawn(decide.buildArgs(request, {}), { SDD_LEDGER_PATH: ledger, XDG_CONFIG_HOME: limits("cfg-month", { dailyUsd: 100, monthlyUsd: 0.5 }) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("this month of $0.5 monthly");
  });

  test("a missing ledger is $0 spend (a $0 limit still refuses, and the script never writes the ledger)", async () => {
    const absent = join(dir, "absent.jsonl");
    const r = await spawn(decide.buildArgs(request, {}), { SDD_LEDGER_PATH: absent, XDG_CONFIG_HOME: limits("cfg-zero", { dailyUsd: 0, monthlyUsd: 0 }) });
    expect(r.stderr).toContain("budget exceeded: $0.0000 in 24h of $0 daily");
    expect(() => readFileSync(absent)).toThrow();
  });

  test("vision refuses on budget too, after validating its inputs", async () => {
    const art = mkdtempSync(join(tmpdir(), "sdd-gemini-vart-"));
    writeFileSync(join(art, "f.png"), "x");
    writeFileSync(join(art, "manifest.json"), JSON.stringify({ frames: [{ file: "f.png", tSeconds: 0 }] }));
    const ledger = join(dir, "ledger-vision.jsonl");
    writeFileSync(ledger, line(16, 1000, "gemini", "vision"));
    const r = await runScript("vision", [art, join(art, "fused.json")], { SDD_LEDGER_PATH: ledger });
    rmSync(art, { recursive: true, force: true });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("gemini-vision: vision budget exceeded: $16.0000 in 24h of $15 daily");
  });

  // An artifact dir with no frames: a vision run that clears the budget gate dies here, before any network call.
  const emptyArt = mkdtempSync(join(tmpdir(), "sdd-gemini-empty-"));
  test("pools are independent: a vision refusal at its own limit while decision still runs, and the reverse", async () => {
    const art = mkdtempSync(join(tmpdir(), "sdd-gemini-pool-"));
    writeFileSync(join(art, "f.png"), "x");
    writeFileSync(join(art, "manifest.json"), JSON.stringify({ frames: [{ file: "f.png", tSeconds: 0 }] }));
    // $20 of vision spend blows the vision $15 limit but is invisible to the decision pool (limit $5).
    const visionHeavy = join(dir, "ledger-pool-vision.jsonl");
    writeFileSync(visionHeavy, line(20, 1000, "gemini", "vision"));
    // Non-dry, so the run passes budgetRefusal/effectiveCap and makes a (mocked) paid call.
    const d = await runMocked("decide", [JSON.stringify({ questions: { q: { type: "noul", instructions: "x" } }, items: [{ id: "a", input: "t" }] }), join(dir, "pool-d.json")], { SDD_LEDGER_PATH: visionHeavy });
    expect(d.stderr).not.toContain("budget exceeded");
    expect(d.code).toBe(0);
    expect(readFileSync(join(dir, "pool-d.json"), "utf8")).toContain("noul");
    const v = await runScript("vision", [art, join(art, "fused.json")], { SDD_LEDGER_PATH: visionHeavy });
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("vision budget exceeded");
    // $6 of decision spend (a missing kind, and kind "default") blows the decision $5 limit but vision (limit $15) is untouched.
    const decisionHeavy = join(dir, "ledger-pool-decision.jsonl");
    writeFileSync(decisionHeavy, line(3, 1000) + line(3, 2000, "gemini", "default"));
    const d2 = await runScript("decide", [JSON.stringify({ questions: { q: { type: "noul", instructions: "x" } }, items: [{ id: "a", input: "t" }] }), join(dir, "pool-d2.json")], { SDD_LEDGER_PATH: decisionHeavy });
    expect(d2.code).toBe(1);
    expect(d2.stderr).toContain("decision budget exceeded: $6.0000 in 24h of $5 daily");
    const v2 = await runMocked("vision", [art, join(art, "fused2.json")], { SDD_LEDGER_PATH: decisionHeavy });
    expect(v2.stderr).not.toContain("budget exceeded");
    expect(v2.code).toBe(0);
    expect(readFileSync(join(art, "fused2.json"), "utf8")).toContain('"summary"');
    rmSync(art, { recursive: true, force: true });
  });

  test("the vision limits come from the nested vision block, merged per field over the $15/$150 defaults", async () => {
    const art = mkdtempSync(join(tmpdir(), "sdd-gemini-vlim-"));
    writeFileSync(join(art, "f.png"), "x");
    writeFileSync(join(art, "manifest.json"), JSON.stringify({ frames: [{ file: "f.png", tSeconds: 0 }] }));
    const ledger = join(dir, "ledger-vlim.jsonl");
    writeFileSync(ledger, line(2, 1000, "gemini", "vision"));
    // Top-level decision limits are huge, vision.dailyUsd is $1: the $2 vision spend is refused.
    const a = await runScript("vision", [art, join(art, "fused.json")], { SDD_LEDGER_PATH: ledger, XDG_CONFIG_HOME: limits("cfg-vlim", { dailyUsd: 999, vision: { dailyUsd: 1 } }) });
    expect(a.stderr).toContain("vision budget exceeded: $2.0000 in 24h of $1 daily");
    // Only the decision daily is overridden: vision keeps $15, so $2 of vision spend is fine.
    const b = await runScript("vision", [emptyArt, join(emptyArt, "fused.json")], { SDD_LEDGER_PATH: ledger, GEMINI_API_KEY: "fake", XDG_CONFIG_HOME: limits("cfg-vlim2", { dailyUsd: 0 }) });
    expect(b.stderr).not.toContain("budget exceeded");
    // An invalid vision value falls back to that field's default ($15), not to the decision limit.
    const c = await runScript("vision", [emptyArt, join(emptyArt, "fused.json")], { SDD_LEDGER_PATH: ledger, GEMINI_API_KEY: "fake", XDG_CONFIG_HOME: limits("cfg-vlim3", { dailyUsd: 0, vision: { dailyUsd: -1, monthlyUsd: "x" } }) });
    expect(c.stderr).not.toContain("budget exceeded");
    rmSync(art, { recursive: true, force: true });
  });
});

/** Run gemini-decide.ts with `fetch` replaced by a scripted mock (bun --preload),
 *  so scheduling policy is testable without a network. */
describe("decide scheduling policy (mocked fetch)", () => {
  let mock: string;
  beforeAll(() => {
    mock = join(dir, "mock-fetch.ts");
    writeFileSync(
      mock,
      `let n = 0;
const mode = process.env.MOCK_MODE;
globalThis.fetch = (async () => {
  n++;
  const bad = mode === "all400" || (mode === "after1" && n > 1);
  if (bad) return new Response(JSON.stringify({ error: { message: "invalid questions.q.criteria" } }), { status: 400 });
  const usage = mode === "nousage" ? {} : { total_input_tokens: 1000000 };
  return new Response(JSON.stringify({ model: mode === "unpriced" ? undefined : "gemini-decision-1", answers: { q: { type: "noul", noul: 0.9, confidence: 0.9 } }, usage }));
}) as typeof fetch;
`,
    );
  });

  const run = async (items: number, mode: string, extra: object = {}) => {
    const reqPath = join(dir, `sched-${mode}-${items}.json`);
    const outPath = join(dir, `sched-${mode}-${items}-out.json`);
    writeFileSync(
      reqPath,
      JSON.stringify({
        questions: { q: { type: "boolean", instructions: "x" } },
        items: Array.from({ length: items }, (_, i) => ({ id: `i${i}`, input: "t" })),
        concurrency: 1,
        ...extra,
      }),
    );
    const argv = decide.buildArgs(reqPath, { outputPath: outPath });
    argv.splice(argv.indexOf("run") + 1, 0, "--preload", mock);
    const r = await spawn(argv, { MOCK_MODE: mode });
    return { ...r, outPath, results: () => JSON.parse(readFileSync(outPath, "utf8")) };
  };

  test("a 400 on the first item aborts: one call, the rest skipped, file still written, exit 1", async () => {
    const r = await run(50, "all400");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HTTP 400");
    const res = r.results();
    expect(res.stopped).toBe("fatal");
    expect(res.results).toHaveLength(50);
    expect(res.results[1].error).toStartWith("skipped:");
    const parsed = decide.parseResult(r.stdout, r.stderr, r.code);
    expect(parsed.status).toBe("failed");
    expect(parsed.artifacts).toEqual([r.outPath]);
  });

  test("5 identical non-retryable errors in a row trip the breaker", async () => {
    const r = await run(30, "after1");
    expect(r.code).toBe(0);
    const res = r.results();
    expect(res.stopped).toBe("circuit");
    expect(res.ok).toBe(1);
    expect(res.results.filter((x: { error?: string }) => x.error?.startsWith("HTTP 400")).length).toBe(5);
    expect(r.stdout).toContain("stopped=circuit");
    expect(r.stdout).toContain("failed_ids=i1,i2,i3,i4,i5");
    expect(r.stdout).toContain("first_error=HTTP 400");
  });

  test("maxCostUsd stops scheduling; the rest are skipped; usage and answers are reported", async () => {
    // Each call is 1M tokens = $0.10; the cap of $0.25 allows 3 calls.
    const r = await run(10, "ok", { maxCostUsd: 0.25 });
    expect(r.code).toBe(0);
    const res = r.results();
    expect(res.stopped).toBe("budget");
    expect(res.ok).toBe(3);
    expect(res.results[3].error).toStartWith("skipped: maxCostUsd reached (cap $0.2500 = min(request maxCostUsd $0.25");
    expect(r.stdout).toContain("stopped=budget");
    const usage = decide.parseUsage(r.stdout);
    expect(usage?.calls).toBe(3);
    expect(usage?.costUsd).toBeCloseTo(0.3, 6);
    expect(usage?.inputTokens).toBe(3_000_000);
    // Native answers gain the uniform `p`, and a legacy `boolean` question gains `probability`.
    expect(res.results[0].answers.q.p).toBe(0.9);
    expect(res.results[0].answers.q.probability).toBe(0.9);
    expect(res.results[0].costUsd).toBeCloseTo(0.1, 6);
    expect(res.questionTypes).toEqual({ q: "boolean" });
    expect(res.requestedModel).toBe("gemini-decision-1");
    expect(r.stdout).toContain('SDD_GEMINI_ANSWERS:{"i0":{"q":0.9}');
    expect(existsSync(`${r.outPath}.partial.jsonl`)).toBe(false);
  });

  test("a response without total_input_tokens is unknown tokens and unknown cost, never 0", async () => {
    const r = await run(1, "nousage");
    expect(r.code).toBe(0);
    const usage = decide.parseUsage(r.stdout);
    expect(usage?.calls).toBe(1);
    expect(usage?.inputTokens).toBeNull();
    // Tokens stay unknown, but the cost is a number: the flat unknown-call charge, so it can never read as free.
    expect(usage?.costUsd).toBe(0.25);
    expect(r.stdout).toContain("input_tokens=unknown cost_usd=0.250000");
    expect(r.results().costUsd).toBe(0.25);
    expect(r.results().results[0].costUsd).toBeNull();
  });

  test("SIGTERM flushes the usage so far, keeps the partial file, and exits 143", async () => {
    const reqPath = join(dir, "sigterm.json");
    const outPath = join(dir, "sigterm-out.json");
    writeFileSync(reqPath, JSON.stringify({ questions: { q: { type: "noul", instructions: "x" } }, items: [0, 1, 2].map((i) => ({ id: `i${i}`, input: "t" })), concurrency: 1 }));
    const slow = join(dir, "mock-slow.ts");
    writeFileSync(
      slow,
      `let n = 0;
globalThis.fetch = (async () => {
  if (++n > 1) await new Promise(() => {});
  return new Response(JSON.stringify({ model: "gemini-decision-1", answers: { q: { noul: 0.5 } }, usage: { total_input_tokens: 500 } }));
}) as typeof fetch;
`,
    );
    const argv = decide.buildArgs(reqPath, { outputPath: outPath });
    argv.splice(argv.indexOf("run") + 1, 0, "--preload", slow);
    const proc = Bun.spawn(argv, { env: { ...process.env, GEMINI_API_KEY: "k", SDD_LEDGER_PATH: join(dir, "none.jsonl"), XDG_CONFIG_HOME: join(dir, "no-config") }, stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(1500);
    proc.kill("SIGTERM");
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(code).toBe(143);
    const usage = decide.parseUsage(stdout);
    // One reply (500 tokens) plus the request still in flight, charged as an unknown-cost call.
    expect(usage?.calls).toBe(2);
    expect(usage?.inputTokens).toBeNull();
    expect(usage?.costUsd).toBeCloseTo(0.00005 + 0.25, 6);
    expect(readFileSync(`${outPath}.partial.jsonl`, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("an unpriced model reports cost unknown", async () => {
    const reqPath = join(dir, "unpriced.json");
    writeFileSync(reqPath, JSON.stringify({ questions: { q: { type: "noul", instructions: "x" } }, items: [{ id: "a", input: "t" }], model: "some-other-model" }));
    const argv = decide.buildArgs(reqPath, { outputPath: join(dir, "unpriced-out.json") });
    argv.splice(argv.indexOf("run") + 1, 0, "--preload", mock);
    const cfg = join(dir, "cfg-allow-unpriced");
    mkdirSync(join(cfg, "sdd"), { recursive: true });
    writeFileSync(join(cfg, "sdd", "budget.json"), JSON.stringify({ gemini: { allowUnpricedModels: true } }));
    const r = await spawn(argv, { MOCK_MODE: "unpriced", XDG_CONFIG_HOME: cfg });
    // An unknown cost is a number (the flat charge), never null and never 0.
    expect(decide.parseUsage(r.stdout)).toMatchObject({ calls: 1, costUsd: 0.25 });
  });
});
