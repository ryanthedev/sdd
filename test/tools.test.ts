/**
 * Phase 3 — the six MCP tools (dispatch/status/result/wait/cancel/list_adapters)
 * over a shared Runtime. Fixture adapters are written as real files to a fresh
 * temp adapters dir per test (same technique as adapters-discover.test.ts) so
 * `dispatch`'s `findAdapter` exercises the real directory-scan discovery path,
 * spawning real short-lived `bun -e ...` children (same technique as
 * jobs.test.ts) — deterministic, no codex/agy dependency.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import * as agy from "../src/adapters/agy.ts";
import * as grok from "../src/adapters/grok.ts";
import { createCancelTool } from "../src/tools/cancel.ts";
import { createDispatchTool, inputShape as dispatchInputShape } from "../src/tools/dispatch.ts";
import { createListAdaptersTool } from "../src/tools/list-adapters.ts";
import { createResultTool } from "../src/tools/result.ts";
import { createRuntime, type Runtime } from "../src/tools/runtime.ts";
import type { ToolResult } from "../src/tools/shared.ts";
import { createStatusTool } from "../src/tools/status.ts";
import { createWaitTool } from "../src/tools/wait.ts";

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

/** A Runtime pointed at a fresh adapters dir + fresh JobStore log dir. */
function newRuntime(adaptersDir?: string): Runtime {
  const rt = createRuntime({
    adaptersDir: adaptersDir ?? freshDir("sdd-tools-adapters-"),
    jobStoreOptions: { logDir: freshDir("sdd-tools-logs-") },
  });
  runtimes.push(rt);
  return rt;
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.jobStore.shutdown();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Poll until `fn()` is true or `timeoutMs` elapses. */
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

// A fast adapter that always emits both contract markers and exits 0.
const OK_ADAPTER = `
export const name = "ok-adapter";
export function injectContract(prompt) { return prompt; }
export function buildArgs(prompt, opts) {
  return [${JSON.stringify(BUN)}, "-e", "process.stdout.write('VERDICT: fine ## Findings None.')"];
}
export function parseResult(stdout, stderr, exitCode) {
  const ok = stdout.includes("VERDICT:") && stdout.includes("## Findings");
  return ok
    ? { status: "done", summary: stdout, artifacts: [], raw: stdout }
    : { status: "failed", summary: "marker missing", artifacts: [], raw: stdout };
}
`;

// Exits 0 but never emits a marker — the silent-misparse case.
const MISPARSE_ADAPTER = `
export const name = "misparse-adapter";
export function injectContract(prompt) { return prompt; }
export function buildArgs(prompt, opts) {
  return [${JSON.stringify(BUN)}, "-e", "process.stdout.write('did stuff'); process.exit(0)"];
}
export function parseResult(stdout, stderr, exitCode) {
  const ok = stdout.includes("VERDICT:");
  return ok
    ? { status: "done", summary: stdout, artifacts: [], raw: stdout }
    : { status: "failed", summary: "marker missing", artifacts: [], raw: stdout };
}
`;

// Never exits on its own — for "still running" assertions.
const SLOW_ADAPTER = `
export const name = "slow-adapter";
export function injectContract(prompt) { return prompt; }
export function buildArgs(prompt, opts) {
  return [${JSON.stringify(BUN)}, "-e", "setInterval(()=>{}, 1e9)"];
}
export function parseResult(stdout, stderr, exitCode) {
  return { status: "done", summary: stdout, artifacts: [], raw: stdout };
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// DW-3.1: dispatch -> wait -> result round-trip returns a structured result.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_3_1_dispatch_wait_result_round_trip_returns_structured_result", async () => {
  const dir = freshDir("sdd-tools-adapters-");
  writeAdapterFile(dir, "ok-adapter.ts", OK_ADAPTER);
  const rt = newRuntime(dir);

  const dispatch = createDispatchTool(rt);
  const wait = createWaitTool(rt);
  const result = createResultTool(rt);

  const dispatchRes = await dispatch.handler({ adapter: "ok-adapter", prompt: "do the thing" });
  expect(dispatchRes.isError).toBeUndefined();
  const jobId = structured(dispatchRes).jobId as string;
  expect(typeof jobId).toBe("string");
  expect(dispatchRes.content[0]!.text).toBe(`dispatched "ok-adapter" as ${jobId}`);

  const waitRes = await wait.handler({ jobIds: [jobId], timeoutMs: 5000 });
  expect(structured(waitRes).done).toEqual([jobId]);

  const resultRes = await result.handler({ jobId });
  const payload = structured(resultRes);
  expect(payload.status).toBe("done");
  expect(payload.summary).toContain("VERDICT: fine");
  expect(payload.artifacts).toEqual([]);
  expect(payload.raw).toContain("VERDICT: fine");
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-3.4: status distinguishes running vs done/failed via exit+marker, not pid.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_3_4_status_running_then_done_with_marker", async () => {
  const dir = freshDir("sdd-tools-adapters-");
  writeAdapterFile(dir, "ok-adapter.ts", OK_ADAPTER);
  const rt = newRuntime(dir);
  const dispatch = createDispatchTool(rt);
  const status = createStatusTool(rt);

  const dispatchRes = await dispatch.handler({ adapter: "ok-adapter", prompt: "p" });
  const jobId = structured(dispatchRes).jobId as string;

  await until(() => rt.jobStore.get(jobId)?.state !== "running");
  const statusRes = await status.handler({ jobId });
  expect(structured(statusRes).state).toBe("done");
});

test("test_DW_3_4_status_failed_on_exit_0_without_marker_not_done", async () => {
  const dir = freshDir("sdd-tools-adapters-");
  writeAdapterFile(dir, "misparse-adapter.ts", MISPARSE_ADAPTER);
  const rt = newRuntime(dir);
  const dispatch = createDispatchTool(rt);
  const status = createStatusTool(rt);

  const dispatchRes = await dispatch.handler({ adapter: "misparse-adapter", prompt: "p" });
  const jobId = structured(dispatchRes).jobId as string;

  await until(() => rt.jobStore.get(jobId)?.state !== "running");
  const job = rt.jobStore.get(jobId)!;
  expect(job.exitCode).toBe(0); // the child genuinely exited 0...

  const statusRes = await status.handler({ jobId });
  expect(structured(statusRes).state).toBe("failed"); // ...but the marker backstop fails it
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge: dispatch to an unknown adapter -> clear error, no job created.
// ─────────────────────────────────────────────────────────────────────────────
test("test_edge_dispatch_unknown_adapter_returns_error_and_creates_no_job", async () => {
  const rt = newRuntime();
  const dispatchSpy = spyOn(rt.jobStore, "dispatch");
  const dispatch = createDispatchTool(rt);

  const res = await dispatch.handler({ adapter: "does-not-exist", prompt: "p" });

  expect(res.isError).toBe(true);
  expect(res.content[0]!.text).toContain("does-not-exist");
  expect(dispatchSpy).not.toHaveBeenCalled(); // no job creation attempted
});

// ─────────────────────────────────────────────────────────────────────────────
// dispatch threads adapter-specific outputPath into DispatchOpts (agy-image path).
// ─────────────────────────────────────────────────────────────────────────────
test("test_dispatch_forwards_outputPath_into_dispatch_opts", async () => {
  const dir = freshDir("sdd-tools-adapters-");
  writeAdapterFile(dir, "ok-adapter.ts", OK_ADAPTER);
  const rt = newRuntime(dir);
  const dispatchSpy = spyOn(rt.jobStore, "dispatch");
  const dispatch = createDispatchTool(rt);

  const res = await dispatch.handler({
    adapter: "ok-adapter",
    prompt: "make an image",
    outputPath: "/tmp/out.png",
  });

  expect(res.isError).toBeUndefined();
  expect(dispatchSpy).toHaveBeenCalledTimes(1);
  const opts = dispatchSpy.mock.calls[0]![2];
  expect(opts).toMatchObject({ outputPath: "/tmp/out.png" });

  await rt.jobStore.wait([structured(res).jobId as string], 5000);
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-1.5: dispatch accepts model/effort, forwards them verbatim into
// DispatchOpts, and rejects an out-of-enum effort at the tool boundary.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_1_5_dispatch_forwards_model_and_effort_into_dispatch_opts", async () => {
  const dir = freshDir("sdd-tools-adapters-");
  writeAdapterFile(dir, "ok-adapter.ts", OK_ADAPTER);
  const rt = newRuntime(dir);
  const dispatchSpy = spyOn(rt.jobStore, "dispatch");
  const dispatch = createDispatchTool(rt);

  const res = await dispatch.handler({
    adapter: "ok-adapter",
    prompt: "review this",
    model: "o3",
    effort: "high",
  });

  expect(res.isError).toBeUndefined();
  expect(dispatchSpy).toHaveBeenCalledTimes(1);
  const opts = dispatchSpy.mock.calls[0]![2];
  expect(opts).toMatchObject({ model: "o3", effort: "high" }); // forwarded verbatim

  await rt.jobStore.wait([structured(res).jobId as string], 5000);
});

test("test_DW_1_5_out_of_enum_effort_rejected_at_tool_boundary", () => {
  // The MCP server validates arguments against inputShape's zod schema before
  // the handler runs — exercise that exact schema.
  const schema = z.object(dispatchInputShape);

  const bad = schema.safeParse({ adapter: "codex", prompt: "p", effort: "max" });
  expect(bad.success).toBe(false);

  for (const effort of ["low", "medium", "high"]) {
    expect(schema.safeParse({ adapter: "codex", prompt: "p", effort }).success).toBe(true);
  }
  // model is a free (non-empty) string — the codex adapter's allowlist, not
  // the schema, is what constrains its use.
  expect(schema.safeParse({ adapter: "codex", prompt: "p", model: "" }).success).toBe(false);
  expect(schema.safeParse({ adapter: "codex", prompt: "p", model: "o3" }).success).toBe(true);
});

test("test_DW_1_5_forwarded_keys_inert_for_adapters_that_do_not_read_them", () => {
  // `model` is read by grok (its `-m` passthrough) and by agy (its own model
  // knob), so it is asserted LIVE for grok.
  expect(grok.buildArgs("p", { model: "grok-4.5" })).not.toEqual(grok.buildArgs("p", {}));

  // `effort` is read by codex and — since 2026-07-21 — by agy, which exposes
  // `--effort low|medium|high` and rejects anything else with exit 1. This
  // assertion used to say the opposite (that agy ignores effort); that was
  // asserting a bug, not a contract: a caller asking for high effort silently
  // got the default.
  expect(agy.buildArgs("p", { effort: "high" })).toEqual([
    "agy",
    "--sandbox",
    "--dangerously-skip-permissions",
    "--effort",
    "high",
    "--print",
    "p",
  ]);

  // grok stays inert for `effort` DELIBERATELY, and this is not an oversight to
  // "fix" later without evidence. grok 0.2.93 does have `--reasoning-effort`
  // (alias `--effort`), but it does NOT validate the value — measured, it
  // accepts `--reasoning-effort definitely-not-valid` and runs the turn anyway.
  // Passing a value grok might silently ignore would make the opt LOOK honored
  // while changing nothing, which is worse than not passing it. Wire this up
  // only once grok's accepted value set is actually known.
  expect(grok.buildArgs("p", { effort: "high" })).toEqual(grok.buildArgs("p", {}));
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-3.1: dispatch forwards the new video-ingestion opts (outputDir, cookies,
// subLangs, frameCount, sceneThreshold, addDir) verbatim into DispatchOpts.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_3_1_dispatch_forwards_video_ingestion_opts_into_dispatch_opts", async () => {
  const dir = freshDir("sdd-tools-adapters-");
  writeAdapterFile(dir, "ok-adapter.ts", OK_ADAPTER);
  const rt = newRuntime(dir);
  const dispatchSpy = spyOn(rt.jobStore, "dispatch");
  const dispatch = createDispatchTool(rt);

  const res = await dispatch.handler({
    adapter: "ok-adapter",
    prompt: "https://example.com/video",
    outputDir: "/tmp/out-dir",
    cookies: "/tmp/cookies.txt",
    subLangs: "en,en-US",
    frameCount: 5,
    sceneThreshold: 0.4,
    addDir: "/tmp/frames-dir",
    sleepRequests: 3,
  });

  expect(res.isError).toBeUndefined();
  expect(dispatchSpy).toHaveBeenCalledTimes(1);
  const opts = dispatchSpy.mock.calls[0]![2];
  expect(opts).toMatchObject({
    outputDir: "/tmp/out-dir",
    cookies: "/tmp/cookies.txt",
    subLangs: "en,en-US",
    frameCount: 5,
    sceneThreshold: 0.4,
    addDir: "/tmp/frames-dir",
    sleepRequests: 3,
  });

  await rt.jobStore.wait([structured(res).jobId as string], 5000);
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-3.2: out-of-range sceneThreshold/frameCount rejected at the tool boundary,
// not silently coerced. Boundary-valid values still pass.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_3_2_out_of_range_scene_threshold_and_frame_count_rejected_at_tool_boundary", () => {
  const schema = z.object(dispatchInputShape);

  expect(schema.safeParse({ adapter: "codex", prompt: "p", sceneThreshold: 1.5 }).success).toBe(false);
  expect(schema.safeParse({ adapter: "codex", prompt: "p", frameCount: 0 }).success).toBe(false);
  expect(schema.safeParse({ adapter: "codex", prompt: "p", frameCount: -1 }).success).toBe(false);
  expect(schema.safeParse({ adapter: "codex", prompt: "p", frameCount: 1.5 }).success).toBe(false); // not an integer
  expect(schema.safeParse({ adapter: "codex", prompt: "p", sceneThreshold: -0.1 }).success).toBe(false);

  // boundary-valid values are accepted, not clamped away
  expect(schema.safeParse({ adapter: "codex", prompt: "p", sceneThreshold: 0 }).success).toBe(true);
  expect(schema.safeParse({ adapter: "codex", prompt: "p", sceneThreshold: 1 }).success).toBe(true);
  expect(schema.safeParse({ adapter: "codex", prompt: "p", frameCount: 1 }).success).toBe(true);

  // sleepRequests shares the positive-int contract
  expect(schema.safeParse({ adapter: "codex", prompt: "p", sleepRequests: 0 }).success).toBe(false);
  expect(schema.safeParse({ adapter: "codex", prompt: "p", sleepRequests: 2.5 }).success).toBe(false);
  expect(schema.safeParse({ adapter: "codex", prompt: "p", sleepRequests: 2 }).success).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge: result on a still-running job -> running status, not a partial artifact.
// ─────────────────────────────────────────────────────────────────────────────
test("test_edge_result_on_running_job_returns_running_not_partial_artifact", async () => {
  const dir = freshDir("sdd-tools-adapters-");
  writeAdapterFile(dir, "slow-adapter.ts", SLOW_ADAPTER);
  const rt = newRuntime(dir);
  const dispatch = createDispatchTool(rt);
  const result = createResultTool(rt);

  const dispatchRes = await dispatch.handler({ adapter: "slow-adapter", prompt: "p" });
  const jobId = structured(dispatchRes).jobId as string;

  const resultRes = await result.handler({ jobId });
  const payload = structured(resultRes);
  expect(payload.status).toBe("running");
  expect(payload.summary).toBeUndefined();
  expect(payload.artifacts).toBeUndefined();
  expect(payload.raw).toBeUndefined();

  await rt.jobStore.cancel(jobId); // clean up the still-running child
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge: two dispatches into the SAME cwd are both accepted — the tool imposes no
// concurrency policy (serializing colliding jobs is the caller's job, not ours).
// ─────────────────────────────────────────────────────────────────────────────
test("test_edge_two_dispatches_into_the_same_cwd_are_both_accepted", async () => {
  const dir = freshDir("sdd-tools-adapters-");
  writeAdapterFile(dir, "slow-adapter.ts", SLOW_ADAPTER);
  const rt = newRuntime(dir);
  const dispatch = createDispatchTool(rt);
  const cwd = freshDir("sdd-tools-cwd-");

  const first = await dispatch.handler({ adapter: "slow-adapter", prompt: "job A", cwd });
  expect(first.isError).toBeUndefined();

  const second = await dispatch.handler({ adapter: "slow-adapter", prompt: "job B", cwd });
  expect(second.isError).toBeUndefined();

  const firstJobId = structured(first).jobId as string;
  const secondJobId = structured(second).jobId as string;
  expect(rt.jobStore.get(firstJobId)!.state).toBe("running");
  expect(rt.jobStore.get(secondJobId)!.state).toBe("running"); // both alive in one cwd

  await rt.jobStore.cancel(firstJobId);
  await rt.jobStore.cancel(secondJobId);
});

// ─────────────────────────────────────────────────────────────────────────────
// cancel: terminates a running job.
// ─────────────────────────────────────────────────────────────────────────────
test("cancel terminates a running job and no-ops on an unknown id", async () => {
  const dir = freshDir("sdd-tools-adapters-");
  writeAdapterFile(dir, "slow-adapter.ts", SLOW_ADAPTER);
  const rt = newRuntime(dir);
  const dispatch = createDispatchTool(rt);
  const cancel = createCancelTool(rt);

  const dispatchRes = await dispatch.handler({ adapter: "slow-adapter", prompt: "p" });
  const jobId = structured(dispatchRes).jobId as string;

  const cancelRes = await cancel.handler({ jobId });
  expect(structured(cancelRes).cancelled).toBe(true);

  const noopRes = await cancel.handler({ jobId: "job-does-not-exist" });
  expect(structured(noopRes).cancelled).toBe(false);
  expect(noopRes.isError).toBeUndefined();
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-3.3: list_adapters reports codex (the real, production adapter) with a
// binaryPresent flag; plus a deterministic PATH-presence check that does not
// depend on whether the real `codex` binary happens to be installed.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_3_3_list_adapters_reports_codex_from_real_adapters_dir", async () => {
  const rt = createRuntime({ jobStoreOptions: { logDir: freshDir("sdd-tools-logs-") } }); // default adaptersDir = src/adapters
  runtimes.push(rt);
  const listAdapters = createListAdaptersTool(rt);

  const res = await listAdapters.handler({});
  const adapters = structured(res).adapters as { name: string; binaryPresent: boolean }[];

  const codexEntry = adapters.find((a) => a.name === "codex");
  expect(codexEntry).toBeDefined();
  expect(typeof codexEntry!.binaryPresent).toBe("boolean");
  // The rendered line carries the name + PATH verdict, and nothing else.
  expect(res.content[0]!.text).toContain(`codex — binary ${codexEntry!.binaryPresent ? "present" : "MISSING"} on PATH`);
});

test("test_DW_3_3_binaryPresent_true_for_a_real_binary_and_false_for_a_fake_one", async () => {
  const dir = freshDir("sdd-tools-adapters-");
  const bunBinaryName = "bun"; // guaranteed present: this is what's running the tests
  writeAdapterFile(
    dir,
    "present.ts",
    `export const name = "${bunBinaryName}"; export function buildArgs(){return ["${bunBinaryName}"]} export function injectContract(p){return p} export function parseResult(o,e,c){return {status:"done",summary:o,artifacts:[],raw:o}}`,
  );
  writeAdapterFile(
    dir,
    "absent.ts",
    `export const name = "definitely-not-a-real-binary-xyz123"; export function buildArgs(){return ["x"]} export function injectContract(p){return p} export function parseResult(o,e,c){return {status:"done",summary:o,artifacts:[],raw:o}}`,
  );
  const rt = newRuntime(dir);
  const listAdapters = createListAdaptersTool(rt);

  const res = await listAdapters.handler({});
  const adapters = structured(res).adapters as { name: string; binaryPresent: boolean }[];

  expect(adapters.find((a) => a.name === bunBinaryName)!.binaryPresent).toBe(true);
  expect(adapters.find((a) => a.name === "definitely-not-a-real-binary-xyz123")!.binaryPresent).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// wait: unknown job id reported, not thrown.
// ─────────────────────────────────────────────────────────────────────────────
test("wait reports an unknown job id instead of throwing", async () => {
  const rt = newRuntime();
  const wait = createWaitTool(rt);
  const res = await wait.handler({ jobIds: ["job-does-not-exist"], timeoutMs: 200 });
  expect(structured(res).unknown).toEqual(["job-does-not-exist"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// status/result: unknown job id -> clean error, not a throw.
// ─────────────────────────────────────────────────────────────────────────────
test("status and result return a clean error for an unknown job id", async () => {
  const rt = newRuntime();
  const status = createStatusTool(rt);
  const result = createResultTool(rt);

  const statusRes = await status.handler({ jobId: "job-does-not-exist" });
  expect(statusRes.isError).toBe(true);

  const resultRes = await result.handler({ jobId: "job-does-not-exist" });
  expect(resultRes.isError).toBe(true);
});
