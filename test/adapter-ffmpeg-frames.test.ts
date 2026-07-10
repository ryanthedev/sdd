/**
 * ffmpeg-frames adapter — Phase 5.
 *
 * Covers DW-5.3 (sceneThreshold/frameCount injected into the filter+cap),
 * DW-5.4 (manifest maps every frame to a timestamp, `dropped` set when the
 * cap fires), DW-5.5 (the select expression structurally guarantees a
 * non-empty selection even with zero real scene cuts), DW-5.6
 * (`../`-escaping outputDir -> TypeError before spawn). ffmpeg is NOT
 * installed here — buildArgs/injectContract/parseResult are driven directly
 * with synthetic stderr (mirroring ffmpeg's own `Output #0, ..., to '...':`
 * banner and `showinfo`'s `pts_time:` lines — see ffmpeg-frames.ts header for
 * the verified format) and real frame files standing in for "the jpgs ffmpeg
 * wrote".
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { discoverAdapters } from "../src/adapters/discover.ts";
import * as ffmpegFrames from "../src/adapters/ffmpeg-frames.ts";

const VIDEO = "/tmp/fixtures/clip.mp4";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sdd-ffmpeg-frames-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** ffmpeg's own "what am I writing to" banner line. */
function outputBanner(dir: string): string {
  return `Output #0, image2, to '${join(dir, "frame_%d.jpg")}':\n`;
}

/** One showinfo line per selected frame, in chronological order. */
function ptsLine(n: number, tSeconds: number): string {
  return `[Parsed_showinfo_2 @ 0x0] n:${n} pts:${n} pts_time:${tSeconds} fmt:yuv420p\n`;
}

/** Write `count` frame files named after ascending fake pts values, and
 *  return the stderr fixture with `count` matching pts_time lines. */
function writeFrames(dir: string, ptsSeconds: number[]): string {
  let stderr = outputBanner(dir);
  ptsSeconds.forEach((t, i) => {
    writeFileSync(join(dir, `frame_${i}.jpg`), "jpg-bytes");
    stderr += ptsLine(i, t);
  });
  return stderr;
}

// ── DW-5.3: sceneThreshold (default 0.35) and frameCount (default 150) ─────

test("test_DW_5_3_default_threshold_and_cap", () => {
  const dir = freshDir();
  const argv = ffmpegFrames.buildArgs(VIDEO, { outputDir: dir });
  const vf = argv[argv.indexOf("-vf") + 1]!;
  expect(vf).toContain("gt(scene\\,0.35)");
  expect(argv[argv.indexOf("-frames:v") + 1]).toBe("150");
});

test("test_DW_5_3_explicit_threshold_and_cap", () => {
  const dir = freshDir();
  const argv = ffmpegFrames.buildArgs(VIDEO, { outputDir: dir, sceneThreshold: 0.6, frameCount: 20 });
  const vf = argv[argv.indexOf("-vf") + 1]!;
  expect(vf).toContain("gt(scene\\,0.6)");
  expect(argv[argv.indexOf("-frames:v") + 1]).toBe("20");
});

test("buildArgs includes mpdecimate (dedup), showinfo, -frame_pts 1, and -i before -vf", () => {
  const dir = freshDir();
  const argv = ffmpegFrames.buildArgs(VIDEO, { outputDir: dir });
  expect(argv[0]).toBe("ffmpeg");
  expect(argv[argv.indexOf("-i") + 1]).toBe(VIDEO);
  const vf = argv[argv.indexOf("-vf") + 1]!;
  expect(vf).toContain("mpdecimate");
  expect(vf).toContain("showinfo");
  expect(argv[argv.indexOf("-frame_pts") + 1]).toBe("1");
  expect(argv).toContain("-vsync");
  expect(argv[argv.indexOf("-vsync") + 1]).toBe("vfr");
  expect(argv[argv.length - 1]).toBe(join(dir, "frame_%d.jpg"));
});

// ── DW-5.4: manifest maps every frame to a timestamp; dropped on over-cap ──

test("test_DW_5_4_manifest_maps_every_frame_to_a_timestamp", () => {
  const dir = freshDir();
  const stderr = writeFrames(dir, [0, 2.5, 6]);
  const result = ffmpegFrames.parseResult("", stderr, 0);

  expect(result.status).toBe("done");
  const manifestPath = join(dir, "manifest.json");
  expect(result.artifacts).toContain(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.frames).toEqual([
    { file: join(dir, "frame_0.jpg"), tSeconds: 0 },
    { file: join(dir, "frame_1.jpg"), tSeconds: 2.5 },
    { file: join(dir, "frame_2.jpg"), tSeconds: 6 },
  ]);
  expect(manifest.dropped).toBeUndefined();
});

