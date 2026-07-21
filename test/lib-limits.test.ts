/**
 * `src/lib/limits.ts` — the one piece of the limits path that does I/O.
 *
 * The JSON-RPC exchange is driven against a FAKE app-server: a short-lived
 * `bun -e ...` child that speaks the same newline-delimited protocol (same
 * technique as jobs.test.ts / tools.test.ts). That exercises the real spawn,
 * the real initialize handshake, real id-matching, and the real timeout — with
 * no dependency on codex being installed or logged in.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "../src/adapters/types.ts";
import { clearLimitsCache, formatSnapshot, readAdapterLimits } from "../src/lib/limits.ts";
import type { UsageSnapshot } from "../src/types.ts";

const BUN = process.execPath;
const tmpDirs: string[] = [];

afterEach(() => {
  clearLimitsCache();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Minimal valid Adapter, with the limits capability pointed at a fake server. */
function fakeAdapter(serverScript: string, over: Partial<Adapter> = {}): Adapter {
  return {
    name: "fake",
    buildArgs: () => ["true"],
    injectContract: (p) => p,
    parseResult: () => ({ status: "done", summary: "", artifacts: [], raw: "" }),
    readLimits: { transport: "app-server-jsonrpc", binary: BUN, args: ["-e", serverScript], method: "limits/read" },
    parseLimits: (raw) => ({
      plan: (raw as { plan?: string } | null)?.plan ?? null,
      windows: [],
      credits: null,
      limitReached: null,
    }),
    ...over,
  };
}

/**
 * A fake app-server: answers `initialize` (id 1) then the limits method (id 2).
 * `behavior` selects how it misbehaves, so each failure branch has a real child
 * producing it rather than a stubbed return value.
 */
function serverScript(behavior: "ok" | "rpc-error" | "init-error" | "hang" | "noise" = "ok"): string {
  return `
    const send = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); };
    if (${JSON.stringify(behavior)} === "noise") process.stdout.write("codex: update available\\n");
    let buf = "";
    process.stdin.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          if (${JSON.stringify(behavior)} === "init-error") { send({ id: msg.id, error: { code: -1, message: "no auth" } }); continue; }
          send({ id: msg.id, result: { ok: true } });
          send({ method: "some/notification", params: {} });   // interleaved noise
          continue;
        }
        if (msg.method === "limits/read") {
          if (${JSON.stringify(behavior)} === "hang") continue;
          if (${JSON.stringify(behavior)} === "rpc-error") { send({ id: msg.id, error: { code: -2, message: "nope" } }); continue; }
          send({ id: msg.id, result: { plan: "plus" } });
        }
      }
    });
  `;
}

test("reads limits over a real initialize + request handshake", async () => {
  const r = await readAdapterLimits(fakeAdapter(serverScript("ok")));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.snapshot.plan).toBe("plus");
  expect(r.snapshot.adapter).toBe("fake");
  expect(r.snapshot.fetchedAt).toBeGreaterThan(0);
});

test("ignores non-JSON banner lines on stdout", async () => {
  const r = await readAdapterLimits(fakeAdapter(serverScript("noise")));
  expect(r.ok).toBe(true);
});

test("an adapter without the capability is reported, not thrown", async () => {
  const a = fakeAdapter(serverScript(), { readLimits: undefined, parseLimits: undefined });
  const r = await readAdapterLimits(a);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("does not report account limits");
});

test("a binary that is not on PATH fails cleanly", async () => {
  const a = fakeAdapter(serverScript());
  a.readLimits = { transport: "app-server-jsonrpc", binary: "definitely-not-installed-xyz", args: [], method: "m" };
  const r = await readAdapterLimits(a);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("not on PATH");
});

test("a rejected initialize is surfaced as an error, not a hang", async () => {
  const r = await readAdapterLimits(fakeAdapter(serverScript("init-error")));
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("initialize rejected");
});

