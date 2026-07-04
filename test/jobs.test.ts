/**
 * Phase 2 — JobStore validation. Every DW item is exercised with a stub Adapter
 * (a plain object implementing the port) whose buildArgs runs a real short-lived
 * child — `bun -e ...`, `sleep`, or a temp writer script — so spawn/wait/cancel/
 * shutdown are proven deterministically without needing codex/agy installed.
 *
 * Test doubles intentionally violate production defensive patterns (minimal
 * adapters, direct pid inspection); that is appropriate in test code.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "../src/adapters/types.ts";
import type { AdapterMode, AdapterResult } from "../src/types.ts";
import { JobStore } from "../src/lib/jobs.ts";

const BUN = process.execPath; // the bun binary running this test

const tmpDirs: string[] = [];
const stores: JobStore[] = [];

function freshDir(prefix = "sdd-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** A JobStore whose logs land in a throwaway dir; auto-shutdown after each test. */
function newStore(opts: Partial<ConstructorParameters<typeof JobStore>[0]> = {}): JobStore {
  const store = new JobStore({ logDir: freshDir("sdd-logs-"), ...opts });
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.shutdown();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Build a stub Adapter from parts; identity injectContract unless overridden. */
function stubAdapter(parts: {
  name?: string;
  mode?: AdapterMode;
  buildArgs: Adapter["buildArgs"];
  injectContract?: Adapter["injectContract"];
  parseResult?: Adapter["parseResult"];
}): Adapter {
  return {
    name: parts.name ?? "stub",
    mode: parts.mode ?? "read",
    buildArgs: parts.buildArgs,
    injectContract: parts.injectContract ?? ((p) => p),
    parseResult:
      parts.parseResult ??
      ((stdout): AdapterResult => ({ status: "done", summary: stdout, artifacts: [], raw: stdout })),
  };
}

/** Poll until `fn()` is true or `timeoutMs` elapses. */
async function until(fn: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}

/** True while `pid` is alive (signal 0 probes existence without killing). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.1: dispatch returns synchronously; fast adapter reaches done w/ result.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_1_dispatch_returns_id_synchronously_and_reaches_done", async () => {
  const store = newStore();
  const adapter = stubAdapter({
    name: "fast",
    buildArgs: () => [BUN, "-e", "process.stdout.write('VERDICT: ok')"],
    parseResult: (stdout): AdapterResult =>
      stdout.includes("VERDICT:")
        ? { status: "done", summary: stdout, artifacts: [], raw: stdout }
        : { status: "failed", summary: "no marker", artifacts: [], raw: stdout },
  });

  const t0 = performance.now();
  const id = store.dispatch(adapter, "do the thing", {});
  const elapsed = performance.now() - t0;

  expect(typeof id).toBe("string");
  expect(elapsed).toBeLessThan(100); // returned synchronously while the child runs
  expect(store.get(id)!.state).toBe("running");

  const res = await store.wait([id], 5000);
  expect(res.done).toEqual([id]);
  expect(res.stillRunning).toEqual([]);

  const job = store.get(id)!;
  expect(job.state).toBe("done");
  expect(job.exitCode).toBe(0);
  expect(job.result).toBeDefined();
  expect(job.result!.status).toBe("done");
  expect(job.result!.summary).toContain("ok");
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.2: exit 0 but missing contract marker → failed (silent-misparse backstop).
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_2_exit_zero_without_marker_is_failed", async () => {
  const store = newStore();
  const adapter = stubAdapter({
    name: "misparse",
    // Exits 0 but never emits the required marker.
    buildArgs: () => [BUN, "-e", "process.stdout.write('did some stuff, exiting 0'); process.exit(0)"],
    parseResult: (stdout): AdapterResult =>
      stdout.includes("VERDICT:")
        ? { status: "done", summary: stdout, artifacts: [], raw: stdout }
        : { status: "failed", summary: "required marker absent", artifacts: [], raw: stdout },
  });

  const id = store.dispatch(adapter, "review this", {});
  await store.wait([id], 5000);

  const job = store.get(id)!;
  expect(job.exitCode).toBe(0); // the child genuinely succeeded...
  expect(job.state).toBe("failed"); // ...but the marker backstop failed it
  expect(job.result!.status).toBe("failed");
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.3: write-write guard (same cwd) rejects the 2nd; reads run concurrently.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_3_second_write_same_cwd_rejected", () => {
  const store = newStore();
  const cwd = freshDir("sdd-cwd-");
  const writer = stubAdapter({
    name: "writer",
    mode: "write",
    buildArgs: () => [BUN, "-e", "setInterval(()=>{}, 1e9)"], // stays running
  });

  const first = store.dispatch(writer, "write A", { cwd });
  expect(store.get(first)!.state).toBe("running");

  expect(() => store.dispatch(writer, "write B", { cwd })).toThrow(/write-write conflict/);
});

test("test_DW_2_3_writes_in_different_cwds_allowed", () => {
  const store = newStore();
  const writer = stubAdapter({
    name: "writer",
    mode: "write",
    buildArgs: () => [BUN, "-e", "setInterval(()=>{}, 1e9)"],
  });
  const a = store.dispatch(writer, "w", { cwd: freshDir("sdd-cwdA-") });
  const b = store.dispatch(writer, "w", { cwd: freshDir("sdd-cwdB-") });
  expect(store.get(a)!.state).toBe("running");
  expect(store.get(b)!.state).toBe("running");
});

test("test_DW_2_3_two_reads_run_concurrently", () => {
  const store = newStore();
  const cwd = freshDir("sdd-cwd-");
  const reader = stubAdapter({
    name: "reader",
    mode: "read",
    buildArgs: () => [BUN, "-e", "setInterval(()=>{}, 1e9)"],
  });
  const a = store.dispatch(reader, "read A", { cwd });
  const b = store.dispatch(reader, "read B", { cwd }); // same cwd, both reads → allowed
  expect(store.get(a)!.state).toBe("running");
  expect(store.get(b)!.state).toBe("running");
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.4: wait partial + bounded; cancel kills the child AND its group.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_4_wait_returns_partial_within_timeout", async () => {
  const store = newStore();
  const quick = stubAdapter({ name: "quick", buildArgs: () => [BUN, "-e", "process.exit(0)"] });
  const slow = stubAdapter({ name: "slow", buildArgs: () => [BUN, "-e", "setInterval(()=>{}, 1e9)"] });

  const q = store.dispatch(quick, "fast", {});
  const s = store.dispatch(slow, "slow", {});

  const res = await store.wait([q, s], 1500);
  expect(res.done).toContain(q);
  expect(res.stillRunning).toContain(s); // partial: the slow one is still running
});

test("test_DW_2_4_wait_never_exceeds_timeout", async () => {
  const store = newStore();
  const slow = stubAdapter({ name: "slow", buildArgs: () => [BUN, "-e", "setInterval(()=>{}, 1e9)"] });
  const id = store.dispatch(slow, "slow", {});

  const t0 = performance.now();
  const res = await store.wait([id], 250);
  const elapsed = performance.now() - t0;

  expect(res.stillRunning).toEqual([id]);
  expect(elapsed).toBeLessThan(2000); // resolved at ~250ms, nowhere near the 1e9 interval
});

test("test_DW_2_4_cancel_terminates_child_and_group", async () => {
  const store = newStore();
  const gpidFile = join(freshDir("sdd-gpid-"), "gpid.txt");
  // Child (group leader) spawns a grandchild WITHOUT detaching → same group.
  const script =
    "const {spawn}=require('child_process');const fs=require('fs');" +
    `const g=spawn('sleep',['300'],{stdio:'ignore'});` +
    `fs.writeFileSync(${JSON.stringify(gpidFile)}, String(g.pid));` +
    "setInterval(()=>{}, 1e9);";
  const adapter = stubAdapter({ name: "grouped", buildArgs: () => [BUN, "-e", script] });

  const id = store.dispatch(adapter, "spawn a group", {});
  expect(await until(() => existsSync(gpidFile))).toBe(true);
  const gpid = Number(readFileSync(gpidFile, "utf8"));
  expect(gpid).toBeGreaterThan(0);
  expect(pidAlive(gpid)).toBe(true);

  const cancelled = await store.cancel(id);
  expect(cancelled).toBe(true);
  expect(store.get(id)!.state).toBe("failed"); // signal path → failed

  // The grandchild was in the killed group → it must die too.
  expect(await until(() => !pidAlive(gpid))).toBe(true);
});

test("test_cancel_unknown_job_is_noop", async () => {
  const store = newStore();
  expect(await store.cancel("job-nope")).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.5: shutdown() and a real SIGINT reap every tracked child (no orphans).
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_5_shutdown_kills_all_tracked_children", async () => {
  const store = newStore();
  const pidFileA = join(freshDir("sdd-pid-"), "a.txt");
  const pidFileB = join(freshDir("sdd-pid-"), "b.txt");
  const mk = (file: string) =>
    stubAdapter({
      buildArgs: () => [BUN, "-e", `require('fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1e9)`],
    });

  const a = store.dispatch(mk(pidFileA), "a", {});
  const b = store.dispatch(mk(pidFileB), "b", {});
  expect(await until(() => existsSync(pidFileA) && existsSync(pidFileB))).toBe(true);
  const pidA = Number(readFileSync(pidFileA, "utf8"));
  const pidB = Number(readFileSync(pidFileB, "utf8"));
  expect(pidAlive(pidA)).toBe(true);
  expect(pidAlive(pidB)).toBe(true);

  await store.shutdown();

  // shutdown awaits reaping → the pids are gone (ESRCH), no orphans.
  expect(pidAlive(pidA)).toBe(false);
  expect(pidAlive(pidB)).toBe(false);
  expect(store.get(a)!.state).toBe("failed");
  expect(store.get(b)!.state).toBe("failed");
});

test("test_DW_2_5_sigint_to_server_reaps_children", async () => {
  // A real Bun subprocess that creates a JobStore with installSignalHandlers,
  // dispatches a long child, prints the grandchild pid, then waits. We SIGINT
  // the harness and assert the tracked child's pid is dead — proving the
  // JobStore's own SIGINT handler reaps children.
  const dir = freshDir("sdd-harness-");
  const childPidFile = join(dir, "child.txt");
  const jobsPath = join(import.meta.dir, "..", "src", "lib", "jobs.ts");

  const harness = `
import { JobStore } from ${JSON.stringify(jobsPath)};
const store = new JobStore({ installSignalHandlers: true, logDir: ${JSON.stringify(dir)} });
const sleeper = {
  name: "sleeper", mode: "read",
  buildArgs: () => [${JSON.stringify(BUN)}, "-e", "require('fs').writeFileSync(" + ${JSON.stringify(JSON.stringify(childPidFile))} + ",String(process.pid));setInterval(()=>{},1e9)"],
  injectContract: (p) => p,
  parseResult: (o) => ({ status: "done", summary: o, artifacts: [], raw: o }),
};
store.dispatch(sleeper, "x", {});
// Harness-level exit so the test can observe termination. In production the
// server (register.ts) owns process.exit; the JobStore handler only reaps.
process.on("SIGINT", () => { setTimeout(() => process.exit(0), 400); });
setInterval(() => {}, 1e9);
`;
  const harnessPath = join(dir, "harness.ts");
  writeFileSync(harnessPath, harness, "utf8");

  const proc = Bun.spawn([BUN, harnessPath], { stdout: "ignore", stderr: "ignore" });

  expect(await until(() => existsSync(childPidFile), 8000)).toBe(true);
  const childPid = Number(readFileSync(childPidFile, "utf8"));
  expect(pidAlive(childPid)).toBe(true);

  proc.kill("SIGINT");
  await proc.exited;

  // The JobStore's SIGINT handler killed the tracked child's group → it's dead.
  expect(await until(() => !pidAlive(childPid), 8000)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-2.6: prompt reaches the child via argv, shell metacharacters stay literal.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_2_6_metacharacters_passed_literally", async () => {
  const store = newStore();
  const outFile = join(freshDir("sdd-argv-"), "argv.txt");
  // A writer that records argv[3] (the prompt) verbatim. argv[2] is the outfile.
  const writer = join(freshDir("sdd-writer-"), "writer.ts");
  writeFileSync(writer, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], process.argv[3] ?? "");\n`, "utf8");

  const HOSTILE = "hello; rm -rf $HOME && `touch /tmp/pwned` | cat";
  const adapter = stubAdapter({
    name: "argv-echo",
    buildArgs: (prompt) => [BUN, writer, outFile, prompt], // prompt is a discrete argv element
  });

  const id = store.dispatch(adapter, HOSTILE, {});
  await store.wait([id], 5000);

  const received = readFileSync(outFile, "utf8");
  expect(received).toBe(HOSTILE); // byte-for-byte — no shell touched it
  expect(existsSync("/tmp/pwned")).toBe(false); // the backtick command never ran
});

test("test_DW_2_6_buildArgs_nonarray_rejected", () => {
  const store = newStore();
  // A malformed adapter that (violating the type) returns a shell string.
  const bad = stubAdapter({
    name: "bad",
    buildArgs: (() => "echo hi; rm -rf /") as unknown as Adapter["buildArgs"],
  });
  expect(() => store.dispatch(bad, "x", {})).toThrow(/argv array|only strings/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Beyond the DW floor — boundary + error paths surfaced by the implementation.
// ─────────────────────────────────────────────────────────────────────────────
test("test_wait_on_unknown_jobid_is_reported_not_thrown", async () => {
  const store = newStore();
  const res = await store.wait(["job-does-not-exist"], 100);
  expect(res.unknown).toEqual(["job-does-not-exist"]);
  expect(res.done).toEqual([]);
  expect(res.stillRunning).toEqual([]);
});

test("test_get_unknown_jobid_returns_undefined", () => {
  const store = newStore();
  expect(store.get("job-nope")).toBeUndefined();
});

test("test_dispatch_bad_cwd_fails_fast", () => {
  const store = newStore();
  const adapter = stubAdapter({ buildArgs: () => [BUN, "-e", "0"] });
  const missing = join(tmpdir(), "sdd-no-such-dir-" + Math.random().toString(36).slice(2));
  expect(() => store.dispatch(adapter, "x", { cwd: missing })).toThrow(/cwd does not exist/);
});

test("test_dispatch_unwritable_log_fails_fast", () => {
  // Point logDir *under* a regular file → mkdir throws ENOTDIR (uid-independent).
  const fileAsDir = join(freshDir("sdd-ro-"), "not-a-dir");
  writeFileSync(fileAsDir, "x", "utf8");
  const store = new JobStore({ logDir: join(fileAsDir, "sub") });
  stores.push(store);
  const adapter = stubAdapter({ buildArgs: () => [BUN, "-e", "0"] });
  expect(() => store.dispatch(adapter, "x", {})).toThrow(/cannot create log directory|cannot open log file/);
});

test("test_parseResult_that_throws_is_contained_as_failed", async () => {
  const store = newStore();
  const adapter = stubAdapter({
    name: "thrower",
    buildArgs: () => [BUN, "-e", "process.exit(0)"],
    parseResult: (): AdapterResult => {
      throw new Error("boom in parser");
    },
  });
  const id = store.dispatch(adapter, "x", {});
  await store.wait([id], 5000);
  const job = store.get(id)!;
  expect(job.state).toBe("failed");
  expect(job.result!.summary).toContain("parseResult threw");
});

test("test_spawn_error_bad_command_is_failed", async () => {
  const store = newStore();
  const adapter = stubAdapter({
    name: "enoent",
    buildArgs: () => ["this-binary-does-not-exist-sdd", "arg"],
  });
  const id = store.dispatch(adapter, "x", {});
  await store.wait([id], 5000);
  expect(store.get(id)!.state).toBe("failed");
});

test("test_killed_by_signal_notes_the_signal", async () => {
  const store = newStore();
  const adapter = stubAdapter({ name: "sig", buildArgs: () => [BUN, "-e", "setInterval(()=>{},1e9)"] });
  const id = store.dispatch(adapter, "x", {});
  await store.cancel(id);
  const job = store.get(id)!;
  expect(job.state).toBe("failed");
  expect(job.result!.summary).toMatch(/signal/i);
});

test("test_wait_timeout_is_clamped_to_cap", async () => {
  const store = new JobStore({ logDir: freshDir("sdd-logs-"), maxTimeoutMs: 200 });
  stores.push(store);
  const slow = stubAdapter({ name: "slow", buildArgs: () => [BUN, "-e", "setInterval(()=>{},1e9)"] });
  const id = store.dispatch(slow, "x", {});
  const t0 = performance.now();
  const res = await store.wait([id], 10_000_000); // asks for way over the cap
  const elapsed = performance.now() - t0;
  expect(res.stillRunning).toEqual([id]);
  expect(elapsed).toBeLessThan(2000); // clamped to the 200ms cap, not 10M ms
});

test("test_shutdown_is_idempotent", async () => {
  const store = newStore();
  await store.shutdown();
  await store.shutdown(); // second call must not throw
  expect(true).toBe(true);
});

test("test_opts_mode_overrides_adapter_mode_for_guard", () => {
  const store = newStore();
  const cwd = freshDir("sdd-cwd-");
  // Adapter declares read, but the dispatch opts force write → guard applies.
  const readAdapter = stubAdapter({ name: "r", mode: "read", buildArgs: () => [BUN, "-e", "setInterval(()=>{},1e9)"] });
  const first = store.dispatch(readAdapter, "w1", { cwd, mode: "write" });
  expect(store.get(first)!.mode).toBe("write");
  expect(() => store.dispatch(readAdapter, "w2", { cwd, mode: "write" })).toThrow(/write-write conflict/);
});
