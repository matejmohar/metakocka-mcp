/**
 * `metakocka-mcp --http` — serves MCP over Streamable HTTP, so a team can run
 * one server instead of everyone installing it locally.
 *
 * Credentials come with each request, in the X-Metakocka-Company-Id and
 * X-Metakocka-Secret-Key headers. The server's own METAKOCKA_COMPANY_ID /
 * METAKOCKA_SECRET_KEY are only used for requests that carry the bearer token
 * from METAKOCKA_HTTP_TOKEN, so an open port never exposes a company's data.
 * The installation (METAKOCKA_BASE_URL) is fixed by the server: clients
 * cannot point it at other hosts.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { TtlCache } from "./cache.js";
import { MetakockaClient } from "./client.js";
import { baseUrlFromEnv, cacheTtlMs, ConfigError, envValue, loadConfig, timeoutMsFromEnv } from "./config.js";
import { describeInstallation } from "./installation.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

export const COMPANY_HEADER = "x-metakocka-company-id";
export const SECRET_HEADER = "x-metakocka-secret-key";
export const MCP_PATH = "/mcp";

export interface HttpOptions {
  env?: NodeJS.ProcessEnv;
  host?: string;
  port?: number;
  /** Injected for tests: the fetch the Metakocka clients use. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Tenants unused for this long are dropped (their cache and queue with them). */
  idleMs?: number;
  maxTenants?: number;
}

interface Tenant {
  handler: McpHttpHandler;
  lastUsed: number;
}

/**
 * The web-standard part of the HTTP server: authentication, routing and one
 * MCP handler (with its own client queue and cache) per company and key.
 * Exposed separately so it can be tested without opening a port.
 */
export function createHttpApp({ env = process.env, fetch: fetchImpl, idleMs = 30 * 60_000, maxTenants = 100, host = "127.0.0.1" }: HttpOptions = {}) {
  const baseUrl = baseUrlFromEnv(env); // throws ConfigError at startup for a bad URL
  const timeoutMs = timeoutMsFromEnv(env);
  const cacheMs = cacheTtlMs(env, { strict: true });
  const token = envValue(env, "METAKOCKA_HTTP_TOKEN");
  const allowedHosts = allowedHostnames(env, host);
  const tenants = new Map<string, Tenant>();

  function tenantFor(companyId: string, secretKey: string): Tenant {
    const key = createHash("sha256").update(`${baseUrl}\0${companyId}\0${secretKey}`).digest("hex");
    let tenant = tenants.get(key);
    if (!tenant) {
      const client = new MetakockaClient({ companyId, secretKey, baseUrl, timeoutMs, fetch: fetchImpl, userAgent: `metakocka-mcp/${VERSION} (http)` });
      const cache = new TtlCache(cacheMs);
      tenant = {
        handler: createMcpHandler(() => createServer({ getClient: () => client, cache, baseUrl, pdfDelivery: "embedded" })),
        lastUsed: 0,
      };
      tenants.set(key, tenant);
    }
    tenant.lastUsed = Date.now();
    // Map order = least recently used first.
    tenants.delete(key);
    tenants.set(key, tenant);
    evict();
    return tenant;
  }

  function evict(): void {
    const cutoff = Date.now() - idleMs;
    for (const [key, t] of tenants) {
      if (tenants.size <= maxTenants && t.lastUsed >= cutoff) break;
      tenants.delete(key);
      void t.handler.close();
    }
  }

  async function fetchHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (allowedHosts && !allowedHosts.includes(hostnameOf(request.headers.get("host") ?? url.host))) {
      return jsonError(403, "Host not allowed. Set METAKOCKA_HTTP_ALLOWED_HOSTS to the host names clients use.");
    }
    const origin = request.headers.get("origin");
    if (origin && allowedHosts && !allowedHosts.includes(hostnameOf(safeHost(origin)))) {
      return jsonError(403, "Origin not allowed.");
    }

    if (url.pathname === "/health") return Response.json({ status: "ok", version: VERSION });
    if (url.pathname !== MCP_PATH) return jsonError(404, `Not found. The MCP endpoint is ${MCP_PATH}.`);

    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
    const hasToken = token !== undefined && bearer !== undefined && sameSecret(bearer, token);
    if (token !== undefined && !hasToken) {
      return jsonError(401, "Missing or wrong bearer token.", { "WWW-Authenticate": 'Bearer realm="metakocka-mcp"' });
    }

    const companyId = request.headers.get(COMPANY_HEADER)?.trim();
    const secretKey = request.headers.get(SECRET_HEADER)?.trim();
    let credentials: { companyId: string; secretKey: string } | undefined;
    if (companyId && secretKey) credentials = { companyId, secretKey };
    else if (hasToken) {
      try {
        credentials = loadConfig(env);
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
      }
    }
    if (!credentials) {
      return jsonError(
        401,
        `Send your Metakocka credentials in the ${headerName(COMPANY_HEADER)} and ${headerName(SECRET_HEADER)} headers` +
          (token ? "." : ", or set METAKOCKA_HTTP_TOKEN on the server to use its own credentials with a bearer token."),
      );
    }
    return tenantFor(credentials.companyId, credentials.secretKey).handler.fetch(request);
  }

  async function close(): Promise<void> {
    const all = [...tenants.values()];
    tenants.clear();
    await Promise.all(all.map((t) => t.handler.close()));
  }

  return { fetch: fetchHandler, close, baseUrl, tenantCount: () => tenants.size };
}

