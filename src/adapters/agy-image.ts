/**
 * agy-image adapter — Nano Banana image generation harness. Single contract:
 * prompt in, one PNG at an explicit absolute path out (reported in
 * `artifacts`). Separate file from `agy.ts` on purpose: one output contract
 * per adapter keeps marker validation unambiguous (see plan Decision Log).
 *
 * `mode: "read"` — the PNG lands at an explicit external artifact path the
 * caller names, never in the source tree, so this does not count as a
 * working-tree write for the JobStore write-write guard.
 *
 * PATH LANDMINE (grug note): agy resolves a relative output filename by
 * searching all of /Users, not the job cwd. `buildArgs` therefore resolves
 * `opts.outputPath` to an absolute path itself, before it ever reaches argv
 * / spawn — never delegates that resolution to the harness.
 *
 * `parseResult(stdout, stderr, exitCode)` receives no `opts` (confirmed by
 * reading JobStore's call sequence in src/lib/jobs.ts), so it cannot look up
 * the caller's intended path independently. Design: `buildArgs` passes the
 * resolved absolute path to the CLI via a real `--out <path>` flag; the
 * injected contract asks the harness to echo that same path back in an
 * `AGY_IMAGE_SAVED:` marker line. `parseResult` extracts the path from that
 * marker and independently verifies the file exists on disk — proving the
 * harness actually wrote something rather than just exiting 0. Like agy.ts,
 * the marker is matched LAST-occurrence-wins (not first), since the injected
 * contract text itself could in principle be echoed back before the real
 * verdict line; taking the last match keeps this adapter consistent with the
 * documented "last line of output" contract.
 *
 * PATH-TRAVERSAL BARRICADE: `opts.outputPath` is untrusted MCP-client input
 * (see below). Beyond the `.png`-suffix check, a RELATIVE `outputPath`
 * resolved against the job cwd is additionally required to stay within that
 * cwd — a `../`-laden relative path that would resolve outside the cwd is
 * rejected with a `TypeError` before it ever reaches argv/spawn. An already-
 * absolute `outputPath` is a caller specifying an explicit target directly
 * (not a traversal) and passes through unchanged, as before.
 */
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Adapter } from "./types.ts";
import type { AdapterMode, AdapterResult, DispatchOpts } from "../types.ts";

export const name = "agy-image";
export const mode: AdapterMode = "read";

/**
 * Marker line the harness must echo, containing the absolute save path. `g`
 * so every occurrence can be enumerated and the LAST one taken (see
 * `lastMarkerMatch` in agy.ts for why first-match is unsafe).
 */
const SAVED_MARKER_RE = /^AGY_IMAGE_SAVED:\s*(.+)$/gm;

function lastMarkerMatch(re: RegExp, text: string): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(re)) last = m;
  return last;
}

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const outPath = resolveOutputPath(opts);
  return ["agy", "--image", "--out", outPath, "--print", prompt];
}

export function injectContract(prompt: string): string {
  return (
    `${prompt}\n\n` +
    "Save the generated PNG to the exact path passed via --out. When done, print " +
    "exactly one line, the last line of output, in this exact form:\n" +
    "AGY_IMAGE_SAVED: <the absolute path you saved the PNG to>"
  );
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  const match = lastMarkerMatch(SAVED_MARKER_RE, stdout);
  if (!match) {
    return {
      status: "failed",
      summary: "agy-image: missing AGY_IMAGE_SAVED marker in output (silent-misparse backstop)",
      artifacts: [],
      raw: stdout,
    };
  }
  const savedPath = match[1]!.trim();
  if (exitCode !== 0) {
    return { status: "failed", summary: `agy-image: exited with code ${exitCode}`, artifacts: [], raw: stdout };
  }
  if (!existsSync(savedPath)) {
    return {
      status: "failed",
      summary: `agy-image: reported output file does not exist: ${savedPath}`,
      artifacts: [],
      raw: stdout,
    };
  }
  return { status: "done", summary: `agy-image: saved PNG to ${savedPath}`, artifacts: [savedPath], raw: stdout };
}

/**
 * Validate + resolve `opts.outputPath` to an absolute PNG path. Untrusted
 * external input (an MCP client's opts) — validated at entry: required,
 * non-empty string, `.png` extension. Relative paths are resolved against
 * `opts.cwd` (mirroring JobStore's own cwd resolution) or `process.cwd()` —
 * this is the fix for the grug-noted landmine where a relative filename
 * handed to agy triggers a search across all of /Users.
 *
 * BARRICADE: a relative `outputPath` is additionally required to resolve to
 * a location INSIDE that base cwd — a `../`-laden relative path (or one
 * disguised with intermediate segments) that would resolve outside the cwd
 * is rejected here, before it ever reaches argv/spawn, rather than trusting
 * the `.png`-suffix check alone. An already-absolute `outputPath` is treated
 * as an explicit caller-specified target and passes through unchanged (not a
 * traversal — the caller named that exact path, not an escape from cwd).
 */
function resolveOutputPath(opts: DispatchOpts): string {
  const raw = opts.outputPath;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError("agy-image: opts.outputPath must be a non-empty string (an absolute or relative .png path)");
  }
  if (!raw.toLowerCase().endsWith(".png")) {
    throw new TypeError(`agy-image: opts.outputPath must end with .png, got: ${raw}`);
  }
  if (isAbsolute(raw)) return raw;
  const base = typeof opts.cwd === "string" && opts.cwd.length > 0 ? resolveBase(opts.cwd) : process.cwd();
  const resolved = resolve(base, raw);
  assertContained(resolved, base, raw);
  return resolved;
}

function resolveBase(cwd: string): string {
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

/**
 * Reject a resolved path that escapes `base` via `../` traversal. `relative`
 * returns a path starting with `..` (or an absolute path, on some
 * platforms/drives) exactly when `resolved` falls outside `base` — that is
 * the containment violation this barricade exists to catch.
 */
function assertContained(resolved: string, base: string, raw: string): void {
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError(
      `agy-image: opts.outputPath escapes the job cwd via '..': ${raw} (resolved: ${resolved}, cwd: ${base})`,
    );
  }
}

const _check: Adapter = { name, mode, buildArgs, injectContract, parseResult };
void _check;
