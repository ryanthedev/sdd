/**
 * Model-catalog reader — executes an adapter's declarative `ModelsProbe` (or
 * returns its static `models` list) and returns a normalized `ModelsSnapshot`.
 *
 * Mirrors `src/lib/limits.ts`: adapters stay pure/I/O-free by declaring data
 * (`readModels`) and a pure normalizer (`parseModels`); this module owns
 * spawning, timeout, owned-reader cleanup, process-group reaping, and TTL
 * caching.
 *
 * SECURITY: every argv element comes from author-written adapter code validated
 * at discovery time (`isModelsProbe`), never from caller input; spawned with
 * `shell: false`.
 */
import type { Adapter, ModelsProbe } from "../adapters/types.ts";
import type { ModelInfo, ModelsSnapshot } from "../types.ts";
import { requestJsonRpc } from "./limits.ts";

export type ModelsCapableAdapter = Pick<Adapter, "name" | "models" | "readModels" | "parseModels">;

export type ModelsResult = { ok: true; snapshot: ModelsSnapshot } | { ok: false; error: string };

export interface ReadModelsOptions {
  timeoutMs?: number;
  refresh?: boolean;
  cacheTtlMs?: number;
  failureTtlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_FAILURE_TTL_MS = 15_000;
const KILL_GRACE_MS = 500;
const STDERR_CAP = 2000;
const FIELD_SEP = "\u0000";
const ARG_SEP = "\u0001";

type CacheEntry = { result: ModelsResult; at: number };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ModelsResult>>();

function cacheKey(adapter: ModelsCapableAdapter): string {
  const p = adapter.readModels;
  if (!p) return adapter.name;
  const method = p.transport === "app-server-jsonrpc" ? p.method : "";
  const params = p.transport === "app-server-jsonrpc" ? JSON.stringify(p.params ?? {}) : "";
  return [adapter.name, p.transport, p.binary, p.args.join(ARG_SEP), method, params].join(FIELD_SEP);
}

/** Drop all cached model lists. Exported for tests. */
export function clearModelsCache(): void {
  cache.clear();
  inFlight.clear();
}

export function hasModelDiscovery(adapter: ModelsCapableAdapter): boolean {
  return (
    (adapter.readModels !== undefined && adapter.parseModels !== undefined) ||
    (Array.isArray(adapter.models) && adapter.models.length > 0)
  );
}

export async function readAdapterModels(
  adapter: ModelsCapableAdapter,
  opts: ReadModelsOptions = {},
): Promise<ModelsResult> {
  const probe = adapter.readModels;
  const parse = adapter.parseModels;

  if (!probe || !parse) {
    if (Array.isArray(adapter.models) && adapter.models.length > 0) {
      return {
        ok: true,
        snapshot: {
          adapter: adapter.name,
          models: [...adapter.models],
          source: "static",
          fetchedAt: Date.now(),
        },
      };
    }
    return { ok: false, error: `${adapter.name}: does not report available models` };
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

function entryTtl(result: ModelsResult, opts: ReadModelsOptions): number {
  if (result.ok) return opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  return Math.min(opts.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS, opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
}

async function performRead(
  adapter: ModelsCapableAdapter,
  probe: ModelsProbe,
  parse: NonNullable<Adapter["parseModels"]>,
  timeoutMs: number,
  key: string,
): Promise<ModelsResult> {
  // Do not cache missing-binary checks (mirrors src/lib/limits.ts): a newly
  // installed CLI should work immediately without waiting for failureTtlMs.
  if (Bun.which(probe.binary) === null) {
    return { ok: false, error: `${adapter.name}: "${probe.binary}" is not on PATH` };
  }

  const raw =
    probe.transport === "app-server-jsonrpc"
      ? await requestJsonRpc(probe.binary, probe.args, probe.method, timeoutMs, probe.params ?? {})
      : await runCliStdout(probe.binary, probe.args, timeoutMs);

  if (!raw.ok) return remember(key, raw);

  let models: ModelInfo[];
  try {
    models = parse(raw.result);
  } catch (e) {
    return remember(key, {
      ok: false,
      error: `${adapter.name}: could not parse models payload — ${message(e)}`,
    });
  }

  return remember(key, {
    ok: true,
    snapshot: {
      adapter: adapter.name,
      models,
      source: "live",
      fetchedAt: Date.now(),
    },
  });
}

function remember(key: string, result: ModelsResult): ModelsResult {
  cache.set(key, { result, at: Date.now() });
  return result;
}

function getReader(stream: ReadableStream<Uint8Array>) {
  return stream.getReader();
}
type StreamReader = ReturnType<typeof getReader>;

async function drainReader(reader: StreamReader, cap?: number): Promise<string> {
  const decoder = new TextDecoder();
  let acc = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    acc += decoder.decode(value, { stream: true });
    if (cap !== undefined && acc.length > cap * 2) {
      acc = acc.slice(-cap);
    }
  }
  acc += decoder.decode();
  return cap !== undefined ? acc.slice(-cap) : acc;
}

async function releaseReader(reader: StreamReader): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // already closed/errored
  }
  try {
    reader.releaseLock();
  } catch {
    // already released
  }
}

async function runCliStdout(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true; result: string } | { ok: false; error: string }> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (e) {
    return { ok: false, error: `failed to start "${binary} ${args.join(" ")}": ${message(e)}` };
  }

