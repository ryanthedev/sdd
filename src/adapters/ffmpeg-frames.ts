/**
 * ffmpeg-frames adapter — scene-cut keyframe extraction harness. Single
 * contract: one video file in, a budget-capped set of PTS-named keyframes
 * plus a `manifest.json` timestamp map out, landed in a caller-named
 * external directory and reported in `artifacts`.
 *
 * Frames land at an explicit external `opts.outputDir` the caller names, never
 * in the source tree (yt-dlp / agy-image precedent).
 *
 * IDENTITY CONTRACT: the "prompt" IS the input video path, and JobStore
 * applies `injectContract` BEFORE `buildArgs` — any non-identity contract
 * would corrupt the path argv element (yt-dlp precedent). ffmpeg is a real
 * CLI, not an NL-instructable harness, so there is no contract text to inject.
 *
 * OUTPUT-PATH BRIDGE (the first load-bearing design decision of this file):
 * `parseResult(stdout, stderr, exitCode)` receives no `opts` (confirmed at
 * src/lib/jobs.ts:358), so — like whisper.ts — it needs a channel back to
 * `opts.outputDir` that isn't `opts` itself. ffmpeg has no `--print`-style
 * flag, but it unconditionally prints (default loglevel, not affected by
 * `-hide_banner`) a line of the shape `Output #0, <format>, to '<path>':`
 * describing exactly what it was told to write to — a stable, well-known
 * part of ffmpeg's own console output (spot-checked this session, e.g.
 * `Output #0, wav, to 'D.wav':`). `parseResult` extracts the output pattern
 * from that line and takes its `dirname()` — never `opts`.
 *
 * TIMESTAMPS (the second load-bearing design decision): `showinfo` prints one
 * `pts_time:<seconds>` line, in chronological order, for every frame that
 * reaches it (verified fact from this plan's research). `-frame_pts 1` names
 * each KEPT output file after its own raw (integer, stream-timebase) pts —
 * monotonic with time, but not literally seconds — so filenames are used only
 * to recover CHRONOLOGICAL ORDER (ascending numeric sort of the embedded
 * pts), never as the timestamp itself. `-frames:v N` keeps the EARLIEST N
 * selected frames, which are exactly the first N `pts_time:` lines in
 * appearance order. So: sort the actual output files ascending by embedded
 * pts, and zip them 1:1 with the first `files.length` entries of the
 * `pts_time:` list — that pairing is exact, not approximate.
 * `dropped = selectedCount - files.length` is set only when
 * `selectedCount > files.length` (the cap actually fired).
 *
 * NEVER-EMPTY GUARANTEE, single invocation, no two-pass (DW-5.5): the filter
 * graph is `mpdecimate,select='gt(scene\,TH)+not(mod(n\,150))',showinfo`. The
 * OR'd periodic term `not(mod(n,150))` is true whenever `n` (the
 * post-mpdecimate frame index) is a multiple of 150 — which ALWAYS includes
 * `n=0` (`0 mod anything == 0`), so at least the very first frame reaching
 * `select` is always selected, regardless of whether any real scene cut ever
 * fires. This generalizes the plan's own suggested
 * `select='gt(scene,TH)+eq(n,0)'` fallback to also resample every 150 frames,
 * so a long cut-free clip yields more than one fallback frame ("periodic,"
 * not just a single frame). The period is expressed in FRAME COUNT, not
 * seconds: an `fps=` filter ahead of `select` to normalize to a known rate
 * would change what `scene` compares frame-to-frame against, altering the
 * *verified* scene-detection behavior this plan's research already
 * confirmed — frame-count periodicity (imprecise across differing source
 * fps, but honest about that) is the accepted trade-off for leaving that
 * verified base filter chain untouched. `mpdecimate` (dedup of near-identical
 * frames) runs first in the chain, ahead of `select`.
 *
 * `-vsync vfr` is required so ffmpeg doesn't pad/drop `select`'s
 * variable-rate output back to a constant frame rate — a well-known gotcha
 * with `select`-based frame extraction. It may print a deprecation notice on
 * newer ffmpeg builds but still functions, and the notice text does not
 * collide with the `Output #0` / `pts_time:` parsing below.
 *
 * MANIFEST WRITE IS A SCOPED EXCEPTION: the plan's Scope-IN line explicitly
 * assigns manifest construction to `parseResult` ("parseResult builds the
 * manifest and classifies"), and ffmpeg itself cannot produce manifest.json.
 * `parseResult` therefore performs exactly one `writeFileSync` — into the
 * external, caller-named `outputDir`, never the source tree (same reasoning as
 * the child processes' own external-dir writes in yt-dlp/agy-image). A failed
 * write is a `failed` result: manifest.json is a required `Produces` artifact,
 * not best-effort.
 *
 * SECURITY BARRICADES (untrusted MCP-client input, validated at entry):
 * - The input video path (the prompt) is the value of the explicit `-i` flag
 *   (not a bare positional), a lower option-injection risk than yt-dlp's URL
 *   or whisper's positional audio path — still validated (non-empty, no
 *   leading `-`, no control characters) for defense-in-depth consistency
 *   across every path-taking adapter in this repo.
 * - `opts.outputDir`: path-traversal barricade (agy-image's `assertContained`
 *   semantics, duplicated locally here — yt-dlp.ts / whisper.ts precedent, no
 *   shared traversal module exists) — a relative path resolved against the
 *   job cwd must stay INSIDE that cwd; a `../`-escaping one is rejected with
 *   a TypeError before it ever reaches argv/spawn.
 * - `opts.frameCount` / `opts.sceneThreshold`: re-validated here even though
 *   the dispatch tool's zod schema already range-checks them (Phase 3) —
 *   opts are untrusted at the adapter boundary too ("internal team API is
 *   still external").
 *
 * `probeable = false`: check_adapter's generic liveness probe dispatches a
 * prompt with no outputDir (buildArgs would throw) and a real run performs a
 * real (slow) video decode. Binary-presence check only (yt-dlp / agy-image /
 * whisper precedent).
 *
 * ffmpeg is NOT installed in this environment — this adapter is built and
 * tested against verified ffmpeg CLI facts (this plan's own research plus a
 * spot-check this session), never a real invocation (yt-dlp / whisper
 * precedent for the same constraint).
 */
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Adapter } from "./types.ts";
import type { AdapterResult, DispatchOpts } from "../types.ts";

