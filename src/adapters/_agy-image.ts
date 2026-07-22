/**
 * agy-image adapter — Nano Banana image generation harness. Single contract:
 * prompt in, one PNG at an explicit absolute path out (reported in
 * `artifacts`). Separate file from `agy.ts` on purpose: one output contract
 * per adapter keeps marker validation unambiguous (see plan Decision Log).
 *
 * The PNG lands at an explicit external artifact path the caller names, never
 * in the source tree.
 *
 * PATH LANDMINE (grug note): agy resolves a relative output filename by
 * searching all of /Users, not the job cwd. `buildArgs` therefore resolves
 * `opts.outputPath` to an absolute path itself, before it ever reaches argv
 * / spawn — never delegates that resolution to the harness.
 *
 * `parseResult(stdout, stderr, exitCode)` receives no `opts` (confirmed by
 * reading JobStore's call sequence in src/lib/jobs.ts), so it cannot look up
 * the caller's intended path independently. Design: agy 1.1.5 has NO
 * `--image` / `--out` flags (verified against `agy --help`) — image generation
 * is a built-in capability of agy's agent, driven entirely through the prompt.
 * `buildArgs` therefore embeds the resolved absolute save path INTO the prompt
 * text (not an argv flag) and spawns `agy --sandbox
 * --dangerously-skip-permissions --print <prompt>`; the injected contract asks
 * the harness to echo that same path back in an `AGY_IMAGE_SAVED:` marker line.
 * `parseResult` extracts the path from that marker and independently verifies
 * the file exists on disk — proving the harness actually wrote something rather
 * than just exiting 0. Like agy.ts,
 * the marker is matched LAST-occurrence-wins (not first), since the injected
 * contract text itself could in principle be echoed back before the real
 * verdict line; taking the last match keeps this adapter consistent with the
 * documented "last line of output" contract.
 *
 * SECURITY POSTURE (non-interactive agent write): `--print` runs the agent
 * with no TTY, so it cannot be prompted to confirm the PNG write — it would
 * block until timeout. agy 1.1.5 offers no scoped tool allowlist (`agy --help`
 * has only two permission knobs), so this adapter combines BOTH as defense-in-
 * depth: `--sandbox` (terminal restrictions — a prompt-injected agent cannot
 * spawn a shell or reach the network) plus `--dangerously-skip-permissions` to
 * auto-approve the one remaining action, the file write, INSIDE that sandbox.
 * The untrusted `prompt` is additionally fenced and labelled as data (not
 * instructions) by `injectContract`, so injected text cannot promote itself to
 * a directive. Residual v1 risk (consistent with sdd's same-cwd, real-env
 * posture): the sandbox is agy's, not ours, and the write path is caller-named.
 *
 * PATH-TRAVERSAL BARRICADE: `opts.outputPath` is untrusted MCP-client input
 * (see below). Beyond the `.png`-suffix check, a RELATIVE `outputPath`
 * resolved against the job cwd is additionally required to stay within that
 * cwd — a `../`-laden relative path that would resolve outside the cwd is
 * rejected with a `TypeError` before it ever reaches argv/spawn. An already-
 * absolute `outputPath` is a caller specifying an explicit target directly
 * (not a traversal) and passes through unchanged, as before.
 *
 * The argv-order guarantee and `lastMarkerMatch` live in `_agy-shared.ts`
 * (shared with `agy.ts`) so the flag-order and marker-collision fixes exist
 * exactly once.
 */
import { buildAgyArgv } from "./_agy-shared.ts";
import {
  appendSavePath,
  injectImageContract,
  markerFor,
  parseImageResult,
  resolveImageOutputPath,
} from "../lib/image-contract.ts";
import type { Capability } from "./types.ts";
import type { AdapterResult, DispatchOpts } from "../types.ts";

export const name = "agy-image";
/** CLI binary is `agy` (same as the agy adapter); the "-image" is the adapter's
 *  own contract, not a separate binary — so list_adapters probes `agy` on PATH. */
export const binary = "agy";
/** Opt OUT of `check_adapter`'s automatic live probe: a probe would bill a real
 *  image generation and needs an outputPath a health check can't supply. */
export const probeable = false;

/**
 * Marker line the harness must echo, containing the absolute save path. `g`
 * so every occurrence can be enumerated and the LAST one taken (see
 * `lastMarkerMatch` in agy.ts for why first-match is unsafe).
 */
const HARNESS_LABEL = "agy-image";
const SAVED_MARKER_RE = markerFor("AGY_IMAGE_SAVED");

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const outPath = resolveImageOutputPath(HARNESS_LABEL, opts);
  // agy 1.1.5 has no --image/--out flags — image gen is a built-in agent
  // capability driven through the prompt. injectContract ran first (before opts
  // was available) and referenced "the absolute path given below"; we append
  // that concrete path here, as the tail of the prompt. Flag-order: --print
  // immediately precedes the prompt, and the prompt is always the last argv
  // element (see agy.ts).
  //
  // SECURITY (see header): --print is non-interactive, so the agent cannot be
  // asked to confirm the PNG write at a TTY — it would block until timeout.
  // agy 1.1.5 exposes no scoped tool allowlist, only two blunt knobs, so we
  // use BOTH as defense-in-depth: --sandbox enables terminal restrictions
  // (a prompt-injected agent cannot spawn a shell or reach the network), and
  // --dangerously-skip-permissions auto-approves the one thing left — the file
  // write — inside that sandbox. Verified: this combination still generates and
  // writes the PNG (incl. to a path outside cwd).
  const withPath = appendSavePath(prompt, outPath);
  return buildAgyArgv(["--sandbox", "--dangerously-skip-permissions"], withPath);
}

export function injectContract(prompt: string): string {
  // Shared contract text (src/lib/image-contract.ts) — the untrusted request is
  // fenced as data so it cannot promote itself to a directive, and the concrete
  // save path is appended later by buildArgs, which is the first place `opts`
  // is available.
  return injectImageContract(prompt, "AGY_IMAGE_SAVED");
}

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  // Shared with codex (src/lib/image-contract.ts): marker-last, then exit code,
  // then an on-disk existence check. The historical `AGY_IMAGE_SAVED` spelling
  // and the `agy-image` label in messages are preserved so existing transcripts
  // and tests keep meaning the same thing.
  return parseImageResult(HARNESS_LABEL, SAVED_MARKER_RE, stdout, exitCode);
}

const _check: Capability = { buildArgs, injectContract, parseResult };
void _check;
