/**
 * DW-1.1: `bun run src/server.ts` starts, connects stdio, logs the registered
 * tool count to stderr, and exits cleanly (code 0) on SIGINT.
 *
 * Updated in Phase 3: the banner now reports 7 tools (dispatch/status/result/
 * wait/cancel/list_adapters/check_adapter), not the Phase-1 scaffold's 0 — the
 * boot/clean-exit invariant this test protects is unchanged.
 *
 * The child is spawned with an open stdin pipe (the real MCP scenario: the
 * client keeps stdin open), so it stays alive until we deliver SIGINT. A hard
 * timeout guards the stderr wait so a regression can't wedge the suite.
 */
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const SERVER_PATH = fileURLToPath(new URL("../src/server.ts", import.meta.url));

/** Read the child's stderr until it contains `needle`, or reject on timeout. */
async function waitForStderr(
  stream: ReadableStream<Uint8Array>,
  needle: string,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const timer = new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), remaining),
      );
      const next = reader
        .read()
        .then((r) => ({ timedOut: false as const, done: r.done, value: r.value }));
      const winner = await Promise.race([next, timer]);

      if (winner.timedOut) break;
      if (winner.done) break;
      if (winner.value) acc += decoder.decode(winner.value, { stream: true });
      if (acc.includes(needle)) return acc;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`stderr did not contain "${needle}" within ${timeoutMs}ms. Got:\n${acc}`);
}

test(
  "test_DW_1_1_boots_logs_tool_count_and_exits_clean_on_sigint",
  async () => {
    const proc = Bun.spawn(["bun", "run", SERVER_PATH], {
      stdin: "pipe", // keep stdin open so the server does not exit on its own
      stdout: "ignore", // stdout is the JSON-RPC transport; no client here
      stderr: "pipe",
    });

    try {
      const banner = await waitForStderr(proc.stderr, "7 tools", 20_000);
      expect(banner).toContain("connected (7 tools)");

      proc.kill("SIGINT");
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0); // clean exit, not 130
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }
  },
  30_000,
);
