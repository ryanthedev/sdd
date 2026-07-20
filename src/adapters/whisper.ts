/**
 * whisper adapter — mlx-whisper (large-v3-turbo) transcription harness. Single
 * contract: one audio file in, a timestamped transcript (SRT + TXT) out,
 * landed in a caller-named external directory and reported in `artifacts`.
 *
 * The transcript lands at an explicit external `opts.outputDir` the caller
 * names, never in the source tree (agy-image / yt-dlp precedent).
 *
 * BINARY: the CLI is `mlx_whisper` (underscore), not `whisper` or
 * `mlx-whisper` — the `binary` export overrides the on-PATH probe name while
 * `name` stays the dispatch key.
 *
 * IDENTITY CONTRACT: the "prompt" IS the audio file path, and JobStore
 * applies `injectContract` BEFORE `buildArgs` (src/lib/jobs.ts:242-243) — any
 * non-identity contract would corrupt the path argv element (yt-dlp
 * precedent).
 *
 * OUTPUT-PATH BRIDGE (the load-bearing design decision of this file):
 * `parseResult(stdout, stderr, exitCode)` receives no `opts` (confirmed at
 * src/lib/jobs.ts:358), so it cannot look up the caller's `outputDir`
 * directly the way it could if it were passed in. Unlike yt-dlp, mlx_whisper
 * has no `--print <template>`-style flag purpose-built for scripting: reading
 * the actual upstream source this session
 * (ml-explore/mlx-examples/whisper/mlx_whisper/cli.py) confirms `main()`
 * does `args = vars(parser.parse_args()); if args["verbose"]: print(f"Args:
 * {args}")` BEFORE popping anything out of `args` — so the full parsed-arg
 * dict, including `output_dir` verbatim, always reaches stdout as one line
 * when `--verbose` is `True`. Neither `cli.py` nor `writers.py`'s
 * `ResultWriter.__call__` print the resolved output file path anywhere else
 * — there is no cleaner channel available. `buildArgs` therefore:
 *   - passes `--verbose True` EXPLICITLY (not relying on the CLI's own
 *     default, so the marker survives a future default change),
 *   - passes `--output-name transcript` to fix the output basename
 *     independent of the input audio filename (mlx-whisper-specific flag,
 *     confirmed in cli.py) — so parseResult never needs to reconstruct a
 *     filename from the audio path, only the two constants below,
 *   - passes `--output-format all` (not `-f srt` alone) so both `.srt` and
 *     `.txt` are produced in the one invocation the plan's `Produces` line
 *     requires (`artifacts=[transcriptSrt, transcriptTxt]`) — `-f srt` alone
 *     cannot satisfy that; DW-5.1 only requires SRT to be pinned/present,
 *     which `-f all` still does.
 * `parseResult` regex-extracts `output_dir` from the `Args: {...}` line, then
 * independently verifies `transcript.srt` AND `transcript.txt` both exist on
 * disk via `existsSync` (read-only fs — agy-image precedent) — the
 * silent-success guard. Missing marker or missing file(s) → `failed` even on
 * exit 0.
 *
 * Trade-off, stated plainly: leaning on an argparse debug-print line is less
 * robust than a purpose-built `--print` flag (it is not a documented stable
 * CLI contract of mlx-whisper) — it is the only channel the CLI offers,
 * verified by reading the source rather than assumed.
 *
 * SECURITY BARRICADES (untrusted MCP-client input, validated at entry):
 * - The audio path (the prompt) is a POSITIONAL argparse argument
 *   (`nargs="+"`), so a value starting with `-` risks being misparsed as an
 *   option rather than consumed as the file. Rejected with a TypeError before
 *   spawn (same posture as yt-dlp's URL barricade, adapted for a positional
 *   arg instead of a URL scheme check).
 * - `opts.outputDir`: path-traversal barricade (agy-image's `assertContained`
 *   semantics, duplicated locally here — yt-dlp.ts precedent, no shared
 *   traversal module exists) — a relative path resolved against the job cwd
 *   must stay INSIDE that cwd; a `../`-escaping one is rejected with a
 *   TypeError before it ever reaches argv/spawn.
 *
 * `probeable = false`: check_adapter's generic liveness probe dispatches a
 * prompt with no outputDir (buildArgs would throw at that call, which
 * check.ts already catches as `probe_dispatch_failed`) — but every user's
 * probe would then ALWAYS report failure, which is a worse signal than
 * `present_unverified`. A real probe would also incur a real (slow)
 * transcription. Binary-presence check only (yt-dlp / agy-image precedent).
 *
 * mlx-whisper is NOT installed in this environment — this adapter is built
 * and tested against the verified upstream CLI source, never a real
 * invocation (yt-dlp precedent for the same constraint).
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Adapter } from "./types.ts";
import type { AdapterResult, DispatchOpts } from "../types.ts";

export const name = "whisper";
/** CLI binary is `mlx_whisper` (underscore) — differs from the dispatch key. */
export const binary = "mlx_whisper";
/** Opt OUT of check_adapter's automatic live probe: a probe supplies no
 *  outputDir (buildArgs would throw) and a real run is a slow, real transcription. */