export const name = "ffmpeg-frames";
export const binary = "ffmpeg";
/** Opt OUT of check_adapter's automatic live probe: a probe supplies no
 *  outputDir (buildArgs would throw) and a real run is a slow video decode. */
export const probeable = false;

const DEFAULT_FRAME_COUNT = 150;
const DEFAULT_SCENE_THRESHOLD = 0.35;
/** Periodic fallback spacing, in post-mpdecimate frame count (see header for
 *  why frame count, not seconds). n=0 is always a multiple, so this alone
 *  guarantees a non-empty selection even with zero real scene cuts. */
const FALLBACK_PERIOD_FRAMES = 150;

const OUTPUT_FILE_PATTERN = "frame_%d.jpg";
/** Matches an actual emitted frame file (`-frame_pts 1` names it after its
 *  own raw pts — an integer, used only to recover chronological order). */
const FRAME_FILE_RE = /^frame_(\d+)\.jpg$/;

/** ffmpeg's own "what am I writing to" banner line — see header. */
const OUTPUT_LINE_RE = /^Output #0,\s*[^,]+,\s*to\s+'([^']+)':/m;
/** One per frame reaching `showinfo`, in chronological order — see header. */
const PTS_TIME_RE = /pts_time:(\d+(?:\.\d+)?)/g;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const inputPath = validateInputPath(prompt);
  const outDir = resolveOutputDir(opts);
  const frameCount = validateOptionalFrameCount(opts) ?? DEFAULT_FRAME_COUNT;
  const sceneThreshold = validateOptionalSceneThreshold(opts) ?? DEFAULT_SCENE_THRESHOLD;

  return [
    "ffmpeg",
    "-y",
    "-i",
    inputPath,
    "-vf",
    buildFilterExpr(sceneThreshold),
    "-vsync",
    "vfr",
    "-frame_pts",
    "1",
    "-frames:v",
    String(frameCount),
    join(outDir, OUTPUT_FILE_PATTERN),
  ];
}

/** Identity — the prompt IS the input video path and must reach buildArgs
 *  unchanged (yt-dlp / whisper precedent). */