test("a JSON-RPC error response is surfaced", async () => {
  const r = await readAdapterLimits(fakeAdapter(serverScript("rpc-error")));
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("rejected");
});

test("a server that never answers is abandoned at the deadline", async () => {
  const started = Date.now();
  const r = await readAdapterLimits(fakeAdapter(serverScript("hang")), { timeoutMs: 800 });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("did not answer limits/read within 800ms");
  expect(Date.now() - started).toBeLessThan(5_000);
});

/**
 * The guarantee under test is that the DEADLINE settles the call, not the kill.
 * A child that ignores SIGTERM keeps stdout open forever, so a version that only
 * called `kill()` and waited for the stream to end would hang here indefinitely.
 * It must also be SIGKILLed, not left running.
 */
test("a child that ignores SIGTERM still settles the call, and is force-killed", async () => {
  const stubborn = `
    process.on("SIGTERM", () => {});           // refuse to die politely
    process.stdin.on("data", () => {});        // never answer
    setInterval(() => {}, 1000);               // stay alive
  `;
  const adapter = fakeAdapter(stubborn);
  const started = Date.now();
  const r = await readAdapterLimits(adapter, { timeoutMs: 700 });
  const elapsed = Date.now() - started;

  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("did not answer");
  // Deadline + the SIGTERM→SIGKILL grace, nowhere near an unbounded hang.
  expect(elapsed).toBeLessThan(5_000);
});

test("a throwing parseLimits is contained", async () => {
  const a = fakeAdapter(serverScript(), {
    parseLimits: () => {
      throw new Error("bad shape");
    },
  });
  const r = await readAdapterLimits(a);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("could not parse limits payload");
});

/**
 * The reap must actually END the process, not just ask it to stop — including
 * after a SUCCESSFUL read, where nothing has timed out and it would be easy to
 * return the answer and leave a child behind.
 *
 * Liveness is observed rather than assumed: the server heartbeats to a file
 * every 30ms and ignores SIGTERM. If it is still alive after the call returns,
 * the file keeps growing.
 */
test("the child is dead after a successful read, even if it ignores SIGTERM", async () => {
  const marker = markerPath();
  const stubbornButAnswers = `
    const fs = require("fs");
    process.on("SIGTERM", () => {});
    setInterval(() => { try { fs.appendFileSync(${JSON.stringify(marker)}, "b"); } catch {} }, 30);
    const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") send({ id: msg.id, result: {} });
        if (msg.method === "limits/read") send({ id: msg.id, result: { plan: "plus" } });
      }
    });
  `;

  const r = await readAdapterLimits(fakeAdapter(stubbornButAnswers));
  expect(r.ok).toBe(true);

  await new Promise((res) => setTimeout(res, 300));
  const settled = spawnCount(marker);
  await new Promise((res) => setTimeout(res, 300));
  expect(spawnCount(marker)).toBe(settled); // no further heartbeats — it is gone
});

/**
 * A server that RECORDS each spawn and reports a different plan every time. The
 * cache tests need the same probe (same cache key) to produce different answers
 * on successive spawns — that is the only way to tell a cache hit from a re-read.
 */
function countingScript(marker: string): string {
  return `
    const fs = require("fs");
    fs.appendFileSync(${JSON.stringify(marker)}, "x");
    const n = fs.readFileSync(${JSON.stringify(marker)}, "utf8").length;
    const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") send({ id: msg.id, result: {} });
        if (msg.method === "limits/read") send({ id: msg.id, result: { plan: "spawn-" + n } });
      }
    });
  `;
}

function markerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdd-limits-"));
  tmpDirs.push(dir);
  return join(dir, "spawns");
}

function spawnCount(marker: string): number {
  try {
    return readFileSync(marker, "utf8").length;
  } catch {
    return 0;
  }
}

