/**
 * Preflight check for the video-ingestion pipeline's external tooling.
 *
 * The video-ingest skill (a later phase) shells out to three CLIs that are
 * NOT managed by `bun install`: `yt-dlp`, `mlx-whisper` (binary `mlx_whisper`),
 * and `ffmpeg`. This module answers one question, cheaply and without any
 * network access or download: "are these usable right now?" — and if not,
 * names exactly what to run to fix it.
 *
 * Three independent checks per tool, all always reported (never short-circuit
 * on the first miss, per the phase's edge-case requirement):
 *   1. PRESENCE   — is the binary resolvable on PATH at all (`Bun.which`)?
 *   2. VERSION    — a best-effort, timeout-bounded probe (`<binary> <versionArgs>`)
 *      to surface a human-readable version string and, where a minimum is
 *      known, flag an outdated install.
 *   3. CAPABILITY — for tools like ffmpeg, being present at a good version is
 *      not enough: the pipeline needs specific encoders compiled in. An ffmpeg
 *      that can't emit keyframe images (`mjpeg`/`png`) or the whisper-ready
 *      PCM wav (`pcm_s16le`) is present-but-unusable, so it's flagged with a
 *      per-tool hint (never a hard throw, and never short-circuiting the
 *      remaining tools).
 *
 * `found` is decided by PRESENCE alone. A version probe that fails to run,
 * times out, or produces unparseable output never flips `found` to `false` —
 * it only leaves `version` undefined. This matters most for `mlx-whisper`,
 * whose exact `--version` behavior was unverified at build time; treating
 * probe failure as "can't confirm a version, but the binary is there" is
 * correct regardless of what that CLI actually does.
 *
 * Library-path output discipline: this module must never write to stdout via
 * the global logging object — stdout is the JSON-RPC transport when the
 * server process imports modules under `src/`. The only place this file
 * writes to stdout is the `import.meta.main` CLI branch at the bottom, and it
 * writes there via `process.stdout.write` directly, so this file stays clean
 * under a grep for that logging object's usage.
 */

/** One tool's result: whether it was found, its resolved version if known, and — when something needs fixing — the exact command to run. */
export interface PreflightToolResult {
  name: string;
  found: boolean;
  version?: string;
  hint?: string;
}

/** The aggregate report `preflight()` resolves to. `ok` is true only when every checked tool is present and not flagged outdated. */
export interface PreflightResult {
  ok: boolean;
  tools: PreflightToolResult[];
}

/**
 * A required capability: either a single token that must be present, or a group
 * of alternatives of which at least ONE must be present. `["mjpeg", "png"]`
 * means "mjpeg OR png" (keyframes can be either); `"pcm_s16le"` means that
 * exact encoder is required.
 */
export type CapabilityReq = string | string[];

/**
 * Static description of how to check one external tool. `minVersion` +
 * `outdatedHint` are optional: a spec without them only ever reports
 * found/version, never an outdated verdict (used for all three real tools —
 * see the module doc for why no threshold is asserted here). The
 * `capability*` fields are optional too: a spec without them skips the
 * capability probe entirely (only ffmpeg uses it).
 */
export interface ToolSpec {
  /** Display name, and the key callers pass in `preflight(tools)` to filter. */
  name: string;
  /** Binary name resolved via `Bun.which`. */
  binary: string;
  /** Argv passed to the binary for the version probe, e.g. `["--version"]`. */
  versionArgs: string[];
  /** Extracts a version string from the probe's stdout/stderr; returns undefined if unparseable. Never throws. */
  parseVersion: (stdout: string, stderr: string) => string | undefined;
  /** Minimum acceptable version (dot-separated numeric segments), if one is known. */
  minVersion?: string;
  /** The exact command to install/upgrade this tool. */
  installHint: string;
  /** Builds the hint shown when a resolved version is below `minVersion`. Defaults to a generic message using `installHint`. */
  outdatedHint?: (found: string, min: string) => string;
  /** Argv that makes the tool list its capabilities, e.g. `["-hide_banner", "-encoders"]`. Required to enable the capability probe. */
  capabilityArgs?: string[];
  /** Extracts the set of available capability tokens (e.g. encoder names) from the capability probe's output. Never throws. */
  parseCapabilities?: (stdout: string, stderr: string) => string[];
  /** Capabilities the pipeline needs; each entry is a single required token or an OR-group. Only checked when `capabilityArgs` + `parseCapabilities` are present. */
  requiredCapabilities?: CapabilityReq[];
  /** Builds the hint shown when a required capability is missing. Defaults to a generic message using `installHint`. */
  capabilityHint?: (missing: string[]) => string;
}

