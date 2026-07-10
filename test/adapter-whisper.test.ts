/**
 * whisper adapter — Phase 5.
 *
 * Covers DW-5.1 (model pin + SRT to opts.outputDir), DW-5.2 (exit 0 + no
 * transcript file -> failed), DW-5.6 (`../`-escaping outputDir -> TypeError
 * before spawn), plus the option-injection and marker-parsing barricades past
 * the DW floor. mlx-whisper is NOT installed here — buildArgs/injectContract/
 * parseResult are driven directly with synthetic stdout/exitCode and real
 * temp files standing in for "the transcript mlx_whisper wrote". The stdout
 * fixtures mirror the verified `Args: {...}` debug-print line format from
 * ml-explore/mlx-examples/whisper/mlx_whisper/cli.py (see whisper.ts header).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { discoverAdapters } from "../src/adapters/discover.ts";
import * as whisper from "../src/adapters/whisper.ts";

const AUDIO = "/tmp/fixtures/interview.wav";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sdd-whisper-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The exact shape mlx_whisper's cli.py prints via `print(f"Args: {args}")`. */
function argsLine(outputDir: string): string {
  return (
    `Args: {'audio': ['${AUDIO}'], 'model': 'mlx-community/whisper-large-v3-turbo', ` +
    `'output_name': 'transcript', 'output_dir': '${outputDir}', 'output_format': 'all', ` +
    `'verbose': True, 'task': 'transcribe', 'language': None, 'temperature': 0.0}\n`
  );
}

function writeTranscripts(dir: string, srtContent = "1\n00:00:00,000 --> 00:00:01,000\nHello.\n", txtContent = "Hello.\n") {
  writeFileSync(join(dir, "transcript.srt"), srtContent);
  writeFileSync(join(dir, "transcript.txt"), txtContent);
}

// ── DW-5.1: buildArgs pins the model and outputs SRT to opts.outputDir ─────

test("test_DW_5_1_pins_model_and_output_dir", () => {
  const dir = freshDir();
  const argv = whisper.buildArgs(AUDIO, { outputDir: dir });

  expect(argv[0]).toBe("mlx_whisper");
  expect(argv[1]).toBe(AUDIO); // audio path is positional, first
  expect(argv[argv.indexOf("--model") + 1]).toBe("mlx-community/whisper-large-v3-turbo");
  expect(argv[argv.indexOf("--output-dir") + 1]).toBe(dir);
});

test("test_DW_5_1_output_format_all_includes_srt", () => {
  const argv = whisper.buildArgs(AUDIO, { outputDir: freshDir() });
  // "all" is required (not "srt" alone) so both .srt and .txt are produced in
  // one invocation, per the plan's Produces contract — see whisper.ts header.
  expect(argv[argv.indexOf("--output-format") + 1]).toBe("all");
  expect(argv).toContain("--output-name");
  expect(argv[argv.indexOf("--output-name") + 1]).toBe("transcript");
});

test("--verbose True is always passed explicitly (the Args marker depends on it)", () => {
  const argv = whisper.buildArgs(AUDIO, { outputDir: freshDir() });
  expect(argv[argv.indexOf("--verbose") + 1]).toBe("True");
});

// ── DW-5.2: exit 0 with no transcript file present -> failed (dirty) ───────

test("test_DW_5_2_exit_0_missing_transcript_files_is_failed", () => {
  const dir = freshDir();
  const result = whisper.parseResult(argsLine(dir), "", 0);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("transcript.srt");
  expect(result.summary).toContain("transcript.txt");
});

test("test_DW_5_2_exit_0_missing_args_marker_is_failed", () => {
  const result = whisper.parseResult("Detecting language... English\n", "", 0);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("no output_dir found");
});

test("exit 0 with only the srt present (txt missing) is still failed", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "transcript.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHi.\n");
  const result = whisper.parseResult(argsLine(dir), "", 0);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("transcript.txt");
});

test("a present Args marker cannot rescue a non-zero exit", () => {
  const dir = freshDir();
  writeTranscripts(dir);
  const result = whisper.parseResult(argsLine(dir), "boom", 2);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("exited with code 2");
});

// ── exit 0 + both files present -> done, absolute artifacts ────────────────

test("exit 0 with both transcript files present is done with absolute artifacts", () => {
  const dir = freshDir();
  writeTranscripts(dir);
  const result = whisper.parseResult(argsLine(dir), "", 0);
  expect(result.status).toBe("done");
  expect(result.artifacts).toEqual([join(dir, "transcript.srt"), join(dir, "transcript.txt")]);
  expect(result.artifacts.every((p) => isAbsolute(p))).toBe(true);
});

