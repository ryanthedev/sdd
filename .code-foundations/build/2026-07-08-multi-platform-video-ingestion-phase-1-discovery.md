# Discovery + Design: Phase 1 - Preflight + install docs

## Files Found
- `src/lib/preflight.ts` — does not exist yet (this phase creates it).
- `test/preflight.test.ts` — does not exist yet.
- `README.md` — exists, 78 lines, ends with a "## Development" section; no video-ingestion content yet.
- `src/tools/check.ts` — existing liveness/version-probe precedent (`Bun.which` for PATH presence, then a live spawn to verify usability). Confirms the house pattern: presence check and usability check are two separate steps, both reported even when one fails.
- `src/lib/log.ts` — the only stderr output channel; not used here since the library path must have zero output and the CLI path prints structured JSON directly (not via `log()`, which prefixes `[sdd]` and is meant for human banners, not machine-parsed JSON).
- `docs/code-standards.md` — read in full; applies (see below).

## Current State
No preflight/tooling code exists anywhere in the repo. `check_adapter` (`src/tools/check.ts`) is the closest analog — it separates `Bun.which` presence from a live usability probe — but it's MCP-tool-shaped (takes a `Runtime`, returns `ToolResult`) and probes *agent CLIs* via the JobStore/dispatch path. This phase's `preflight()` is a plain library function with no MCP/Runtime/JobStore dependency, probing three external CLIs (`yt-dlp`, `mlx-whisper` via `mlx_whisper`, `ffmpeg`) directly via `Bun.which` + `Bun.spawn`.

Verified on this machine: `ffmpeg` is installed (`/opt/homebrew/bin/ffmpeg`, version 8.1.1); `yt-dlp` and `mlx_whisper` are **not** installed. This matters for DW-1.5's integration test — the real environment already exercises the "some tools missing → non-zero exit" path without needing a stubbed PATH.

Confirmed `Bun.which(binary, { PATH })` fully overrides PATH resolution (tested directly: a fixture binary on a custom `PATH` resolves; a real binary not on that custom `PATH` resolves to `null`). This is the exact "small seam a test can stub" the plan's design notes ask for — no need for a separate injectable resolver abstraction.

## Gaps
- Plan's `Produces` line fixes the call shape `preflight(tools?: string[]): Promise<PreflightResult>` but the design notes explicitly ask for an injectable seam for PATH resolution. Resolved by adding a second **optional** parameter (`options: PreflightOptions = {}`) carrying `{ PATH?, specs?, probeTimeoutMs? }` — every existing call site (bare `preflight()`, `preflight(["ffmpeg"])`) is untouched; only tests use the second parameter.
- Plan flags an open uncertainty: exact `mlx-whisper` CLI version-probe invocation. Resolved defensively: the version probe is fully fault-tolerant (try/catch + timeout) and a failed/unparseable version probe never flips `found` to `false` — `found` is decided solely by `Bun.which` resolution, independent of whether `--version` parses. This means the implementation is correct regardless of what `mlx_whisper --version` actually does (it isn't installed here to verify against).
- Plan's edge case "ffmpeg present but missing a needed encoder" — RESOLVED (post-review update). Initially deferred as unsourced, but the independent REVIEW sourced the concrete set the later phases rely on: keyframe image output (`mjpeg` OR `png`) and the whisper-ready PCM wav (`pcm_s16le`). Implemented a third per-tool probe (CAPABILITY) alongside PRESENCE and VERSION: the ffmpeg `ToolSpec` now carries `capabilityArgs: ["-hide_banner", "-encoders"]`, a `parseFfmpegEncoders` parser, and `requiredCapabilities: [["mjpeg","png"], "pcm_s16le"]` (an OR-group plus a required token). A missing encoder keeps `found:true` but sets a `hint` naming the missing encoder(s), which drives aggregate `ok:false` — without throwing or short-circuiting the other tools. The probe is injectable/mockable the same way as PATH/version: a fixture `ffmpeg` script advertises whatever encoder list a test wants, so "present + good version + encoder X missing" is driven deterministically with no crippled host ffmpeg. The capability probe shares the version probe's fault-tolerance: if the `-encoders` probe itself can't run, it reports no missing capabilities (can't-confirm, never a false negative).
- No `minVersion` thresholds are set on the three real tool specs (no sourced minimum for any of them). The `minVersion`/outdated-hint mechanism is implemented and unit-tested via a synthetic spec (satisfies T-1.3's intent: verify the "too old" flagging path works and doesn't crash) rather than asserting an invented real-world threshold.

## Code Standards
Key conventions applied from `docs/code-standards.md`:
- No `console.*` anywhere in `src/` — CLI branch uses `process.stdout.write` directly, not `console.log`.
- Explicit `.ts` extensions on internal imports (none needed here — no internal imports).
- Throw `TypeError` on malformed/unknown input rather than silently ignoring (unknown tool name in the `tools` filter).
- Argv-array + `shell:false`-equivalent spawning (`Bun.spawn` with an array, never a shell string) — same discipline as `JobStore`/adapters even though this module doesn't go through `JobStore`.
- One test file per source file: `test/preflight.test.ts` ↔ `src/lib/preflight.ts`.
- File organization: `src/lib/` is for library helpers (`jobs.ts`, `log.ts`, `ids.ts`) — `preflight.ts` fits there, not `src/adapters/` or `src/tools/` (it's not an `Adapter` and not an MCP tool per plan's scope OUT).