/** Test/advanced-caller seam. Every field is optional; omitting all of them reproduces the real environment. */
export interface PreflightOptions {
  /** Overrides PATH resolution for `Bun.which` (test seam — see `Bun.which(binary, {PATH})`). Omit to use the real process PATH. */
  PATH?: string;
  /** Overrides the tool registry `preflight` checks against. Defaults to `DEFAULT_TOOL_SPECS`. */
  specs?: ToolSpec[];
  /** How long to wait for a version probe before giving up on it, in ms. Default 3000. */
  probeTimeoutMs?: number;
}

/** yt-dlp prints a bare version like "2024.12.13" as the first stdout line. */
function parseYtDlpVersion(stdout: string): string | undefined {
  const firstLine = stdout.trim().split("\n")[0]?.trim();
  return firstLine && /^\d/.test(firstLine) ? firstLine : undefined;
}

/** ffmpeg's first line is e.g. "ffmpeg version 8.1.1 Copyright (c) 2000-2026 ...". */
function parseFfmpegVersion(stdout: string): string | undefined {
  return /ffmpeg version (\S+)/.exec(stdout)?.[1];
}

/**
 * Extracts encoder names from `ffmpeg -encoders` output. Each encoder line is
 * a 6-char capability-flags field (letters/dots, e.g. "V....D" / "A....D")
 * followed by the encoder name in the next column:
 *   ` V....D mjpeg                MJPEG (Motion JPEG)`
 * We take that name column per line; non-encoder lines (headers, the legend,
 * the `------` separator) don't match the flags-field shape and are ignored.
 */