test("test_DW_5_4_dropped_set_when_cap_fires_dirty", () => {
  const dir = freshDir();
  // Simulate showinfo reporting 5 selected frames, but only 2 survived the
  // -frames:v cap (the other 3 files were never written to outputDir).
  let stderr = outputBanner(dir);
  for (let i = 0; i < 5; i++) stderr += ptsLine(i, i * 1.5);
  writeFileSync(join(dir, "frame_0.jpg"), "jpg-bytes");
  writeFileSync(join(dir, "frame_1.jpg"), "jpg-bytes");

  const result = ffmpegFrames.parseResult("", stderr, 0);
  expect(result.status).toBe("done");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  expect(manifest.dropped).toBe(3);
  expect(manifest.frames).toHaveLength(2);
  // The kept frames are the EARLIEST two selected (pts 0 and 1.5) — no silent
  // truncation from the wrong end.
  expect(manifest.frames[0].tSeconds).toBe(0);
  expect(manifest.frames[1].tSeconds).toBe(1.5);
});

test("artifacts list every frame file plus the manifest, in that order", () => {
  const dir = freshDir();
  const stderr = writeFrames(dir, [0, 3]);
  const result = ffmpegFrames.parseResult("", stderr, 0);
  expect(result.artifacts).toEqual([join(dir, "frame_0.jpg"), join(dir, "frame_1.jpg"), join(dir, "manifest.json")]);
});

// ── DW-5.5: 0-scene-cut input falls back to periodic frames (never empty) ──

test("test_DW_5_5_filter_structurally_guarantees_frame_zero_selected", () => {
  const dir = freshDir();
  const argv = ffmpegFrames.buildArgs(VIDEO, { outputDir: dir });
  const vf = argv[argv.indexOf("-vf") + 1]!;
  // not(mod(n,150)) is true at n=0 regardless of scene score, for ANY
  // sceneThreshold — this is the structural non-empty guarantee.
  expect(vf).toContain("not(mod(n\\,150))");
});

test("test_DW_5_5_zero_scene_cut_single_fallback_frame_still_done", () => {
  const dir = freshDir();
  // A static clip: only the n=0 periodic fallback frame was ever selected.
  const stderr = writeFrames(dir, [0]);
  const result = ffmpegFrames.parseResult("", stderr, 0);
  expect(result.status).toBe("done");
  expect(result.artifacts).toHaveLength(2); // one frame + manifest
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  expect(manifest.frames).toHaveLength(1);
  expect(manifest.dropped).toBeUndefined();
});

test("zero frame files with exit 0 is failed (never-empty guarantee violated, don't fake success)", () => {
  const dir = freshDir();
  const stderr = outputBanner(dir); // no pts_time lines, no frame files
  const result = ffmpegFrames.parseResult("", stderr, 0);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("no frame files found");
});

// ── exit != 0 -> failed with a stderr tail ──────────────────────────────────

test("non-zero exit is failed and carries the stderr tail", () => {
  const stderr = "Unknown decoder 'foo'\nError opening input";
  const result = ffmpegFrames.parseResult("", stderr, 1);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("exited with code 1");
  expect(result.summary).toContain("Error opening input");
});

test("missing Output banner entirely on exit 0 is failed (silent-misparse backstop)", () => {
  const result = ffmpegFrames.parseResult("", "frame=  10 fps=5.0\n", 0);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("output banner");
});

// ── DW-5.6: `../`-escaping outputDir -> TypeError before spawn ─────────────

test("test_DW_5_6_dotdot_outputDir_throws_ffmpeg_frames", () => {
  const dir = freshDir();
  expect(() => ffmpegFrames.buildArgs(VIDEO, { cwd: dir, outputDir: "../../etc" })).toThrow(TypeError);
});

test("a deep dotdot escape throws a TypeError too", () => {
  const dir = freshDir();
  expect(() => ffmpegFrames.buildArgs(VIDEO, { cwd: dir, outputDir: "../../../../../../root" })).toThrow(TypeError);
});