test("silent/music-only audio: empty transcript files still count as present -> done", () => {
  const dir = freshDir();
  writeTranscripts(dir, "", ""); // empty content, files exist
  const result = whisper.parseResult(argsLine(dir), "", 0);
  expect(result.status).toBe("done");
});

test("last Args line wins when several appear (last-occurrence invariant)", () => {
  const dir = freshDir();
  const stale = freshDir();
  writeTranscripts(dir);
  const stdout = argsLine(stale) + argsLine(dir);
  const result = whisper.parseResult(stdout, "", 0);
  expect(result.status).toBe("done");
  expect(result.artifacts[0]).toBe(join(dir, "transcript.srt"));
});

// ── DW-5.6: `../`-escaping outputDir -> TypeError before spawn ─────────────

test("test_DW_5_6_dotdot_outputDir_throws_whisper", () => {
  const dir = freshDir();
  expect(() => whisper.buildArgs(AUDIO, { cwd: dir, outputDir: "../../etc" })).toThrow(TypeError);
});

test("a deep dotdot escape throws a TypeError too", () => {
  const dir = freshDir();
  expect(() => whisper.buildArgs(AUDIO, { cwd: dir, outputDir: "../../../../../../root" })).toThrow(TypeError);
});

test("a relative outputDir that stays inside the cwd is resolved absolute, not rejected", () => {
  const dir = freshDir();
  const argv = whisper.buildArgs(AUDIO, { cwd: dir, outputDir: "media/../audio" });
  const outDir = argv[argv.indexOf("--output-dir") + 1]!;
  expect(outDir).toBe(join(dir, "audio"));
  expect(isAbsolute(outDir)).toBe(true);
});

test("an absolute outputDir is an explicit caller target and passes through", () => {
  const dir = freshDir();
  const argv = whisper.buildArgs(AUDIO, { outputDir: dir });
  expect(argv[argv.indexOf("--output-dir") + 1]).toBe(dir);
});

test("a missing outputDir throws a TypeError (required opt)", () => {
  expect(() => whisper.buildArgs(AUDIO, {})).toThrow(TypeError);
});

// ── identity injectContract ─────────────────────────────────────────────────

test("injectContract is identity", () => {
  expect(whisper.injectContract(AUDIO)).toBe(AUDIO);
  const hostile = "/tmp/$(rm -rf /);`evil`&&|<>.wav";
  expect(whisper.injectContract(hostile)).toBe(hostile);
});

// ── option-injection barricade on the positional audio path ────────────────

test("an audio path starting with '-' is rejected with a TypeError", () => {
  expect(() => whisper.buildArgs("--verbose=False", { outputDir: freshDir() })).toThrow(TypeError);
});

test("an empty or whitespace-only prompt throws a TypeError", () => {
  expect(() => whisper.buildArgs("", { outputDir: freshDir() })).toThrow(TypeError);
  expect(() => whisper.buildArgs("   ", { outputDir: freshDir() })).toThrow(TypeError);
});

test("a control character in the audio path throws a TypeError", () => {
  const withControlChar = "/tmp/evil" + String.fromCharCode(1) + ".wav"; // SOH, never a literal byte in source
  expect(() => whisper.buildArgs(withControlChar, { outputDir: freshDir() })).toThrow(TypeError);
});

test("a space in the audio path is fine (legitimate filenames have spaces)", () => {
  const argv = whisper.buildArgs("/tmp/my recording.wav", { outputDir: freshDir() });
  expect(argv[1]).toBe("/tmp/my recording.wav");
});

// ── malformed opts throw, never silently coerce ─────────────────────────────

test("malformed outputDir throws a TypeError instead of being dropped", () => {
  expect(() => whisper.buildArgs(AUDIO, { outputDir: "" })).toThrow(TypeError);
  expect(() => whisper.buildArgs(AUDIO, { outputDir: 42 })).toThrow(TypeError);
});

// ── adapter surface + discovery ─────────────────────────────────────────────

test("mode is read, binary overrides to mlx_whisper, and the adapter opts out of live probing", () => {
  expect(whisper.mode).toBe("read");
  expect(whisper.binary).toBe("mlx_whisper");
  expect(whisper.probeable).toBe(false);
});

test("whisper is discovered via directory scan, no registry edit", () => {
  const adapters = discoverAdapters(join(import.meta.dir, "..", "src", "adapters"));
  const found = adapters.find((a) => a.name === "whisper");
  expect(found).toBeDefined();
  expect(found!.mode).toBe("read");
  expect(found!.binary).toBe("mlx_whisper");
  expect(typeof found!.buildArgs).toBe("function");
  expect(typeof found!.injectContract).toBe("function");
  expect(typeof found!.parseResult).toBe("function");
});
