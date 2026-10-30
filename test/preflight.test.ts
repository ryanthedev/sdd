/**
 * preflight — presence + version checks for `yt-dlp`, `mlx-whisper`, `ffmpeg`.
 *
 * PATH stubbing follows the same "real thing, not a mock" technique as
 * `test/tools-check.test.ts`: fixture cases write real, tiny, executable
 * shell scripts to a fresh temp dir and point `Bun.which` at it via
 * `preflight`'s `{PATH}` option override (verified in discovery: Bun.which
 * fully honors a PATH override, independent of the real process PATH) —
 * so DW-1.1/1.2 exercise the real `Bun.spawn` version-probe path without
 * needing yt-dlp/mlx-whisper/ffmpeg actually installed.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  DEFAULT_TOOL_SPECS,
  OPTIONAL_TOOL_SPECS,
  preflight,
  type PreflightResult,
  type ToolSpec,
} from "../src/lib/preflight.ts";

const tmpDirs: string[] = [];

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Writes an executable shell-script fixture named `binary` into `dir` that prints `stdout` and exits 0. */
function writeFakeBinary(dir: string, binary: string, stdout: string): void {
  writeFileSync(join(dir, binary), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(stdout)}\n`, { mode: 0o755 });
}

/**
 * Writes a fake `ffmpeg` that answers BOTH probes the spec issues: `-version`
 * prints the version banner, and `-encoders` prints one encoder line per name
 * in `encoders` (real ffmpeg's `<6-flag-field> <name> <description>` shape).
 * `encoders` lets a test cripple the fake by omitting a required encoder.
 */
function writeFakeFfmpeg(dir: string, version: string, encoders: string[]): void {
  // One printf argument per output line, with a `%s\n` format that re-applies
  // to each — so printf inserts the REAL newlines. (Embedding a joined
  // newline string in a single arg would land as literal "\n" text via JSON
  // escaping, collapsing every encoder onto one physical line.)
  const lineArgs = ["Encoders:", ...encoders.map((e) => ` V....D ${e}   fake ${e} encoder`)]
    .map((line) => JSON.stringify(line))
    .join(" ");
  const script =
    `#!/bin/sh\n` +
    `case "$*" in\n` +
    `  *-encoders*)\n` +
    `    printf '%s\\n' ${lineArgs} ;;\n` +
    `  *)\n` +
    `    printf 'ffmpeg version %s Copyright (c) 2000-2026 the FFmpeg developers\\n' ${JSON.stringify(version)} ;;\n` +
    `esac\n`;
  writeFileSync(join(dir, "ffmpeg"), script, { mode: 0o755 });
}

