#!/usr/bin/env node
/**
 * metakocka-mcp — stdio entry point. MCP hosts (Claude Desktop, Claude Code,
 * Cursor, …) launch this process and talk to it over stdin/stdout.
 *
 * Never write to stdout here: it carries the protocol. Log to stderr.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigError, loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const arg = process.argv[2];
if (arg === "--version" || arg === "-v") {
  process.stderr.write(`${VERSION}\n`);
  process.exit(0);
}
if (arg === "--help" || arg === "-h") {
  process.stderr.write(
    [
      `metakocka-mcp ${VERSION} — MCP server for the Metakocka ERP`,
      "",
      "Environment:",
      "  METAKOCKA_COMPANY_ID   your Metakocka company id (required)",
      "  METAKOCKA_SECRET_KEY   your Metakocka API secret key (required)",
      "  METAKOCKA_BASE_URL     API base URL (optional)",
      "  METAKOCKA_TIMEOUT_MS   request timeout in ms (optional, default 30000)",
      "",
      "Setup instructions: see README.md or https://martej.com",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// Warn early, but keep running: the tools explain the missing setup to the user.
try {
  loadConfig();
} catch (error) {
  if (error instanceof ConfigError) process.stderr.write(`[metakocka-mcp] ${error.message}\n`);
  else throw error;
}

const handle = serveStdio(() => createServer());
process.stderr.write(`[metakocka-mcp] ${VERSION} running on stdio\n`);

const shutdown = () => {
  void handle.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
