/**
 * `decide` — a command-line entry to the gemini adapter's default kind, for
 * callers that are not MCP clients (for example a CLI tool such as alsp, https://github.com/ryanthedev/agent-lsp).
 *
 *   bun run src/cli/decide.ts [--timeout-ms N] [--model M] [--] <request.json> [<results.json>]
 *
 * It runs the SAME code path the MCP server uses: the gemini adapter's default
 * work unit through a JobStore with `appendLedger` as its sink. So argv
 * validation, hermetic spawn, the script's budget refusal, usage parsing and
 * the one spend line per job are all existing code; nothing is reimplemented
 * here. This is the second caller of the ledger's single writer module
 * (docs/usage-contract.md section 3).
 *
 * Exit codes: 0 done (stdout = the absolute results path, nothing else);
 * 1 the job failed (stderr = the adapter's summary, which carries the script's
 * reason, e.g. `budget exceeded`); 2 usage error (nothing was spawned).
 * SIGTERM/SIGINT: the job's process group is terminated so the script flushes
 * its usage marker, the spend line is still written, and the exit code is 1.
 *
 * The results JSON format is documented in assets/gemini-decide.ts. stdout is
 * reserved for the results path; every diagnostic goes to stderr.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as gemini from "../adapters/gemini.ts";
import { type Adapter, resolveWorkUnit } from "../adapters/types.ts";
import { appendLedger } from "../lib/ledger.ts";
import { JobStore } from "../lib/jobs.ts";
import type { DispatchOpts } from "../types.ts";

export const EXIT_DONE = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** A caller (often an unattended program) must not hang forever on a stuck script. */
const DEFAULT_TIMEOUT_MS = 600_000;

const USAGE = "usage: bun run src/cli/decide.ts [--timeout-ms N] [--model M] [--] <request.json> [<results.json>]";

export interface DecideIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processIo: DecideIo = {
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
};

interface Parsed {
  request: string;
  results: string | undefined;
  opts: DispatchOpts;
}

/** Parse and validate argv; throws a message-bearing Error for every usage problem. */
function parse(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "timeout-ms": { type: "string" }, model: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length < 1 || positionals.length > 2) throw new Error("expected a request file path and an optional results path");

  const request = positionals[0] as string;
  // Inline JSON is a server feature; here the request is always a file, so a
  // `{`-prefixed argument can only be a mistake.
  if (request.trim().startsWith("{")) throw new Error("the request must be a file path, not inline JSON");

  const opts: DispatchOpts = { timeoutMs: DEFAULT_TIMEOUT_MS, cwd: process.cwd() };
  if (values["timeout-ms"] !== undefined) {
    const raw = values["timeout-ms"];
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) throw new Error(`--timeout-ms must be a positive integer, got: ${JSON.stringify(raw)}`);
    opts.timeoutMs = n;
  }
  if (values.model !== undefined) opts.model = values.model;
  if (positionals[1] !== undefined) opts.outputPath = positionals[1];
  return { request, results: positionals[1], opts };
}

/**
 * Run one decision job to completion and return the process exit code.
 * Never throws: every failure maps to an exit code plus a stderr line.
 */
export async function runDecide(argv: string[], io: DecideIo = processIo): Promise<number> {
  let parsed: Parsed;
  const resolved = resolveWorkUnit(gemini as Adapter);
  if ("error" in resolved) {
    io.stderr(`decide: ${resolved.error}\n`);
    return EXIT_USAGE;
  }
  try {
    parsed = parse(argv);
    // The adapter's own barricade (leading '-', control chars, '..' escape, bad
    // model id, non-path prompt) runs here too, before anything is spawned.
    resolved.buildArgs(resolved.injectContract(parsed.request), parsed.opts);
    const file = resolve(parsed.opts.cwd as string, parsed.request.trim());
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`request file not found: ${file}`);
  } catch (e) {
    io.stderr(`decide: ${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  const timeoutMs = parsed.opts.timeoutMs as number;
  const logDir = mkdtempSync(join(tmpdir(), "sdd-decide-"));
  const store = new JobStore({ logDir, maxTimeoutMs: timeoutMs, ledger: (entry) => appendLedger(entry) });

  let signalled: NodeJS.Signals | null = null;
  const onSignal = (sig: NodeJS.Signals): void => {
    signalled ??= sig;
    void store.shutdown();
  };
  const onTerm = (): void => onSignal("SIGTERM");
  const onInt = (): void => onSignal("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  try {
    const id = store.dispatch(resolved, parsed.request, parsed.opts);
    const w = await store.wait([id], timeoutMs);
    let timedOut = false;
    if (w.stillRunning.length > 0) {
      timedOut = true;
      await store.cancel(id); // settles the job; its spend line is still written
    }
    const job = store.get(id);
    const result = job?.result;
    if (job?.state === "done" && result && result.artifacts[0] && !signalled) {
      io.stdout(`${result.artifacts[0]}\n`);
      rmSync(logDir, { recursive: true, force: true });
      return EXIT_DONE;
    }
    const why = signalled ? `cancelled by ${signalled}` : timedOut ? `timed out after ${timeoutMs}ms` : (result?.summary ?? "job failed without a result");
    io.stderr(`decide: ${why}${job ? ` (log: ${job.logPath})` : ""}\n`);
    return EXIT_FAILED;
  } catch (e) {
    // dispatch throws only on a bad cwd or an unwritable log dir; a TypeError is the adapter rejecting input.
    io.stderr(`decide: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof TypeError ? EXIT_USAGE : EXIT_FAILED;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
}

if (import.meta.main) {
  process.exitCode = await runDecide(process.argv.slice(2));
}
