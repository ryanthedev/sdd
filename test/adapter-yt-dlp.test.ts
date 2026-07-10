/**
 * yt-dlp adapter — Phase 4.
 *
 * Covers DW-4.1 (all flags before the positional URL), DW-4.2 (exit 0 +
 * absent audio file → failed), DW-4.3 (exit 0 + present file → done with
 * artifact), DW-4.4 (`../`-escaping outputDir → TypeError before spawn),
 * DW-4.5 (identity injectContract), plus the option-injection and
 * traversal barricades past the DW floor. No real yt-dlp binary is spawned
 * (it is not installed here) — buildArgs/injectContract/parseResult are
 * driven directly with synthetic inputs and real temp files standing in for
 * "the WAV yt-dlp wrote".
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { discoverAdapters } from "../src/adapters/discover.ts";
import * as ytdlp from "../src/adapters/yt-dlp.ts";

const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sdd-yt-dlp-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── DW-4.1: all flags before the positional URL, never after it ────────────

test("test_DW_4_1_url_is_last_argv_element_all_flags_before_it", () => {
  const dir = freshDir();
  const argv = ytdlp.buildArgs(URL, {
    outputDir: dir,
    cookies: join(dir, "cookies.txt"),
    subLangs: "en,en-US",
    sleepRequests: 2,
  });

  expect(argv[0]).toBe("yt-dlp");
  expect(argv[argv.length - 1]).toBe(URL); // URL is the LAST element
  // Every dash-prefixed element (a flag) sits strictly before the URL.
  const urlIdx = argv.indexOf(URL);
  for (const [i, el] of argv.entries()) {
    if (el.startsWith("-")) expect(i).toBeLessThan(urlIdx);
  }
  // The full plan-pinned flag set is present.
  for (const flag of ["-x", "--audio-format", "-f", "-k", "--cookies", "--sub-langs", "--sleep-requests", "-o"]) {
    expect(argv).toContain(flag);
  }
  expect(argv[argv.indexOf("--audio-format") + 1]).toBe("wav");
  // Amended contract (Phase 7 cross-adapter fix): a resolution-capped video,
  // not audio-only — `-f` caps at 720p and `-k` keeps the merged video.
  expect(argv[argv.indexOf("-f") + 1]).toContain("height<=720");
});

test("test_DW_4_1_end_of_options_separator_immediately_precedes_url", () => {
  const argv = ytdlp.buildArgs(URL, { outputDir: freshDir() });
  expect(argv[argv.length - 1]).toBe(URL);
  expect(argv[argv.length - 2]).toBe("--"); // structural end-of-options barricade
});

test("minimal opts omit the optional flag groups entirely", () => {
  const argv = ytdlp.buildArgs(URL, { outputDir: freshDir() });
  for (const absent of ["--cookies", "--sub-langs", "--write-subs", "--write-auto-subs", "--sleep-requests"]) {
    expect(argv).not.toContain(absent);
  }
  // The marker flags are always present (parseResult's contract line).
  expect(argv).toContain("--print");
  expect(argv[argv.indexOf("--print") + 1]).toBe("after_move:filepath");
  expect(argv).toContain("--no-simulate");
  expect(argv).toContain("--no-quiet");
  expect(argv).toContain("--no-playlist");
});

test("subLangs opt expands to the full best-effort subtitle flag group", () => {
  const argv = ytdlp.buildArgs(URL, { outputDir: freshDir(), subLangs: "en.*,ja" });
  expect(argv).toContain("--write-subs");
  expect(argv).toContain("--write-auto-subs");
  expect(argv[argv.indexOf("--sub-langs") + 1]).toBe("en.*,ja");
  expect(argv[argv.indexOf("--sub-format") + 1]).toBe("vtt");
});

// ── DW-4.6: resolution-capped video retained alongside the wav ─────────────

test("test_DW_4_6_buildArgs_caps_resolution_keeps_video_and_emits_labeled_video_print", () => {
  const argv = ytdlp.buildArgs(URL, { outputDir: freshDir() });
  expect(argv[argv.indexOf("-f") + 1]).toContain("height<=720"); // resolution cap
  expect(argv).toContain("-k"); // keep merged video after wav extraction
  // The video --print uses the post_process stage (after_video's filepath is
  // NA — verified against real yt-dlp), labeled so parseResult can tag it.
  expect(argv.some((a) => a === "post_process:SDD_VIDEO_PATH:%(filepath)s")).toBe(true);
  expect(argv.some((a) => a.startsWith("after_video:"))).toBe(false);
  // The audio --print (first one) is still the bare after_move:filepath line.
  expect(argv[argv.indexOf("--print") + 1]).toBe("after_move:filepath");
});

// post_process emits the video path as a BASENAME (not absolute); parseResult
// resolves it against the wav's dir. These synthetic triples mirror the real
// yt-dlp stdout shape confirmed in the E2E (see also the real-binary test).
test("test_DW_4_6_parseResult_resolves_basename_video_against_wav_dir_and_reports_both", () => {
  const dir = freshDir();
  const wav = join(dir, "jNQXAC9IVRw.wav");
  const video = join(dir, "jNQXAC9IVRw.webm");
  writeFileSync(wav, "RIFF");
  writeFileSync(video, "\x00\x00");
  // absolute wav line (after_move) + BASENAME video line (post_process)
  const stdout = `[download] 100%\n${wav}\nSDD_VIDEO_PATH:jNQXAC9IVRw.webm\n`;
  const result = ytdlp.parseResult(stdout, "", 0);
  expect(result.status).toBe("done");
  expect(result.artifacts).toEqual([wav, video]); // audio first, then resolved-absolute video
  expect(result.summary).toContain(video);
});

test("post_process ExtractAudio (.wav) line is not mistaken for the video marker", () => {
  // post_process fires for BOTH Merger and ExtractAudio; the video regex only
  // accepts a video extension, so a SDD_VIDEO_PATH:<stem>.wav line is ignored.
  const dir = freshDir();
  const wav = join(dir, "clip.wav");
  const video = join(dir, "clip.webm");
  writeFileSync(wav, "RIFF");
  writeFileSync(video, "\x00");
  const stdout = `${wav}\nSDD_VIDEO_PATH:clip.wav\nSDD_VIDEO_PATH:clip.webm\n`;
  expect(ytdlp.parseResult(stdout, "", 0).artifacts).toEqual([wav, video]);
});

test("artifacts order is audio, video, then subtitles", () => {
  const dir = freshDir();
  const wav = join(dir, "v.wav");
  const video = join(dir, "v.mp4");
  const vtt = join(dir, "v.en.vtt");
  for (const [p, c] of [
    [wav, "RIFF"],
    [video, "\x00"],
    [vtt, "WEBVTT"],
  ] as const)
    writeFileSync(p, c);
  const stdout = `[info] Writing video subtitles to: ${vtt}\n${wav}\nSDD_VIDEO_PATH:v.mp4\n`;
  expect(ytdlp.parseResult(stdout, "", 0).artifacts).toEqual([wav, video, vtt]);
});

test("a labeled video whose resolved file is missing is dropped, not fatal (audio still done)", () => {
  const dir = freshDir();
  const wav = join(dir, "v.wav");
  writeFileSync(wav, "RIFF"); // no video file written into dir
  const result = ytdlp.parseResult(`${wav}\nSDD_VIDEO_PATH:ghost.mp4\n`, "", 0);
  expect(result.status).toBe("done");
  expect(result.artifacts).toEqual([wav]); // silent-success guard stays keyed on the audio file only
});

test("the LAST labeled video line wins when several appear", () => {
  const dir = freshDir();
  const wav = join(dir, "v.wav");
  const real = join(dir, "real.mp4");
  writeFileSync(wav, "RIFF");
  writeFileSync(real, "\x00");
  // basenames; stale.mp4 was never written to dir, real.mp4 was
  const stdout = `${wav}\nSDD_VIDEO_PATH:stale.mp4\nSDD_VIDEO_PATH:real.mp4\n`;
  expect(ytdlp.parseResult(stdout, "", 0).artifacts).toEqual([wav, real]);
});

// ── DW-4.2: exit 0 but expected audio file absent → failed ─────────────────

test("test_DW_4_2_exit_0_with_absent_audio_file_is_failed", () => {
  const ghost = join(freshDir(), "never-written.wav"); // synthetic path driving the existence check
  const result = ytdlp.parseResult(`[ExtractAudio] Destination: ${ghost}\n${ghost}\n`, "", 0);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain(ghost);
  expect(result.summary).toContain("does not exist");
});

test("missing audio-path line entirely on exit 0 is failed (silent-misparse backstop)", () => {
  const result = ytdlp.parseResult("[youtube] dQw4w9WgXcQ: Downloading webpage\nDone.\n", "", 0);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("no output audio path");
});

// ── DW-4.3: exit 0 + file present → done with the audio path in artifacts ──

test("test_DW_4_3_exit_0_and_existing_wav_is_done_with_artifact", () => {
  const dir = freshDir();
  const wav = join(dir, "dQw4w9WgXcQ.wav");
  writeFileSync(wav, "RIFF"); // contents irrelevant to the adapter
  const result = ytdlp.parseResult(`[download] 100%\n[ExtractAudio] Destination: ${wav}\n${wav}\n`, "", 0);
  expect(result.status).toBe("done");
  expect(result.artifacts).toEqual([wav]);
  expect(isAbsolute(result.artifacts[0]!)).toBe(true);
});

test("test_DW_4_3_existing_subtitles_are_appended_to_artifacts", () => {
  const dir = freshDir();
  const wav = join(dir, "vid.wav");
  const vtt = join(dir, "vid.en.vtt");
  writeFileSync(wav, "RIFF");
  writeFileSync(vtt, "WEBVTT");
  const stdout =
    `[info] Writing video subtitles to: ${vtt}\n` +
    `[info] Writing video automatic subtitles to: ${join(dir, "ghost.ja.vtt")}\n` + // never written → excluded
    `${wav}\n`;
  const result = ytdlp.parseResult(stdout, "", 0);
  expect(result.status).toBe("done");
  expect(result.artifacts).toEqual([wav, vtt]); // audio first, existing subs appended, ghost filtered
});

test("subtitle collection dedupes a twice-reported path", () => {
  const dir = freshDir();
  const wav = join(dir, "vid.wav");
  const vtt = join(dir, "vid.en.vtt");
  writeFileSync(wav, "RIFF");
  writeFileSync(vtt, "WEBVTT");
  const stdout = `[info] Writing video subtitles to: ${vtt}\n[info] Writing video subtitles to: ${vtt}\n${wav}\n`;
  expect(ytdlp.parseResult(stdout, "", 0).artifacts).toEqual([wav, vtt]);
});

test("last audio-path line wins when several appear (last-occurrence invariant)", () => {
  const dir = freshDir();
  const real = join(dir, "real.wav");
  writeFileSync(real, "RIFF");
  const stdout = `/somewhere/stale-echo.wav\n${real}\n`;
  const result = ytdlp.parseResult(stdout, "", 0);
  expect(result.status).toBe("done");
  expect(result.artifacts).toEqual([real]);
});

// ── exit ≠ 0 → failed with a stderr tail in the summary ────────────────────

test("non-zero exit is failed and carries the stderr tail", () => {
  const stderr = "WARNING: something\nERROR: [instagram] login required, use --cookies";
  const result = ytdlp.parseResult("", stderr, 1);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("exited with code 1");
  expect(result.summary).toContain("login required");
});

test("a present audio-path line cannot rescue a non-zero exit", () => {
  const dir = freshDir();
  const wav = join(dir, "vid.wav");
  writeFileSync(wav, "RIFF");
  const result = ytdlp.parseResult(`${wav}\n`, "boom", 2);
  expect(result.status).toBe("failed");
});

test("a very long stderr is truncated to a tail, not dumped whole", () => {
  const stderr = `${"x".repeat(5000)}ERROR: rate limited`;
  const result = ytdlp.parseResult("", stderr, 1);
  expect(result.summary).toContain("rate limited");
  expect(result.summary.length).toBeLessThan(600);
});

// ── DW-4.4: `../`-escaping outputDir (and cookies) → TypeError before spawn ─

test("test_DW_4_4_dotdot_escaping_outputDir_throws_TypeError", () => {
  const dir = freshDir();
  expect(() => ytdlp.buildArgs(URL, { cwd: dir, outputDir: "../../etc" })).toThrow(TypeError);
});

test("test_DW_4_4_deep_dotdot_escape_throws_TypeError", () => {
  const dir = freshDir();
  expect(() => ytdlp.buildArgs(URL, { cwd: dir, outputDir: "../../../../../../root" })).toThrow(TypeError);
});

test("a dotdot-escaping cookies path throws a TypeError too (same barricade)", () => {
  const dir = freshDir();
  expect(() => ytdlp.buildArgs(URL, { cwd: dir, outputDir: dir, cookies: "../../.netrc" })).toThrow(TypeError);
});

test("a relative outputDir that stays inside the cwd is resolved absolute, not rejected", () => {
  const dir = freshDir();
  const argv = ytdlp.buildArgs(URL, { cwd: dir, outputDir: "media/../audio" });
  const template = argv[argv.indexOf("-o") + 1]!;
  expect(template).toContain(join(dir, "audio"));
  expect(isAbsolute(template)).toBe(true);
});

test("an absolute outputDir is an explicit caller target and passes through", () => {
  const dir = freshDir();
  const argv = ytdlp.buildArgs(URL, { outputDir: dir });
  expect(argv[argv.indexOf("-o") + 1]).toBe(join(dir, "%(id)s.%(ext)s"));
});

test("a missing outputDir throws a TypeError (required opt)", () => {
  expect(() => ytdlp.buildArgs(URL, {})).toThrow(TypeError);
});

test("a literal % in outputDir is escaped in the -o template", () => {
  const dir = join(freshDir(), "100% legit");
  const argv = ytdlp.buildArgs(URL, { outputDir: dir });
  expect(argv[argv.indexOf("-o") + 1]).toContain("100%% legit");
});

// ── DW-4.5: identity injectContract ─────────────────────────────────────────

test("test_DW_4_5_injectContract_is_identity", () => {
  expect(ytdlp.injectContract(URL)).toBe(URL);
  const hostile = "https://x.com/i/status/1?q=$(rm -rf /);`evil`&&|<>";
  expect(ytdlp.injectContract(hostile)).toBe(hostile);
});

// ── URL barricade: shell metacharacters inert, option injection rejected ───

test("a URL with shell metacharacters is one literal argv element, never split or quoted", () => {
  const url = "https://www.youtube.com/watch?v=abc&list=$(whoami);x|y";
  const argv = ytdlp.buildArgs(url, { outputDir: freshDir() });
  expect(argv[argv.length - 1]).toBe(url); // exactly the URL, verbatim, as ONE element
  expect(argv.filter((a) => a.includes("whoami"))).toEqual([url]);
});

test("an option-injection 'URL' like --exec=... is rejected with a TypeError", () => {
  expect(() => ytdlp.buildArgs("--exec=touch /tmp/pwned", { outputDir: freshDir() })).toThrow(TypeError);
});

test("non-http(s) and whitespace-bearing 'URLs' are rejected with a TypeError", () => {
  const dir = freshDir();
  expect(() => ytdlp.buildArgs("file:///etc/passwd", { outputDir: dir })).toThrow(TypeError);
  expect(() => ytdlp.buildArgs("https://a.com/x --exec=evil", { outputDir: dir })).toThrow(TypeError);
  expect(() => ytdlp.buildArgs("", { outputDir: dir })).toThrow(TypeError);
});

// ── malformed opts throw, never silently coerce ─────────────────────────────

test("malformed optional opts throw TypeErrors instead of being dropped", () => {
  const dir = freshDir();
  expect(() => ytdlp.buildArgs(URL, { outputDir: dir, cookies: "" })).toThrow(TypeError);
  expect(() => ytdlp.buildArgs(URL, { outputDir: dir, subLangs: "--exec=evil" })).toThrow(TypeError);
  expect(() => ytdlp.buildArgs(URL, { outputDir: dir, subLangs: "en, ja" })).toThrow(TypeError);
  expect(() => ytdlp.buildArgs(URL, { outputDir: dir, sleepRequests: -1 })).toThrow(TypeError);
  expect(() => ytdlp.buildArgs(URL, { outputDir: dir, sleepRequests: "2" })).toThrow(TypeError);
  expect(() => ytdlp.buildArgs(URL, { outputDir: 42 })).toThrow(TypeError);
});

// ── adapter surface + discovery ─────────────────────────────────────────────

test("mode is read and the adapter opts out of live probing", () => {
  expect(ytdlp.mode).toBe("read");
  expect(ytdlp.probeable).toBe(false);
});

test("yt-dlp is discovered via directory scan, no registry edit", () => {
  const adapters = discoverAdapters(join(import.meta.dir, "..", "src", "adapters"));
  const found = adapters.find((a) => a.name === "yt-dlp");
  expect(found).toBeDefined();
  expect(found!.mode).toBe("read");
  expect(typeof found!.buildArgs).toBe("function");
  expect(typeof found!.injectContract).toBe("function");
  expect(typeof found!.parseResult).toBe("function");
});
