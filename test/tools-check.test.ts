/**
 * check_adapter — the liveness + auth health-check tool. Fixture adapters are
 * written as real files to a fresh temp adapters dir per test (same technique as
 * tools.test.ts), spawning real short-lived `bun -e ...` children so the probe
 * exercises the real dispatch path — deterministic, no codex/agy dependency.
 *
 * PRESENCE vs PROBE: `binaryPresent` checks the adapter's `binary`/`name` on
 * PATH via `Bun.which`, which is independent of the probe spawn (argv[0] = BUN).
 * A fixture that wants binaryPresent:true therefore sets `binary = "sh"` (always
 * on PATH), while its buildArgs still spawns the real BUN child.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckTool } from "../src/tools/check.ts";
import { createRuntime, type Runtime } from "../src/tools/runtime.ts";
import type { ToolResult } from "../src/tools/shared.ts";

const BUN = process.execPath;

const tmpDirs: string[] = [];
const runtimes: Runtime[] = [];

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function writeAdapterFile(dir: string, fileName: string, body: string): void {
  writeFileSync(join(dir, fileName), body, "utf8");
}

function newRuntime(adaptersDir?: string): Runtime {
  const rt = createRuntime({
    adaptersDir: adaptersDir ?? freshDir("sdd-check-adapters-"),
    jobStoreOptions: { logDir: freshDir("sdd-check-logs-") },
  });
  runtimes.push(rt);
  return rt;
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.jobStore.shutdown();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(fn: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}

function structured(result: ToolResult): Record<string, unknown> {
  return result.structuredContent ?? {};
}

// binary "sh" -> binaryPresent true; buildArgs spawns a BUN child that prints the
// contract marker and exits 0; parseResult classifies it done.
const PROBE_OK_ADAPTER = `
export const name = "probe-ok";
export const binary = "sh";
export const mode = "read";
export function injectContract(prompt) { return prompt; }
export function buildArgs(prompt, opts) {
  return [${JSON.stringify(BUN)}, "-e", "process.stdout.write('PROBE_OK: operational')"];
}
export function parseResult(stdout, stderr, exitCode) {
  return stdout.includes("PROBE_OK:")
    ? { status: "done", summary: stdout, artifacts: [], raw: stdout }
    : { status: "failed", summary: "marker missing", artifacts: [], raw: stdout };
}
`;

// A WRITE-mode adapter whose probe completes — used to prove that write-capable
// adapters get isolated into a throwaway temp cwd (agy-shaped isolation).
const PROBE_OK_WRITE_ADAPTER = PROBE_OK_ADAPTER.replace('name = "probe-ok"', 'name = "probe-write"').replace(
  'mode = "read"',
  'mode = "write"',
);

// Writes an auth-like error to STDERR (which lands in the job log, NOT result.raw)
// and exits 1; parseResult classifies it failed with a generic summary. The detail
// builder must surface the stderr text by tailing the log.
const PROBE_FAIL_ADAPTER = `
export const name = "probe-fail";
export const binary = "sh";
export const mode = "read";
export function injectContract(prompt) { return prompt; }
export function buildArgs(prompt, opts) {
  return [${JSON.stringify(BUN)}, "-e", "process.stderr.write('Error: not logged in (401)'); process.exit(1)"];
}
export function parseResult(stdout, stderr, exitCode) {
  // Build raw from STDOUT only (house convention) — stderr never reaches result.raw.
  return { status: "failed", summary: "probe exited non-zero", artifacts: [], raw: stdout };
}
`;

// binary guaranteed absent from PATH -> status missing, no probe.
const PROBE_MISSING_ADAPTER = `
export const name = "probe-missing";
export const binary = "sdd-definitely-not-installed-xyz";
export const mode = "read";
export function injectContract(prompt) { return prompt; }
export function buildArgs(prompt, opts) { return [${JSON.stringify(BUN)}, "-e", "process.exit(0)"]; }
export function parseResult(stdout, stderr, exitCode) {
  return { status: "done", summary: stdout, artifacts: [], raw: stdout };
}
`;

// binary present but opts out of probing -> status present_unverified, no probe.
const PROBE_OPTOUT_ADAPTER = `
export const name = "probe-optout";
export const binary = "sh";
export const probeable = false;
export const mode = "read";
export function injectContract(prompt) { return prompt; }
export function buildArgs(prompt, opts) { return [${JSON.stringify(BUN)}, "-e", "process.exit(0)"]; }
export function parseResult(stdout, stderr, exitCode) {
  return { status: "done", summary: stdout, artifacts: [], raw: stdout };
}
`;

// Never exits on its own -> forces the timeout branch.
const PROBE_HANG_ADAPTER = `
export const name = "probe-hang";
export const binary = "sh";
export const mode = "read";
export function injectContract(prompt) { return prompt; }
export function buildArgs(prompt, opts) { return [${JSON.stringify(BUN)}, "-e", "setInterval(()=>{}, 1e9)"]; }
export function parseResult(stdout, stderr, exitCode) {
  return { status: "done", summary: stdout, artifacts: [], raw: stdout };
}
`;

// binary present + probeable, but buildArgs throws synchronously at dispatch
// time -> the probe never spawns; the tool reports a probe_dispatch_failed error.
const PROBE_DISPATCH_THROW_ADAPTER = `
export const name = "probe-throw";
export const binary = "sh";
export const mode = "read";
export function injectContract(prompt) { return prompt; }
export function buildArgs(prompt, opts) { throw new Error("boom building argv"); }
export function parseResult(stdout, stderr, exitCode) {
  return { status: "done", summary: stdout, artifacts: [], raw: stdout };
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// ok: a present, probeable adapter whose live probe completes -> status ok.
// ─────────────────────────────────────────────────────────────────────────────
test("check_adapter reports status ok when the live probe completes", async () => {
  const dir = freshDir("sdd-check-adapters-");
  writeAdapterFile(dir, "probe-ok.ts", PROBE_OK_ADAPTER);
  const rt = newRuntime(dir);
  const check = createCheckTool(rt);

  const res = await check.handler({ adapter: "probe-ok", timeoutMs: 5000 });

  expect(res.isError).toBeUndefined();
  const payload = structured(res);
  expect(payload.status).toBe("ok");
  expect(payload.binaryPresent).toBe(true);
  expect(payload.adapter).toBe("probe-ok");
  expect(typeof payload.jobId).toBe("string");
});

// ─────────────────────────────────────────────────────────────────────────────
// failed: probe exits non-zero; the auth error on STDERR is surfaced via the log
// tail (proving the detail path, since result.raw would NOT contain stderr).
// ─────────────────────────────────────────────────────────────────────────────
test("check_adapter reports status failed and surfaces the stderr auth error in detail", async () => {
  const dir = freshDir("sdd-check-adapters-");
  writeAdapterFile(dir, "probe-fail.ts", PROBE_FAIL_ADAPTER);
  const rt = newRuntime(dir);
  const check = createCheckTool(rt);

  const res = await check.handler({ adapter: "probe-fail", timeoutMs: 5000 });

  expect(res.isError).toBeUndefined();
  const payload = structured(res);
  expect(payload.status).toBe("failed");
  expect(payload.binaryPresent).toBe(true);
  // The stderr text is not in result.raw (stdout-only); only the log tail carries it.
  expect(payload.detail).toContain("not logged in (401)");
});

// ─────────────────────────────────────────────────────────────────────────────
// missing: binary not on PATH -> status missing, and NO job is dispatched.
// ─────────────────────────────────────────────────────────────────────────────
test("check_adapter reports status missing without dispatching a probe when the binary is absent", async () => {
  const dir = freshDir("sdd-check-adapters-");
  writeAdapterFile(dir, "probe-missing.ts", PROBE_MISSING_ADAPTER);
  const rt = newRuntime(dir);
  const dispatchSpy = spyOn(rt.jobStore, "dispatch");
  const check = createCheckTool(rt);

  const res = await check.handler({ adapter: "probe-missing" });

  const payload = structured(res);
  expect(payload.status).toBe("missing");
  expect(payload.binaryPresent).toBe(false);
  expect(dispatchSpy).not.toHaveBeenCalled();
});

// ─────────────────────────────────────────────────────────────────────────────
// present_unverified: probeable:false -> reports presence only, NO probe.
// ─────────────────────────────────────────────────────────────────────────────
test("check_adapter reports status present_unverified without a probe when the adapter opts out", async () => {
  const dir = freshDir("sdd-check-adapters-");
  writeAdapterFile(dir, "probe-optout.ts", PROBE_OPTOUT_ADAPTER);
  const rt = newRuntime(dir);
  const dispatchSpy = spyOn(rt.jobStore, "dispatch");
  const check = createCheckTool(rt);

  const res = await check.handler({ adapter: "probe-optout" });

  const payload = structured(res);
  expect(payload.status).toBe("present_unverified");
  expect(payload.binaryPresent).toBe(true);
  expect(dispatchSpy).not.toHaveBeenCalled();
});

// ─────────────────────────────────────────────────────────────────────────────
// timeout: probe never exits within the tiny timeout -> status timeout, and the
// job is cancelled (driven terminal), not left running.
// ─────────────────────────────────────────────────────────────────────────────
test("check_adapter reports status timeout and cancels a probe that never finishes", async () => {
  const dir = freshDir("sdd-check-adapters-");
  writeAdapterFile(dir, "probe-hang.ts", PROBE_HANG_ADAPTER);
  const rt = newRuntime(dir);
  const check = createCheckTool(rt);

  const res = await check.handler({ adapter: "probe-hang", timeoutMs: 300 });

  const payload = structured(res);
  expect(payload.status).toBe("timeout");
  expect(payload.binaryPresent).toBe(true);
  const jobId = payload.jobId as string;
  expect(await until(() => rt.jobStore.get(jobId)?.state !== "running")).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// dispatch-throw: buildArgs throws synchronously -> probe_dispatch_failed error.
// ─────────────────────────────────────────────────────────────────────────────
test("check_adapter returns a probe_dispatch_failed error when the probe dispatch throws synchronously", async () => {
  const dir = freshDir("sdd-check-adapters-");
  writeAdapterFile(dir, "probe-throw.ts", PROBE_DISPATCH_THROW_ADAPTER);
  const rt = newRuntime(dir);
  const check = createCheckTool(rt);

  const res = await check.handler({ adapter: "probe-throw" });

  expect(res.isError).toBe(true);
  const payload = structured(res);
  expect(payload.code).toBe("probe_dispatch_failed");
  expect(payload.status).toBe("failed");
  expect(payload.binaryPresent).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// isolation (WRITE adapter): with no caller cwd, a write-capable adapter's probe
// runs in a throwaway temp dir under tmpdir(), never the process cwd — a
// structural guard (agy ignores opts.mode) independent of prompt compliance.
// ─────────────────────────────────────────────────────────────────────────────
test("check_adapter isolates a write-mode probe in a disposable temp cwd, not the process cwd", async () => {
  const dir = freshDir("sdd-check-adapters-");
  writeAdapterFile(dir, "probe-write.ts", PROBE_OK_WRITE_ADAPTER);
  const rt = newRuntime(dir);
  const check = createCheckTool(rt);

  const res = await check.handler({ adapter: "probe-write", timeoutMs: 5000 });

  const jobId = structured(res).jobId as string;
  const jobCwd = rt.jobStore.get(jobId)?.cwd;
  expect(jobCwd).toBeDefined();
  expect(jobCwd).not.toBe(process.cwd()); // NOT the user's tree
  expect(jobCwd!.startsWith(tmpdir())).toBe(true); // a throwaway temp dir
});

// ─────────────────────────────────────────────────────────────────────────────
// isolation (READ adapter): read-mode adapters cannot write during a probe and
// some (codex) REQUIRE a git/trusted cwd — so they run in the server's real cwd,
// NOT a bare temp dir (which would make codex falsely report `failed`).
// ─────────────────────────────────────────────────────────────────────────────
test("check_adapter runs a read-mode probe in the process cwd, not a temp dir, when no cwd is given", async () => {
  const dir = freshDir("sdd-check-adapters-");
  writeAdapterFile(dir, "probe-ok.ts", PROBE_OK_ADAPTER);
  const rt = newRuntime(dir);
  const check = createCheckTool(rt);

  const res = await check.handler({ adapter: "probe-ok", timeoutMs: 5000 });

  const jobId = structured(res).jobId as string;
  const jobCwd = rt.jobStore.get(jobId)?.cwd;
  expect(jobCwd).toBe(process.cwd()); // read adapters run in the real cwd
});

// ─────────────────────────────────────────────────────────────────────────────
// unknown adapter: clean error, message names the adapter, no job dispatched.
// ─────────────────────────────────────────────────────────────────────────────
test("check_adapter returns a clean error for an unknown adapter and dispatches nothing", async () => {
  const rt = newRuntime();
  const dispatchSpy = spyOn(rt.jobStore, "dispatch");
  const check = createCheckTool(rt);

  const res = await check.handler({ adapter: "does-not-exist" });

  expect(res.isError).toBe(true);
  expect(res.content[0]!.text).toContain("does-not-exist");
  expect(dispatchSpy).not.toHaveBeenCalled();
});