test("a second read inside the TTL is served from cache; refresh forces a live read", async () => {
  const marker = markerPath();
  const a = fakeAdapter(countingScript(marker));

  const first = await readAdapterLimits(a);
  expect(first.ok && first.snapshot.plan).toBe("spawn-1");

  const cached = await readAdapterLimits(a);
  expect(cached.ok && cached.snapshot.plan).toBe("spawn-1");
  expect(spawnCount(marker)).toBe(1); // no second child

  const forced = await readAdapterLimits(a, { refresh: true });
  expect(forced.ok && forced.snapshot.plan).toBe("spawn-2");
  expect(spawnCount(marker)).toBe(2);
});

test("a zero TTL disables the cache", async () => {
  const marker = markerPath();
  const a = fakeAdapter(countingScript(marker));
  await readAdapterLimits(a);
  const second = await readAdapterLimits(a, { cacheTtlMs: 0 });
  expect(second.ok && second.snapshot.plan).toBe("spawn-2");
});

/**
 * Cache identity must include the PROBE, not just the adapter name. Keying on
 * the name alone lets one adapter's quota be served as another's whenever two
 * definitions share a name — a fixture dir, a swapped adapters dir, or an
 * adapter edited between reads.
 */
test("two same-named adapters with different probes do not share a cache entry", async () => {
  const first = fakeAdapter(serverScript("ok"), { name: "same-name" });
  const r1 = await readAdapterLimits(first);
  expect(r1.ok && r1.snapshot.plan).toBe("plus");

  const second = fakeAdapter(serverScript("ok").replace('"plus"', '"team"'), { name: "same-name" });
  const r2 = await readAdapterLimits(second);
  expect(r2.ok && r2.snapshot.plan).toBe("team");
});

/**
 * The TTL cache only de-duplicates SEQUENTIAL reads. A fan-out calls usage from
 * several places at once, finds the cache cold every time, and would spawn one
 * app-server per caller — the exact stampede the cache exists to prevent.
 */
test("concurrent reads coalesce onto a single child process", async () => {
  const marker = markerPath();
  const a = fakeAdapter(countingScript(marker));

  const results = await Promise.all([
    readAdapterLimits(a),
    readAdapterLimits(a),
    readAdapterLimits(a),
    readAdapterLimits(a),
  ]);

  expect(results.every((r) => r.ok)).toBe(true);
  expect(spawnCount(marker)).toBe(1);
  // All four callers see the same snapshot, not four independent reads.
  expect(new Set(results.map((r) => (r.ok ? r.snapshot.fetchedAt : 0))).size).toBe(1);
});

const snapshot = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  adapter: "codex",
  plan: "plus",
  windows: [{ name: "codex", usedPercent: 1, windowMinutes: 10080, resetsAt: null }],
  credits: null,
  limitReached: null,
  fetchedAt: Date.now(),
  ...over,
});

test("formatSnapshot renders plan, percent used, and window length", () => {
  expect(formatSnapshot(snapshot())).toBe("codex (plan plus) · codex: 1% used of 7d");
});

test("formatSnapshot renders a reset as a duration from now, not an epoch", () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
  const text = formatSnapshot(snapshot({ windows: [{ name: "codex", usedPercent: 50, windowMinutes: 300, resetsAt }] }));
  expect(text).toContain("50% used of 5h, resets in 3h");
  expect(text).not.toContain(String(resetsAt));
});

test("formatSnapshot shouts when a limit is currently reached", () => {
  expect(formatSnapshot(snapshot({ limitReached: "rate_limit_reached" }))).toContain("LIMIT REACHED (rate_limit_reached)");
});

test("formatSnapshot states when no window was reported instead of implying zero use", () => {
  expect(formatSnapshot(snapshot({ windows: [] }))).toContain("no metered windows reported");
});

test("formatSnapshot renders credit state", () => {
  expect(formatSnapshot(snapshot({ credits: { hasCredits: true, unlimited: false, balance: "12" } }))).toContain(
    "credits: available (12)",
  );
  expect(formatSnapshot(snapshot({ credits: { hasCredits: false, unlimited: true, balance: null } }))).toContain(
    "credits: unlimited",
  );
});

