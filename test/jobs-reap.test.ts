/**
 * Process-group reaping: cancel and shutdown send SIGTERM then SIGKILL, and a
 * grandchild that ignores SIGTERM must not survive them even though the group
 * leader settles (and clears the grace timer) the moment it exits on SIGTERM.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkUnit } from "../src/adapters/types.ts";
import { JobStore } from "../src/lib/jobs.ts";

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A leader that exits cleanly on SIGTERM, leaving a SIGTERM-ignoring grandchild. */
function stubborn(): { unit: WorkUnit; pidfile: string } {
  const dir = mkdtempSync(join(tmpdir(), "sdd-reap-"));
  dirs.push(dir);
  const pidfile = join(dir, "gc.pid");
  // Ignored signals survive exec, so the grandchild (pid recorded by the exec'd sh) ignores TERM.
  const script = `( trap '' TERM; exec sh -c 'echo $$ > ${pidfile}; exec sleep 30' ) </dev/null >/dev/null 2>&1 & trap 'exit 0' TERM; while true; do sleep 0.1; done`;
  const unit: WorkUnit = {
    name: "stubborn",
    buildArgs: () => ["bash", "-c", script],
    injectContract: (p) => p,
    parseResult: () => ({ status: "done", summary: "", artifacts: [], raw: "" }),
  };
  return { unit, pidfile };
}

async function grandchildPid(pidfile: string): Promise<number> {
  for (let i = 0; i < 50; i++) {
    try {
      const pid = Number(readFileSync(pidfile, "utf8").trim());
      if (pid > 0) {
        pids.push(pid);
        return pid;
      }
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("grandchild never started");
}

test("cancel SIGKILLs a SIGTERM-ignoring grandchild when the leader settles", async () => {
  const { unit, pidfile } = stubborn();
  const store = new JobStore({ killGraceMs: 300 });
  const id = store.dispatch(unit, "x");
  const gc = await grandchildPid(pidfile);
  expect(alive(gc)).toBe(true);
  await store.cancel(id);
  await Bun.sleep(200);
  expect(store.get(id)?.state).toBe("failed");
  expect(alive(gc)).toBe(false);
});

test("shutdown SIGKILLs a SIGTERM-ignoring grandchild too", async () => {
  const { unit, pidfile } = stubborn();
  const store = new JobStore({ killGraceMs: 300 });
  store.dispatch(unit, "x");
  const gc = await grandchildPid(pidfile);
  await store.shutdown();
  await Bun.sleep(200);
  expect(alive(gc)).toBe(false);
});

test("a job that finishes on its own is not group-killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sdd-reap-"));
  dirs.push(dir);
  const unit: WorkUnit = {
    name: "quick",
    buildArgs: () => ["bash", "-c", "true"],
    injectContract: (p) => p,
    parseResult: () => ({ status: "done", summary: "", artifacts: [], raw: "" }),
  };
  const store = new JobStore();
  const id = store.dispatch(unit, "x");
  await store.wait([id], 5000);
  expect(store.get(id)?.state).toBe("done");
});
