/**
 * JobStore — the core of the hexagon. It owns the one dangerous capability in
 * this system: spawning a caller-controlled work unit as a child process. Every
 * other component (the MCP tools in Phase 3, the adapters) stays pure or thin;
 * the spawn/lifecycle/reaping risk is contained here behind a small surface.
 *
 * Responsibilities (what this class hides from its callers):
 *   - spawning an adapter's argv as a child process in the caller's cwd,
 *   - streaming the child's stdout+stderr to a per-job log file,
 *   - tracking the pid / process group and reaping it on cancel/shutdown,
 *   - on exit, running the adapter's parseResult into an AdapterResult and
 *     deciding done vs failed (exit code AND contract-marker validation),
 *   - the write-write concurrency guard (one writer per cwd).
 *
 * SECURITY (barricade design): `dispatch` is the trust boundary. prompt/opts are
 * untrusted. The child is spawned from an argv ARRAY with an explicit cwd and
 * `shell:false` — never a shell string — so a prompt containing shell
 * metacharacters is passed as literal argument text and can never be evaluated.
 * A runtime guard rejects any non-array / non-string argv from buildArgs, so the
 * type-level `string[]` guarantee cannot be bypassed by a malformed adapter.
 *
 * Clean Architecture: this depends inward on the core types and the Adapter port
 * only. It does not know about MCP, tools, or discovery.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { type WriteStream, closeSync, createWriteStream, mkdirSync, mkdtempSync, openSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Adapter } from "../adapters/types.ts";
import type { AdapterMode, AdapterResult, DispatchOpts, Job } from "../types.ts";
import { newJobId } from "./ids.ts";
import { log } from "./log.ts";

/** Default `wait` timeout when the caller passes none — short, poll-friendly. */
const DEFAULT_WAIT_MS = 30_000;
/** Documented upper bound for a single `wait` block (10 minutes). */
const MAX_WAIT_MS = 600_000;

/** Tunables for a JobStore instance. All optional; sane defaults for production. */
export interface JobStoreOptions {
  /** Root dir for per-job log files. Defaults to a fresh mkdtemp under the OS tmp dir. */
  logDir?: string;
  /** Install SIGINT/SIGTERM handlers that reap children. Off by default so unit tests don't leak listeners; the server turns it on. */
  installSignalHandlers?: boolean;
  /** `wait` timeout used when the caller passes none. */
  defaultTimeoutMs?: number;
  /** Hard cap a caller's `wait` timeout is clamped to. */
  maxTimeoutMs?: number;
}

/** Partial view returned by `wait`. `unknown` reports ids that name no tracked job. */
export interface WaitResult {
  done: string[];
  stillRunning: string[];
  unknown: string[];
}

/**
 * Internal runtime record. The public `Job` (plain data) is exposed via `get`;
 * everything else here — the child handle, output buffers, the completion
 * promise — is machinery the caller never sees.
 */
interface TrackedJob {
  job: Job;
  adapter: Adapter;
  child: ChildProcess;
  logStream: WriteStream;
  stdout: string[];
  stderr: string[];
  /** Guards against finalizing twice (both `close` and `error` can fire). */
  settled: boolean;
  /** Resolves when the job reaches a terminal state (done | failed). */
  done: Promise<void>;
  resolveDone: () => void;
}

export class JobStore {
  readonly #jobs = new Map<string, TrackedJob>();
  readonly #logDir: string;
  readonly #defaultTimeoutMs: number;
  readonly #maxTimeoutMs: number;
  #signalHandlers?: { sigint: () => void; sigterm: () => void };
  #shuttingDown = false;

  constructor(opts: JobStoreOptions = {}) {
    this.#logDir = opts.logDir ?? mkdtempLogDir();
    this.#defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_WAIT_MS;
    this.#maxTimeoutMs = opts.maxTimeoutMs ?? MAX_WAIT_MS;
    if (opts.installSignalHandlers) this.#installSignalHandlers();
  }

  // ── Public surface (consumed verbatim by the Phase 3 tools) ──────────────

  /**
   * Spawn `adapter`'s work unit as a child process and start tracking it.
   * Returns the job id SYNCHRONOUSLY — the child runs asynchronously; the caller
   * polls with `get`/`wait`. Throws (fails fast, no job created) on invalid
   * input, a write-write conflict, a bad cwd, or an unwritable log file.
   */
  dispatch(adapter: Adapter, prompt: string, opts: DispatchOpts = {}): string {
    // Barricade: validate all untrusted/boundary input before doing anything.
    this.#assertValidAdapter(adapter);
    if (typeof prompt !== "string") throw new TypeError("dispatch: prompt must be a string");

    const cwd = this.#resolveCwd(opts.cwd);
    const mode: AdapterMode = opts.mode ?? adapter.mode;
    this.#assertNoWriteConflict(mode, cwd, adapter.name);

    const argv = this.#buildArgv(adapter, prompt, opts);

    const id = newJobId();
    const logPath = this.#openLogPath(id);

    this.#spawnAndTrack(id, adapter, mode, cwd, logPath, argv);
    return id;
  }

