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
import { DEFAULT_KIND } from "./types.ts";
import type { Adapter, Capability, LimitsProbe } from "./types.ts";

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

  // Two accepted module shapes (see AdapterModule in types.ts): a `capabilities`
  // record for a harness that does several things, or the three port functions
  // flat for one that does one. Flat is normalized into a single DEFAULT_KIND
  // capability here so the rest of the system only ever sees `capabilities` —
  // one code path downstream, no per-adapter special-casing.
  //
  // When BOTH are present, `capabilities` wins and the flat exports are just
  // ordinary module functions. There is no ambiguity to protect against: the
  // record explicitly names what runs, and a multi-capability adapter naturally
  // wants `export function buildArgs` for its own default kind (agy does) plus
  // the ability to unit-test that function by name.
  const capabilities = toCapabilities(mod.capabilities);

  if (mod.capabilities !== undefined) {
    if (!capabilities) missing.push("capabilities");
  } else {
    if (typeof mod.buildArgs !== "function") missing.push("buildArgs");
    if (typeof mod.injectContract !== "function") missing.push("injectContract");
    if (typeof mod.parseResult !== "function") missing.push("parseResult");
  }

  // A declared default that names a capability the adapter doesn't have would
  // fail only at dispatch time, on a caller who omitted `kind` — reject at load.
  const defaultKind = mod.defaultKind;
  if (defaultKind !== undefined) {
    if (typeof defaultKind !== "string" || defaultKind.length === 0) missing.push("defaultKind");
    else if (capabilities && !capabilities[defaultKind]) {
      missing.push(`defaultKind ("${defaultKind}" is not one of: ${Object.keys(capabilities).join(", ")})`);
    }
  }

  // `binary` is optional, but if a module exports it, it must be a non-empty
  // string — a malformed override is a bug worth rejecting, not silently ignoring.
  const binary = mod.binary;
  if (binary !== undefined && (typeof binary !== "string" || binary.length === 0)) missing.push("binary");

  // `probeable` is optional, but if a module exports it, it must be a boolean —
  // a malformed live-probe policy is a bug worth rejecting, like `binary`.
  const probeable = mod.probeable;
  if (probeable !== undefined && typeof probeable !== "boolean") missing.push("probeable");

  // The account-limits capability is optional but ALL-OR-NOTHING: a probe
  // without a parser yields an unusable raw blob, and a parser without a probe
  // is dead code. Either both are well-formed or neither is present; anything
  // else is a malformed adapter and the file is skipped with a warning rather
  // than silently half-loaded.
  const readLimits = mod.readLimits;
  const parseLimits = mod.parseLimits;
  if (readLimits !== undefined || parseLimits !== undefined) {
    if (!isLimitsProbe(readLimits)) missing.push("readLimits");
    if (typeof parseLimits !== "function") missing.push("parseLimits");
  }

  if (missing.length > 0) return { missing };

  // Assemble a cohesive Adapter object rather than leaking the raw module
  // namespace, so downstream (Phase 2 JobStore) holds a single well-typed value.
  return {
    name: name as string,
    binary: typeof binary === "string" ? binary : undefined,
    probeable: typeof probeable === "boolean" ? probeable : undefined,
    capabilities: capabilities ?? {
      [DEFAULT_KIND]: {
        buildArgs: mod.buildArgs as Capability["buildArgs"],
        injectContract: mod.injectContract as Capability["injectContract"],
        parseResult: mod.parseResult as Capability["parseResult"],
      },
    },
    defaultKind: typeof defaultKind === "string" ? defaultKind : undefined,
    readLimits: isLimitsProbe(readLimits) ? readLimits : undefined,
    parseLimits: typeof parseLimits === "function" ? (parseLimits as Adapter["parseLimits"]) : undefined,
  };
}

/**
 * Structural check for a `capabilities` export. Every value must carry all
 * three port functions — a half-declared capability would pass discovery and
 * then throw inside the JobStore, turning an authoring mistake into a runtime
 * crash on a caller's dispatch. Returns null when the export is present but
 * malformed, so `toAdapter` can report it as missing.
 */
function toCapabilities(value: unknown): Record<string, Capability> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;

  const out: Record<string, Capability> = {};
  for (const [kind, raw] of entries) {
    if (kind.length === 0) return null;
    if (typeof raw !== "object" || raw === null) return null;
    const cap = raw as Record<string, unknown>;
    if (typeof cap.buildArgs !== "function") return null;
    if (typeof cap.injectContract !== "function") return null;
    if (typeof cap.parseResult !== "function") return null;
    out[kind] = {
      buildArgs: cap.buildArgs as Capability["buildArgs"],
      injectContract: cap.injectContract as Capability["injectContract"],
      parseResult: cap.parseResult as Capability["parseResult"],
    };
  }
  return out;
}

/**
 * Structural check for the LimitsProbe literal. Validated here rather than
 * trusted because `limits.ts` spawns `binary` with `args`: a malformed literal
 * must be rejected at load time, not discovered at spawn time.
 */
function isLimitsProbe(value: unknown): value is LimitsProbe {
  if (typeof value !== "object" || value === null) return false;
  const probe = value as Record<string, unknown>;
  if (probe.transport !== "app-server-jsonrpc") return false;
  if (typeof probe.binary !== "string" || probe.binary.length === 0) return false;
  if (typeof probe.method !== "string" || probe.method.length === 0) return false;
  return Array.isArray(probe.args) && probe.args.every((a) => typeof a === "string");
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
