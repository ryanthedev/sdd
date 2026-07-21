/**
 * Account-limits reader — performs the `LimitsProbe` an adapter declares and
 * returns a normalized `UsageSnapshot`.
 *
 * Why this is NOT in the adapter: the Adapter port is pure (no I/O, no spawn),
 * which is what makes adapters unit-testable. So the adapter declares the call
 * as data (`readLimits`) and maps the payload with a pure function
 * (`parseLimits`); this module owns the only moving parts — spawn, handshake,
 * timeout, cache.
 *
 * Why this is NOT in JobStore: a JobStore job runs a CALLER-CONTROLLED prompt in
 * a caller-chosen cwd and is the security-critical path. A limits read carries
 * no prompt, no cwd, and no caller input whatsoever — its argv is entirely
 * author-written, validated at discovery time (`isLimitsProbe`). Folding it into
 * JobStore would give a metadata read the same lifecycle, logging, and reaping
 * machinery a real work unit needs, and would put a non-job in the job map.
 *
 * SECURITY: `[probe.binary, ...probe.args]` is spawned as an argv ARRAY with
 * `shell:false` — the same barricade as jobs.ts, with strictly less exposure
 * because no element derives from caller input.
 *
 * COST: zero tokens and no work unit. `codex app-server` + one JSON-RPC round
 * trip returns in about a second; it is not a model call. That is why this reads
 * on demand and there is no background poller — a timer would only add staleness
 * and state to something already cheap.
 */
import type { Adapter } from "../adapters/types.ts";
import type { UsageSnapshot } from "../types.ts";

/** Outcome of a limits read: never throws to the caller, always classified. */
export type LimitsResult = { ok: true; snapshot: UsageSnapshot } | { ok: false; error: string };

export interface ReadLimitsOptions {
  /** Hard ceiling on the whole exchange, in ms. */
  timeoutMs?: number;
  /** Bypass the cache and force a live read. */
  refresh?: boolean;
  /** How long a SUCCESSFUL snapshot stays servable, in ms. */
  cacheTtlMs?: number;
  /** How long a FAILED read is remembered before being retried, in ms. */
  failureTtlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Default cache lifetime. Sized for the fan-out case: dispatching ten jobs and
 * checking usage around each must not spawn ten app-servers. Quota moves on the
 * order of minutes, so a snapshot up to a minute old is still decision-grade —
 * and `refresh: true` always forces a live read when the caller needs certainty.
 */
const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * FAILURES are cached too, for much less time.
 *
 * Without this, a harness whose limits endpoint is broken re-pays the full
 * timeout on every single call — and because `check_adapter` reads limits on
 * every invocation, a broken endpoint permanently adds the timeout to an
 * otherwise-healthy health check. Caching the failure briefly bounds that to
 * once per window; keeping the window short means a harness that comes back is
 * picked up almost immediately.
 */
const DEFAULT_FAILURE_TTL_MS = 15_000;

/** Bound on how much stderr is retained for diagnostics — never unbounded. */
const STDERR_CAP = 2000;

/** Grace period between SIGTERM and SIGKILL when reaping the probe child. */
const KILL_GRACE_MS = 500;

/**
 * Cache-key separators, written as explicit escapes rather than the literal
 * control BYTES they used to be — invisible characters in source read as an
 * empty separator and invited exactly the collision they prevent. Distinct
 * characters that cannot occur in a probe field, so `args:["ab","c"]` and
 * `args:["a","bc"]` produce different keys.
 */
const FIELD_SEP = "\u0000";
const ARG_SEP = "\u0001";

type CacheEntry = { result: LimitsResult; at: number };
const cache = new Map<string, CacheEntry>();

/**
 * In-flight reads, so N concurrent callers share ONE child process.
 *
 * The TTL cache alone only de-duplicates SEQUENTIAL reads: a fan-out that calls
 * `usage` from ten places at once would find the cache empty ten times and spawn
 * ten app-servers — exactly the stampede the cache exists to prevent. Joining an
 * in-flight promise closes that window. A `refresh` caller joins too: whatever is
 * already in flight is by definition a live read, which is what it asked for.
 */
const inFlight = new Map<string, Promise<LimitsResult>>();

/**
 * Cache identity is the adapter name PLUS the probe it declares — never the name
 * alone. Two adapter definitions can share a name (a test fixture dir, a swapped
 * adapters dir, an adapter edited between reads); keying on the name only would
 * serve one adapter's quota as another's. The probe is what actually determines
 * the answer, so it belongs in the key.
 */
function cacheKey(adapter: Adapter): string {
  const p = adapter.readLimits;
  return [adapter.name, p?.binary ?? "", (p?.args ?? []).join(ARG_SEP), p?.method ?? ""].join(FIELD_SEP);
}

/**
 * Drop all cached state. Exported for tests; not part of the MCP surface.
 * Clears in-flight reads as well as the cache — otherwise a caller that just
 * "cleared" the cache can still be handed a pre-clear result by joining a read
 * that was already running.
 */
export function clearLimitsCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Read one adapter's account limits. Returns `{ok:false}` — never throws — for
 * every failure mode (no capability, binary missing, handshake refused, timeout,
 * unparseable payload) so a usage read can never take down a tool handler.
 */
export async function readAdapterLimits(adapter: Adapter, opts: ReadLimitsOptions = {}): Promise<LimitsResult> {
  const probe = adapter.readLimits;
  const parse = adapter.parseLimits;
  if (!probe || !parse) {
    return { ok: false, error: `${adapter.name}: does not report account limits` };
  }

  const key = cacheKey(adapter);
  if (!opts.refresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < entryTtl(hit.result, opts)) return hit.result;
  }