  /** Snapshot of a job's public state, or undefined for an unknown id. */
  get(jobId: string): Job | undefined {
    const tracked = this.#jobs.get(jobId);
    if (!tracked) return undefined;
    return { ...tracked.job }; // copy — callers never mutate internal state
  }

  /**
   * Block until every known job in `jobIds` is terminal, or until `timeoutMs`
   * elapses — whichever comes first. Never blocks past the (clamped) timeout.
   * Returns a partial classification; unknown ids are reported, not thrown.
   */
  async wait(jobIds: string[], timeoutMs?: number): Promise<WaitResult> {
    const timeout = this.#clampTimeout(timeoutMs);

    const known: TrackedJob[] = [];
    const unknown: string[] = [];
    for (const id of jobIds) {
      const tracked = this.#jobs.get(id);
      if (tracked) known.push(tracked);
      else unknown.push(id);
    }
    if (unknown.length > 0) log(`wait: unknown job id(s): ${unknown.join(", ")}`);

    if (known.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timed = new Promise<void>((res) => {
        timer = setTimeout(res, timeout);
        timer.unref?.(); // a pending wait-timer must not keep the process alive
      });
      await Promise.race([Promise.all(known.map((t) => t.done)), timed]);
      if (timer) clearTimeout(timer);
    }

    const done: string[] = [];
    const stillRunning: string[] = [];
    for (const tracked of known) {
      if (tracked.job.state === "running") stillRunning.push(tracked.job.id);
      else done.push(tracked.job.id);
    }
    return { done, stillRunning, unknown };
  }

  /**
   * Terminate a running job's entire process group (child + any grandchildren)
   * and wait for it to be reaped. No-op (returns false) for an unknown or
   * already-terminal job. The job settles to `failed` via the signal path.
   */
  async cancel(jobId: string): Promise<boolean> {
    const tracked = this.#jobs.get(jobId);
    if (!tracked) {
      log(`cancel: unknown job id ${jobId}`);
      return false;
    }
    if (tracked.job.state !== "running") return false;
    this.#killGroup(tracked);
    await tracked.done;
    return true;
  }

  /**
   * Kill every tracked running child (whole process group each) and wait for
   * them all to be reaped. Idempotent. Removes any installed signal handlers.
   * After this resolves, no tracked child pid is alive.
   */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#removeSignalHandlers();

    const running = [...this.#jobs.values()].filter((t) => t.job.state === "running");
    for (const tracked of running) this.#killGroup(tracked);
    await Promise.all(running.map((t) => t.done));
  }

  // ── Dispatch helpers (each one operation; callers pass validated data) ────

