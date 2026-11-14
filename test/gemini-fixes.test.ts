/**
 * Regression tests for the gemini scripts' budget, usage-accounting, fail-fast
 * and request-shape behavior. The scripts run for real under bun with `fetch`
 * replaced by a scripted mock (`bun --preload`), a hermetic ledger and config,
 * and a fake key; nothing here touches the network or the user's real ledger.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as decide from "../src/adapters/_gemini-decide.ts";
import * as vision from "../src/adapters/_gemini-vision.ts";

let dir: string;
let mock: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sdd-gemini-fixes-"));
  mock = join(dir, "mock-fetch.ts");
  writeFileSync(
    mock,
    `let n = 0;
const mode = process.env.MOCK_MODE;
const capture = process.env.CAPTURE;
globalThis.fetch = (async (_url, init) => {
  n++;
  if (capture) await Bun.write(capture, init.body);
  const ok = (usage, model = "gemini-decision-1") =>
    new Response(JSON.stringify({ model, answers: { q: { type: "noul", noul: 0.9, confidence: 0.9 } }, usage }));
  if (mode === "timeout") throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
  if (mode === "first400media" && n === 1) return new Response(JSON.stringify({ error: { message: "Unable to process input image" } }), { status: 400 });
  if (mode === "first401" && n === 1) return new Response("denied", { status: 401 });
  if (mode === "badbody" && n === 1) {
    return new Response(new ReadableStream({ start(c) { c.error(new Error("boom")); } }), { status: 200 });
  }
  if (mode === "nullbody") return new Response("null", { status: 200 });
  if (mode === "mixed") return ok(n === 2 ? {} : { total_input_tokens: 1000000 });
  if (mode === "nousage") return ok({});
  if (mode === "respmodel") return ok({ total_input_tokens: 1000000 }, "some-other-model");
  return ok({ total_input_tokens: 1000000 });
}) as typeof fetch;
`,
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function spawn(argv: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, GEMINI_API_KEY: "fake-key", SDD_LEDGER_PATH: join(dir, "no-ledger.jsonl"), XDG_CONFIG_HOME: join(dir, "no-config"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

let seq = 0;
/** Run gemini-decide with the mock fetch. */
async function run(request: object, mode: string, env: Record<string, string> = {}) {
  const id = ++seq;
  const reqPath = join(dir, `req-${id}.json`);
  const outPath = join(dir, `out-${id}.json`);
  writeFileSync(reqPath, JSON.stringify(request));
  const argv = decide.buildArgs(reqPath, { outputPath: outPath });
  argv.splice(argv.indexOf("run") + 1, 0, "--preload", mock);
  const r = await spawn(argv, { MOCK_MODE: mode, ...env });
  return { ...r, usage: decide.parseUsage(r.stdout), results: () => JSON.parse(readFileSync(outPath, "utf8")) };
}

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, input: "t" }));
const noul = { q: { type: "noul", instructions: "x" } };

/** A budget file (written with the harness's own Write path, never a shell) and a ledger. */
function config(name: string, gemini: object): string {
  const cfg = join(dir, name);
  mkdirSync(join(cfg, "sdd"), { recursive: true });
  writeFileSync(join(cfg, "sdd", "budget.json"), JSON.stringify({ gemini }));
  return cfg;
}
function ledgerWith(name: string, costs: number[]): string {
  const path = join(dir, name);
  writeFileSync(path, costs.map((c) => JSON.stringify({ v: 1, ts: Date.now() - 1000, adapter: "gemini", usage: { calls: 1, costUsd: c } })).join("\n") + "\n");
  return path;
}

