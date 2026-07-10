/**
 * `codex-high` — a codex variant pinned to `model_reasoning_effort=high` on
 * the default model, for when a task needs codex's deepest reasoning. Write
 * mode by default (inherits the factory default, so it can modify the repo;
 * write-mode jobs serialize per cwd), `binary:"codex"` (the real CLI probed by
 * `list_adapters`). Built by `makeCodexVariant` (see `_codex-factory.ts`) so
 * flag assembly and the output contract are reused, never re-implemented.
 *
 * Per-call `model`/`effort` on `opts` are ignored — the pin is the whole
 * point. Pass those to the base `codex` adapter instead.
 */
import { makeCodexVariant } from "./_codex-factory.ts";

const variant = makeCodexVariant({
  name: "codex-high",
  configOverrides: { model_reasoning_effort: "high" },
});

export const name = variant.name;
export const mode = variant.mode;
export const binary = variant.binary;
export const buildArgs = variant.buildArgs;
export const injectContract = variant.injectContract;
export const parseResult = variant.parseResult;
