# Review: Phase 5 - whisper + ffmpeg-frames adapters

## Executed Results (Step 0)
- Focused suite: `bun test test/adapter-whisper.test.ts test/adapter-ffmpeg-frames.test.ts` → **47 pass, 0 fail, 111 expect() calls**
- Full suite: `bun test` → **250 pass, 0 fail, 704 expect() calls** across 17 files
- Typecheck: `bunx tsc --noEmit` → clean, no output, exit 0
- Lint: no separate lint command configured in this repo; `bunx tsc --noEmit` (strict + `noUncheckedIndexedAccess` + `noFallthroughCasesInSwitch`) is the enforced static gate and passed
- Coverage (focused): `bun test ... --coverage` → `src/adapters/whisper.ts` **100% funcs / 100% lines**; `src/adapters/ffmpeg-frames.ts` **95% funcs / 89.2% lines** (uncovered: readdirSync-throws catch, files.length>selectedCount invariant branch, writeFileSync-throws catch — all defensive I/O-failure paths, not DW items)

## Requirement Fulfillment

### DW-5.1
PREMISE:  `whisper.buildArgs` pins the large-v3-turbo model and outputs SRT to `opts.outputDir`.
EVIDENCE: src/adapters/whisper.ts:91 (`MODEL = "mlx-community/whisper-large-v3-turbo"`), :103-123 (`buildArgs`), :111 (`--model` uses `MODEL`), :114-115 (`--output-dir` uses `outDir` = `resolveOutputDir(opts)`), :112-113 (`--output-format all` — includes srt)
TRACE:    `buildArgs(AUDIO, {outputDir: dir})` → `MODEL` inserted after `--model`; `resolveOutputDir(opts)` returns `dir` inserted after `--output-dir` → argv = `["mlx_whisper", AUDIO, "--model", "mlx-community/whisper-large-v3-turbo", "--output-format", "all", "--output-dir", dir, ...]` → asserted by test/adapter-whisper.test.ts:48-56 (`test_DW_5_1_pins_model_and_output_dir`) and :58-65 (`test_DW_5_1_output_format_all_includes_srt`), both ran and passed in Step 0.
VERDICT:  PASS

### DW-5.2
PREMISE:  `whisper.parseResult` → `failed` on exit 0 with no transcript file (dirty).
EVIDENCE: src/adapters/whisper.ts:152-162 (missing-file check via `existsSync`)
TRACE:    `parseResult(argsLine(dir), "", 0)` with an empty `dir` (no transcript files) → `outDir` extracted from `Args:` marker → `missing = [srtPath, txtPath].filter(!existsSync)` = both → `status: "failed"`, summary lists both missing paths → matches test/adapter-whisper.test.ts:74-80 (`test_DW_5_2_exit_0_missing_transcript_files_is_failed`), ran and passed.
VERDICT:  PASS

### DW-5.3
PREMISE:  `ffmpeg-frames.buildArgs` injects `sceneThreshold` (default 0.35) and caps at `frameCount` (default 150).
EVIDENCE: src/adapters/ffmpeg-frames.ts:113-114 (`DEFAULT_FRAME_COUNT = 150`, `DEFAULT_SCENE_THRESHOLD = 0.35`), :133-134 (opts fall back to defaults), :142 (`buildFilterExpr(sceneThreshold)` into `-vf`), :147-148 (`-frames:v`, `String(frameCount)`)
TRACE:    `buildArgs(VIDEO, {outputDir: dir})` (no overrides) → `sceneThreshold = 0.35`, `frameCount = 150` → `-vf` contains `gt(scene\,0.35)`, `-frames:v` = `"150"`; with `{sceneThreshold: 0.6, frameCount: 20}` → `-vf` contains `gt(scene\,0.6)`, `-frames:v` = `"20"` → matches test/adapter-ffmpeg-frames.test.ts:57-63 and :65-71, both ran and passed.
VERDICT:  PASS