describe("budget clamp (finding 2)", () => {
  test("the per-job cap is clamped to the remaining daily budget, and the stop message says so", async () => {
    // $4.90 already spent of $5 daily: $0.10 left. Each call is $0.10, so one call exhausts it
    // even though the request's own maxCostUsd (default 1) would allow ten.
    const r = await run({ questions: noul, items: items(10), concurrency: 1 }, "ok", { SDD_LEDGER_PATH: ledgerWith("l-clamp.jsonl", [4.9]) });
    expect(r.code).toBe(0);
    const res = r.results();
    expect(res.stopped).toBe("budget");
    expect(res.ok).toBe(1);
    expect(res.results[1].error).toContain("daily remaining $0.1000");
    expect(res.results[1].error).toContain("monthly remaining");
    expect(r.stdout).toContain("stopped=budget");
  });

  test("the monthly remainder clamps too", async () => {
    const r = await run({ questions: noul, items: items(10), concurrency: 1 }, "ok", {
      SDD_LEDGER_PATH: ledgerWith("l-month.jsonl", [0.75]),
      XDG_CONFIG_HOME: config("cfg-month-clamp", { dailyUsd: 100, monthlyUsd: 1 }),
    });
    expect(r.results().ok).toBe(3); // $0.25 left: the third $0.10 call crosses it
    expect(r.results().stopped).toBe("budget");
  });

  test("unknown-cost calls count $0.25 each toward the running cap, so a job without usage is still capped", async () => {
    const r = await run({ questions: noul, items: items(10), concurrency: 1, maxCostUsd: 0.4 }, "nousage");
    const res = r.results();
    expect(res.stopped).toBe("budget");
    expect(res.ok).toBe(2); // 0.25 < 0.4, then 0.50 >= 0.4
    expect(r.usage).toMatchObject({ calls: 2, costUsd: 0.5 });
  });

  test("timed-out calls count as unknown-cost calls and stop the retries at the cap", async () => {
    const r = await run({ questions: noul, items: items(1), concurrency: 1, maxCostUsd: 0.2 }, "timeout");
    expect(r.usage?.calls).toBe(1); // the retry loop stopped before a second possibly-billed call
    expect(r.usage?.costUsd).toBe(0.25);
    expect(r.results().results[0].error).toContain("stopped retrying: cost cap reached");
  });
});

describe("spend windows match the server's (finding 10)", () => {
  test("a future-dated line and a line just past 24h do not count toward the daily limit", async () => {
    const path = join(dir, "l-window.jsonl");
    const row = (ts: number) => JSON.stringify({ v: 1, ts, adapter: "gemini", usage: { calls: 1, costUsd: 99 } });
    // Both are in the current calendar month at test time only by luck, so pin the month limit high.
    writeFileSync(path, `${row(Date.now() + 3_600_000)}\n${row(Date.now() - 86_400_000 - 1000)}\n`);
    const r = await run({ questions: noul, items: items(1) }, "ok", {
      SDD_LEDGER_PATH: path,
      XDG_CONFIG_HOME: config("cfg-window", { dailyUsd: 5, monthlyUsd: 100_000 }),
    });
    expect(r.code).toBe(0);
    expect(r.results().ok).toBe(1);
  });
});

describe("usage accounting (findings 4, 5)", () => {
  test("one usage-less reply adds a flat charge to the known cost instead of nulling the job", async () => {
    const r = await run({ questions: noul, items: items(3), concurrency: 1 }, "mixed");
    expect(r.usage?.calls).toBe(3);
    expect(r.usage?.costUsd).toBeCloseTo(0.1 + 0.25 + 0.1, 6);
    expect(r.usage?.costUsd).not.toBeNull();
    expect(r.usage?.costIsEstimate).toBe(true);
    expect(r.usage?.unknownCalls).toBe(1); // the fallback-priced call is flagged, not passed off as known cost
  });

  test("the job is priced by the REQUESTED model, not by the model the reply names", async () => {
    const r = await run({ questions: noul, items: items(1) }, "respmodel");
    expect(r.usage?.model).toBe("gemini-decision-1");
    expect(r.usage?.costUsd).toBeCloseTo(0.1, 6); // not unknown/charged
    expect(r.results().model).toBe("some-other-model"); // the reply's model is still reported
    expect(r.results().requestedModel).toBe("gemini-decision-1");
  });

  test("a response body that cannot be read becomes that item's error, charged as unknown, and the batch continues", async () => {
    const r = await run({ questions: noul, items: items(2), concurrency: 1 }, "badbody");
    expect(r.code).toBe(0);
    const res = r.results();
    expect(res.ok).toBe(1);
    expect(res.results[0].error).toContain("could not read the response body");
    expect(r.usage?.calls).toBe(2);
    expect(r.usage?.costUsd).toBeCloseTo(0.25 + 0.1, 6);
  });
});

describe("fail-fast scope (finding 6)", () => {
  test("a first-item 400 about that item's own media does not abort the batch", async () => {
    const r = await run({ questions: noul, items: items(3), concurrency: 1 }, "first400media");
    expect(r.code).toBe(0);
    const res = r.results();
    expect(res.stopped).toBeUndefined();
    expect(res.ok).toBe(2);
    expect(res.results[0].error).toContain("HTTP 400");
  });

  test("a first-item 401 still aborts", async () => {
    const r = await run({ questions: noul, items: items(3), concurrency: 1 }, "first401");
    expect(r.results().stopped).toBe("fatal");
    expect(r.results().results[1].error).toStartWith("skipped:");
  });
});