test("a relative outputDir that stays inside the cwd is resolved absolute, not rejected", () => {
  const dir = freshDir();
  const argv = ffmpegFrames.buildArgs(VIDEO, { cwd: dir, outputDir: "media/../frames" });
  const target = argv[argv.length - 1]!;
  expect(target).toBe(join(dir, "frames", "frame_%d.jpg"));
  expect(isAbsolute(target)).toBe(true);
});

test("an absolute outputDir is an explicit caller target and passes through", () => {
  const dir = freshDir();
  const argv = ffmpegFrames.buildArgs(VIDEO, { outputDir: dir });
  expect(argv[argv.length - 1]).toBe(join(dir, "frame_%d.jpg"));
});

test("a missing outputDir throws a TypeError (required opt)", () => {
  expect(() => ffmpegFrames.buildArgs(VIDEO, {})).toThrow(TypeError);
});

// ── identity injectContract ─────────────────────────────────────────────────

test("injectContract is identity", () => {
  expect(ffmpegFrames.injectContract(VIDEO)).toBe(VIDEO);
  const hostile = "/tmp/$(rm -rf /);`evil`&&|<>.mp4";
  expect(ffmpegFrames.injectContract(hostile)).toBe(hostile);
});

// ── option-injection barricade on the -i input path ─────────────────────────

test("an input path starting with '-' is rejected with a TypeError", () => {
  expect(() => ffmpegFrames.buildArgs("-loglevel quiet", { outputDir: freshDir() })).toThrow(TypeError);
});

test("an empty or whitespace-only prompt throws a TypeError", () => {
  expect(() => ffmpegFrames.buildArgs("", { outputDir: freshDir() })).toThrow(TypeError);
  expect(() => ffmpegFrames.buildArgs("   ", { outputDir: freshDir() })).toThrow(TypeError);
});

test("a control character in the input path throws a TypeError", () => {
  const withControlChar = "/tmp/evil" + String.fromCharCode(1) + ".mp4";
  expect(() => ffmpegFrames.buildArgs(withControlChar, { outputDir: freshDir() })).toThrow(TypeError);
});

// ── malformed opts throw, never silently coerce ─────────────────────────────

test("malformed frameCount/sceneThreshold throw TypeErrors instead of being clamped silently", () => {
  const dir = freshDir();
  expect(() => ffmpegFrames.buildArgs(VIDEO, { outputDir: dir, frameCount: 0 })).toThrow(TypeError);
  expect(() => ffmpegFrames.buildArgs(VIDEO, { outputDir: dir, frameCount: -5 })).toThrow(TypeError);
  expect(() => ffmpegFrames.buildArgs(VIDEO, { outputDir: dir, frameCount: 1.5 })).toThrow(TypeError);
  expect(() => ffmpegFrames.buildArgs(VIDEO, { outputDir: dir, frameCount: "150" })).toThrow(TypeError);
  expect(() => ffmpegFrames.buildArgs(VIDEO, { outputDir: dir, sceneThreshold: 1.5 })).toThrow(TypeError);
  expect(() => ffmpegFrames.buildArgs(VIDEO, { outputDir: dir, sceneThreshold: -0.1 })).toThrow(TypeError);
  expect(() => ffmpegFrames.buildArgs(VIDEO, { outputDir: 42 })).toThrow(TypeError);
});

test("sceneThreshold boundary values 0 and 1 are accepted", () => {
  const dir = freshDir();
  expect(() => ffmpegFrames.buildArgs(VIDEO, { outputDir: dir, sceneThreshold: 0 })).not.toThrow();
  expect(() => ffmpegFrames.buildArgs(VIDEO, { outputDir: dir, sceneThreshold: 1 })).not.toThrow();
});

// ── adapter surface + discovery ─────────────────────────────────────────────

test("mode is read, binary is ffmpeg, and the adapter opts out of live probing", () => {
  expect(ffmpegFrames.mode).toBe("read");
  expect(ffmpegFrames.binary).toBe("ffmpeg");
  expect(ffmpegFrames.probeable).toBe(false);
});

test("ffmpeg-frames is discovered via directory scan, no registry edit", () => {
  const adapters = discoverAdapters(join(import.meta.dir, "..", "src", "adapters"));
  const found = adapters.find((a) => a.name === "ffmpeg-frames");
  expect(found).toBeDefined();
  expect(found!.mode).toBe("read");
  expect(found!.binary).toBe("ffmpeg");
  expect(typeof found!.buildArgs).toBe("function");
  expect(typeof found!.injectContract).toBe("function");
  expect(typeof found!.parseResult).toBe("function");
});