### DW-5.4
PREMISE:  frames manifest `frames[]` maps every emitted frame to a timestamp and sets `dropped` when the cap fires (dirty: over-cap input).
EVIDENCE: src/adapters/ffmpeg-frames.ts:219 (`frames = files.map((f,i) => ({file, tSeconds: ptsTimes[i]!}))`), :220 (`dropped = selectedCount > files.length ? selectedCount - files.length : undefined`), :222-235 (manifest built and written)
TRACE (dirty): stderr simulates 5 `pts_time:` lines (`selectedCount=5`) but only 2 frame files exist on disk (simulating the `-frames:v` cap firing) → `files.length=2` → `dropped = 5-2 = 3`; `frames` = the 2 kept files zipped 1:1 with the first 2 (earliest) pts entries (`tSeconds` 0 and 1.5, not the last 2) → `manifest.dropped === 3`, `manifest.frames.length === 2` → matches test/adapter-ffmpeg-frames.test.ts:106-124 (`test_DW_5_4_dropped_set_when_cap_fires_dirty`), ran and passed. Clean case (no cap fired) at :89-104 confirms `dropped` is `undefined` and every frame maps 1:1 to its timestamp.
VERDICT:  PASS

### DW-5.5
PREMISE:  0-scene-cut input falls back to periodic frames (never empty).
EVIDENCE: src/adapters/ffmpeg-frames.ts:118 (`FALLBACK_PERIOD_FRAMES = 150`), :251-253 (`buildFilterExpr` → `select='gt(scene\,TH)+not(mod(n\,150))'`), :201-208 (zero-files → `failed`, never a fabricated `done`)
TRACE:    `not(mod(n,150))` is true whenever `n` is a multiple of 150, which always includes `n=0` — so at least the first frame reaching `select` is always chosen regardless of real scene-cut activity. Simulated stderr with a single `pts_time:` line (the n=0 fallback, as on a static clip with zero real cuts) → `files.length=1` → `status: "done"`, `frames.length===1`, `dropped===undefined` → matches test/adapter-ffmpeg-frames.test.ts:144-154 (`test_DW_5_5_zero_scene_cut_single_fallback_frame_still_done`) and the structural check at :135-142, both ran and passed. The negative case (truly zero frame files with exit 0) correctly returns `failed`, never a fabricated non-empty success (test at :156-162, "never-empty guarantee violated, don't fake success").
VERDICT:  PASS

### DW-5.6
PREMISE:  a `../`-escaping `outputDir` throws a `TypeError` before spawn (both adapters).
EVIDENCE: src/adapters/whisper.ts:224-235 (`resolveContained`); src/adapters/ffmpeg-frames.ts:331-342 (`resolveContained`, identical semantics)
TRACE:    `buildArgs(AUDIO/VIDEO, {cwd: dir, outputDir: "../../etc"})` → `resolveContained` computes `resolved = resolve(dir, "../../etc")`, `rel = relative(dir, resolved)` → `rel` starts with `..` → throws `TypeError` synchronously inside `buildArgs`, before any argv is returned or a child process spawned (both `buildArgs` functions are pure, no I/O). Confirmed by test/adapter-whisper.test.ts:134-137 and test/adapter-ffmpeg-frames.test.ts:182-185, both ran and passed. A deeper `../../../../../../root` escape and a benign `media/../audio`-style non-escaping relative path are both correctly discriminated (tests at whisper:139-150, ffmpeg-frames:187-198).
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
- [x] All 6 DW items have corresponding automated tests referencing DW-IDs (`test_DW_5_1_...` through `test_DW_5_6_...`), all ran in Step 0 and passed.
- [x] Test coverage matches the stated level for DW-item purposes (every DW item has a real automated test, not observed-behavior fallback).
- Note: `--coverage` shows `ffmpeg-frames.ts` at 89.2% line coverage (readdirSync-throws catch, the `files.length > selectedCount` internal-invariant branch, and writeFileSync-throws catch are unexercised). None of these are DW items or listed edge cases — see Notes.

