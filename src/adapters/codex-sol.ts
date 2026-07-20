/**
 * `codex-sol` — a codex variant pinned to OpenAI's GPT-5.6 "Sol" model
 * (`-m gpt-5.6-sol`, GA 2026-07-09) at `model_reasoning_effort=high`, for hard
 * coding / deep-reasoning work on the flagship tier. `binary:"codex"` (the real
 * CLI probed by `list_adapters`). Built by `makeCodexVariant` (see
 * `_codex-factory.ts`) so flag assembly and the output contract are reused,
 * never re-implemented.
 *
 * Per-call `model`/`effort` on `opts` are ignored — the pin is the whole
 * point. Pass those to the base `codex` adapter instead.
 */
import { makeCodexVariant } from "./_codex-factory.ts";

const variant = makeCodexVariant({
  name: "codex-sol",
  model: "gpt-5.6-sol",
  configOverrides: { model_reasoning_effort: "high" },
});

export const name = variant.name;
export const binary = variant.binary;
export const buildArgs = variant.buildArgs;
export const injectContract = variant.injectContract;
export const parseResult = variant.parseResult;