export const probeable = false;

const MODEL = "mlx-community/whisper-large-v3-turbo";
/** Fixed output basename (via --output-name) so parseResult never has to
 *  reconstruct a filename from the input audio path — see header. */
const OUTPUT_NAME = "transcript";

/** Extracts `output_dir` from mlx_whisper's own `Args: {...}` debug-print
 *  line (verbatim argparse dict repr) — see header for why this is the only
 *  available channel. `g` so the last occurrence wins, consistent with this
 *  repo's marker-parsing convention, even though in practice this line is
 *  printed exactly once per invocation. */
const ARGS_OUTPUT_DIR_RE = /output_dir':\s*'([^']*)'/g;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const audioPath = validateAudioPath(prompt);
  const outDir = resolveOutputDir(opts);

  return [
    "mlx_whisper",
    audioPath,
    "--model",
    MODEL,
    "--output-format",
    "all",
    "--output-dir",
    outDir,
    "--output-name",
    OUTPUT_NAME,
    // Explicit (not relying on the CLI's own default) — this is what
    // guarantees the `Args: {...}` marker line parseResult depends on.
    "--verbose",
    "True",
  ];
}

/** Identity — the prompt IS the audio path and must reach buildArgs
 *  unchanged; mlx_whisper is a real CLI, not an NL-instructable harness, so
 *  there is no contract text to inject (yt-dlp precedent). */
export function injectContract(prompt: string): string {
  return prompt;
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  if (exitCode !== 0) {
    return {
      status: "failed",
      summary: `whisper: exited with code ${exitCode}${stderrTail(stderr)}`,
      artifacts: [],
      raw: stdout,
    };
  }

  const outDir = lastMatch(ARGS_OUTPUT_DIR_RE, stdout);
  if (outDir === undefined) {
    return {
      status: "failed",
      summary: "whisper: no output_dir found in stdout (missing --verbose Args marker — silent-misparse backstop)",
      artifacts: [],
      raw: stdout,
    };
  }

  const srtPath = join(outDir, `${OUTPUT_NAME}.srt`);
  const txtPath = join(outDir, `${OUTPUT_NAME}.txt`);
  const missing = [srtPath, txtPath].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    return {
      status: "failed",
      summary: `whisper: expected transcript file(s) do not exist: ${missing.join(", ")}`,
      artifacts: [],
      raw: stdout,
    };
  }

  return {
    status: "done",
    summary: `whisper: transcribed to ${srtPath} (+ ${txtPath})`,
    artifacts: [srtPath, txtPath],
    raw: stdout,
  };
}

/**
 * Reject a positional audio path that could be misparsed as an option by
 * mlx_whisper's argparse-based CLI (`nargs="+"` positional). Non-empty,
 * no leading `-`, no control characters.
 */
function validateAudioPath(prompt: string): string {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TypeError("whisper: prompt must be a non-empty audio file path");
  }
  const path = prompt.trim();
  if (path.startsWith("-")) {
    throw new TypeError(`whisper: audio path must not start with '-' (option-injection risk), got: ${truncate(path)}`);
  }
  if (hasControlChar(path)) {
    throw new TypeError(`whisper: audio path must not contain control characters, got: ${truncate(path)}`);
  }
  return path;
}

/** True if `s` contains a C0 control character or DEL. Written as a charCode
 *  scan (never a regex/string containing raw control bytes or unicode escapes)
 *  to keep the source unambiguous. */
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
    throw new TypeError("whisper: opts.outputDir must be a non-empty string (an absolute or relative directory path)");
  }
  return resolveContained(raw, opts, "outputDir");
}

/**
 * PATH-TRAVERSAL BARRICADE (agy-image's `resolveOutputPath`/`assertContained`
 * semantics, yt-dlp.ts's local copy): a relative path resolved against the
 * job cwd (or process.cwd()) must stay INSIDE that base — `relative()`
 * yielding `..`-leading (or an absolute path across drives) is the
 * containment violation, rejected with a TypeError before spawn. An
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
      `whisper: opts.${key} escapes the job cwd via '..': ${raw} (resolved: ${resolved}, cwd: ${base})`,
    );
  }
  return resolved;
}

/** Scan every match of `re` in `text` and return the last one — never the
 *  first (this repo's marker-collision convention; see _agy-shared.ts). */
function lastMatch(re: RegExp, text: string): string | undefined {
  let last: string | undefined;
  for (const m of text.matchAll(re)) last = m[1];
  return last;
}

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return "";
  const tail = trimmed.length > 400 ? `…${trimmed.slice(-400)}` : trimmed;
  return ` — stderr tail: ${tail.replaceAll("\n", " | ")}`;
}

const _check: Adapter = { name, binary, probeable, buildArgs, injectContract, parseResult };
void _check;
