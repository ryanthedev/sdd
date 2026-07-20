<!-- base-commit: 03f2b7b09ebc4b9fb1158a46409c955fa02c5049 -->
<!-- generated: 2026-07-08 -->

# sdd Code Standards

Conventions extracted from the actual codebase, for an LLM implementer adding adapters or tools. Not general TypeScript advice — see `CLAUDE.md` for architecture/invariants; this file is patterns-with-code.

## 1. Forbidden Patterns

**Never spawn with a shell string or `shell: true`.** The whole security model rests on argv arrays.
```typescript
// BAD — a shell string lets prompt text be interpreted as shell metacharacters
spawn(`agy --print "${prompt}"`, { shell: true });

// GOOD — src/lib/jobs.ts:282-288 — argv array, shell:false, explicit cwd
const child = spawn(argv[0]!, argv.slice(1), { cwd, shell: false, ... });
```

**Never `console.log` anywhere in `src/`.** stdout is the JSON-RPC transport for this stdio MCP server; any stray stdout write corrupts the protocol stream.
```typescript
// BAD — corrupts the MCP stdio channel
console.log("adapter loaded:", name);

// GOOD — src/lib/log.ts — stderr only
import { log } from "../lib/log.ts";
log("adapter loaded:", name);
```

**Never let a caller's opts reach codex's `-c` config passthrough.** An open `key=value` passthrough would let a caller emit `sandbox_mode=danger-full-access` and defeat the `--sandbox` barricade.
```typescript
// BAD — arbitrary caller-controlled config keys
if (opts.configOverrides) cfg.configOverrides = opts.configOverrides as Record<string, string>;

// GOOD — src/adapters/codex.ts:77-82 — one hardcoded key, allowlisted value
if (effort !== undefined) {
  if (typeof effort !== "string" || !EFFORT_LEVELS.has(effort)) {
    throw new TypeError('codex: opts.effort must be "low" | "medium" | "high" if provided');
  }
  cfg.configOverrides = { model_reasoning_effort: effort };
}
```

**Never silently drop malformed `opts` — throw.** Untrusted MCP-client input is validated at the boundary; a wrong type is a bug worth surfacing, not coercing.
```typescript
// BAD — silently ignores a bad value, runs with defaults instead
if (typeof opts.model === "string") flags.push("--model", opts.model);

// GOOD — src/adapters/agy.ts:122-129 — throws TypeError, dispatch surfaces it as a clean MCP error
function pushOptionalStringFlag(flags: string[], opts: DispatchOpts, key: string, flag: string): void {
  const value = opts[key];
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`agy: opts.${key} must be a non-empty string if provided, got: ${JSON.stringify(value)}`);
  }
  flags.push(flag, value);
}
```

## 2. Code Examples

### A minimal review adapter (`src/adapters/grok.ts`)
```typescript
// DO — pure data + pure functions, no spawning, `_check` proves port conformance at compile time
export const name = "grok";

export function buildArgs(prompt: string, _opts: DispatchOpts): string[] {
  return ["grok", "--always-approve", "-p", prompt]; // flags then prompt — prompt is always last
}
export const injectContract = injectReviewContract;      // shared helper, not reimplemented
export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}
const _check: Adapter = { name, buildArgs, injectContract, parseResult };
void _check;

// DON'T — no compile-time port check, opts read without validation, no contract marker
export function buildArgs(prompt, opts) {
  return ["grok", opts.flag, "-p", prompt]; // opts.flag could land AFTER the prompt-bearing flag
}
```

### Contract-marker parsing — LAST occurrence wins
```typescript
// DO — src/adapters/_agy-shared.ts — scans every match, keeps the LAST one
function lastMarkerMatch(re: RegExp, text: string): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(re)) last = m;
  return last;
}
// WHY: a harness may echo the injected instruction text (which contains the
// literal marker strings as examples) before printing its real, final verdict.
// Taking the FIRST match would classify the echo, not the outcome.

// DON'T
const match = RESULT_MARKER_RE.exec(stdout); // first match — vulnerable to echoed-instruction collision
```

## 3. Error Handling

Two layers, by trust boundary. **Adapters throw `TypeError`/`Error` on invalid opts** (caught by the tool handler and turned into a clean MCP error). **Tool handlers never throw to the transport** — they catch and return `err(...)`.

```typescript
// From src/adapters/codex.ts:71-76 — adapter layer: throw on invalid input
if (model !== undefined) {
  if (typeof model !== "string" || model.length === 0) {
    throw new TypeError(`codex: opts.model must be a non-empty string if provided, got ${typeof model}`);
  }
  cfg.model = model;
}

// From src/tools/dispatch.ts:135-139 — tool layer: catch and translate to a structured result
try {
  const jobId = rt.jobStore.dispatch(adapter, args.prompt, opts);
  return ok(`dispatched "${adapter.name}" as ${jobId}`, { jobId });
} catch (e) {
  return err(`dispatch failed: ${friendlyMessage(e)}`, { code: "dispatch_failed" });
}
```