## Dead Code
- `src/adapters/ffmpeg-frames.ts:101` imports `existsSync` from `node:fs` but never calls it anywhere in the file (grep confirms the only occurrence is the import line itself). Unused import — non-blocking (not unreachable code after an early return), listed under Notes.
- No unreachable code after early returns, no commented-out blocks, no debug statements found in either adapter file.

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Both adapters are pure functions (`buildArgs`/`injectContract`/`parseResult`) with no shared mutable module state and only synchronous fs calls (`existsSync`, `readdirSync`, `writeFileSync`) inside a single call — no interleaving surface. |
| Error Handling | PASS | ffmpeg-frames.ts:184-193 and :226-234 wrap `readdirSync`/`writeFileSync` in try/catch, each returning a `failed` result with the error message (traced: a throwing `readdirSync(outDir)` on a nonexistent dir → caught → `status:"failed"`, never propagates). whisper.ts uses only `existsSync`, which does not throw on a missing path, so no unhandled-throw path exists there. |
| Resources | PASS | Only synchronous, auto-closing fs calls; no handles, sockets, or timers held across calls. |
| Boundaries | PASS | `ptsTimes[i]!` at ffmpeg-frames.ts:219 is a non-null assertion under `noUncheckedIndexedAccess`, but it is provably safe: the guard at :210-217 rejects any case where `files.length > selectedCount` before reaching :219, so for every `i < files.length`, `i < ptsTimes.length` always holds. `sceneThreshold`/`frameCount` numeric validation rejects `NaN`/`Infinity` (`Number.isFinite`) and non-integers, traced and tested at ffmpeg-frames.test.ts:236-251. |
| Security | PASS | Traversal barricade demonstrated (DW-5.6); positional/flag-value path args rejected when leading `-` or control chars (tested whisper.test.ts:172-184, ffmpeg-frames.test.ts:220-232); `frameCount`/`sceneThreshold` re-validated at the adapter boundary independent of any upstream zod schema (defense in depth, per the file's own header rationale). |

## Loaded-Skill Criteria

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| cc-defensive-programming | No executable code in assertions | N/A | Neither file uses language-level assertions (`assert`, `console.assert`); all validation is explicit `if (...) throw new TypeError(...)`, which is not compiled out in production. |
| cc-defensive-programming | No empty catch blocks | PASS | The only two catch blocks (ffmpeg-frames.ts:186-193, :226-234) each construct and return a `failed` `AdapterResult` carrying the error message — neither is empty or silently swallows. |
| cc-defensive-programming | External input validated at entry | PASS | `opts.outputDir` (both files, path-traversal + type checks), the audio/video path (leading-`-`, control-char, non-empty checks), and `opts.frameCount`/`opts.sceneThreshold` (type/range checks) are all validated at the top of `buildArgs` before any value reaches argv — traced and covered by tests for every rejection path (empty, whitespace, leading dash, control char, `NaN`, out-of-range, wrong type). |
| cc-defensive-programming | Assertions for bugs only (external input gets error handling, not assertions) | PASS | The one internal-invariant check (`files.length > selectedCount`, ffmpeg-frames.ts:210-217) — a should-never-happen condition given the module's own control flow — is handled as a graceful `failed` result rather than a disabled-in-production assertion, appropriate for a long-lived MCP server process where a thrown/uncaught assertion would be worse than a reported failure. |

## Notes (non-blocking)
- `src/adapters/ffmpeg-frames.ts:101` — unused `existsSync` import (dead code, minor).
- `ffmpeg-frames.ts` line coverage is 89.2%, not 100%: the `readdirSync` failure catch, the `files.length > selectedCount` invariant-violation branch, and the `writeFileSync` failure catch are not exercised by any test. All three are defensive I/O/invariant backstops, not DW items or listed edge cases, and were verified correct by trace rather than by execution — flagged for awareness, not blocking.
- Both `parseResult` functions derive `outputDir` from a single-quote-delimited regex over harness-generated text (`Args: {...}` for whisper, `Output #0 ... to '<path>'` for ffmpeg). If a legitimate `outputDir` itself contains a literal single-quote character (not rejected by the traversal barricade, which only checks `..`-escaping), the regex would truncate at the embedded quote and the adapter would report `failed` (transcript/frame files "missing" at the truncated path) rather than silently succeeding with the wrong path — i.e., it fails closed, not open. Not a listed edge case and not demonstrated to misparse into a false "done", so this is a Note, not a FAIL.

**Verdict: PASS**
