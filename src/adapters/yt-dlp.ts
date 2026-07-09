/**
 * yt-dlp adapter — multi-platform video fetch harness (YouTube, Instagram,
 * TikTok, X). Single contract: one video URL in, TWO local media files out —
 * a whisper-ready WAV and the resolution-capped merged VIDEO it was extracted
 * from (plus best-effort VTT subtitles) — landed in a caller-named external
 * directory and reported in `artifacts`.
 *
 * WHY KEEP THE VIDEO (Phase 7 cross-adapter contract): the pipeline's visual
 * half (Phase 5 `ffmpeg-frames`) extracts keyframes from a LOCAL VIDEO FILE.
 * An audio-only fetch would starve it on every run, so buildArgs fetches a
 * 720p-capped video (`-f bv*[height<=720]+ba/…` — ample for frame analysis,
 * bounds bandwidth) and keeps it (`-k`) after extracting the wav.
 *
 * `mode: "read"` — media lands at an explicit external `opts.outputDir` the
 * caller names, never in the source tree, so this does not count as a
 * working-tree write for the JobStore write-write guard (agy-image precedent).
 *
 * IDENTITY CONTRACT: the "prompt" IS the URL, and JobStore applies
 * `injectContract` BEFORE `buildArgs` (src/lib/jobs.ts:242-243) — any
 * non-identity contract would corrupt the URL argv element. So the contract
 * marker cannot ride in the prompt the way agy-image's does.
 *
 * MARKER DESIGN: `parseResult(stdout, stderr, exitCode)` receives no opts
 * (confirmed at src/lib/jobs.ts:358), so it cannot look up the caller's
 * outputDir. Instead, yt-dlp itself emits the marker: `buildArgs` appends
 * `--print after_move:filepath --no-simulate --no-quiet`, which makes yt-dlp
 * print the FINAL post-postprocessing absolute filepath (the .wav, since
 * `-x --audio-format wav` converts before `after_move` fires) on its own
 * stdout line. `outputDir` is resolved to an absolute path before it reaches
 * the `-o` template, so that line is an absolute path ending in `.wav`.
 * `parseResult` scans for the LAST such line (repo invariant: last-occurrence
 * wins, via `lastMarkerMatch`) and independently verifies the file exists on
 * disk — the silent-success guard. No path line → `failed` even on exit 0.
 * Subtitles are best-effort: `Writing video … subtitles to:` info lines are
 * collected, filtered by existence, and appended to artifacts — never a
 * failure condition (Instagram/X have no real subs).
 *
 * SECURITY BARRICADES (untrusted MCP-client input, validated at entry):
 * - URL (the prompt): `shell:false` + argv array already make shell
 *   metacharacters inert, but yt-dlp parses its own options — a "URL" of
 *   `--exec=<cmd>` would otherwise be option-parsed into arbitrary command
 *   execution. Two independent layers: the URL must be a single http(s) URL
 *   with no whitespace/control chars (TypeError otherwise), AND a literal
 *   `--` end-of-options separator always immediately precedes it in argv.
 * - `opts.outputDir` / `opts.cookies`: path-traversal barricade (agy-image's
 *   `assertContained` semantics) — a relative path resolved against the job
 *   cwd must stay INSIDE that cwd; a `../`-escaping one is rejected with a
 *   TypeError before it ever reaches argv/spawn. An absolute path is an
 *   explicit caller-specified target and passes through unchanged.
 * - Cookies are credential-adjacent: this adapter only ever handles the PATH
 *   (validated, passed as `--cookies <path>`), never reads the file, so its
 *   contents can never reach a job log.
 * - A literal `%` in `outputDir` is escaped to `%%` in the `-o` template —
 *   `%` is a yt-dlp template metacharacter, and a legal-on-disk directory
 *   name must not be able to corrupt the output template.
 *
 * `probeable = false`: check_adapter's generic liveness probe dispatches a
 * non-URL prompt with no outputDir (buildArgs would throw), and a real probe
 * would perform a network download — binary-presence check only.
 *
 * `--no-playlist` structurally enforces the scope-out of profile/bulk
 * downloads: one URL, one video.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { lastMarkerMatch } from "./_agy-shared.ts";
import type { Adapter } from "./types.ts";
import type { AdapterMode, AdapterResult, DispatchOpts } from "../types.ts";

export const name = "yt-dlp";
export const mode: AdapterMode = "read";
/** Opt OUT of check_adapter's automatic live probe: a probe prompt is not a
 *  URL, supplies no outputDir, and a real run would download from the network. */
export const probeable = false;

