/**
 * DW-1.3: the Adapter port + AdapterResult / Job / JobState / DispatchOpts are
 * exported from src/types.ts and src/adapters/types.ts, and buildArgs is typed
 * to return string[]. Types erase at runtime, so this file enforces the
 * contract two ways: (1) it only compiles under strict TS if the values conform
 * to the exported types, and (2) it asserts the runtime shape those types
 * describe — in particular that buildArgs returns an argv array of strings.
 */
import { test, expect } from "bun:test";
import type { Adapter } from "../src/adapters/types.ts";
import type { AdapterResult, DispatchOpts, Job, JobState } from "../src/types.ts";

test("test_DW_1_3_adapter_port_conforms_and_buildArgs_returns_string_array", () => {
  const adapter: Adapter = {
    name: "sample",
    buildArgs: (prompt: string, opts: DispatchOpts): string[] => {
      const sandbox = typeof opts.sandbox === "string" ? opts.sandbox : "read-only";
      // A shell-metacharacter-laden prompt is just another argv element here.
      return ["exec", "--sandbox", sandbox, prompt];
    },
    injectContract: (prompt: string): string => `${prompt}\n\nEnd with VERDICT: <one line>.`,
    parseResult: (stdout: string, _stderr: string, exitCode: number): AdapterResult => ({
      status: exitCode === 0 && stdout.includes("VERDICT:") ? "done" : "failed",
      summary: stdout.trim(),
      artifacts: [],
      raw: stdout,
    }),
  };

  const argv = adapter.buildArgs("look at `whoami`; rm -rf /", { sandbox: "read-only" });
  expect(Array.isArray(argv)).toBe(true);
  expect(argv.every((a) => typeof a === "string")).toBe(true);
  // The dangerous prompt survives verbatim as a single argv element — no shell.
  expect(argv).toContain("look at `whoami`; rm -rf /");
});

test("test_DW_1_3_adapter_parseResult_fails_when_marker_absent", () => {
  const adapter: Adapter = {
    name: "sample",
    buildArgs: () => [],
    injectContract: (p) => p,
    parseResult: (stdout, _stderr, exitCode): AdapterResult => ({
      status: exitCode === 0 && stdout.includes("VERDICT:") ? "done" : "failed",
      summary: stdout,
      artifacts: [],
      raw: stdout,
    }),
  };

  // Exit 0 but no marker -> failed (the silent-misparse backstop the port exists for).
  expect(adapter.parseResult("all good, nothing to report", "", 0).status).toBe("failed");
  expect(adapter.parseResult("VERDICT: approved", "", 0).status).toBe("done");
});

test("test_DW_1_3_core_types_are_constructable", () => {
  const result: AdapterResult = { status: "done", summary: "ok", artifacts: ["/tmp/out.png"], raw: "raw" };
  const state: JobState = "running";
  const opts: DispatchOpts = { cwd: "/repo", timeoutMs: 30_000, model: "gpt-5" };
  const job: Job = {
    id: "job_1",
    adapter: "sample",
    cwd: "/repo",
    state,
    logPath: "/tmp/job_1.log",
    createdAt: Date.now(),
  };

  expect(result.artifacts).toEqual(["/tmp/out.png"]);
  expect(opts.model).toBe("gpt-5");
  expect(job.state).toBe("running");
  expect(job.exitCode).toBeUndefined();
  expect(job.result).toBeUndefined();

  // Terminal states are assignable.
  const done: JobState = "done";
  const failed: JobState = "failed";
  expect([done, failed]).toEqual(["done", "failed"]);
});
