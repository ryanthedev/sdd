/**
 * DW-1.4: discoverAdapters() returns [] for an empty dir and skips (with a
 * stderr warning) a file missing a required export, without throwing. Plus the
 * plan's edge cases: missing dir, import throw, infra-file exclusion, and a
 * valid adapter round-trip.
 *
 * Fixtures are written to a fresh mkdtemp dir per test so module paths are
 * unique (no require-cache collisions across tests).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAdapters } from "../src/adapters/discover.ts";
import type { Adapter } from "../src/adapters/types.ts";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sdd-adapters-"));
  tmpDirs.push(d);
  return d;
}
function writeAdapterFile(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), body, "utf8");
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Capture everything the code logs to stderr (console.error) during `fn`. */
function captureStderr(fn: () => void): string[] {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

const VALID_ADAPTER = `
export const name = "fixture";
export function buildArgs(prompt, opts) { return ["exec", prompt]; }
export function injectContract(prompt) { return prompt + "\\nVERDICT:"; }
export function parseResult(stdout, stderr, exitCode) {
  return { status: exitCode === 0 ? "done" : "failed", summary: stdout, artifacts: [], raw: stdout };
}
`;

test("test_DW_1_4_empty_dir_returns_empty", () => {
  const dir = freshDir();
  let adapters: Adapter[] | undefined;
  const logs = captureStderr(() => {
    adapters = discoverAdapters(dir);
  });
  expect(adapters).toEqual([]);
  expect(logs).toEqual([]); // an empty dir is not an error
});

test("test_DW_1_4_missing_dir_returns_empty_and_warns_no_throw", () => {
  const missing = join(tmpdir(), "sdd-does-not-exist-" + Math.random().toString(36).slice(2));
  let adapters: Adapter[] | undefined;
  const logs = captureStderr(() => {
    expect(() => {
      adapters = discoverAdapters(missing);
    }).not.toThrow();
  });
  expect(adapters).toEqual([]);
  expect(logs.some((l) => l.includes("cannot read directory"))).toBe(true);
});

test("test_DW_1_4_missing_export_is_skipped_with_warning_no_throw", () => {
  const dir = freshDir();
  // Declares name but omits buildArgs / injectContract / parseResult.
  writeAdapterFile(dir, "broken.ts", `export const name = "broken";\n`);

  let adapters: Adapter[] | undefined;
  const logs = captureStderr(() => {
    expect(() => {
      adapters = discoverAdapters(dir);
    }).not.toThrow();
  });

  expect(adapters).toEqual([]);
  const warning = logs.find((l) => l.includes("broken.ts"));
  expect(warning).toBeDefined();
  expect(warning).toContain("missing/invalid export");
  expect(warning).toContain("buildArgs");
});

test("test_DW_1_4_valid_adapter_is_discovered", () => {
  const dir = freshDir();
  writeAdapterFile(dir, "good.ts", VALID_ADAPTER);

  let adapters = discoverAdapters(dir);
  expect(adapters.length).toBe(1);
  const a = adapters[0]!;
  expect(a.name).toBe("fixture");
  expect(a.buildArgs("hello", {})).toEqual(["exec", "hello"]);
  expect(a.injectContract("hi")).toContain("VERDICT:");
  expect(a.parseResult("out", "", 0)).toEqual({ status: "done", summary: "out", artifacts: [], raw: "out" });
});

test("test_DW_1_4_infra_files_skipped_silently", () => {
  const dir = freshDir();
  // These share the adapters dir in production and must never be treated as
  // adapters — nor warned about (they are not malformed adapters).
  writeAdapterFile(dir, "types.ts", `export const something = 1;\n`);
  writeAdapterFile(dir, "discover.ts", `export function discoverAdapters() { return []; }\n`);
  writeAdapterFile(dir, "good.ts", VALID_ADAPTER);

  let adapters: Adapter[] | undefined;
  const logs = captureStderr(() => {
    adapters = discoverAdapters(dir);
  });
  expect(adapters!.map((a) => a.name)).toEqual(["fixture"]);
  expect(logs).toEqual([]); // infra files skipped silently, no noise
});

test("test_DW_1_4_import_throw_is_skipped_with_warning", () => {
  const dir = freshDir();
  writeAdapterFile(dir, "explodes.ts", `throw new Error("boom on import");\n`);
  writeAdapterFile(dir, "good.ts", VALID_ADAPTER);

  let adapters: Adapter[] | undefined;
  const logs = captureStderr(() => {
    expect(() => {
      adapters = discoverAdapters(dir);
    }).not.toThrow();
  });

  expect(adapters!.map((a) => a.name)).toEqual(["fixture"]); // the good one still loads
  const warning = logs.find((l) => l.includes("explodes.ts"));
  expect(warning).toBeDefined();
  expect(warning).toContain("failed to load");
});

test("probeable=false is threaded through discovery onto the Adapter", () => {
  const dir = freshDir();
  writeAdapterFile(
    dir,
    "opts-out.ts",
    VALID_ADAPTER.replace('name = "fixture"', 'name = "opts-out"') + "\nexport const probeable = false;\n",
  );

  const adapters = discoverAdapters(dir);
  expect(adapters.length).toBe(1);
  expect(adapters[0]!.probeable).toBe(false);
});

test("a malformed probeable export is rejected — the adapter is skipped with a warning", () => {
  const dir = freshDir();
  // probeable must be a boolean; a string is malformed and rejected (like binary).
  writeAdapterFile(dir, "bad-probeable.ts", VALID_ADAPTER + '\nexport const probeable = "yes";\n');

  let adapters: Adapter[] | undefined;
  const logs = captureStderr(() => {
    adapters = discoverAdapters(dir);
  });

  expect(adapters).toEqual([]);
  const warning = logs.find((l) => l.includes("bad-probeable.ts"));
  expect(warning).toBeDefined();
  expect(warning).toContain("missing/invalid export");
  expect(warning).toContain("probeable");
});

test("test_DW_1_4_duplicate_adapter_name_is_skipped_with_warning", () => {
  const dir = freshDir();
  writeAdapterFile(dir, "a-first.ts", VALID_ADAPTER);
  writeAdapterFile(dir, "b-second.ts", VALID_ADAPTER); // same name "fixture"

  let adapters: Adapter[] | undefined;
  const logs = captureStderr(() => {
    adapters = discoverAdapters(dir);
  });
  expect(adapters!.length).toBe(1); // only the first wins
  expect(logs.some((l) => l.includes("duplicate adapter name"))).toBe(true);
});