/** A stdout line that IS an absolute .wav path — the `--print
 *  after_move:filepath` marker line. Leading-`/` anchoring keeps narration
 *  lines like `[ExtractAudio] Destination: …` from being captured (POSIX
 *  assumption, consistent with this darwin-targeted project). `g` so
 *  lastMarkerMatch can take the LAST occurrence. */
const AUDIO_PATH_LINE_RE = /^(\/.*\.wav)\r?$/gm;

/** Label prefix on the video `--print` line (see buildArgs). A tagged channel,
 *  distinct from the bare wav line, so parseResult never confuses the two. */
const VIDEO_MARKER_PREFIX = "SDD_VIDEO_PATH:";
/** The retained-video marker line. `g` for lastMarkerMatch. */
const VIDEO_PATH_LINE_RE = /^SDD_VIDEO_PATH:(.+?)\r?$/gm;

/** Best-effort subtitle artifacts: yt-dlp's `[info] Writing video subtitles
 *  to: <path>` / `[info] Writing video automatic subtitles to: <path>` lines
 *  (visible because buildArgs passes `--no-quiet`). */
const SUBTITLE_LINE_RE = /Writing video (?:automatic )?subtitles to: (.+\.vtt)\r?$/gm;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const url = validateUrl(prompt);
  const outDir = resolveOutputDir(opts);

  const argv = [
    "yt-dlp",
    // Resolution-capped video WITH its audio, merged — 720p is ample for
    // Phase 5's keyframe analysis and bounds bandwidth. The `/b[height<=720]`
    // and trailing `/b` fallbacks keep single-stream platforms (Instagram/
    // TikTok/X) working when separate bv*/ba streams aren't offered.
    "-f",
    "bv*[height<=720]+ba/b[height<=720]/b",
    // Extract a whisper-ready wav from that video AND keep the merged video
    // (`-k`/--keep-video) so BOTH files survive for the two pipeline halves.
    "-x",
    "--audio-format",
    "wav",
    "-k",
    // One URL, one video — profile/bulk downloads are out of scope.
    "--no-playlist",
    // Output template rooted in the caller's (resolved-absolute) outputDir;
    // literal '%' in the dir is escaped so it cannot act as a template field.
    "-o",
    join(outDir.replaceAll("%", "%%"), "%(id)s.%(ext)s"),
  ];

  const cookies = resolveOptionalCookies(opts);
  if (cookies !== undefined) argv.push("--cookies", cookies);

  const subLangs = validateOptionalSubLangs(opts);
  if (subLangs !== undefined) {
    argv.push("--write-subs", "--write-auto-subs", "--sub-langs", subLangs, "--sub-format", "vtt");
  }

  const sleep = validateOptionalSleepRequests(opts);
  if (sleep !== undefined) argv.push("--sleep-requests", String(sleep));

  // Contract markers — two labeled stdout channels, since parseResult gets no
  // opts and must recover TWO paths (audio + video):
  //  1) the AUDIO wav: `--print after_move:filepath` prints the final moved
  //     filepath. With -k, both the wav and the video are moved and printed
  //     here as bare path lines; parseResult picks the one ending in `.wav`.
  //  2) the VIDEO: a LABELLED `--print after_video:SDD_VIDEO_PATH:%(filepath)s`
  //     prints the merged video path once, tagged so parseResult can tell it
  //     apart from the bare wav line unambiguously (last-occurrence-wins).
  // --no-simulate re-enables the download (--print alone implies simulate);
  // --no-quiet restores the info lines subtitle collection reads.
  // (The exact WHEN-stage→filepath mapping is pinned against a real clip in
  // the later manual E2E phase; the label-based parse contract below is what
  // this adapter's unit tests own and guarantee.)
  argv.push(
    "--print",
    "after_move:filepath",
    "--print",
    `after_video:${VIDEO_MARKER_PREFIX}%(filepath)s`,
    "--no-simulate",
    "--no-quiet",
  );

  // Structural end-of-options barricade: nothing after `--` can be parsed as
  // a yt-dlp option, and the URL is always the LAST argv element.
  argv.push("--", url);
  return argv;
}

/** Identity — the prompt IS the URL and must reach buildArgs unchanged; the
 *  output contract is enforced by CLI flags in buildArgs instead (see header). */
