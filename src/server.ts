#!/usr/bin/env bun
/**
 * sdd — stdio MCP server entry point.
 *
 * This file stays dependency-free: it dynamically imports the registrar so a
 * half-installed plugin (dependencies not yet installed) fails with a clear,
 * actionable stderr message and a non-zero exit instead of a raw
 * module-resolution stack trace.
 *
 * No console.log anywhere — stdout is the JSON-RPC transport.
 */

async function main(): Promise<void> {
  let registrar: typeof import("./register.ts");
  try {
    registrar = await import("./register.ts");
  } catch (e) {
    console.error(
      "[sdd] dependencies not installed yet — run `bun install` in the plugin directory " +
        "(or /reload-plugins after the install hook completes). Underlying error: " +
        (e instanceof Error ? e.message : String(e)),
    );
    process.exit(1);
  }
  await registrar.startServer();
}

main().catch((e: unknown) => {
  console.error("[sdd] fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
