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
 * FLAG ORDER (see agy.ts's header): `--print` takes the single argv element
 * immediately following it as the prompt, so that pairing must stay intact.
 * `buildAgyArgv` makes it structural rather than conventional: the prompt is
 * always the LAST array element, `--print` always the element immediately
 * before it, and no code path can insert anything after the prompt.
 *
 * CORRECTION (verified against agy 1.1.5, 2026-07-21): an earlier version of
 * this comment claimed a flag placed after the prompt is "silently absorbed
 * into the prompt string" and that "agy exits 0 on this misparse". That is
 * FALSE for 1.1.5 and the exit-0 half was never demonstrated at all.
 * Measured: `agy --sandbox --print "reply with just OK" --nope` prints
 * "flags provided but not defined: -nope" and exits 2; an invalid value
 * (`--effort bogus`) exits 1. Both reject BEFORE any model call. The ordering
 * guarantee is kept anyway — it is the house rule for every adapter (some
 * harnesses genuinely do absorb a trailing flag), and structural ordering
 * costs nothing — but it is a convention, not a fix for an agy bug.
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
