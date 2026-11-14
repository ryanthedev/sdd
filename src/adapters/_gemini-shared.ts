/**
 * Shared plumbing for the `gemini` harness's kinds (`_gemini-decide.ts`,
 * `_gemini-vision.ts`). Both run a bundled bun script hermetically and pass
 * caller-supplied paths as positional argv, so the path barricade, the
 * bundled-asset lookup, the hermetic argv prefix, and the LAST-occurrence
 * marker scan live here once. The leading `_` keeps discovery from loading
 * this file as an adapter.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DispatchOpts } from "../types.ts";

/** A Gemini model id as an argv element: lowercase alphanumerics, dots, dashes. */
export const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,79}$/;

/** The empty bunfig that stops the job cwd's bunfig.toml `preload` from
 *  running code inside the job (same reason as jev; see jev.ts HERMETIC RUN). */
const BUNFIG_RELATIVE = join("assets", "gemini-bunfig.toml");

/**
 * Argv for `bun run <bundled script> ...positionals`, hermetic: an empty
 * bundled bunfig and `--no-env-file`, so neither the job cwd's bunfig
 * preload nor its `.env` (which could supply a different key) is read.
 * Flags first, then the script, then positionals (repo convention).
 */
export function hermeticBunArgv(scriptRelative: string, positionals: string[]): string[] {
  return ["bun", `--config=${bundledPath(BUNFIG_RELATIVE)}`, "--no-env-file", "run", bundledPath(scriptRelative), ...positionals];
}

/**
 * Absolute path to a bundled asset. Prefers $CLAUDE_PLUGIN_ROOT when running
 * inside Claude Code, falling back to a path relative to this module for tests
 * and manual `bun run` (jev / register.ts:readVersion precedent).
 */
export function bundledPath(rel: string): string {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (typeof root === "string" && root.length > 0) {
    const candidate = join(root, rel);
    if (existsSync(candidate)) return candidate;
  }
  return fileURLToPath(new URL(`../../${rel}`, import.meta.url));
}

/** Non-empty, no leading `-`, no control characters, contained in the job cwd
 *  when relative; returned absolute. `who` prefixes every error. */
export function validatePath(raw: unknown, opts: DispatchOpts, label: string, who: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new TypeError(`${who}: ${label} must be a non-empty path`);
  }
  const path = raw.trim();
  if (path.startsWith("-")) {
    throw new TypeError(`${who}: ${label} must not start with '-' (option-injection risk), got: ${truncate(path)}`);
  }
  if (hasControlChar(path)) {
    throw new TypeError(`${who}: ${label} must not contain control characters, got: ${truncate(path)}`);
  }
  if (isAbsolute(path)) return path;
  const base = typeof opts.cwd === "string" && opts.cwd.length > 0 ? resolve(opts.cwd) : process.cwd();
  const resolved = resolve(base, path);
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError(`${who}: ${label} escapes the job cwd via '..': ${path} (resolved: ${resolved}, cwd: ${base})`);
  }
  return resolved;
}

export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function truncate(s: string): string {
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** Scan every match of `re` (must be global) and return the last capture —
 *  never the first (repo invariant: the first may be an echo). */
export function lastMatch(re: RegExp, text: string): string | undefined {
  let last: string | undefined;
  for (const m of text.matchAll(re)) last = m[1];
  return last;
}

/** The script's own `<prefix>:` error line if present, else the last non-empty
 *  stderr line; capped so a noisy stderr can't flood the summary. */
export function stderrReason(stderr: string, prefix: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const line = lines.findLast((l) => l.startsWith(`${prefix}:`)) ?? lines.at(-1) ?? "(no stderr output)";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
