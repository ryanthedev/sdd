/**
 * Shared codex argv assembly — the single place that owns codex flag spelling,
 * flag ordering, the sandbox mapping, and the prompt-last invariant. The base
 * `codex` adapter delegates here for its per-call model/effort path, and the
 * variant factory (Phase 2) delegates here for pinned rosters — so the
 * flag-ordering and sandbox-safety logic exists exactly once.
 *
 * Leading `_` in the filename: adapter discovery (discover.ts `isCandidate`)
 * skips underscore-prefixed files, so this helper is never loaded as an
 * adapter.
 *
 * SECURITY (barricade — see src/lib/jobs.ts header):
 *   - The returned argv is a plain `string[]` spawned with `shell:false`;
 *     every cfg value lands as ONE literal argv element and can never be
 *     shell-evaluated or split.
 *   - `cfg` is TRUSTED input by contract: callers validate/allowlist any
 *     untrusted data BEFORE constructing it (codex.ts allowlists per-call
 *     `model`/`effort`; the factory's cfg is author-written code). This
 *     function must never read DispatchOpts directly — the trust decision
 *     belongs to the caller that owns the boundary.
 *   - Caller-influenced flags are emitted BEFORE `--sandbox`. If codex's
 *     flag parsing is later-wins, the trusted sandbox flag therefore prevails
 *     — defense-in-depth on top of the caller-side allowlist.
 *   - The sandbox mapping only knows `read-only`/`workspace-write`;
 *     `danger-full-access` is structurally unreachable.
 *
 * Flag names verified against `codex exec --help`:
 *   `-m, --model <MODEL>`, `-p, --profile <CONFIG_PROFILE_V2>`,
 *   `-c, --config <key=value>`.
 */
import type { AdapterMode } from "../types.ts";

/** Trusted, pre-validated codex flag configuration (see header). */
export interface CodexArgvConfig {
  /** Model to run (`-m <model>`), e.g. "o3". Empty string = omit the flag. */
  model?: string;
  /** Config profile (`-p <profile>`). Empty string = omit the flag. */
  profile?: string;
  /** Raw `-c key=value` overrides, emitted in insertion order. */
  configOverrides?: Record<string, string>;
}

const SANDBOX_BY_MODE: Record<AdapterMode, "read-only" | "workspace-write"> = {
  read: "read-only",
  write: "workspace-write",
};

/**
 * Assemble `codex exec` argv: `["codex","exec", ...flags, "--sandbox",
 * <sandbox>, prompt]`. Flag order is fixed (`-m`, `-p`, `-c`...) and the
 * prompt is always the LAST element — a flag placed after the prompt would be
 * silently absorbed as prompt text (codex still exits 0), so the ordering is
 * encoded structurally here rather than left to callers.
 */
export function buildCodexArgv(prompt: string, mode: AdapterMode, cfg: CodexArgvConfig = {}): string[] {
  const flags: string[] = [];
  if (cfg.model) flags.push("-m", cfg.model);
  if (cfg.profile) flags.push("-p", cfg.profile);
  for (const [key, value] of Object.entries(cfg.configOverrides ?? {})) flags.push("-c", `${key}=${value}`);
  return ["codex", "exec", ...flags, "--sandbox", SANDBOX_BY_MODE[mode], prompt];
}
