/**
 * MCP server construction. Builds an McpServer, registers the seven tools
 * (dispatch/status/result/wait/cancel/list_adapters/check_adapter) over one shared Runtime
 * (JobStore + adapters dir), and connects the stdio transport. Imported
 * dynamically by server.ts so a missing node_modules yields a clear startup
 * error instead of a cryptic module-resolution stack.
 *
 * No console.log — stdout is the JSON-RPC transport. All human-facing output
 * (banner, shutdown) goes through the stderr logger.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { z } from "zod";
import { log } from "./lib/log.ts";
import { createCancelTool } from "./tools/cancel.ts";
import { createCheckTool } from "./tools/check.ts";
import { createDispatchTool } from "./tools/dispatch.ts";
import { createListAdaptersTool } from "./tools/list-adapters.ts";
import { createResultTool } from "./tools/result.ts";
import { createRuntime, type Runtime } from "./tools/runtime.ts";
import { friendlyMessage, type ToolModule, type ToolResult } from "./tools/shared.ts";
import { createStatusTool } from "./tools/status.ts";
import { createWaitTool } from "./tools/wait.ts";

const INSTRUCTIONS =
  "Subagent-Driven Development: delegate scoped, fresh-context work units (code, review, " +
  "second-opinion, image-gen) to CLI agent harnesses that run in the same working tree, then " +
  "collect structured {status, summary, artifacts, raw} results. Claude stays the brain and owns the diff.";

/**
 * Server version comes from the plugin manifest — the single source of truth.
 * Prefer $CLAUDE_PLUGIN_ROOT when running inside Claude Code; fall back to a
 * path relative to this module for tests and manual `bun run`.
 */
export function readVersion(): string {
  const candidates: (string | URL)[] = [];
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    candidates.push(join(process.env.CLAUDE_PLUGIN_ROOT, ".claude-plugin", "plugin.json"));
  }
  candidates.push(new URL("../.claude-plugin/plugin.json", import.meta.url));

  for (const candidate of candidates) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof manifest === "object" && manifest !== null) {
        const v = (manifest as Record<string, unknown>).version;
        if (typeof v === "string") return v;
      }
    } catch {
      // try the next candidate
    }
  }
  return "0.0.0";
}

/** Type-erased registration record — mirrors oberskills/mcp's register.ts `RegisteredTool`. */
type RegisteredTool = {
  name: string;
  title: string;
  description: string;
  inputShape: z.ZodRawShape;
  invoke: (args: unknown) => Promise<ToolResult>;
};

/**
 * Compile-time bridge from a typed ToolModule to the registration list: the
 * one `as` cast here is the runtime trust boundary — the MCP SDK has already
 * validated `args` against this same `inputShape` before invoking `invoke`.
 */
function defineTool<Shape extends z.ZodRawShape>(mod: ToolModule<Shape>): RegisteredTool {
  return {
    name: mod.name,
    title: mod.title,
    description: mod.description,
    inputShape: mod.inputShape,
    invoke: (args: unknown) => mod.handler(args as z.output<z.ZodObject<Shape>>),
  };
}

/** Build the seven registration records over one shared Runtime. */
function buildTools(rt: Runtime): RegisteredTool[] {
  return [
    defineTool(createDispatchTool(rt)),
    defineTool(createStatusTool(rt)),
    defineTool(createResultTool(rt)),
    defineTool(createWaitTool(rt)),
    defineTool(createCancelTool(rt)),
    defineTool(createListAdaptersTool(rt)),
    defineTool(createCheckTool(rt)),
  ];
}

/**
 * Build the server, register the seven tools over a fresh Runtime, connect
 * stdio, and install clean-shutdown handlers. Resolves once the transport is
 * connected.
 */
export async function startServer(): Promise<void> {
  const version = readVersion();
  const server = new McpServer({ name: "sdd", version }, { instructions: INSTRUCTIONS });

  const runtime = createRuntime({ jobStoreOptions: {} });
  const tools = buildTools(runtime);

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputShape },
      async (args: unknown) => {
        try {
          return await tool.invoke(args);
        } catch (e) {
          log(`${tool.name} failed:`, friendlyMessage(e));
          return { isError: true, content: [{ type: "text" as const, text: `${tool.name} failed: ${friendlyMessage(e)}` }] };
        }
      },
    );
  }

  installShutdownHandlers(server, runtime);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`sdd ${version} connected (${tools.length} tools)`);
}

/**
 * Exit cleanly on SIGINT/SIGTERM: reap every tracked child (JobStore.shutdown),
 * THEN close the transport and exit 0 — rather than letting the default signal
 * disposition terminate with 130. Reaping is composed explicitly here instead
 * of via JobStore's own opt-in signal handlers, so the shutdown sequence is
 * deterministic (reap, then close, then exit) instead of two independent
 * SIGINT handlers racing each other.
 */
function installShutdownHandlers(server: McpServer, runtime: Runtime): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    void runtime.jobStore
      .shutdown()
      .catch((e: unknown) => log("error reaping jobs:", e instanceof Error ? e.message : String(e)))
      .then(() => server.close())
      .catch((e: unknown) => log("error during shutdown:", e instanceof Error ? e.message : String(e)))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