  const joined = inFlight.get(key);
  if (joined) return joined;

  const pending = performRead(adapter, probe, parse, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, key).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

/**
 * How long a cache entry stays servable. A SUCCESS is good for the full TTL; a
 * FAILURE is held far more briefly — long enough that a broken endpoint can't be
 * re-paid on every call (check_adapter reads limits every invocation), short
 * enough that a harness coming back is picked up almost immediately.
 */
function entryTtl(result: LimitsResult, opts: ReadLimitsOptions): number {
  if (result.ok) return opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  return Math.min(opts.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS, opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
}

/** The uncached read. Split out so `readAdapterLimits` owns cache/coalescing only. */
async function performRead(
  adapter: Adapter,
  probe: NonNullable<Adapter["readLimits"]>,
  parse: NonNullable<Adapter["parseLimits"]>,
  timeoutMs: number,
  key: string,
): Promise<LimitsResult> {
  if (Bun.which(probe.binary) === null) {
    return { ok: false, error: `${adapter.name}: "${probe.binary}" is not on PATH` };
  }

  const raw = await requestJsonRpc(probe.binary, probe.args, probe.method, timeoutMs);
  if (!raw.ok) return remember(key, raw);

  // A vendor payload that shifts shape must degrade, not explode: parseLimits is
  // contracted to tolerate junk, but it is third-party-ish code from the
  // adapters dir, so a throw is contained here too.
  let parsed: Omit<UsageSnapshot, "adapter" | "fetchedAt">;
  try {
    parsed = parse(raw.result);
  } catch (e) {
    return remember(key, { ok: false, error: `${adapter.name}: could not parse limits payload — ${message(e)}` });
  }

  const snapshot: UsageSnapshot = { ...parsed, adapter: adapter.name, fetchedAt: Date.now() };
  return remember(key, { ok: true, snapshot });
}

/** Cache a result (success OR failure) and hand it back. */
function remember(key: string, result: LimitsResult): LimitsResult {
  cache.set(key, { result, at: Date.now() });
  return result;
}

type RpcResult = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * The stdout reader type, derived from the runtime rather than spelled out:
 * Bun's subprocess streams use a narrower Uint8Array generic than the DOM lib's
 * `ReadableStreamDefaultReader`, and hardcoding either spelling breaks on a
 * lib/TS version bump.
 */
function getStdoutReader(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
  return child.stdout.getReader();
}
type StdoutReader = ReturnType<typeof getStdoutReader>;

/**
 * Spawn the harness's app-server, complete the `initialize` handshake, call
 * `method` with null params, and return its `result`.
 *
 * The handshake is mandatory: the server rejects requests before `initialize`.
 * Notifications and unrelated server-initiated messages arrive interleaved on
 * the same stream, so responses are matched by request `id` rather than by
 * position.
 *
 * TIMEOUT AND REAPING — the two properties this function must guarantee:
 *   - It ALWAYS settles by `timeoutMs`. The deadline is a RACE against the
 *     exchange, not a `kill()` that hopes the stream ends. Relying on the kill
 *     alone means a child that ignores SIGTERM never closes stdout and the
 *     `for await` below never returns, hanging `usage` and `check_adapter`
 *     indefinitely.
 *   - No READER is left permanently locked. THIS function owns the stdout reader, so
 *     it can always cancel it — an abandoned exchange holding its own reader
 *     could not be unlocked from outside, and each timed-out read would leak the
 *     pipe. Killing the child is NOT sufficient: a harness that spawns its own
 *     detached grandchild leaves that grandchild holding the write end, so the
 *     stream never ends no matter what we signal.
 *   - The child is dead on the way out, on every path, with escalation: SIGTERM,
 *     then SIGKILL if it is still alive after a grace period. `kill()` is a
 *     request; only SIGKILL is a guarantee. (A grandchild the harness detached
 *     into its OWN process group is beyond our reach either way — which is
 *     precisely why the reader guarantee above cannot depend on the kill.)
 *
 * MEASURED, so it is not re-investigated: Bun holds a unix socketpair per
 * subprocess for its stdio, and `lsof` shows one retained per read until the
 * Subprocess object is collected — `Bun.gc(true)` drops them back to baseline.
 * That is GC latency, not a leak; there is no unbounded growth to fix here.
 */
async function requestJsonRpc(binary: string, args: string[], method: string, timeoutMs: number): Promise<RpcResult> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    // `detached: true` puts the child in its own process GROUP so `reap` can
    // signal its descendants as well, the same mechanism JobStore uses
    // (`src/lib/jobs.ts`).
    child = Bun.spawn([binary, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (e) {
    return { ok: false, error: `failed to start "${binary} ${args.join(" ")}": ${message(e)}` };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<RpcResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: `${binary} did not answer ${method} within ${timeoutMs}ms` }),
      timeoutMs,
    );
  });

  // The reader is acquired HERE, not inside the exchange, so it stays cancellable
  // after the exchange has been abandoned — see the fd guarantee above.
  const reader = getStdoutReader(child);
  const abort = { aborted: false };

  // The exchange promise may still be pending when the deadline wins the race.
  // It is abandoned deliberately — but it must carry a catch handler, or a late
  // rejection from an abandoned promise surfaces as an unhandled rejection and
  // can take the process down.
  const exchange = runExchange(child, reader, abort, binary, method);
  exchange.catch(() => {});

  try {
    return await Promise.race([exchange, deadline]);
  } finally {
    clearTimeout(timer);
    abort.aborted = true;
    await releaseReader(reader);
    await reap(child);
  }
}

