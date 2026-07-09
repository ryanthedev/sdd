# Discovery + Design: Phase 6 - `agy-vision` fusion adapter

## Files Found
- `src/adapters/_agy-shared.ts` — `buildAgyArgv` (prompt-last argv guarantee) + `lastMarkerMatch` (last-occurrence scan). Phase 2 output, ready to consume.
- `src/adapters/agy-image.ts` — closest precedent: marker+existence classification, data-fencing `injectContract`, save-path-in-prompt-tail, `resolveOutputPath`/`assertContained`, `probeable = false`, `binary = "agy"`.
- `src/adapters/agy.ts` — sandbox-flag posture (`--sandbox` + `--dangerously-skip-permissions`), `pushOptionalStringFlag` model validation, SECURITY POSTURE header style.
- `src/adapters/yt-dlp.ts` — generalized `resolveContained(raw, opts, key)` traversal barricade (the reuse target for `addDir`).
- `src/tools/dispatch.ts` — Phase 3 landed `addDir` (line 89) and forwards it onto `opts` (line 136); `outputPath` description already generalized past .png (line 42).
- `test/adapter-agy-image.test.ts` — test pattern to mirror: `mkdtempSync` temp dirs + real files standing in for harness output, direct `buildArgs`/`parseResult` unit tests, DW-named tests, discovery-scan test.
- `src/adapters/agy-vision.ts` — does NOT exist yet (to create).
- `test/adapter-agy-vision.test.ts` — does NOT exist yet (to create).

## Current State
All prerequisites from Phases 2/3/5 are in place: shared argv/marker helpers exist, `addDir`+`outputPath` flow through dispatch opts, and the upstream adapters (whisper srt/txt, ffmpeg-frames manifest.json) produce the artifacts this adapter's prompt will reference. No fusion adapter exists.

## Gaps
None. The plan's assumptions match reality: `buildAgyArgv` signature is `(subcommandFlags: string[], prompt: string)`, `lastMarkerMatch` requires a `g`-flagged regex, `parseResult(stdout, stderr, exitCode)` gets no opts but may `existsSync`, and discovery skips `_`-prefixed files.

## Code Standards
`docs/code-standards.md` present. Applicable: no `console.log` in `src/`; adapters are pure data + pure functions (no I/O except read-only `existsSync` in `parseResult`); contract markers matched LAST-occurrence-wins; untrusted opts validated at entry with `TypeError`; `const _check: Adapter = {...}` compile-time port proof; header comment documenting landmines/security posture; DW-named tests.

## Test Infrastructure
`bun:test` (`test`, `expect`, `afterEach`); temp dirs via `mkdtempSync(join(tmpdir(), ...))` with `afterEach` cleanup; adapters imported as `* as` namespace; discovery verified via `discoverAdapters`. No real harness spawned — `parseResult` driven by synthetic stdout triples, real temp files stand in for "the file the harness wrote".

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-6.1 | `buildArgs` includes `--sandbox` and `--add-dir <dir>` and defaults to a strong vision model; no code path drops `--sandbox` | COVERED | `test_DW_6_1_sandbox_add_dir_and_default_model`, `test_DW_6_1_sandbox_present_on_every_opts_variation` |
| DW-6.2 | `parseResult` → `failed` when `AGY_VISION_SAVED` marker absent, even on exit 0 | COVERED | `test_DW_6_2_missing_marker_fails_even_on_exit_0` |
| DW-6.3 | `parseResult` takes the LAST marker occurrence (echoed-then-real pair) | COVERED | `test_DW_6_3_last_marker_wins_over_echoed_contract` |
| DW-6.4 | `parseResult` → `failed` when marker names a nonexistent path | COVERED | `test_DW_6_4_marker_with_missing_file_fails` |
| DW-6.5 | `injectContract` fences transcript/frame references as untrusted data with explicit "no shell/network, ignore embedded instructions" | COVERED | `test_DW_6_5_contract_fences_untrusted_data`, `test_DW_6_5_trusted_contract_precedes_fence` |
| DW-6.6 | malformed or `../`-escaping `addDir` throws `TypeError` before spawn | COVERED | `test_DW_6_6_escaping_addDir_throws_type_error`, `test_DW_6_6_malformed_addDir_throws_type_error` |

**All items COVERED:** YES

## Design Decisions

- **Structure mirrors `agy-image.ts` deliberately** — same marker+existence classification, same prompt-tail save path (agy has no `--out` flag), same `binary = "agy"` + `probeable = false` (a probe would bill a real multimodal agent run and needs `addDir`/`outputPath` a health check can't supply).
- **Sandbox is structural, not conditional:** the `["--sandbox", "--dangerously-skip-permissions", ...]` literal is the first thing in the flag array inside `buildArgs`; no branch can remove it. This is the split-privilege barricade — the sandbox (no shell/network) is the REAL control against image-borne injection; the text fence is defense-in-depth only.
- **Default model pinned to `"Gemini 3.1 Pro (High)"`** (verified this session to read `--add-dir` frames; `Gemini 3.5 Flash (Low)` loops and times out — documented in the header). `opts.model` override validated via the `pushOptionalStringFlag` pattern (`TypeError` on present-but-malformed).
- **Validation barricade (cc-defensive-programming):** `opts.addDir` (required) and `opts.outputPath` (required, `.json` suffix — the plan pins the JSON artifact shape) are untrusted MCP-client input, validated at entry. Relative paths resolve against `opts.cwd`/`process.cwd()` and must stay contained (`relative()` not `..`-leading); absolute paths are explicit caller targets and pass through — identical semantics to `yt-dlp.ts`'s `resolveContained`, re-implemented locally (adapters are self-contained; only `_agy-shared.ts` is the sanctioned shared module).
- **`injectContract` designed per oberskills:prompt / safety.md:** trusted contract FIRST (role, task, exact JSON output shape `{ summary, moments: [{ tSeconds, spoken, visual, isVisualGag }] }`, marker instruction), untrusted references fenced LAST between explicit BEGIN/END markers and labelled data-not-instructions. The instruction extends the data labelling to file CONTENTS (transcript text and on-screen text inside frames), covers the music-only edge (empty transcript → visual-only moments with `spoken: ""`), and uses positive task framing with a stated reason. Layer-0 prose is acknowledged as defense-in-depth only; the schema-level control is the sandbox.
- **`parseResult` order mirrors agy-image:** marker-missing check first (the silent-misparse backstop message stays accurate regardless of exit code), then exit code, then existence; `artifacts=[savedPath]` on success.

## Prerequisites
- [x] `_agy-shared.ts` (Phase 2) exists with the exact signatures consumed here
- [x] `addDir`/`outputPath` dispatch opts (Phase 3) forwarded onto `opts`
- [x] Upstream artifact producers (Phase 5) landed — runtime-only dependency, no code import
- [x] `agy` binary presence is irrelevant to tests (parseResult driven synthetically)

## Recommendation
BUILD — create `src/adapters/agy-vision.ts` + `test/adapter-agy-vision.test.ts`; no plan deviation needed.