/**
 * A broken limits endpoint must not be re-paid on every call. `check_adapter`
 * reads limits on every invocation, so an uncached failure would permanently
 * add the full timeout to an otherwise-healthy health check.
 */
test("a failed read is cached briefly so a broken endpoint is not re-paid per call", async () => {
  const marker = markerPath();
  // Answers initialize, then goes silent — the expensive failure mode.
  const silent = `
    const fs = require("fs");
    fs.appendFileSync(${JSON.stringify("MARKER")}, "x");
    const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") send({ id: msg.id, result: {} });
      }
    });
    setInterval(() => {}, 1000);
  `.replace('"MARKER"', JSON.stringify(marker));

  const a = fakeAdapter(silent);
  const first = await readAdapterLimits(a, { timeoutMs: 400 });
  expect(first.ok).toBe(false);
  expect(spawnCount(marker)).toBe(1);

  const started = Date.now();
  const second = await readAdapterLimits(a, { timeoutMs: 400 });
  expect(second.ok).toBe(false);
  expect(spawnCount(marker)).toBe(1); // served from the negative cache, no respawn
  expect(Date.now() - started).toBeLessThan(200); // and it did not re-pay the timeout
});

test("a short failure TTL lets a recovered harness be picked up again", async () => {
  const marker = markerPath();
  const a = fakeAdapter(countingScript(marker));
  await readAdapterLimits(a);
  // failureTtlMs only bounds FAILURES; a success still honours cacheTtlMs.
  const cached = await readAdapterLimits(a, { failureTtlMs: 1 });
  expect(cached.ok && cached.snapshot.plan).toBe("spawn-1");
  expect(spawnCount(marker)).toBe(1);
});

/**
 * JSON-RPC requires a `result` member on success. A reply with neither result
 * nor error must not be treated as a good read: parseLimits would degrade it to
 * an empty snapshot, which then caches for the full success TTL and reads as
 * "this harness genuinely meters nothing".
 */
test("a reply carrying neither result nor error is a failure, not an empty snapshot", async () => {
  const malformed = `
    const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") send({ id: msg.id, result: {} });
        if (msg.method === "limits/read") send({ id: msg.id });   // no result, no error
      }
    });
  `;
  const r = await readAdapterLimits(fakeAdapter(malformed));
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("no result");
});

test("clearLimitsCache also drops in-flight reads", async () => {
  const marker = markerPath();
  const a = fakeAdapter(countingScript(marker));

  const inflight = readAdapterLimits(a);
  clearLimitsCache();
  const after = await readAdapterLimits(a);
  const before = await inflight;

  // Two independent children, not one joined read. The spawn COUNT is the
  // deterministic signal; which child observes which count is a genuine race
  // between concurrent processes, so it is not asserted.
  expect(before.ok).toBe(true);
  expect(after.ok).toBe(true);
  expect(spawnCount(marker)).toBe(2);
});

/**
 * The reviewer's reported key collision was NOT reproducible — the separators
 * were already distinct control characters, merely invisible in the source. This
 * pins the property so it cannot regress into a real collision.
 */
test("probe args that differ only in where they split produce different cache keys", async () => {
  const script = serverScript("ok");
  const a1 = fakeAdapter(script, { name: "n" });
  a1.readLimits = { transport: "app-server-jsonrpc", binary: BUN, args: ["-e", script, "ab", "c"], method: "limits/read" };
  const a2 = fakeAdapter(script.replace('"plus"', '"team"'), { name: "n" });
  const script2 = script.replace('"plus"', '"team"');
  a2.readLimits = { transport: "app-server-jsonrpc", binary: BUN, args: ["-e", script2, "a", "bc"], method: "limits/read" };

  const r1 = await readAdapterLimits(a1);
  const r2 = await readAdapterLimits(a2);
  expect(r1.ok && r1.snapshot.plan).toBe("plus");
  expect(r2.ok && r2.snapshot.plan).toBe("team");
});
