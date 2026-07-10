/**
 * Shared agy helpers — the single place that owns the agy argv-order
 * guarantee and the last-occurrence marker-match scan. `agy.ts` and
 * `agy-image.ts` both delegate here so the flag-order landmine fix and the
 * marker-collision fix exist exactly once (Phase 6's `agy-vision` adapter
 * will consume this too).
 *
 * Leading `_` in the filename: adapter discovery (`discover.ts`'s
 * `isCandidate`) skips underscore-prefixed files, so this helper is never
 * loaded as an adapter.
 *
 * FLAG-ORDER LANDMINE (see agy.ts's header for the full writeup): agy's
 * `--print` swallows the single argv element that immediately follows it as
 * the prompt. Any flag placed AFTER `--print` is silently absorbed into the
 * prompt string instead of being parsed as a flag — and agy exits 0 on this
 * misparse, so a wrong flag order fails silently with no non-zero exit code
 * to catch it. `buildAgyArgv` makes the correct order structural rather than
 * conventional: the prompt is always the LAST array element, and `--print`
 * is always the element immediately before it. There is no code path that
 * can insert anything after the prompt.
 *
 * TRUST BOUNDARY: `subcommandFlags` is caller-assembled and must already be
 * validated by the caller (e.g. `agy.ts`'s `pushOptionalStringFlag` throws on
 * a malformed `opts.model` before it ever reaches here) — this function only
 * guarantees ordering, it does not itself validate untrusted input.
 */
export function buildAgyArgv(subcommandFlags: string[], prompt: string): string[] {
  return ["agy", ...subcommandFlags, "--print", prompt];
}

/**
 * MARKER-COLLISION LANDMINE: a harness may echo the injected contract
 * instructions (which literally contain example marker lines) before its
 * real, final verdict — making both the echoed example and the real marker
 * appear in stdout. The contract defines the marker as "the last line of
 * output," so callers must scan for the LAST marker-shaped match, not the
 * first — otherwise an echoed example can mask a real, later verdict.
 *
 * Scan every match of `re` in `text` and return the last one — never the
 * first. `re` must carry the `g` flag.
 */
export function lastMarkerMatch(re: RegExp, text: string): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(re)) last = m;
  return last;
}