describe("decide request-path check (finding 7)", () => {
  const opts = { cwd: "/tmp" };
  test("an extensionless path is a request path", () => {
    expect(decide.buildArgs("/tmp/req", opts)).toContain("/tmp/req");
    expect(decide.buildArgs("req", opts)).toContain("/tmp/req");
  });
  test("inline JSON still works and a .json path with spaces in its directory is accepted", () => {
    expect(decide.buildArgs('{"questions":{},"items":[]}', opts)).toContain("--inline");
    expect(decide.buildArgs("/Users/me/My Docs/req.json", opts)).toContain("/Users/me/My Docs/req.json");
  });
  test("natural language is rejected with the request shape", () => {
    for (const q of ["Is this video funny?", "which of these is best\nand why", "rank these by quality.json please"]) {
      expect(() => decide.buildArgs(q, opts)).toThrow(/must be a request, not a question/);
    }
    expect(() => decide.buildArgs("Is this a cat?", opts)).toThrow(/"questions"/);
  });
});

describe("question shapes (finding 12)", () => {
  /** The `questions` object actually sent to the API for one question. */
  async function sent(question: object): Promise<Record<string, any>> {
    const capture = join(dir, `capture-${++seq}.json`);
    const r = await run({ questions: { q: question }, items: items(1) }, "ok", { CAPTURE: capture });
    expect(r.code).toBe(0);
    return JSON.parse(readFileSync(capture, "utf8")).questions.q;
  }
  async function rejected(question: object): Promise<string> {
    const capture = join(dir, `nocall-${++seq}.json`);
    const r = await run({ questions: { q: question }, items: items(1) }, "ok", { CAPTURE: capture });
    expect(r.code).toBe(1);
    expect(existsSync(capture)).toBe(false); // died before ANY API call
    expect(decide.parseUsage(r.stdout)).toMatchObject({ calls: 0, costUsd: 0 });
    return r.stderr;
  }

  test("score: an object rubric becomes a string", async () => {
    const q = await sent({ type: "score", instructions: "x", criteria: { "1": "bad", "5": "great" } });
    expect(q.criteria).toBe("1: bad\n5: great");
  });
  test("score: {low, high} becomes a string", async () => {
    const q = await sent({ type: "score", instructions: "x", criteria: { low: "poor", high: "superb" } });
    expect(q.criteria).toBe("low: poor\nhigh: superb");
  });
  test("score: an array of strings or of {score, description} becomes a string; a string passes through", async () => {
    expect((await sent({ type: "score", instructions: "x", criteria: ["1 = bad", "5 = good"] })).criteria).toBe("1 = bad\n5 = good");
    expect((await sent({ type: "score", instructions: "x", criteria: [{ score: 1, description: "bad" }, { label: "5", description: "good" }] })).criteria).toBe("1: bad\n5: good");
    expect((await sent({ type: "score", instructions: "x", criteria: "1 = bad, 5 = good" })).criteria).toBe("1 = bad, 5 = good");
  });
  test("score: a number or a nested object dies and shows the correct JSON", async () => {
    for (const criteria of [5, { a: { b: 1 } }, [], ""]) {
      const err = await rejected({ type: "score", instructions: "x", criteria });
      expect(err).toContain('question "q" (score): criteria must be a non-empty string rubric');
      expect(err).toContain('"criteria": "1 = awful, 3 = fine, 5 = excellent"');
    }
  });

  test("choice: an object passes through; strings and {label, description} arrays are converted", async () => {
    expect((await sent({ type: "choice", instructions: "x", criteria: { a: "the a", b: "" } })).criteria).toEqual({ a: "the a", b: "" });
    expect((await sent({ type: "choice", instructions: "x", criteria: ["a", "b"] })).criteria).toEqual({ a: "", b: "" });
    expect((await sent({ type: "choice", instructions: "x", criteria: [{ label: "a", description: "the a" }, { label: "b" }] })).criteria).toEqual({ a: "the a", b: "" });
  });
  test("choice: a string, a missing criteria, an empty list, or a list of numbers dies with the correct JSON", async () => {
    for (const criteria of ["a, b", undefined, [], [1, 2], { a: 1 }, [{ description: "no label" }]]) {
      const err = await rejected({ type: "choice", instructions: "x", ...(criteria === undefined ? {} : { criteria }) });
      expect(err).toContain('question "q" (choice): criteria must be a non-empty object {label: description}');
      expect(err).toContain('"criteria": {"red": "a red hue", "blue": "a blue hue"}');
    }
  });

  test("noul: criteria is optional; {true_description, false_description} passes; legacy {true, false} is mapped", async () => {
    expect((await sent({ type: "noul", instructions: "x" })).criteria).toBeUndefined();
    expect((await sent({ type: "noul", instructions: "x", criteria: { true_description: "t", false_description: "f" } })).criteria).toEqual({ true_description: "t", false_description: "f" });
    const legacy = await sent({ type: "boolean", instructions: "x", criteria: { true: "t", false: "f" } });
    expect(legacy.type).toBe("noul");
    expect(legacy.criteria).toEqual({ true_description: "t", false_description: "f" });
  });
  test("noul: a string, an array, or unknown keys die with the correct JSON", async () => {
    for (const criteria of ["is it true", ["t", "f"], { yes: "t" }, { true_description: 1 }]) {
      const err = await rejected({ type: "noul", instructions: "x", criteria });
      expect(err).toContain('question "q" (noul): criteria must be an object');
      expect(err).toContain('"criteria": {"true_description": "the sky is blue", "false_description": "the sky is not blue"}');
    }
  });

  test("legacy item `state` is still read as text input and a legacy boolean answer carries `probability`", async () => {
    const r = await run({ questions: { q: { type: "boolean", instructions: "x" } }, items: [{ id: "a", state: "some text" }] }, "ok");
    expect(r.code).toBe(0);
    expect(r.results().results[0].answers.q.probability).toBe(0.9);
  });
});

