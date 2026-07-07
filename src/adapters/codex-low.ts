/**
 * `codex-low` — a codex variant pinned to `model_reasoning_effort=low` on
 * the default model, for cheap/fast codex work that doesn't need deep
 * reasoning. Read mode, `binary:"codex"` (the real CLI probed by
 * `list_adapters`). Built by `makeCodexVariant` (see `_codex-factory.ts`) so
 * flag assembly and the output contract are reused, never re-implemented.
 *
 * Per-call `model`/`effort` on `opts` are ignored — the pin is the whole
 * point. Pass those to the base `codex` adapter instead.
 */
import { makeCodexVariant } from "./_codex-factory.ts";

const variant = makeCodexVariant({
  name: "codex-low",
  configOverrides: { model_reasoning_effort: "low" },
});

export const name = variant.name;
export const mode = variant.mode;
export const binary = variant.binary;
export const buildArgs = variant.buildArgs;
export const injectContract = variant.injectContract;
export const parseResult = variant.parseResult;
