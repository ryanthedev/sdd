/**
 * shazam adapter — acoustic-fingerprint track identification. One audio file
 * in, a JSON identity ({matched, title, artist, album, label, released,
 * shazam_url, apple_music_url, isrc, raw}) out, landed at a caller-named
 * external `opts.outputPath` and reported in `artifacts`.
 *
 * WHY THIS EXISTS: the video-ingest pipeline reads two channels — speech
 * (whisper) and pixels (frames + vision) — and neither can name a song. A reel
 * scored with a wordless choral hook transcribes as one long "Ооооо", and the
 * audio attribution is Instagram UI chrome that never reaches the downloaded
 * media or yt-dlp's metadata. Identity has to come from the waveform itself, so
 * this is a fingerprint step, not a transcription or vision step.
 *
 * HARNESS: `uv`, running the repo-bundled `assets/shazam-recognize.py`. That
 * script carries PEP 723 inline metadata (`requires-python`, `dependencies =
 * ["shazamio"]`), so `uv run` provisions both the interpreter and the library
 * on first use and caches them — the user installs `uv` and nothing else. The
 * alternatives were worse: shazamio ships no console entry point (so there is
 * no binary to put on PATH), and songrec has no Homebrew formula. macOS's own
 * ShazamKit was tried first and rejected on evidence — `SHSession.match` from
 * an unsigned CLI fails with `com.apple.ShazamKit error 202`
 * (matchAttemptFailed), because catalog matching wants the ShazamKit
 * entitlement that only a signed, provisioned app carries.
 *
 * `--no-project` matters: without it `uv run` would try to adopt whatever
 * pyproject.toml happens to sit in the job cwd and resolve the script against
 * THAT project's environment. The script must stay hermetic — its dependencies
 * come from its own inline metadata, never from the tree being worked on.
 *
 * IDENTITY CONTRACT: the "prompt" IS the audio file path, and JobStore applies
 * `injectContract` BEFORE `buildArgs` (src/lib/jobs.ts) — any non-identity
 * contract would corrupt the path argv element (yt-dlp / whisper precedent).
 *
 * OUTPUT-PATH BRIDGE: `parseResult` receives no `opts`, so — unlike whisper,
 * which has to scrape mlx_whisper's argparse debug line — this adapter owns
 * its script and simply has it print `SDD_SHAZAM_RESULT:<abs json path>` as
 * its final line (yt-dlp's labelled `--print` precedent, but a first-class
 * contract rather than a borrowed one). `SDD_SHAZAM_TITLE` /
 * `SDD_SHAZAM_ARTIST` / `SDD_SHAZAM_NOMATCH` carry the summary. Markers are
 * matched by LAST occurrence (repo convention) and the JSON's existence is
 * independently verified on disk (`existsSync`, read-only fs — whisper /
 * agy-image precedent) before reporting `done`.
 *
 * NO MATCH IS `done`, NOT `failed`. "This audio is not in the catalog" is a
 * real, correctly-produced answer; only a breakdown (unreadable audio, API
 * failure, missing marker) is a failure. Conflating the two would make an
 * honest negative indistinguishable from a broken harness.
 *
 * SECURITY BARRICADES (untrusted MCP-client input, validated at entry):
 * - The audio path (the prompt) becomes a positional argv element after the
 *   script path. A leading `-` is rejected before spawn (whisper precedent) so
 *   it can never be re-read as an option by the script's own arg handling.
 * - `opts.outputPath`: path-traversal barricade (agy-image's `assertContained`
 *   semantics, duplicated locally as in whisper.ts / yt-dlp.ts — no shared
 *   traversal module exists) — a relative path resolved against the job cwd
 *   must stay INSIDE that cwd.
 * - The script path is author-controlled (resolved from $CLAUDE_PLUGIN_ROOT or
 *   this module's own URL), never caller input.
 *
 * `probeable = false`: check_adapter's generic liveness probe dispatches a
 * prompt with no outputPath (buildArgs throws, which check.ts reports as
 * `probe_dispatch_failed`), so every user's probe would always read as a
 * failure — a worse signal than `present_unverified`. A real probe would also
 * hit the Shazam API with a fabricated audio path. Binary-presence only
 * (whisper / yt-dlp / agy-image precedent).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FlatAdapterModule } from "./types.ts";
import type { AdapterResult, DispatchOpts } from "../types.ts";

export const name = "shazam";
/** CLI binary is `uv` — it provisions and runs the bundled script. */
export const binary = "uv";
/** Opt OUT of check_adapter's automatic live probe — see header. */
export const probeable = false;

/** Bundled recognizer, relative to the plugin root. */
const SCRIPT_RELATIVE = join("assets", "shazam-recognize.py");

const RESULT_MARKER_RE = /^SDD_SHAZAM_RESULT:(.+?)\r?$/gim;
const TITLE_MARKER_RE = /^SDD_SHAZAM_TITLE:(.*?)\r?$/gim;
const ARTIST_MARKER_RE = /^SDD_SHAZAM_ARTIST:(.*?)\r?$/gim;
const NOMATCH_MARKER_RE = /^SDD_SHAZAM_NOMATCH:1\r?$/im;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const audioPath = validateAudioPath(prompt);
  const outPath = resolveOutputPath(opts);

  return [
    "uv",
    "run",
    // Silence uv's own provisioning chatter so stdout carries the script's
    // markers and nothing else.
    "--quiet",
    // Hermetic: never adopt a pyproject.toml sitting in the job cwd — see header.
    "--no-project",
    scriptPath(),
    // Flags before positionals (repo convention): everything above is a uv
    // flag, everything below is the script's own positional argv.
    audioPath,
    outPath,
  ];
}