describe("vision timeouts are unknown-cost calls (finding 5)", () => {
  test("a timed-out call is charged and retries stop at the clamped cap", async () => {
    const art = mkdtempSync(join(tmpdir(), "sdd-gemini-vfix-"));
    writeFileSync(join(art, "f.png"), "x");
    writeFileSync(join(art, "manifest.json"), JSON.stringify({ frames: [{ file: "f.png", tSeconds: 0 }] }));
    const argv = vision.buildArgs("describe", { addDir: art, outputPath: join(art, "fused.json") });
    argv.splice(argv.indexOf("run") + 1, 0, "--preload", mock);
    // $0.20 of daily budget left < one $0.25 unknown-cost charge, so the first timeout ends the retries.
    const r = await spawn(argv, { MOCK_MODE: "timeout", XDG_CONFIG_HOME: config("cfg-vision-cap", { vision: { dailyUsd: 0.2, monthlyUsd: 50 } }) });
    rmSync(art, { recursive: true, force: true });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stopped=budget");
    expect(r.stderr).toContain("1 timed-out call(s)");
    const usage = vision.parseUsage(r.stdout);
    expect(usage).toMatchObject({ calls: 1, costUsd: 0.25 });
  }, 20_000);
});

describe("review fixes: unreadable ledger, null body, unknown-cost flag", () => {
  test("a ledger that cannot be read (EISDIR) refuses paid calls with a zero-call usage marker", async () => {
    const asDir = join(dir, "ledger-is-a-dir");
    mkdirSync(asDir, { recursive: true });
    const r = await run({ questions: noul, items: items(1) }, "ok", { SDD_LEDGER_PATH: asDir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("budget unknown");
    expect(r.usage).toMatchObject({ calls: 0, costUsd: 0 });
  });

  test("a missing ledger (ENOENT) is still a known $0 and does not refuse", async () => {
    const r = await run({ questions: noul, items: items(1) }, "ok");
    expect(r.code).toBe(0);
  });

  test("a usage-less call is flagged unknownCalls in the usage marker", async () => {
    const r = await run({ questions: noul, items: items(2), concurrency: 1 }, "nousage");
    expect(r.usage?.unknownCalls).toBe(2);
  });

  test("vision: an HTTP 200 with JSON null is an unknown-cost call, counted and capped", async () => {
    const art = mkdtempSync(join(tmpdir(), "sdd-gemini-vnull-"));
    writeFileSync(join(art, "f.png"), "x");
    writeFileSync(join(art, "manifest.json"), JSON.stringify({ frames: [{ file: "f.png", tSeconds: 0 }] }));
    const argv = vision.buildArgs("describe", { addDir: art, outputPath: join(art, "fused.json") });
    argv.splice(argv.indexOf("run") + 1, 0, "--preload", mock);
    const r = await spawn(argv, { MOCK_MODE: "nullbody", XDG_CONFIG_HOME: config("cfg-vision-null", { vision: { dailyUsd: 0.2, monthlyUsd: 50 } }) });
    rmSync(art, { recursive: true, force: true });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stopped=budget");
    expect(vision.parseUsage(r.stdout)).toMatchObject({ calls: 1, costUsd: 0.25, unknownCalls: 1 });
  }, 20_000);
});