  #assertValidAdapter(adapter: Adapter): void {
    if (!adapter || typeof adapter !== "object") throw new TypeError("dispatch: adapter must be an object");
    if (typeof adapter.name !== "string" || adapter.name.length === 0) {
      throw new TypeError("dispatch: adapter.name must be a non-empty string");
    }
    if (adapter.mode !== "read" && adapter.mode !== "write") {
      throw new TypeError('dispatch: adapter.mode must be "read" or "write"');
    }
    for (const fn of ["buildArgs", "injectContract", "parseResult"] as const) {
      if (typeof adapter[fn] !== "function") throw new TypeError(`dispatch: adapter.${fn} must be a function`);
    }
  }

  /** Resolve + validate the working directory the child will run in. */
  #resolveCwd(cwd: string | undefined): string {
    const target = cwd ? (isAbsolute(cwd) ? cwd : resolve(cwd)) : process.cwd();
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(target);
    } catch {
      throw new Error(`dispatch: cwd does not exist: ${target}`);
    }
    if (!stat.isDirectory()) throw new Error(`dispatch: cwd is not a directory: ${target}`);
    return target;
  }

  /** Refuse a second concurrent WRITE job in the same cwd (serialize writes). */
  #assertNoWriteConflict(mode: AdapterMode, cwd: string, adapterName: string): void {
    if (mode !== "write") return;
    for (const tracked of this.#jobs.values()) {
      const { job } = tracked;
      if (job.state === "running" && job.mode === "write" && job.cwd === cwd) {
        throw new Error(
          `write-write conflict: job ${job.id} (${job.adapter}) is already writing in ${cwd}. ` +
            `Serialize writes — wait for it to finish or cancel it before dispatching "${adapterName}".`,
        );
      }
    }
  }

  /**
   * Inject the output contract, build the argv, and enforce the security
   * invariant: buildArgs MUST yield a non-empty array of strings. This runtime
   * guard backs the type-level `string[]` guarantee — no shell string, no
   * non-string element can reach `spawn`.
   */
  #buildArgv(adapter: Adapter, prompt: string, opts: DispatchOpts): string[] {
    const contracted = adapter.injectContract(prompt);
    const argv = adapter.buildArgs(contracted, opts);
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new TypeError(`dispatch: adapter "${adapter.name}" buildArgs must return a non-empty argv array`);
    }
    for (const arg of argv) {
      if (typeof arg !== "string") {
        throw new TypeError(
          `dispatch: adapter "${adapter.name}" buildArgs must return only strings (argv array, never a shell string)`,
        );
      }
    }
    return argv;
  }

  /** Ensure the log dir exists and the per-job log is writable — fail fast if not. */
  #openLogPath(id: string): string {
    try {
      mkdirSync(this.#logDir, { recursive: true });
    } catch (e) {
      throw new Error(`dispatch: cannot create log directory ${this.#logDir}: ${errMessage(e)}`);
    }
    const logPath = join(this.#logDir, `${id}.log`);
    try {
      closeSync(openSync(logPath, "a")); // touch to prove writability before spawning
    } catch (e) {
      throw new Error(`dispatch: cannot open log file ${logPath}: ${errMessage(e)}`);
    }
    return logPath;
  }

  /** Spawn the child (no shell, new process group), wire streaming + exit handling. */
  #spawnAndTrack(
    id: string,
    adapter: Adapter,
    mode: AdapterMode,
    cwd: string,
    logPath: string,
    argv: string[],
  ): void {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      detached: true, // new process group → cancel/shutdown can kill the whole group
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env, // harness needs credentials; env is NEVER written to the log
      shell: false, // explicit: the prompt is data, never interpreted by a shell
    });

    const logStream = createWriteStream(logPath, { flags: "a" });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk.toString());
      logStream.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString());
      logStream.write(chunk);
    });

    const job: Job = {
      id,
      adapter: adapter.name,
      mode,
      cwd,
      state: "running",
      logPath,
      createdAt: Date.now(),
    };

    let resolveDone!: () => void;
    const done = new Promise<void>((res) => {
      resolveDone = res;
    });
    const tracked: TrackedJob = { job, adapter, child, logStream, stdout, stderr, settled: false, done, resolveDone };
    this.#jobs.set(id, tracked);

    const finalize = (finish: () => void): void => {
      if (tracked.settled) return;
      tracked.settled = true;
      logStream.end();
      finish();
      tracked.resolveDone();
    };

    child.on("close", (code, signal) => finalize(() => this.#classify(tracked, code, signal)));
    child.on("error", (err) =>
      finalize(() => {
        job.state = "failed";
        job.result = { status: "failed", summary: `spawn error: ${err.message}`, artifacts: [], raw: stdout.join("") };
      }),
    );
  }

  /**
   * Decide a finished job's terminal state. A signal kill → `failed` (never
   * trust a parser on a job we terminated). Otherwise the adapter's parseResult
   * drives it — a missing contract marker yields `failed` even on exit 0 (the
   * silent-misparse backstop). A throwing parser is contained → `failed`.
   */
  #classify(tracked: TrackedJob, code: number | null, signal: NodeJS.Signals | null): void {
    const { job, adapter } = tracked;
    const stdout = tracked.stdout.join("");
    const stderr = tracked.stderr.join("");

    if (signal) {
      job.state = "failed";
      job.result = { status: "failed", summary: `terminated by signal ${signal}`, artifacts: [], raw: stdout };
      return;
    }

    const exitCode = code ?? -1;
    job.exitCode = exitCode;

    let result: AdapterResult;
    try {
      result = adapter.parseResult(stdout, stderr, exitCode);
    } catch (e) {
      job.state = "failed";
      job.result = { status: "failed", summary: `parseResult threw: ${errMessage(e)}`, artifacts: [], raw: stdout };
      return;
    }

    job.result = result;
    job.state = result.status === "done" ? "done" : "failed";
  }

  /** SIGKILL a job's whole process group; fall back to the bare pid if the group is gone. */
  #killGroup(tracked: TrackedJob): void {
    const pid = tracked.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL"); // negative pid = the process group led by the detached child
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* process already exited — nothing to kill */
      }
    }
  }

  #clampTimeout(ms: number | undefined): number {
    if (typeof ms !== "number" || Number.isNaN(ms)) return this.#defaultTimeoutMs;
    return Math.min(Math.max(ms, 0), this.#maxTimeoutMs);
  }

  // ── Signal handling (opt-in; the server owns process.exit, this only reaps) ─

  #installSignalHandlers(): void {
    const reap = (signal: NodeJS.Signals): void => {
      log(`JobStore: received ${signal}, reaping tracked children`);
      void this.shutdown();
    };
    const sigint = (): void => reap("SIGINT");
    const sigterm = (): void => reap("SIGTERM");
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);
    this.#signalHandlers = { sigint, sigterm };
  }

  #removeSignalHandlers(): void {
    if (!this.#signalHandlers) return;
    process.off("SIGINT", this.#signalHandlers.sigint);
    process.off("SIGTERM", this.#signalHandlers.sigterm);
    this.#signalHandlers = undefined;
  }
}

/** Create a fresh private temp dir for this store's job logs. */
function mkdtempLogDir(): string {
  return mkdtempSync(join(tmpdir(), "sdd-jobs-"));
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