/**
 * Cancel and release the stdout reader. Cancelling closes our end of the pipe —
 * the only thing that reclaims the fd when a process we cannot signal is holding
 * the other end open. Never throws.
 */
async function releaseReader(reader: StdoutReader): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Already errored/closed.
  }
  try {
    reader.releaseLock();
  } catch {
    // Already released.
  }
}

/**
 * Terminate the probe child for certain: cancel the streams so any abandoned
 * reader unblocks, SIGTERM, and escalate to SIGKILL if it outlives the grace
 * period. Never throws — a cleanup path that can throw would mask the real result.
 */
async function reap(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
  // stdin is a pipe WE hold open by writing to it; nothing else ever closes it,
  // so leaving it open leaks one fd per read.
  try {
    void child.stdin.end();
  } catch {
    // Already closed.
  }
  cancelQuietly(child.stdout);
  cancelQuietly(child.stderr);
  try {
    killGroup(child, "SIGTERM");
    const exited = await Promise.race([child.exited.then(() => true), delay(KILL_GRACE_MS).then(() => false)]);
    if (!exited) {
      killGroup(child, "SIGKILL");
      await Promise.race([child.exited, delay(KILL_GRACE_MS)]);
    }
  } catch {
    // Already reaped.
  }
}

/**
 * Cancel a stream only if nothing holds its reader. Cancelling a LOCKED stream
 * throws (`ERR_INVALID_STATE`) — and it is locked exactly when an abandoned
 * exchange is still reading it, which is the case we cancel for. That reader is
 * released by the kill below ending the stream, so skipping the cancel is
 * correct rather than merely safe.
 */
function cancelQuietly(stream: ReadableStream<Uint8Array>): void {
  try {
    if (!stream.locked) void stream.cancel().catch(() => {});
  } catch {
    // Already closed/errored — nothing to unblock.
  }
}

/**
 * Signal the child's whole process GROUP, falling back to the bare pid if the
 * group is already gone. A negative pid addresses the group led by the detached
 * child, so a harness that forked a helper does not leave it behind holding our
 * pipes. Mirrors `JobStore#killGroup`.
 */