function parseFfmpegEncoders(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

/**
 * mlx_whisper's exact `--version` behavior was unverified at build time (it
 * is not installed on the build machine). This parser is deliberately
 * permissive: it scans stdout+stderr for the first dotted-number token,
 * whatever the surrounding output looks like. If nothing matches, `found`
 * still reports true (decided by PATH resolution, not this parse) — only
 * `version` stays undefined.
 */
function parseMlxWhisperVersion(stdout: string, stderr: string): string | undefined {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(`${stdout}\n${stderr}`)?.[1];
}

/** The three tools this pipeline depends on. */
export const DEFAULT_TOOL_SPECS: ToolSpec[] = [
  {
    name: "yt-dlp",
    binary: "yt-dlp",
    versionArgs: ["--version"],
    parseVersion: (stdout) => parseYtDlpVersion(stdout),
    installHint: "brew install yt-dlp  (or: pip install -U yt-dlp / uv tool install yt-dlp)",
  },
  {
    name: "mlx-whisper",
    binary: "mlx_whisper",
    versionArgs: ["--version"],
    parseVersion: parseMlxWhisperVersion,
    installHint: "pip install -U mlx-whisper  (or: uv tool install mlx-whisper) — requires Apple Silicon + Python 3.9+",
  },
  {
    name: "ffmpeg",
    binary: "ffmpeg",
    versionArgs: ["-version"],
    parseVersion: (stdout) => parseFfmpegVersion(stdout),
    installHint: "brew install ffmpeg",
    // The pipeline needs ffmpeg to (a) write keyframe images — either mjpeg or
    // png — and (b) produce the whisper-ready PCM wav (pcm_s16le). All three
    // are core encoders in any standard ffmpeg build; a build lacking one is
    // present-but-unusable for this pipeline, so flag it rather than let a
    // downstream frame/audio step fail cryptically later.
    capabilityArgs: ["-hide_banner", "-encoders"],
    parseCapabilities: (stdout) => parseFfmpegEncoders(stdout),
    requiredCapabilities: [["mjpeg", "png"], "pcm_s16le"],
    capabilityHint: (missing) =>
      `ffmpeg is present but missing required encoder(s): ${missing.join(", ")} — ` +
      "install a full ffmpeg build (brew install ffmpeg) that includes them.",
  },
];

const DEFAULT_PROBE_TIMEOUT_MS = 3000;

/** Compares dot-separated numeric version segments. Negative when `a` < `b`, 0 when equal, positive when `a` > `b`. Non-numeric segments compare as 0. */
function compareVersions(a: string, b: string): number {
  const segsA = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const segsB = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(segsA.length, segsB.length);
  for (let i = 0; i < len; i++) {
    const diff = (segsA[i] ?? 0) - (segsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Runs `<resolvedPath> <args>` and returns its captured output. Fully
 * fault-tolerant: a spawn failure, a non-zero exit, or a timeout all resolve
 * to `undefined` rather than throwing or hanging — every probe built on this
 * is best-effort, never a presence check (that's `Bun.which`).
 */
async function runProbe(
  resolvedPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string } | undefined> {
  try {
    const proc = Bun.spawn([resolvedPath, ...args], { stdout: "pipe", stderr: "pipe" });
    const timedOut = await Promise.race([
      proc.exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
    ]);
    if (timedOut) {
      proc.kill();
      return undefined;
    }
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { stdout, stderr };
  } catch {
    return undefined;
  }
}

/** Best-effort version probe: runs `spec.versionArgs`, parses a version, undefined if it can't. */
async function probeVersion(resolvedPath: string, spec: ToolSpec, timeoutMs: number): Promise<string | undefined> {
  const out = await runProbe(resolvedPath, spec.versionArgs, timeoutMs);
  return out ? spec.parseVersion(out.stdout, out.stderr) : undefined;
}

/**
 * Best-effort capability probe: runs `spec.capabilityArgs`, parses the
 * available capability tokens, and returns the required ones that are absent
 * (a display token per unmet requirement — an OR-group renders as "a|b").
 * Returns `[]` when the spec has no capability requirements OR when the probe
 * itself can't run — same fault-tolerance as the version probe: an unreadable
 * probe is "can't confirm", not "definitely broken", so it never manufactures
 * a false negative.
 */
async function probeMissingCapabilities(resolvedPath: string, spec: ToolSpec, timeoutMs: number): Promise<string[]> {
  if (!spec.capabilityArgs || !spec.parseCapabilities || !spec.requiredCapabilities) return [];
  const out = await runProbe(resolvedPath, spec.capabilityArgs, timeoutMs);
  if (!out) return [];
  const available = new Set(spec.parseCapabilities(out.stdout, out.stderr));

  const missing: string[] = [];
  for (const req of spec.requiredCapabilities) {
    if (typeof req === "string") {
      if (!available.has(req)) missing.push(req);
    } else if (!req.some((alt) => available.has(alt))) {
      missing.push(req.join("|"));
    }
  }
  return missing;
}

/**
 * Checks a single tool spec: presence (`Bun.which`), then version, then
 * capabilities. At most one hint is reported, in priority order — absent
 * beats outdated beats missing-capability — and any hint drives the aggregate
 * `ok` to false. Every branch still returns a result; a tool never throws or
 * short-circuits its siblings.
 */
async function probeTool(spec: ToolSpec, options: PreflightOptions): Promise<PreflightToolResult> {
  const whichOpts = options.PATH !== undefined ? { PATH: options.PATH } : undefined;
  const resolved = Bun.which(spec.binary, whichOpts);
  if (!resolved) {
    return { name: spec.name, found: false, hint: spec.installHint };
  }

  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const version = await probeVersion(resolved, spec, timeoutMs);
  const base: PreflightToolResult =
    version !== undefined ? { name: spec.name, found: true, version } : { name: spec.name, found: true };

  if (version !== undefined && spec.minVersion !== undefined && compareVersions(version, spec.minVersion) < 0) {
    const hint =
      spec.outdatedHint?.(version, spec.minVersion) ??
      `found ${spec.name} ${version}, need >= ${spec.minVersion}: ${spec.installHint}`;
    return { ...base, hint };
  }

  const missingCaps = await probeMissingCapabilities(resolved, spec, timeoutMs);
  if (missingCaps.length > 0) {
    const hint =
      spec.capabilityHint?.(missingCaps) ??
      `${spec.name} is missing required capability/ies: ${missingCaps.join(", ")}: ${spec.installHint}`;
    return { ...base, hint };
  }

  return base;
}

/**
 * Checks each named tool (or every tool in `specs` when `tools` is omitted)
 * for presence and version. Never performs network I/O or downloads anything
 * — PATH resolution and a local version-probe spawn only. Every tool is
 * checked and reported regardless of whether an earlier one failed (never
 * short-circuits on the first miss).
 *
 * @throws {TypeError} if `tools` names something not present in `specs`.
 */
export async function preflight(tools?: string[], options: PreflightOptions = {}): Promise<PreflightResult> {
  const specs = options.specs ?? DEFAULT_TOOL_SPECS;

  let selected: ToolSpec[];
  if (tools === undefined) {
    selected = specs;
  } else {
    selected = [];
    for (const wanted of tools) {
      const spec = specs.find((s) => s.name === wanted);
      if (!spec) {
        throw new TypeError(
          `preflight: unknown tool "${wanted}" — expected one of: ${specs.map((s) => s.name).join(", ")}`,
        );
      }
      selected.push(spec);
    }
  }

  const results = await Promise.all(selected.map((spec) => probeTool(spec, options)));
  return { ok: results.every((r) => r.hint === undefined), tools: results };
}

// CLI entry: `bun run src/lib/preflight.ts`. Prints the real-environment
// report as JSON on stdout and exits non-zero on any failure — the gate the
// video-ingest skill (Phase 7) runs via Bash before dispatching any work.
// This is the ONLY place this module writes to stdout, and it does so via
// `process.stdout.write` directly, never the global logging object.
if (import.meta.main) {
  const result = await preflight();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}