`friendlyMessage` (src/tools/shared.ts:50-53) truncates to 2048 chars — never leak an unbounded stack/env dump to an MCP client. `JobStore.#classify` (src/lib/jobs.ts:342-367) is the third layer: a `parseResult` that *throws* is caught and turned into a `failed` job, never propagated.

## 4. Imports & Dependency Direction

All internal imports use explicit `.ts` extensions (Bun/ESM requirement, `allowImportingTsExtensions: true` in tsconfig.json):
```typescript
import type { AdapterResult, DispatchOpts } from "../types.ts";
import { buildCodexArgv, type CodexArgvConfig } from "./_codex-shared.ts";
```

Dependency direction (Clean Architecture, inward-pointing only):
- `src/types.ts` — imports nothing from this project (the innermost layer).
- `src/adapters/types.ts` (the port) — imports only `../types.ts`.
- `src/adapters/*.ts` (concrete adapters) — import the port + `../types.ts` + `../lib/*.ts` helpers. Never import from `src/tools/`.
- `src/lib/jobs.ts` — imports `../adapters/types.ts` (the port) and `../types.ts`. Never imports a concrete adapter.
- `src/tools/*.ts` — import `src/lib/jobs.ts`, `src/adapters/discover.ts`, `src/adapters/types.ts`. This is the only layer allowed to know about MCP shapes.

No barrel files. Every import names the specific module.

## 5. Testing Patterns

Framework: `bun test` (never Jest/Vitest — see Technology Decisions).

Adapter tests drive `parseResult`/`buildArgs` directly with **stdout/stderr/exitCode triples** — no real binary is spawned:
```typescript
// From test/adapter-agy.test.ts:62-66
test("test_DW_4_2_missing_marker_on_exit_0_is_failed_misparse_backstop", () => {
  const result = agy.parseResult("some unrelated output with no marker at all", "", 0);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("missing AGY_RESULT marker");
});
```

Discovery is tested against the REAL `src/adapters` directory, not a fixture, to catch drift:
```typescript
// From test/adapter-agy.test.ts:138-146
test("test_DW_4_4_agy_discovered_via_directory_scan", () => {
  const adapters = discoverAdapters(join(import.meta.dir, "..", "src", "adapters"));
  const found = adapters.find((a) => a.name === "agy");
  expect(found).toBeDefined();
  expect(typeof found!.buildArgs).toBe("function");
});
```

Every new adapter gets a `test/adapter-<name>.test.ts` covering: argv shape/flag-order, missing-marker → failed, marker + non-zero exit → failed, and a real discovery lookup. One test file per source file (`test/jobs.test.ts` ↔ `src/lib/jobs.ts`, `test/tools-check.test.ts` ↔ `src/tools/check.ts`).

## 6. Naming Conventions

- Adapter module exports: `name`, `buildArgs`, `injectContract`, `parseResult` — always these exact identifiers as plain top-level `export`s (duck-typed by `discover.ts`, not a class).
- Tool factories: `createXTool(rt: Runtime)`, e.g. `createDispatchTool` (src/tools/dispatch.ts:54). One per file, named to match the file (`dispatch.ts` → `createDispatchTool`).
- Files that are helpers, not adapters: leading underscore — `_codex-shared.ts`, `_codex-factory.ts`. `discover.ts`'s `isCandidate` skips any `_`-prefixed or `.`-prefixed file, so this is how you keep a shared helper out of the adapter registry without an allowlist edit.
- Contract markers are `SCREAMING_SNAKE:` line prefixes unique per adapter — `AGY_RESULT:`, `AGY_IMAGE_SAVED:`, `AGY_VISION_SAVED:`, `SDD_VIDEO_PATH:` (yt-dlp), `VERDICT:`/`## Findings` (the review roster, shared via `src/lib/review-contract.ts`). Never reuse another adapter's marker name.
- Private class fields use `#` (ECMAScript private, not `_`-prefix convention) — see every method on `JobStore` in src/lib/jobs.ts (`#jobs`, `#assertValidAdapter`, ...).
- Domain term "job", never "task" or "run" — matches `Job`, `JobStore`, `JobState`, `jobId` throughout.

## 7. File Organization