function killGroup(child: Bun.Subprocess<"pipe", "pipe", "pipe">, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  try {
    if (typeof pid === "number") process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The JSON-RPC conversation itself, with no lifecycle concerns — see requestJsonRpc. */
async function runExchange(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
  reader: StdoutReader,
  abort: { aborted: boolean },
  binary: string,
  method: string,
): Promise<RpcResult> {
  try {
    const write = (msg: unknown): void => {
      child.stdin.write(JSON.stringify(msg) + "\n");
      child.stdin.flush();
    };

    const INIT_ID = 1;
    const CALL_ID = 2;
    write({
      jsonrpc: "2.0",
      id: INIT_ID,
      method: "initialize",
      params: { clientInfo: { name: "sdd", title: "sdd", version: "1" } },
    });

    let sawInit = false;
    for await (const msg of readMessages(reader)) {
      if (msg.id === INIT_ID) {
        if (msg.error) return { ok: false, error: `initialize rejected: ${JSON.stringify(msg.error).slice(0, 300)}` };
        sawInit = true;
        write({ jsonrpc: "2.0", method: "initialized", params: null });
        write({ jsonrpc: "2.0", id: CALL_ID, method, params: null });
        continue;
      }
      if (msg.id === CALL_ID) {
        if (msg.error) return { ok: false, error: `${method} rejected: ${JSON.stringify(msg.error).slice(0, 300)}` };
        // JSON-RPC requires a `result` member on success. A reply carrying
        // neither is malformed, and must NOT be handed to parseLimits: that
        // would degrade to an empty snapshot and be cached as a good read —
        // indistinguishable from "this harness genuinely meters nothing", and
        // it would suppress retries for the full success TTL.
        if (!("result" in msg)) return { ok: false, error: `${method} returned a reply with no result` };
        return { ok: true, result: msg.result };
      }
      // Anything else is a notification or an unrelated request — ignore it.
    }

    // Stream ended without our answer — the child exited on its own. stderr is
    // where the reason lands (auth, version skew). Bounded by its own short race:
    // this runs on a failure path, and a stderr pipe that never closes must not
    // turn a clean error into a hang.
    // An ABANDONED exchange must not touch stderr: the caller already has its
    // answer, and locking another stream here would defeat the point of the
    // cleanup that just cancelled stdout.
    const stderr = abort.aborted ? "" : await readStderr(child);
    const stage = sawInit ? `after initialize, awaiting ${method}` : "during initialize";
    return { ok: false, error: `${binary} ended ${stage}${stderr ? ` — ${stderr}` : ""}` };
  } catch (e) {
    return { ok: false, error: `${binary} ${method} failed: ${message(e)}` };
  }
}

/** Bounded, best-effort stderr read for diagnostics. Never throws, never hangs. */
async function readStderr(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<string> {
  try {
    const text = await Promise.race([new Response(child.stderr).text(), delay(KILL_GRACE_MS).then(() => "")]);
    return text.trim().slice(-STDERR_CAP);
  } catch {
    return "";
  }
}

type RpcMessage = { id?: unknown; result?: unknown; error?: unknown };

/**
 * Decode a newline-delimited JSON-RPC stream into messages. A line that is not
 * valid JSON is SKIPPED rather than fatal — a CLI that prints a stray banner or
 * an update notice onto stdout must not break the exchange.
 */
async function* readMessages(reader: StdoutReader): AsyncGenerator<RpcMessage> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as RpcMessage;
      } catch {
        // Not JSON — banner/log noise on stdout. Skip it.
      }
    }
  }
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}

/**
 * One-line human rendering of a snapshot, shared by `usage` and `check_adapter`
 * so both speak identically. Percentages are rendered as USED, and the reset is
 * given as a duration from now — "82% used, resets in 3h" is actionable in a way
 * that a bare epoch is not.
 */
export function formatSnapshot(s: UsageSnapshot): string {
  const parts: string[] = [];
  parts.push(`${s.adapter}${s.plan ? ` (plan ${s.plan})` : ""}`);
  if (s.windows.length === 0) {
    parts.push("no metered windows reported");
  } else {
    for (const w of s.windows) {
      const window = w.windowMinutes !== null ? ` of ${formatMinutes(w.windowMinutes)}` : "";
      const reset = w.resetsAt !== null ? `, resets ${formatEta(w.resetsAt)}` : "";
      parts.push(`${w.name}: ${w.usedPercent}% used${window}${reset}`);
    }
  }
  if (s.credits) {
    parts.push(
      s.credits.unlimited
        ? "credits: unlimited"
        : `credits: ${s.credits.hasCredits ? `available${s.credits.balance ? ` (${s.credits.balance})` : ""}` : "none"}`,
    );
  }
  if (s.limitReached) parts.push(`LIMIT REACHED (${s.limitReached})`);
  return parts.join(" · ");
}

function formatMinutes(mins: number): string {
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

/** Relative reset time from an epoch-SECONDS timestamp. */
function formatEta(epochSeconds: number): string {
  const deltaMs = epochSeconds * 1000 - Date.now();
  if (deltaMs <= 0) return "now";
  const hours = deltaMs / 3_600_000;
  if (hours < 1) return `in ${Math.max(1, Math.round(deltaMs / 60_000))}m`;
  if (hours < 48) return `in ${Math.round(hours)}h`;
  return `in ${Math.round(hours / 24)}d`;
}