/** The encoders a healthy ffmpeg advertises for this pipeline (keyframes + PCM wav). */
const FULL_FFMPEG_ENCODERS = ["mjpeg", "png", "pcm_s16le", "libx264", "aac"];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-1.1: absent binary -> ok:false, per-tool hint, PATH stubbed to exclude it.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_1_1_reports_ok_false_with_hint_when_binary_absent", async () => {
  const emptyPath = freshDir("sdd-preflight-empty-");

  const result = await preflight(undefined, { PATH: emptyPath });

  expect(result.ok).toBe(false);
  expect(result.tools).toHaveLength(3);
  for (const tool of result.tools) {
    expect(tool.found).toBe(false);
    expect(tool.version).toBeUndefined();
    expect(tool.hint).toBeTruthy();
  }
  const names = result.tools.map((t) => t.name).sort();
  expect(names).toEqual(["ffmpeg", "mlx-whisper", "yt-dlp"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-1.2: all three present -> ok:true, resolved versions, via fixture binaries.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_1_2_reports_ok_true_with_versions_when_all_present", async () => {
  const dir = freshDir("sdd-preflight-present-");
  writeFakeBinary(dir, "yt-dlp", "2024.12.13");
  writeFakeBinary(dir, "mlx_whisper", "mlx_whisper 0.4.2");
  writeFakeFfmpeg(dir, "8.1.1", FULL_FFMPEG_ENCODERS);

  const result = await preflight(undefined, { PATH: dir });

  expect(result.ok).toBe(true);
  const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
  expect(byName["yt-dlp"]).toEqual({ name: "yt-dlp", found: true, version: "2024.12.13" });
  expect(byName["mlx-whisper"]).toEqual({ name: "mlx-whisper", found: true, version: "0.4.2" });
  expect(byName.ffmpeg).toEqual({ name: "ffmpeg", found: true, version: "8.1.1" });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge case (plan): ffmpeg present + good version but MISSING a required
// encoder → found:true with an encoder hint, preflight().ok === false, and the
// OTHER tools are still probed and reported (no first-miss short-circuit). The
// fake ffmpeg advertises mjpeg + png (keyframes fine) but omits pcm_s16le
// (the whisper-ready wav encoder) — driven deterministically via the fixture,
// no crippled host ffmpeg needed.
// ─────────────────────────────────────────────────────────────────────────────
test("ffmpeg present but missing a required encoder is flagged per-tool while other tools still probe", async () => {
  const dir = freshDir("sdd-preflight-noencoder-");
  writeFakeBinary(dir, "yt-dlp", "2024.12.13");
  writeFakeBinary(dir, "mlx_whisper", "mlx_whisper 0.4.2");
  writeFakeFfmpeg(dir, "8.1.1", ["mjpeg", "png", "libx264"]); // no pcm_s16le

  const result = await preflight(undefined, { PATH: dir });

  // Aggregate reflects the miss…
  expect(result.ok).toBe(false);
  // …but every tool was still probed (no short-circuit on the ffmpeg miss).
  expect(result.tools).toHaveLength(3);
  const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));

  // ffmpeg: present, version resolved, but hinted about the missing encoder.
  expect(byName.ffmpeg!.found).toBe(true);
  expect(byName.ffmpeg!.version).toBe("8.1.1");
  expect(byName.ffmpeg!.hint).toBeTruthy();
  expect(byName.ffmpeg!.hint).toContain("pcm_s16le");
  // The satisfied keyframe encoders must NOT appear as missing.
  expect(byName.ffmpeg!.hint).not.toContain("mjpeg");
  expect(byName.ffmpeg!.hint).not.toContain("png");

  // The other two tools are healthy and unaffected.
  expect(byName["yt-dlp"]).toEqual({ name: "yt-dlp", found: true, version: "2024.12.13" });
  expect(byName["mlx-whisper"]).toEqual({ name: "mlx-whisper", found: true, version: "0.4.2" });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge case (plan): an OR-group is satisfied by EITHER alternative. ffmpeg with
// png but no mjpeg still passes the keyframe requirement — only a genuinely
// unmet group flags.
// ─────────────────────────────────────────────────────────────────────────────
test("ffmpeg satisfies the keyframe requirement with either mjpeg or png alone", async () => {
  const dir = freshDir("sdd-preflight-oneencoder-");
  writeFakeFfmpeg(dir, "8.1.1", ["png", "pcm_s16le"]); // png only, no mjpeg — still fine

  const result = await preflight(["ffmpeg"], { PATH: dir });

  expect(result.ok).toBe(true);
  expect(result.tools[0]).toEqual({ name: "ffmpeg", found: true, version: "8.1.1" });
});

// ─────────────────────────────────────────────────────────────────────────────
// dirty: preflight(["bogus"]) throws instead of silently ignoring bad input
// (external-input validation, per cc-defensive-programming).
// ─────────────────────────────────────────────────────────────────────────────
test("preflight throws a TypeError for an unknown tool name instead of silently ignoring it", async () => {
  await expect(preflight(["totally-not-a-real-tool"])).rejects.toThrow(TypeError);
});

// ─────────────────────────────────────────────────────────────────────────────
// dirty: the `tools` filter narrows the checked/returned set.
// ─────────────────────────────────────────────────────────────────────────────
test("preflight(tools) checks and returns only the named subset", async () => {
  const emptyPath = freshDir("sdd-preflight-subset-");

  const result = await preflight(["ffmpeg"], { PATH: emptyPath });

  expect(result.tools).toHaveLength(1);
  expect(result.tools[0]!.name).toBe("ffmpeg");
});

// ─────────────────────────────────────────────────────────────────────────────
// T-1.3 (dirty, DW-1.1 edge case): a present-but-too-old tool is flagged via
// the generic minVersion/outdatedHint mechanism, and preflight does not crash.
// No real threshold is asserted for the actual three tools (none is sourced —
// see discovery doc); this exercises the mechanism itself through a synthetic
// spec, end-to-end through the real preflight() function.
// ─────────────────────────────────────────────────────────────────────────────
test("a tool below its configured minVersion is flagged outdated without crashing preflight", async () => {
  const dir = freshDir("sdd-preflight-outdated-");
  writeFakeBinary(dir, "fake-tool", "1.0.0");
  const spec: ToolSpec = {
    name: "fake-tool",
    binary: "fake-tool",
    versionArgs: ["--version"],
    parseVersion: (stdout) => stdout.trim() || undefined,
    minVersion: "2.0.0",
    installHint: "install fake-tool >= 2.0.0",
  };

  const result = await preflight(["fake-tool"], { PATH: dir, specs: [spec] });

  expect(result.ok).toBe(false);
  expect(result.tools).toEqual([
    {
      name: "fake-tool",
      found: true,
      version: "1.0.0",
      hint: "found fake-tool 1.0.0, need >= 2.0.0: install fake-tool >= 2.0.0",
    },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// dirty: a version probe that never exits is bounded by probeTimeoutMs and
// resolves found:true with no version, rather than hanging preflight().
// ─────────────────────────────────────────────────────────────────────────────
test("a hanging version probe times out and still reports found:true with no version", async () => {
  const dir = freshDir("sdd-preflight-hang-");
  writeFileSync(join(dir, "hang-tool"), "#!/bin/sh\nwhile true; do sleep 1; done\n", { mode: 0o755 });
  const spec: ToolSpec = {
    name: "hang-tool",
    binary: "hang-tool",
    versionArgs: ["--version"],
    parseVersion: (stdout) => stdout.trim() || undefined,
    installHint: "n/a",
  };

  const result = await preflight(["hang-tool"], { PATH: dir, specs: [spec], probeTimeoutMs: 200 });

  expect(result.tools).toEqual([{ name: "hang-tool", found: true }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// dirty: a version probe that exits non-zero with unparseable output still
// reports found:true (presence is Bun.which alone, never gated on the probe).
// ─────────────────────────────────────────────────────────────────────────────
test("an unparseable/failing version probe still reports found:true, only version stays undefined", async () => {
  const dir = freshDir("sdd-preflight-badprobe-");
  writeFileSync(join(dir, "bad-tool"), "#!/bin/sh\necho 'not a version' 1>&2\nexit 2\n", { mode: 0o755 });
  const spec: ToolSpec = {
    name: "bad-tool",
    binary: "bad-tool",
    versionArgs: ["--version"],
    parseVersion: () => undefined,
    installHint: "n/a",
  };

  const result = await preflight(["bad-tool"], { PATH: dir, specs: [spec] });

  expect(result.tools).toEqual([{ name: "bad-tool", found: true }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT_TOOL_SPECS sanity: the real registry names the three tools the plan
// requires, each with a non-empty install hint.
// ─────────────────────────────────────────────────────────────────────────────
test("DEFAULT_TOOL_SPECS covers yt-dlp, mlx-whisper, and ffmpeg with install hints", () => {
  const names = DEFAULT_TOOL_SPECS.map((s) => s.name).sort();
  expect(names).toEqual(["ffmpeg", "mlx-whisper", "yt-dlp"]);
  for (const spec of DEFAULT_TOOL_SPECS) {
    expect(spec.installHint.length).toBeGreaterThan(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-1.4: grep-clean — no console.* anywhere in the source file (including the
// import.meta.main CLI branch, which uses process.stdout.write instead).
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_1_4_no_console_usage_anywhere_in_preflight_source", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "lib", "preflight.ts"), "utf8");
  // A plain literal grep for the banned identifier — not just call-site
  // usage — stays clean: the file's comments describe the discipline without
  // ever spelling out the literal substring "console.".
  expect(source).not.toMatch(/console\./);
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-1.5: `bun run src/lib/preflight.ts` prints valid JSON and exits non-zero
// when a tool is missing. The CLI branch calls preflight() with no options,
// so it resolves against the child process's real PATH — the child is given
// a PATH stripped down to a bare-empty directory so all three tools are
// deterministically absent, regardless of what happens to be installed on
// whatever machine runs this test (never rely on ambient host state).
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_1_5_cli_prints_valid_json_and_exits_nonzero_when_tool_missing", async () => {
  const repoRoot = join(import.meta.dir, "..");
  const emptyPath = freshDir("sdd-preflight-cli-empty-");
  const proc = Bun.spawn([process.execPath, "run", "src/lib/preflight.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PATH: emptyPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(exitCode).not.toBe(0);
  const parsed = JSON.parse(stdout) as PreflightResult;
  expect(parsed.ok).toBe(false);
  expect(Array.isArray(parsed.tools)).toBe(true);
  expect(parsed.tools.length).toBeGreaterThan(0);
  expect(parsed.tools.some((t) => t.found === false && typeof t.hint === "string")).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// DW-1.3: README documents install for all three tools + the Instagram
// cookies/nightly caveat.
// ─────────────────────────────────────────────────────────────────────────────
test("test_DW_1_3_readme_documents_all_three_tools_and_instagram_caveat", () => {
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

  expect(readme).toMatch(/yt-dlp/);
  expect(readme).toMatch(/ffmpeg/);
  expect(readme).toMatch(/mlx-whisper|mlx_whisper/);
  // install commands
  expect(readme).toMatch(/brew install yt-dlp/);
  expect(readme).toMatch(/brew install ffmpeg/);
  expect(readme).toMatch(/pip install .*mlx-whisper|uv tool install mlx-whisper/);
  // Instagram cookies + nightly caveat
  expect(readme).toMatch(/Instagram/);
  expect(readme).toMatch(/cookies/i);
  expect(readme).toMatch(/nightly/i);
  // points at the preflight CLI
  expect(readme).toMatch(/bun run src\/lib\/preflight\.ts/);
});

/**
 * OPTIONAL_TOOL_SPECS — tools only an opt-in step needs (`uv`, for `shazam`).
 * The invariant under test is that they are reported but never gate: a machine
 * without `uv` must still pass preflight, because the core fetch → transcribe →
 * frames → fuse sequence is complete without it.
 */
test("optional specs are disjoint from the gating specs", () => {
  const required = new Set(DEFAULT_TOOL_SPECS.map((s) => s.name));
  expect(OPTIONAL_TOOL_SPECS.length).toBeGreaterThan(0);
  for (const spec of OPTIONAL_TOOL_SPECS) {
    expect(required.has(spec.name)).toBe(false);
    // Every optional spec still names an exact fix, like every required one.
    expect(spec.installHint.length).toBeGreaterThan(0);
  }
  expect(OPTIONAL_TOOL_SPECS.map((s) => s.name)).toContain("uv");
});

test("a missing optional tool is reported but never flips ok", async () => {
  const emptyDir = freshDir("sdd-preflight-empty-");

  // Nothing on PATH at all: the optional probe reports the miss with a hint...
  const optional = await preflight(undefined, { specs: OPTIONAL_TOOL_SPECS, PATH: emptyDir });
  expect(optional.tools[0]?.found).toBe(false);
  expect(optional.tools[0]?.hint).toBeDefined();

  // ...and the gating call is decided by DEFAULT_TOOL_SPECS alone — an absent
  // `uv` is never one of the tools it looks at.
  const gating = await preflight(undefined, { specs: DEFAULT_TOOL_SPECS, PATH: emptyDir });
  expect(gating.tools.map((t) => t.name)).not.toContain("uv");
});

test("uv version output is parsed", async () => {
  const dir = freshDir("sdd-preflight-uv-");
  writeFakeBinary(dir, "uv", "uv 0.11.21 (abc1234 2026-06-01)");

  const result = await preflight(undefined, { specs: OPTIONAL_TOOL_SPECS, PATH: dir });
  expect(result.tools[0]?.found).toBe(true);
  expect(result.tools[0]?.version).toBe("0.11.21");
  expect(result.tools[0]?.hint).toBeUndefined();
});