  // Own both readers explicitly so `finally` can ALWAYS cancel and release
  // them on timeout — even if a detached grandchild holds the write end open.
  const stdoutReader = getReader(child.stdout);
  const stderrReader = getReader(child.stderr);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  const collected = Promise.all([
    drainReader(stdoutReader),
    drainReader(stderrReader, STDERR_CAP),
    child.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ timedOut: false as const, stdout, stderr, exitCode }));
  collected.catch(() => {});

  try {
    const winner = await Promise.race([collected, deadline]);
    if (winner.timedOut) {
      return { ok: false, error: `${binary} ${args.join(" ")} timed out after ${timeoutMs}ms` };
    }
    if (winner.exitCode !== 0) {
      const errTail = winner.stderr.trim().slice(-STDERR_CAP);
      return {
        ok: false,
        error: `${binary} ${args.join(" ")} exited ${winner.exitCode}${errTail ? ` — ${errTail}` : ""}`,
      };
    }
    return { ok: true, result: winner.stdout };
  } finally {
    clearTimeout(timer);
    await releaseReader(stdoutReader);
    await releaseReader(stderrReader);
    if (child.exitCode === null && child.signalCode === null) {
      await reapCli(child);
    }
  }
}

async function reapCli(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  const kill = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // already exited
      }
    }
  };
  kill("SIGTERM");
  const exited = await Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), KILL_GRACE_MS)),
  ]);
  if (!exited) {
    kill("SIGKILL");
    await Promise.race([child.exited, new Promise<void>((r) => setTimeout(r, KILL_GRACE_MS))]);
  }
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}

/** Human-readable multi-line rendering of one adapter's model list. */
export function formatModelsSnapshot(s: ModelsSnapshot): string {
  const header = `${s.adapter} (${s.source}, ${s.models.length} model${s.models.length === 1 ? "" : "s"}):`;
  if (s.models.length === 0) return `${header} (none)`;
  const lines = s.models.map((m) => {
    const bits: string[] = [];
    if (m.displayName && m.displayName !== m.id) bits.push(m.displayName);
    if (m.isDefault) bits.push("default");
    if (m.effortLevels && m.effortLevels.length > 0) {
      const def = m.defaultEffort ? `, default ${m.defaultEffort}` : "";
      bits.push(`effort: ${m.effortLevels.join("|")}${def}`);
    }
    if (m.serviceTiers && m.serviceTiers.length > 0) {
      bits.push(`tiers: ${m.serviceTiers.join("|")}`);
    }
    return `  - ${m.id}${bits.length > 0 ? ` (${bits.join("; ")})` : ""}`;
  });
  return [header, ...lines].join("\n");
}