/** Starts listening; resolves once the port is open. */
export async function startHttpServer(options: HttpOptions = {}): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const host = options.host ?? envValue(env, "METAKOCKA_HTTP_HOST") ?? "127.0.0.1";
  const port = options.port ?? Number(envValue(env, "METAKOCKA_HTTP_PORT") ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("METAKOCKA_HTTP_PORT must be a port number (0–65535).");

  const app = createHttpApp({ ...options, env, host });
  const server = createHttpServer((req, res) => {
    void serveNode(app.fetch, req, res).catch((error: unknown) => {
      log(`[metakocka-mcp] request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${isIP(host) === 6 ? `[${host}]` : host}:${actualPort}${MCP_PATH}`;
  const installation = describeInstallation(app.baseUrl);
  log(`[metakocka-mcp] ${VERSION} serving MCP on ${url} (Metakocka: ${installation.isDefault ? "main.metakocka.si" : app.baseUrl})`);
  if (!isLoopback(host) && !envValue(env, "METAKOCKA_HTTP_TOKEN")) {
    log("[metakocka-mcp] Listening beyond this computer without METAKOCKA_HTTP_TOKEN: clients must send their own Metakocka credentials.");
  }
  if (!isLoopback(host)) {
    log("[metakocka-mcp] Put a TLS-terminating proxy in front: secret keys travel in request headers.");
  }

  return {
    server,
    url,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    },
  };
}

/** Bridges node:http to the web-standard handler, streaming the response (SSE progress) back as it comes. */
async function serveNode(handler: (request: Request) => Promise<Response>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    signal: controller.signal,
    // Required by Node's fetch for a streamed request body.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);

  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  controller.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

/**
 * Hosts the server answers to. Bound to loopback: only localhost names, which
 * blocks DNS-rebinding attacks from web pages. Otherwise
 * METAKOCKA_HTTP_ALLOWED_HOSTS, or any host when that is not set (e.g.
 * behind a reverse proxy).
 */
function allowedHostnames(env: NodeJS.ProcessEnv, host: string): string[] | undefined {
  const configured = envValue(env, "METAKOCKA_HTTP_ALLOWED_HOSTS");
  if (configured) return configured.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return isLoopback(host) ? ["localhost", "127.0.0.1", "[::1]"] : undefined;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function hostnameOf(hostHeader: string | null | undefined): string {
  if (!hostHeader) return "";
  const h = hostHeader.trim().toLowerCase();
  return h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.replace(/:\d+$/, "");
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function headerName(lower: string): string {
  return lower.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => dash + c.toUpperCase());
}

function jsonError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }, { status, headers });
}