```
src/
├── types.ts              # Core domain types — the innermost layer, no outward imports
├── lib/                  # jobs.ts (the one spawn/lifecycle capability), log.ts, ids.ts,
│                         #   review-contract.ts, preflight.ts (video-pipeline CLI gate)
├── adapters/             # Fourteen adapters + infra
│   ├── types.ts           # The Adapter port (interface) — infra, skipped by discovery
│   ├── discover.ts        # Directory-scan registry — infra, skipped by discovery
│   ├── _codex-shared.ts   # Underscore = helper, not an adapter — skipped by discovery
│   ├── _codex-factory.ts  # Underscore = helper, not an adapter — skipped by discovery
│   ├── _agy-shared.ts     # Underscore = helper (buildAgyArgv, lastMarkerMatch) — skipped
│   ├── codex.ts            # Concrete adapter (per-call model/effort)
│   ├── codex-high.ts / codex-low.ts / codex-sol.ts   # Pinned variants, via _codex-factory.ts
│   ├── agy.ts / grok.ts / kimi.ts / mistral.ts / qwen.ts      # Agent harnesses
│   ├── agy-image.ts / agy-vision.ts                          # Artifact producers
│   ├── yt-dlp.ts / whisper.ts / ffmpeg-frames.ts             # Video pipeline (real CLIs, identity injectContract)
└── tools/
    ├── runtime.ts          # Shared Runtime (JobStore + adaptersDir), no methods
    ├── shared.ts           # ToolModule type, ok()/err()/friendlyMessage()
    └── dispatch.ts / status.ts / result.ts / wait.ts / cancel.ts / list-adapters.ts / check.ts
test/
├── adapter-<name>.test.ts   # One per adapter, stdout/stderr/exitCode triples into parseResult
│                            #   (the four review CLIs share adapters-review.test.ts)
├── adapters-discover.test.ts / adapters-review.test.ts / adapter-agy-shared.test.ts
├── jobs.test.ts / tools.test.ts / tools-check.test.ts / preflight.test.ts
├── server-boot.test.ts / types.test.ts
```

New adapter → `src/adapters/<name>.ts` + `test/adapter-<name>.test.ts`. New tool → `src/tools/<name>.ts` + a `createXTool(rt)` factory, registered in `src/register.ts`. Never put an adapter file directly under `src/tools/` or vice versa.

## 8. Technology Decisions

- **Bun runtime, `bun test` only** — no Jest/Vitest/ts-node. `.ts` files run directly, no build step.
- **Adapter discovery is a directory scan (`readdirSync` + synchronous `createRequire`), not a hand-maintained registry.** Adding an adapter is dropping a file, never editing a list. `discover.ts` never throws — a malformed adapter file is a stderr warning and a skip, because a bad third-party-ish adapter file must never crash the MCP server.
- **The JobStore imposes no concurrency policy — every dispatch runs immediately, in parallel.** No job is refused because another is already running in the same `cwd`; the server does not model which jobs read and which write. Agent harnesses are unconditionally permissive (codex `--sandbox workspace-write`, agy `--dangerously-skip-permissions`, grok `--always-approve`, kimi/qwen `--yolo`, mistral `--auto-approve`), so any dispatched harness may edit the tree it is handed. Serializing jobs that would collide on one tree — or handing them separate `cwd`s — is the caller's decision. See `src/lib/jobs.ts:15`.
- **Pinned codex variants ignore `opts` on `buildArgs` entirely** (`_codex-factory.ts:58`) — the pin is a security/determinism feature, not a default that can be overridden by a caller passing `model`/`effort`.
- **External artifact paths (e.g. agy-image PNG output) land outside the source tree**, at an absolute path the caller names — `buildArgs` resolves it to an absolute path itself rather than delegating that resolution to the harness. See `src/adapters/agy-image.ts`.
- Zod for MCP tool input validation (`src/tools/dispatch.ts` `inputShape`) — this is the schema boundary a raw MCP client actually hits; TypeScript types alone don't validate JSON-RPC payloads at runtime.

## 9. Exemplar Files

**`src/adapters/agy.ts`** — demonstrates:
- Structural (not conventional) enforcement of flag-order via `buildArgs` always pushing `--print` then the prompt last
- LAST-occurrence-wins contract marker parsing (`lastMarkerMatch`)
- Untrusted-opts validation that throws instead of silently coercing
- The `_check: Adapter = {...}` compile-time port-conformance proof pattern

**`src/adapters/_codex-factory.ts` + `src/adapters/codex-high.ts`** — demonstrates:
- The shared-extraction pattern: a factory (`makeCodexVariant`) owns argv assembly once; a variant file is a ~15-line config-only call
- `injectContract`/`parseResult` reused by identity, never re-implemented per variant
- `_`-prefix convention keeping a helper out of adapter discovery

**`src/lib/jobs.ts`** — demonstrates:
- The barricade pattern: all untrusted input (`prompt`, `opts`) validated before any side effect
- argv-array + `shell:false` spawn, contract-marker + exit-code dual classification (`#classify`)
- Private (`#`) method naming for internal-only operations
