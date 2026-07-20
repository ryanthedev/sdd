/**
 * Shared tool-handler plumbing, mirroring oberskills/mcp's lib/tool.ts pattern:
 * a typed `ToolModule` contract plus `ok()`/`err()` result builders every tool
 * handler returns instead of throwing. `register.ts` wraps `invoke` in a
 * try/catch backstop, but each handler here also catches its own known failure
 * modes (unknown adapter, bad cwd, ...) so the caller gets a
 * specific, actionable message instead of a generic "X failed" string.
 */
import type { z } from "zod";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * The per-tool object every factory in `src/tools/*.ts` produces. Unlike
 * oberskills' stateless tools (bare module exports), these tools share one
 * mutable `JobStore` (see `runtime.ts`), so `handler` is built by a
 * `createXTool(rt)` factory that closes over the injected runtime — the shape
 * of the produced object still matches name/title/description/inputShape/
 * handler; only how `handler` is assembled differs (documented in the phase
 * discovery notes as a deliberate DI seam for testability).
 */
export type ToolModule<Shape extends z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  inputShape: Shape;
  handler: (args: z.output<z.ZodObject<Shape>>) => Promise<ToolResult>;
};

export function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function err(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/** Bound, whitelisted error text — never leaks a raw unbounded stack/env dump. */
export function friendlyMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.slice(0, 2048);
}