export function injectContract(prompt: string): string {
  return prompt;
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  if (exitCode !== 0) {
    return {
      status: "failed",
      summary: `ffmpeg-frames: exited with code ${exitCode}${stderrTail(stderr)}`,
      artifacts: [],
      raw: stdout,
    };
  }

  const outputMatch = OUTPUT_LINE_RE.exec(stderr);
  if (!outputMatch) {
    return {
      status: "failed",
      summary: "ffmpeg-frames: no 'Output #0, ..., to' line in stderr (missing output banner — silent-misparse backstop)",
      artifacts: [],
      raw: stdout,
    };
  }
  const outDir = dirname(outputMatch[1]!);

  const ptsTimes = [...stderr.matchAll(PTS_TIME_RE)].map((m) => Number(m[1]));
  const selectedCount = ptsTimes.length;

  let entries: string[];
  try {
    entries = readdirSync(outDir);
  } catch (e) {
    return {
      status: "failed",
      summary: `ffmpeg-frames: could not read outputDir ${outDir}: ${errMessage(e)}`,
      artifacts: [],
      raw: stdout,
    };
  }

  const files = entries
    .map((f) => ({ f, m: FRAME_FILE_RE.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => x.f);

  if (files.length === 0) {
    return {
      status: "failed",
      summary: `ffmpeg-frames: no frame files found in ${outDir} (expected at least one — never-empty guarantee violated)`,
      artifacts: [],
      raw: stdout,
    };
  }

  if (files.length > selectedCount) {
    return {
      status: "failed",
      summary: `ffmpeg-frames: ${files.length} frame file(s) on disk but only ${selectedCount} pts_time entr${selectedCount === 1 ? "y" : "ies"} in stderr (invariant violation)`,
      artifacts: [],
      raw: stdout,
    };
  }

  const frames = files.map((f, i) => ({ file: join(outDir, f), tSeconds: ptsTimes[i]! }));
  const dropped = selectedCount > files.length ? selectedCount - files.length : undefined;

  const manifest: { frames: { file: string; tSeconds: number }[]; dropped?: number } = { frames };
  if (dropped !== undefined) manifest.dropped = dropped;

  const manifestPath = join(outDir, "manifest.json");
  try {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (e) {
    return {
      status: "failed",
      summary: `ffmpeg-frames: could not write manifest ${manifestPath}: ${errMessage(e)}`,
      artifacts: [],
      raw: stdout,
    };
  }

  const droppedNote = dropped !== undefined ? ` (dropped ${dropped})` : "";
  return {
    status: "done",
    summary: `ffmpeg-frames: extracted ${frames.length} frame(s) to ${outDir}${droppedNote}`,
    artifacts: [...frames.map((fr) => fr.file), manifestPath],
    raw: stdout,
  };
}

/**
 * Scene-cut-OR-periodic-fallback select expression (see header for the full
 * design rationale). Commas inside filter option values must be escaped as
 * `\,` in ffmpeg filtergraph syntax (a bare `,` separates chained filters).
 */
function buildFilterExpr(sceneThreshold: number): string {
  return `mpdecimate,select='gt(scene\\,${sceneThreshold})+not(mod(n\\,${FALLBACK_PERIOD_FRAMES}))',showinfo`;
}

/**
 * Reject an input video path that could be misparsed. Lower risk than a bare
 * positional (this is the explicit value of `-i`), still validated for
 * defense-in-depth consistency with every other path-taking adapter here.
 */
function validateInputPath(prompt: string): string {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TypeError("ffmpeg-frames: prompt must be a non-empty input video file path");
  }
  const path = prompt.trim();
  if (path.startsWith("-")) {
    throw new TypeError(
      `ffmpeg-frames: input path must not start with '-' (option-injection risk), got: ${truncate(path)}`,
    );
  }
  if (hasControlChar(path)) {
    throw new TypeError(`ffmpeg-frames: input path must not contain control characters, got: ${truncate(path)}`);
  }
  return path;
}

/** True if `s` contains a C0 control character or DEL. Written as a charCode
 *  scan (never a regex/string containing raw control bytes or unicode
 *  escapes) to keep the source unambiguous. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function truncate(s: string): string {
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** Required, validated, traversal-barricaded, resolved to absolute. */
function resolveOutputDir(opts: DispatchOpts): string {
  const raw = opts.outputDir;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError(
      "ffmpeg-frames: opts.outputDir must be a non-empty string (an absolute or relative directory path)",
    );
  }
  return resolveContained(raw, opts, "outputDir");
}

function validateOptionalFrameCount(opts: DispatchOpts): number | undefined {
  const raw = opts.frameCount;
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new TypeError(`ffmpeg-frames: opts.frameCount must be a positive integer if provided, got: ${JSON.stringify(raw)}`);
  }
  return raw;
}

function validateOptionalSceneThreshold(opts: DispatchOpts): number | undefined {
  const raw = opts.sceneThreshold;
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new TypeError(
      `ffmpeg-frames: opts.sceneThreshold must be a number in [0, 1] if provided, got: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * PATH-TRAVERSAL BARRICADE (agy-image's `resolveOutputPath`/`assertContained`
 * semantics, yt-dlp.ts / whisper.ts local copy): a relative path resolved
 * against the job cwd (or process.cwd()) must stay INSIDE that base —
 * `relative()` yielding `..`-leading (or an absolute path across drives) is
 * the containment violation, rejected with a TypeError before spawn. An
 * already-absolute path is an explicit caller-specified target, not a
 * traversal, and passes through unchanged.
 */
function resolveContained(raw: string, opts: DispatchOpts, key: string): string {
  if (isAbsolute(raw)) return raw;
  const base = typeof opts.cwd === "string" && opts.cwd.length > 0 ? resolve(opts.cwd) : process.cwd();
  const resolved = resolve(base, raw);
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError(
      `ffmpeg-frames: opts.${key} escapes the job cwd via '..': ${raw} (resolved: ${resolved}, cwd: ${base})`,
    );
  }
  return resolved;
}

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return "";
  const tail = trimmed.length > 400 ? `…${trimmed.slice(-400)}` : trimmed;
  return ` — stderr tail: ${tail.replaceAll("\n", " | ")}`;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const _check: Adapter = { name, binary, probeable, buildArgs, injectContract, parseResult };
void _check;
