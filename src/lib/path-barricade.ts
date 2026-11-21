/**
 * Shared path-traversal barricade for optional `--add-dir` arguments across
 * agent adapters. Mirrors the containment semantics in `_agy-vision.ts` and
 * `image-contract.ts`:
 *   - Absent (`undefined`) → returns `undefined`.
 *   - Non-string or empty string → throws `TypeError` before spawn.
 *   - Already-absolute path → explicit caller target, returned as-is.
 *   - Relative path → resolved against `opts.cwd` (or `process.cwd()`);
 *     escaping via `..` throws `TypeError` before spawn.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DispatchOpts } from "../types.ts";

export function resolveOptionalAddDir(adapterName: string, opts: DispatchOpts): string | undefined {
  const raw = opts.addDir;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError(`${adapterName}: opts.addDir must be a non-empty string if provided, got: ${JSON.stringify(raw)}`);
  }
  if (isAbsolute(raw)) return raw;
  const base = typeof opts.cwd === "string" && opts.cwd.length > 0 ? resolve(opts.cwd) : process.cwd();
  const resolved = resolve(base, raw);
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError(
      `${adapterName}: opts.addDir escapes the job cwd via '..': ${raw} (resolved: ${resolved}, cwd: ${base})`,
    );
  }
  return resolved;
}

/**
 * Validate `opts.readOnly` at an adapter's trust boundary. Absent → false;
 * non-boolean → TypeError. For adapters that cannot enforce read-only mode
 * natively, pass `supported: false` so `readOnly: true` throws loudly instead
 * of silently running permissively.
 */
export function resolveReadOnly(adapterName: string, opts: DispatchOpts, supported: boolean): boolean {
  const raw = opts.readOnly;
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    throw new TypeError(`${adapterName}: opts.readOnly must be a boolean if provided, got: ${typeof raw}`);
  }
  if (raw && !supported) {
    throw new TypeError(`${adapterName}: opts.readOnly is not supported by this adapter`);
  }
  return raw;
}