/** Identity — the prompt IS the audio path and must reach buildArgs unchanged;
 *  the recognizer is a real CLI, not an NL-instructable harness, so there is no
 *  contract text to inject (yt-dlp / whisper precedent). */
export function injectContract(prompt: string): string {
  return prompt;
}

export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  if (exitCode !== 0) {
    return {
      status: "failed",
      summary: `shazam: exited with code ${exitCode}${stderrTail(stderr)}`,
      artifacts: [],
      raw: stdout,
    };
  }

  const jsonPath = lastMatch(RESULT_MARKER_RE, stdout);
  if (jsonPath === undefined || jsonPath.trim().length === 0) {
    return {
      status: "failed",
      summary: `shazam: no SDD_SHAZAM_RESULT marker in stdout (silent-misparse backstop)${stderrTail(stderr)}`,
      artifacts: [],
      raw: stdout,
    };
  }

  const resultPath = jsonPath.trim();
  if (!existsSync(resultPath)) {
    return {
      status: "failed",
      summary: `shazam: result file does not exist: ${resultPath}`,
      artifacts: [],
      raw: stdout,
    };
  }

  // A negative result is a real answer, not a failure — see header.
  if (NOMATCH_MARKER_RE.test(stdout)) {
    return {
      status: "done",
      summary: `shazam: no match — audio is not in the catalog (details: ${resultPath})`,
      artifacts: [resultPath],
      raw: stdout,
    };
  }

  const title = lastMatch(TITLE_MARKER_RE, stdout)?.trim();
  const artist = lastMatch(ARTIST_MARKER_RE, stdout)?.trim();
  if (!title && !artist) {
    return {
      status: "failed",
      summary: `shazam: result marker present but neither title nor artist was reported — treating as a broken run (details: ${resultPath})`,
      artifacts: [resultPath],
      raw: stdout,
    };
  }

  const identity = artist ? `${title || "(untitled)"} — ${artist}` : (title as string);
  return {
    status: "done",
    summary: `shazam: matched ${identity} (details: ${resultPath})`,
    artifacts: [resultPath],
    raw: stdout,
  };
}

/**
 * Absolute path to the bundled recognizer. Prefers $CLAUDE_PLUGIN_ROOT when
 * running inside Claude Code, falling back to a path relative to this module
 * for tests and manual `bun run` (register.ts:readVersion precedent). Never
 * caller input.
 */
function scriptPath(): string {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (typeof root === "string" && root.length > 0) {
    const candidate = join(root, SCRIPT_RELATIVE);
    if (existsSync(candidate)) return candidate;
  }
  return fileURLToPath(new URL(`../../${SCRIPT_RELATIVE}`, import.meta.url));
}

/**
 * Reject a positional audio path that the script's own arg handling could
 * re-read as an option. Non-empty, no leading `-`, no control characters
 * (whisper precedent).
 */
function validateAudioPath(prompt: string): string {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TypeError("shazam: prompt must be a non-empty audio file path");
  }
  const path = prompt.trim();
  if (path.startsWith("-")) {
    throw new TypeError(`shazam: audio path must not start with '-' (option-injection risk), got: ${truncate(path)}`);
  }
  if (hasControlChar(path)) {
    throw new TypeError(`shazam: audio path must not contain control characters, got: ${truncate(path)}`);
  }
  return path;
}

/** Required, validated, traversal-barricaded, resolved to absolute. */
function resolveOutputPath(opts: DispatchOpts): string {
  const raw = opts.outputPath;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError("shazam: opts.outputPath must be a non-empty string (where to write the identity JSON)");
  }
  if (raw.startsWith("-")) {
    throw new TypeError(`shazam: opts.outputPath must not start with '-' (option-injection risk), got: ${truncate(raw)}`);
  }
  if (hasControlChar(raw)) {
    throw new TypeError(`shazam: opts.outputPath must not contain control characters, got: ${truncate(raw)}`);
  }
  return resolveContained(raw, opts, "outputPath");
}

/**
 * PATH-TRAVERSAL BARRICADE (agy-image's `resolveOutputPath`/`assertContained`
 * semantics; whisper.ts / yt-dlp.ts carry local copies for the same reason —
 * no shared traversal module exists): a relative path resolved against the job
 * cwd must stay INSIDE that base. An already-absolute path is an explicit
 * caller-specified target, not a traversal, and passes through unchanged.
 */
function resolveContained(raw: string, opts: DispatchOpts, key: string): string {
  if (isAbsolute(raw)) return raw;
  const base = typeof opts.cwd === "string" && opts.cwd.length > 0 ? resolve(opts.cwd) : process.cwd();
  const resolved = resolve(base, raw);
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError(
      `shazam: opts.${key} escapes the job cwd via '..': ${raw} (resolved: ${resolved}, cwd: ${base})`,
    );
  }
  return resolved;
}

/** True if `s` contains a C0 control character or DEL. Written as a charCode
 *  scan (never a regex/string containing raw control bytes) to keep the source
 *  unambiguous. */
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

const _check: FlatAdapterModule = { name, binary, probeable, buildArgs, injectContract, parseResult };
void _check;
