/**
 * MCP server construction. Builds an McpServer, registers the tool set (zero
 * tools in Phase 1 — the six tools are wired here in Phase 3), and connects the
 * stdio transport. Imported dynamically by server.ts so a missing node_modules
 * yields a clear startup error instead of a cryptic module-resolution stack.
 *
 * No console.log — stdout is the JSON-RPC transport. All human-facing output
 * (banner, shutdown) goes through the stderr logger.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "./lib/log.ts";

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

/**
 * Build the server, register tools (none yet), connect stdio, and install
 * clean-shutdown handlers. Resolves once the transport is connected.
 */
export async function startServer(): Promise<void> {
  const version = readVersion();
  const server = new McpServer({ name: "sdd", version }, { instructions: INSTRUCTIONS });

  // Phase 1: zero tools. Phase 3 registers the six tools here.
  const toolCount = 0;

  installShutdownHandlers(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`sdd ${version} connected (${toolCount} tools)`);
}

/**
 * Exit cleanly on SIGINT/SIGTERM: close the transport and exit 0 rather than
 * letting the default signal disposition terminate with 130. Phase 2 extends
 * this handler to also reap tracked child processes.
 */
function installShutdownHandlers(server: McpServer): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    void server
      .close()
      .catch((e: unknown) => log("error during shutdown:", e instanceof Error ? e.message : String(e)))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
