/**
 * Runtime — the shared state the six MCP tools operate on: one `JobStore`
 * instance (spawn/lifecycle/reaping, owned by Phase 2) plus the directory the
 * adapters are discovered from. Kept as a plain data holder (no methods, no
 * hidden behavior) so each tool factory can depend on exactly the two things
 * it needs and tests can construct an isolated `Runtime` pointing at a
 * throwaway adapters dir + a throwaway JobStore log dir.
 *
 * `listAdapters`/`findAdapter` are free functions rather than Runtime methods:
 * they call `discoverAdapters` fresh on every invocation (directory-scan
 * discovery is designed to pick up a newly dropped adapter file without a
 * restart — see Phase 1), so there is no cache to keep in sync with Runtime.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAdapters } from "../adapters/discover.ts";
import type { Adapter } from "../adapters/types.ts";
import { JobStore, type JobStoreOptions } from "../lib/jobs.ts";

/** `src/adapters` resolved relative to this module — the production adapters dir. */
const DEFAULT_ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters");

export interface Runtime {
  jobStore: JobStore;
  adaptersDir: string;
}

export interface RuntimeOptions {
  /** Override for tests — a temp dir with fixture adapter files. */
  adaptersDir?: string;
  jobStoreOptions?: JobStoreOptions;
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  return {
    jobStore: new JobStore(opts.jobStoreOptions),
    adaptersDir: opts.adaptersDir ?? DEFAULT_ADAPTERS_DIR,
  };
}

export function listAdapters(rt: Runtime): Adapter[] {
  return discoverAdapters(rt.adaptersDir);
}

export function findAdapter(rt: Runtime, name: string): Adapter | undefined {
  return listAdapters(rt).find((a) => a.name === name);
}