export function injectContract(prompt: string): string {
  return prompt;
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  if (exitCode !== 0) {
    // login-required / rate-limited / extractor-broken all land here; the
    // stderr tail is the actionable part.
    return {
      status: "failed",
      summary: `yt-dlp: exited with code ${exitCode}${stderrTail(stderr)}`,
      artifacts: [],
      raw: stdout,
    };
  }
  const match = lastMarkerMatch(AUDIO_PATH_LINE_RE, stdout);
  if (!match) {
    return {
      status: "failed",
      summary: `yt-dlp: no output audio path in stdout (missing --print after_move:filepath line — silent-misparse backstop)${stderrTail(stderr)}`,
      artifacts: [],
      raw: stdout,
    };
  }
  const wavPath = match[1]!;
  if (!existsSync(wavPath)) {
    return {
      status: "failed",
      summary: `yt-dlp: reported audio file does not exist: ${wavPath} (silent-success guard)`,
      artifacts: [],
      raw: stdout,
    };
  }
  // The retained video is additive, not a gate: if its marker line is present
  // and the file exists, report it; if the line is present but the file is
  // missing, report only what exists rather than failing the whole job (the
  // silent-success guard stays keyed on the AUDIO file alone).
  const videoMatch = lastMarkerMatch(VIDEO_PATH_LINE_RE, stdout);
  const videoPath = videoMatch && existsSync(videoMatch[1]!.trim()) ? videoMatch[1]!.trim() : undefined;

  const subtitles = [...new Set([...stdout.matchAll(SUBTITLE_LINE_RE)].map((m) => m[1]!))].filter((p) =>
    existsSync(p),
  );
  // Order (plan-pinned): audio, then retained video, then best-effort subs.
  const artifacts = [wavPath, ...(videoPath !== undefined ? [videoPath] : []), ...subtitles];
  const videoNote = videoPath !== undefined ? ` + video ${videoPath}` : "";
  const subNote = subtitles.length > 0 ? ` (+${subtitles.length} subtitle file(s))` : "";
  return {
    status: "done",
    summary: `yt-dlp: extracted audio to ${wavPath}${videoNote}${subNote}`,
    artifacts,
    raw: stdout,
  };
}

/**
 * Validate the untrusted prompt as a single http(s) URL. This is the
 * option-injection barricade's first layer: a string that does not start
 * with http(s):// (e.g. `--exec=…`) or that embeds whitespace/control chars
 * is rejected with a TypeError before it ever reaches argv/spawn.
 */
function validateUrl(prompt: string): string {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TypeError("yt-dlp: prompt must be a single http(s) video URL");
  }
  const url = prompt.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new TypeError(`yt-dlp: prompt must be a single http(s) video URL, got: ${truncate(url)}`);
  }
  if (/[\s\u0000-\u001f\u007f]/.test(url)) {
    throw new TypeError(`yt-dlp: URL must not contain whitespace or control characters, got: ${truncate(url)}`);
  }
  return url;
}

function truncate(s: string): string {
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** Required, validated, traversal-barricaded, resolved to absolute. */
function resolveOutputDir(opts: DispatchOpts): string {
  const raw = opts.outputDir;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError("yt-dlp: opts.outputDir must be a non-empty string (an absolute or relative directory path)");
  }
  return resolveContained(raw, opts, "outputDir");
}

/** Optional cookies-file path — credential-adjacent, same barricade. */
function resolveOptionalCookies(opts: DispatchOpts): string | undefined {
  const raw = opts.cookies;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError(`yt-dlp: opts.cookies must be a non-empty string path if provided, got: ${JSON.stringify(raw)}`);
  }
  return resolveContained(raw, opts, "cookies");
}

function validateOptionalSubLangs(opts: DispatchOpts): string | undefined {
  const raw = opts.subLangs;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.startsWith("-") || /\s/.test(raw)) {
    throw new TypeError(
      `yt-dlp: opts.subLangs must be a non-empty language selector (e.g. "en,en-US") with no whitespace or leading '-' if provided, got: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function validateOptionalSleepRequests(opts: DispatchOpts): number | undefined {
  const raw = opts.sleepRequests;
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new TypeError(`yt-dlp: opts.sleepRequests must be a positive number if provided, got: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * PATH-TRAVERSAL BARRICADE (agy-image's `resolveOutputPath`/`assertContained`
 * semantics): a relative path resolved against the job cwd (or process.cwd())
 * must stay INSIDE that base — `relative()` yielding `..`-leading (or an
 * absolute path across drives) is the containment violation, rejected with a
 * TypeError before spawn. An already-absolute path is an explicit
 * caller-specified target, not a traversal, and passes through unchanged.
 */
function resolveContained(raw: string, opts: DispatchOpts, key: string): string {
  if (isAbsolute(raw)) return raw;
  const base = typeof opts.cwd === "string" && opts.cwd.length > 0 ? resolve(opts.cwd) : process.cwd();
  const resolved = resolve(base, raw);
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError(
      `yt-dlp: opts.${key} escapes the job cwd via '..': ${raw} (resolved: ${resolved}, cwd: ${base})`,
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

const _check: Adapter = { name, probeable, mode, buildArgs, injectContract, parseResult };
void _check;
