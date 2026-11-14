/**
 * `src/cli/decide.ts` end to end: the CLI is spawned as a real process, so the
 * JobStore, the hermetic script spawn, the budget refusal and the ledger line
 * are all the real code. Every file the run touches lives in a temp dir via
 * the existing env overrides (set here in code, never on a command line).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "..", "src", "cli", "decide.ts");
const README = resolve(import.meta.dir, "..", "README.md");
const CONTRACT = resolve(import.meta.dir, "..", "docs", "usage-contract.md");

let dir: string;
let seq = 0;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sdd-cli-decide-")));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  ledger: string;
  env: Record<string, string>;
  lines(): { adapter: string; kind: string; state: string; usage: { calls: number } | null }[];
}

/** Fresh ledger path + fresh (empty) config dir, so the real user files are never in play. */
function sandbox(extraEnv: Record<string, string> = {}): Sandbox {
  const root = join(dir, `sb-${++seq}`);
  mkdirSync(root, { recursive: true });
  const ledger = join(root, "ledger-under-test.jsonl");
  return {
    root,
    ledger,
    env: { SDD_LEDGER_PATH: ledger, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), GEMINI_API_KEY: "fake-key", ...extraEnv },
    lines: () => (existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

function request(sb: Sandbox, body: object, name = "request.json"): string {
  const p = join(sb.root, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

const dry = { dryRun: true, questions: { q: { type: "noul", instructions: "is it?" } }, items: [{ id: "a", input: "hello" }] };
const live = { questions: { q: { type: "noul", instructions: "is it?" } }, items: [{ id: "a", input: "hello" }] };

function spawnCli(args: string[], sb: Sandbox, cwd = sb.root) {
  return Bun.spawn(["bun", "run", CLI, ...args], { cwd, env: { ...process.env, ...sb.env }, stdout: "pipe", stderr: "pipe" });
}
async function runCli(args: string[], sb: Sandbox, cwd = sb.root) {
  const proc = spawnCli(args, sb, cwd);
  const code = await proc.exited;
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

describe("DW-2.1 dry run end to end", () => {
  test("test_DW_2_1_dry_run_end_to_end: exit 0, stdout is the results path, one spend line", async () => {
    const sb = sandbox();
    const r = await runCli([request(sb, dry)], sb);
    expect(r.code).toBe(0);
    const path = r.stdout.trim();
    expect(r.stdout).toBe(`${path}\n`); // the path and nothing else
    expect(isAbsolute(path)).toBe(true);
    expect(existsSync(path)).toBe(true);
    const results = JSON.parse(readFileSync(path, "utf8"));
    expect(results).toMatchObject({ dryRun: true, items: 1 });

    const lines = sb.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ adapter: "gemini", kind: "default", state: "done", usage: { calls: 0 } });
  });

  test("an explicit results path is honored and printed absolute, even when given relative", async () => {
    const sb = sandbox();
    const req = request(sb, dry);
    const r = await runCli([req, "out/results.json"], sb);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(join(sb.root, "out", "results.json"));
    expect(existsSync(r.stdout.trim())).toBe(true);
  });

  test("a relative request path inside the cwd works", async () => {
    const sb = sandbox();
    request(sb, dry, "rel.json");
    const r = await runCli(["rel.json"], sb);
    expect(r.code).toBe(0);
    expect(existsSync(r.stdout.trim())).toBe(true);
  });

  test("--model and --timeout-ms are accepted and reach the script", async () => {
    const sb = sandbox();
    const r = await runCli(["--model", "gemini-decision-1", "--timeout-ms", "60000", request(sb, dry)], sb);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(r.stdout.trim(), "utf8")).model).toBe("gemini-decision-1");
  });
});

describe("DW-2.2 budget", () => {
  test("test_DW_2_2_over_budget: exit 1, the script's reason on stderr, no API call", async () => {
    const sb = sandbox();
    // Budget written by test code into the temp config dir; $2 already spent against a $1 daily limit.
    mkdirSync(join(sb.root, "config", "sdd"), { recursive: true });
    writeFileSync(join(sb.root, "config", "sdd", "budget.json"), JSON.stringify({ gemini: { dailyUsd: 1, monthlyUsd: 50 } }));
    writeFileSync(sb.ledger, `${JSON.stringify({ v: 1, ts: Date.now() - 1000, adapter: "gemini", kind: "default", usage: { calls: 1, costUsd: 2 } })}\n`);

    const r = await runCli([request(sb, live)], sb);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("budget exceeded");

    const lines = sb.lines();
    expect(lines).toHaveLength(2); // the seeded line plus exactly one for this job
    expect(lines[1]).toMatchObject({ adapter: "gemini", state: "failed", usage: { calls: 0 } }); // refused before any call
  });
});

describe("usage errors exit 2 and spawn nothing", () => {
  const cases: [string, (sb: Sandbox) => string[]][] = [
    ["no arguments", () => []],
    ["three positionals", (sb) => [request(sb, dry), "a.json", "b.json"]],
    ["unknown flag", (sb) => ["--bogus", request(sb, dry)]],
    ["inline JSON instead of a path", () => ['{"items":[]}']],
    ["missing request file", (sb) => [join(sb.root, "nope.json")]],
    ["request path with a leading dash", () => ["--", "-request.json"]],
    ["request path with a control character", () => ["--", "bad\u0007.json"]],
    ["relative request escaping the cwd", () => ["../outside.json"]],
    ["natural language instead of a request", () => ["--", "is this good?"]],
    ["results path with a leading dash", (sb) => ["--", request(sb, dry), "-out.json"]],
    ["non-numeric --timeout-ms", (sb) => ["--timeout-ms", "soon", request(sb, dry)]],
    ["zero --timeout-ms", (sb) => ["--timeout-ms", "0", request(sb, dry)]],
    ["bad model id", (sb) => ["--model", "Not A Model!", request(sb, dry)]],
  ];
  for (const [name, args] of cases) {
    test(name, async () => {
      const sb = sandbox();
      const r = await runCli(args(sb), sb);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("usage:");
      expect(sb.lines()).toHaveLength(0);
    });
  }
});

describe("failure paths", () => {
  test("results file not created: the script cannot write it, so the job fails with exit 1 and no stdout", async () => {
    const sb = sandbox();
    const blocker = join(sb.root, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const r = await runCli([request(sb, dry), join(blocker, "results.json")], sb);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("decide:");
    expect(sb.lines()).toHaveLength(1);
  });

  // A fetch that never answers, preloaded into the script through BUN_OPTIONS, so a job is genuinely running.
  function hangEnv(sb: Sandbox): Record<string, string> {
    const started = join(sb.root, "fetch-started");
    const preload = join(sb.root, "hang-fetch.ts");
    writeFileSync(preload, `import { writeFileSync } from "node:fs";\nglobalThis.fetch = (() => { writeFileSync(${JSON.stringify(started)}, "1"); return new Promise(() => {}); }) as typeof fetch;\n`);
    return { BUN_OPTIONS: `--preload=${preload}` };
  }
  async function untilFetchStarts(sb: Sandbox): Promise<void> {
    for (let i = 0; i < 200 && !existsSync(join(sb.root, "fetch-started")); i++) await Bun.sleep(50);
    expect(existsSync(join(sb.root, "fetch-started"))).toBe(true);
  }

  test("SIGTERM while a job runs: the job settles, the spend line is written, exit 1", async () => {
    const sb = sandbox();
    Object.assign(sb.env, hangEnv(sb));
    const proc = spawnCli([request(sb, live)], sb);
    await untilFetchStarts(sb);
    proc.kill("SIGTERM");
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).toBe(1);
    expect(stderr).toContain("cancelled by SIGTERM");
    expect(await new Response(proc.stdout).text()).toBe("");
    const lines = sb.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ adapter: "gemini", state: "failed" });
    expect(lines[0]?.usage?.calls).toBe(1); // the in-flight call is charged, not dropped
  }, 15_000);

  test("--timeout-ms cancels a stuck job, exit 1, one spend line", async () => {
    const sb = sandbox();
    Object.assign(sb.env, hangEnv(sb));
    const r = await runCli(["--timeout-ms", "1500", request(sb, live)], sb);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("timed out after 1500ms");
    expect(sb.lines()).toHaveLength(1);
  }, 15_000);
});

describe("DW-2.4 docs", () => {
  test("README and usage-contract.md describe the entry", () => {
    for (const file of [README, CONTRACT]) {
      const text = readFileSync(file, "utf8");
      expect(text).toContain("src/cli/decide.ts");
    }
    expect(readFileSync(CONTRACT, "utf8")).toMatch(/second caller|two callers|second writer/i);
  });
});