## Test Infrastructure
`bun test`, Bun's built-in test runner (never Jest/Vitest). Existing precedent for spawning real short-lived child processes as fixtures instead of mocking (`test/tools-check.test.ts` writes real adapter files that spawn real `bun -e ...` children). This phase follows the same "real thing, not a mock" philosophy: fixture tests write real tiny shell scripts to a temp dir and point `Bun.which` at that dir via the `PATH` option, then run the real `Bun.spawn` version-probe path against them — no mocking framework, no fake process objects.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-1.1 | `preflight()` returns `ok:false` with a per-tool `hint` when a binary is absent (test stubs PATH). | COVERED | `test_DW_1_1_reports_ok_false_with_hint_when_binary_absent` (PATH override to an empty temp dir) |
| DW-1.2 | `preflight()` returns `ok:true` with resolved versions when all three are present. | COVERED | `test_DW_1_2_reports_ok_true_with_versions_when_all_present` (PATH override to a fixture dir with 3 fake executables printing known version strings) |
| DW-1.3 | README documents install for all three + the Instagram cookies/nightly caveat. | COVERED | `test_DW_1_3_readme_documents_all_three_tools_and_instagram_caveat` (reads README.md, asserts on install commands + cookies/nightly keywords) |
| DW-1.4 | no `console.*` in the library code path (grep-clean; only the `import.meta.main` branch prints). | COVERED | `test_DW_1_4_no_console_usage_anywhere_in_preflight_source` (reads the source file text, asserts zero `console.` matches — whole file, since the CLI branch uses `process.stdout.write` too, satisfying the stricter reading) |
| DW-1.5 | `bun run src/lib/preflight.ts` prints valid JSON and exits non-zero when a tool is missing. | COVERED | `test_DW_1_5_cli_prints_valid_json_and_exits_nonzero_when_tool_missing` (spawns the real CLI as a child process with `PATH` stripped to an empty temp dir, so all three tools are deterministically absent regardless of host state; `JSON.parse`s stdout, asserts `ok:false` and non-zero exit code) |

**All items COVERED:** YES

## Design Decisions

**Interface:**
```ts
export interface PreflightToolResult { name: string; found: boolean; version?: string; hint?: string; }
export interface PreflightResult { ok: boolean; tools: PreflightToolResult[]; }

export interface ToolSpec {
  name: string;
  binary: string;
  versionArgs: string[];
  parseVersion: (stdout: string, stderr: string) => string | undefined;
  minVersion?: string;
  installHint: string;
  outdatedHint?: (found: string, min: string) => string;
}

export interface PreflightOptions { PATH?: string; specs?: ToolSpec[]; probeTimeoutMs?: number; }

export const DEFAULT_TOOL_SPECS: ToolSpec[]; // yt-dlp, mlx-whisper, ffmpeg

export async function preflight(tools?: string[], options?: PreflightOptions): Promise<PreflightResult>;
```

**Why an `options` seam instead of a bare resolver callback:** `Bun.which`'s native `{PATH}` override (verified working) is simpler than hand-rolling a resolver abstraction, matches the existing house pattern (`list-adapters.ts`/`check.ts` both call `Bun.which` directly), and keeps the public one-arg call shape (`preflight()`, `preflight(tools)`) exactly as specified in `Produces`. `specs` is exposed too, so the "too old" mechanism (T-1.3) can be tested end-to-end through the real `preflight()` function with a synthetic spec, rather than testing a private helper in isolation or inventing an unsourced real threshold.

**Why `found` is decided by `Bun.which` alone, never by the version probe succeeding:** the version probe (`Bun.spawn` + timeout) is best-effort and wrapped in try/catch — a binary that doesn't support `--version`, hangs, or prints unparseable output must never be misreported as "absent." This directly resolves the plan's `mlx-whisper` CLI-invocation uncertainty without needing the real binary to test against.

**Version-probe timeout:** default 3000ms via `setTimeout` raced against `proc.exited`, `proc.kill()` on timeout — a defensive-programming measure so a hung binary can't hang `preflight()` (probe must stay "fast," per the phase's constraints).

**CLI entry:** `import.meta.main` branch calls `preflight()` with no options (real environment), writes `JSON.stringify(result, null, 2)` via `process.stdout.write` (never `console.log`), and calls `process.exit(result.ok ? 0 : 1)`.

**Install hints (grounded, not invented thresholds — just the install commands themselves, which the plan explicitly asks for):**
- `yt-dlp`: `brew install yt-dlp` (or `pip install -U yt-dlp` / `uv tool install yt-dlp`)
- `ffmpeg`: `brew install ffmpeg`
- `mlx-whisper`: `pip install -U mlx-whisper` (or `uv tool install mlx-whisper`)

## Prerequisites
- [x] Required files exist (or will be created) — `src/lib/` directory already exists.
- [x] Dependencies available — no new dependencies; `Bun.which`/`Bun.spawn` are runtime built-ins.
- [x] No missing prerequisites — Phase 1 has no plan dependency (`Depends on: none`).

## Recommendation
BUILD. The plan's contract is fully implementable as specified; the one open uncertainty (mlx-whisper version-probe invocation) is resolved by a fault-tolerant design that doesn't depend on knowing the exact CLI behavior. No scope changes needed.
