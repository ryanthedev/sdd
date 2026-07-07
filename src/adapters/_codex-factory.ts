/**
 * `makeCodexVariant` — the single place that assembles a complete, drop-in
 * codex Adapter module from a pinned `CodexArgvConfig`-shaped config. Used by
 * `codex-high.ts`/`codex-low.ts` (and any future `codex-<model>.ts`, see the
 * plan's Phase 3 doctrine note) so that shipping a new pinned variant is one
 * factory call plus a handful of re-export lines, never a hand-written
 * `Adapter` object literal.
 *
 * Leading `_` in the filename: adapter discovery (`discover.ts` `isCandidate`)
 * skips underscore-prefixed files, so this factory itself is never loaded as
 * an adapter — only the concrete variant files that call it are.
 *
 * SECURITY: this factory takes TRUSTED, author-written config (the same trust
 * boundary `_codex-shared.ts` documents for `buildCodexArgv`'s `cfg`
 * parameter) — it is never fed caller/opts data directly. The returned
 * `buildArgs` closure deliberately ignores its `opts` parameter: a pinned
 * variant's whole purpose is to NOT let a caller override the pinned
 * model/effort at dispatch time. `injectContract`/`parseResult` are reused by
 * IDENTITY from `codex.ts` (not re-implemented) so the output contract has a
 * single source of truth across the base adapter and every variant.
 */
import type { AdapterMode, AdapterResult, DispatchOpts } from "../types.ts";
import { buildCodexArgv, type CodexArgvConfig } from "./_codex-shared.ts";
import * as codex from "./codex.ts";

/** Config for one pinned codex variant. `name` is the only required field. */
export interface CodexVariantConfig extends CodexArgvConfig {
  /** Adapter name — the on-disk filename stem and the dispatch key. */
  name: string;
  /** Read/write mode for the write-write guard. Defaults to "read". */
  mode?: AdapterMode;
}

/** The shape discovery expects a variant module to export, as a plain object. */
export interface CodexVariant {
  name: string;
  mode: AdapterMode;
  binary: string;
  buildArgs(prompt: string, opts: DispatchOpts): string[];
  injectContract(prompt: string): string;
  parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult;
}

/**
 * Build a complete codex variant Adapter object. `buildArgs` pins the given
 * model/profile/configOverrides at construction time and ignores per-call
 * `opts` entirely — the pin IS the point (DW-2.5). `binary` is always
 * "codex" so `list_adapters` probes the real CLI, not the variant name.
 */
export function makeCodexVariant(cfg: CodexVariantConfig): CodexVariant {
  const { name, mode: variantMode, ...argvCfg } = cfg;
  const resolvedMode: AdapterMode = variantMode ?? "read";

  return {
    name,
    mode: resolvedMode,
    binary: "codex",
    buildArgs: (prompt: string, _opts: DispatchOpts): string[] => buildCodexArgv(prompt, resolvedMode, argvCfg),
    injectContract: codex.injectContract,
    parseResult: codex.parseResult,
  };
}
