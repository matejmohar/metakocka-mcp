#!/usr/bin/env node
/**
 * metakocka-mcp — command-line entry point. By default MCP hosts (Claude
 * Desktop, Claude Code, Cursor, …) launch this process and talk to it over
 * stdin/stdout; with --http it serves MCP over HTTP instead.
 *
 * Never write to stdout here: in stdio mode it carries the protocol. Log to stderr.
 */
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { baseUrlFromEnv, ConfigError, loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { startHttpServer } from "./http.js";
import { createServer } from "./server.js";
import { createWriteContext } from "./tools/write.js";
import { writeSettingsFromEnv } from "./write/settings.js";
import { VERSION } from "./version.js";

const HELP = [
  `metakocka-mcp ${VERSION} — MCP server for the Metakocka ERP`,
  "",
  "Usage: metakocka-mcp [--check | --http [--port N] [--host H]]",
  "",
  "Options:",
  "  --check                verify the setup (installation, credentials, connection), then exit",
  "  --http                 serve MCP over HTTP at http://<host>:<port>/mcp instead of stdio",
  "  --port N               HTTP port (default 3000, or METAKOCKA_HTTP_PORT)",
  "  --host H               HTTP address to listen on (default 127.0.0.1, or METAKOCKA_HTTP_HOST)",
  "  --version, -v          print the version",
  "  --help, -h             print this help",
  "",
  "Environment:",
  "  METAKOCKA_COMPANY_ID       your Metakocka company id (required for stdio)",
  "  METAKOCKA_SECRET_KEY       your Metakocka API secret key (required for stdio)",
  "  METAKOCKA_BASE_URL         Metakocka installation: a URL, host name or IP, e.g. https://erp.example.com",
  "                             or http://10.0.0.15:8080 (default https://main.metakocka.si/rest/eshop/v1)",
  "  NODE_EXTRA_CA_CERTS        CA certificate (PEM file) for an installation with a company or self-signed certificate",
  "  METAKOCKA_TIMEOUT_MS       request timeout in ms (default 30000)",
  "  METAKOCKA_MAX_CONCURRENT   requests sent to Metakocka at once (default 2)",
  "  METAKOCKA_MAX_CONCURRENT_SEARCH searches at once (default 1)",
  "  METAKOCKA_QUEUE_TIMEOUT_SECONDS how long a request waits for a free slot (default 300)",
  "  METAKOCKA_CACHE_SECONDS    how long warehouses and partner lookups are reused (default 300, 0 = off)",
  "  METAKOCKA_PDF_DIR          where get_document_pdf saves files (default Downloads/Metakocka)",
  "",
  "Creating documents (off unless set):",
  "  METAKOCKA_WRITE                 comma-separated: offers (ponudbe / predračuni), invoices (računi, saved",
  "                                  not issued), purchase_invoices (prejeti računi), partners, products",
  "  METAKOCKA_WRITE_CONFIRM         client (default): the user confirms each document in a prompt, or by approving",
  "                                  the save in the client; elicitation: prompt only; never: no confirmation",
  "  METAKOCKA_WRITE_TIMEOUT_SECONDS how long to wait for Metakocka to save a document (default 120)",
  "  METAKOCKA_WRITE_LOG             audit log of all writes (default ~/.metakocka-mcp/writes.jsonl)",
  "",
  "HTTP mode:",
  "  Clients send X-Metakocka-Company-Id and X-Metakocka-Secret-Key headers.",
  "  METAKOCKA_HTTP_TOKEN         require \"Authorization: Bearer <token>\"; requests with it but without",
  "                               credential headers use METAKOCKA_COMPANY_ID / METAKOCKA_SECRET_KEY",
  "  METAKOCKA_HTTP_ALLOWED_HOSTS comma-separated host names clients use (Host header check)",
  "",
  "Setup instructions: see README.md or https://martej.com",
  "",
].join("\n");

let args: ReturnType<typeof parse>;
function parse() {
  return parseArgs({
    options: {
      check: { type: "boolean" },
      doctor: { type: "boolean" },
      http: { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  }).values;
}
try {
  args = parse();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
  process.exit(2);
}

if (args.version) {
  process.stderr.write(`${VERSION}\n`);
  process.exit(0);
}
if (args.help) {
  process.stderr.write(HELP);
  process.exit(0);
}
if (args.check || args.doctor) {
  process.exit(await runDoctor());
}

if (args.http) {
  try {
    const port = args.port !== undefined ? Number(args.port) : undefined;
    const http = await startHttpServer({ port, host: args.host });
    const shutdown = () => {
      void http.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    // A bad setting or a port in use: say so and stop, there's no client to explain it to.
    process.stderr.write(`[metakocka-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
} else {
  // Warn early, but keep running: the tools explain the missing setup to the user.
  try {
    loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) process.stderr.write(`[metakocka-mcp] ${error.message}\n`);
    else throw error;
  }

  let target = "";
  try {
    target = ` (Metakocka: ${new URL(baseUrlFromEnv()).host})`;
  } catch {
    // already reported above
  }
  // Created once: drafts must survive between requests.
  let write: ReturnType<typeof createWriteContext> | undefined;
  try {
    const settings = writeSettingsFromEnv();
    if (settings) write = createWriteContext(settings, { localFiles: true });
  } catch (error) {
    // A bad write setting must never leave writing half on: refuse to start.
    process.stderr.write(`[metakocka-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  const handle = serveStdio(() => createServer({ write }));
  const mode = write ? `, creating documents enabled: ${write.settings.docTypes.join(", ")} (confirm: ${write.settings.confirm})` : ", read-only";
  process.stderr.write(`[metakocka-mcp] ${VERSION} running on stdio${target}${mode}\n`);

  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
