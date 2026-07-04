/**
 * stderr-only logger. stdout IS the JSON-RPC transport on a stdio MCP server —
 * a console.log anywhere in src/ corrupts the protocol stream. Everything the
 * server wants to say to a human (startup banner, discovery warnings, shutdown)
 * goes through here, to stderr.
 */
export function log(...args: unknown[]): void {
  console.error("[sdd]", ...args);
}
