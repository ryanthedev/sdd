/**
 * Directory-scan adapter registry. Adding an adapter = drop a `*.ts` file in
 * this directory that exports the port members — there is no central list to
 * edit. `discoverAdapters` reads the directory, loads each candidate module,
 * validates it against the Adapter port, and returns the valid ones.
 *
 * Robustness contract (a server must never crash because of a bad adapter file):
 *   - missing / unreadable directory            -> []
 *   - empty directory                           -> []
 *   - a candidate that throws on import          -> stderr warning, skipped
 *   - a candidate missing a required export      -> stderr warning, skipped
 *   - infra files (this file, types.ts, …)       -> skipped silently
 * The function never throws.
 *
 * Loading is synchronous (createRequire) so the pinned `Adapter[]` return type
 * holds — Bun's require() resolves ESM/TS modules synchronously.
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { log } from "../lib/log.ts";
import type { Adapter } from "./types.ts";

const require = createRequire(import.meta.url);

/**
 * Filenames that live in the adapters directory but are NOT adapters. This set
 * is fixed and adapter-count-independent — adding an adapter never edits it, so
 * the "no central list to edit" invariant holds.
 */
const INFRA_FILES = new Set(["discover.ts", "types.ts"]);

/** Whether a directory entry is a candidate adapter file worth loading. */
function isCandidate(fileName: string): boolean {
  if (!fileName.endsWith(".ts")) return false;
  if (fileName.endsWith(".d.ts") || fileName.endsWith(".test.ts")) return false;
  if (fileName.startsWith(".") || fileName.startsWith("_")) return false;
  return !INFRA_FILES.has(fileName);
}

/**
 * Validate a loaded module against the Adapter port. Returns the assembled
 * Adapter on success, or the list of missing/malformed export names on failure
 * (so the caller can log exactly what was wrong).
 */
function toAdapter(mod: Record<string, unknown>): Adapter | { missing: string[] } {
  const missing: string[] = [];

  const name = mod.name;
  if (typeof name !== "string" || name.length === 0) missing.push("name");

  if (typeof mod.buildArgs !== "function") missing.push("buildArgs");
  if (typeof mod.injectContract !== "function") missing.push("injectContract");
  if (typeof mod.parseResult !== "function") missing.push("parseResult");

  // `binary` is optional, but if a module exports it, it must be a non-empty
  // string — a malformed override is a bug worth rejecting, not silently ignoring.
  const binary = mod.binary;
  if (binary !== undefined && (typeof binary !== "string" || binary.length === 0)) missing.push("binary");

  // `probeable` is optional, but if a module exports it, it must be a boolean —
  // a malformed live-probe policy is a bug worth rejecting, like `binary`.
  const probeable = mod.probeable;
  if (probeable !== undefined && typeof probeable !== "boolean") missing.push("probeable");

  if (missing.length > 0) return { missing };

  // Assemble a cohesive Adapter object rather than leaking the raw module
  // namespace, so downstream (Phase 2 JobStore) holds a single well-typed value.
  return {
    name: name as string,
    binary: typeof binary === "string" ? binary : undefined,
    probeable: typeof probeable === "boolean" ? probeable : undefined,
    buildArgs: mod.buildArgs as Adapter["buildArgs"],
    injectContract: mod.injectContract as Adapter["injectContract"],
    parseResult: mod.parseResult as Adapter["parseResult"],
  };
}

/**
 * Scan `dir` for adapter modules and return the valid ones. Never throws;
 * problems are reported to stderr and the offending file is skipped.
 */
export function discoverAdapters(dir: string): Adapter[] {
  const absDir = isAbsolute(dir) ? dir : resolve(dir);

  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch (e) {
    log(`adapter discovery: cannot read directory ${absDir} — ${errMessage(e)}`);
    return [];
  }

  const adapters: Adapter[] = [];
  const seen = new Set<string>();

  for (const fileName of entries.sort()) {
    if (!isCandidate(fileName)) continue;

    const filePath = join(absDir, fileName);
    let mod: Record<string, unknown>;
    try {
      mod = require(filePath) as Record<string, unknown>;
    } catch (e) {
      log(`adapter discovery: skipping ${fileName} — failed to load: ${errMessage(e)}`);
      continue;
    }

    const result = toAdapter(mod);
    if ("missing" in result) {
      log(`adapter discovery: skipping ${fileName} — missing/invalid export(s): ${result.missing.join(", ")}`);
      continue;
    }

    if (seen.has(result.name)) {
      log(`adapter discovery: skipping ${fileName} — duplicate adapter name "${result.name}"`);
      continue;
    }
    seen.add(result.name);
    adapters.push(result);
  }

  return adapters;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
