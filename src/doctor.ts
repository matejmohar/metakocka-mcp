/**
 * `metakocka-mcp --check` — verifies the setup without starting the MCP server,
 * and explains in plain language what to fix.
 */
import { readFile } from "node:fs/promises";
import { listWarehouses, searchDocuments } from "./api.js";
import { CERTIFICATE_ERROR_CODES, MetakockaClient, MetakockaError, NetworkError } from "./client.js";
import { baseUrlFromEnv, ConfigError, envValue, loadConfig } from "./config.js";
import { addDays, todayInLjubljana } from "./dates.js";
import { describeInstallation } from "./installation.js";
import { VERSION } from "./version.js";

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Injected for tests. */
  now?: () => number;
}

/** A search slower than this makes the bigger reports likely to time out. */
const SLOW_SEARCH_MS = 10_000;

/** Returns the process exit code: 0 when everything works, 1 otherwise. */
export async function runDoctor({ env = process.env, fetch: fetchImpl, log = console.log, now = performance.now.bind(performance) }: DoctorDeps = {}): Promise<number> {
  log(`metakocka-mcp ${VERSION}`);
  let ok = true;
  const pass = (message: string) => log(`  ✓ ${message}`);
  const warn = (message: string, hint?: string) => {
    log(`  ! ${message}`);
    if (hint) log(`    → ${hint}`);
  };
  const fail = (message: string, hint?: string) => {
    ok = false;
    log(`  ✗ ${message}`);
    if (hint) log(`    → ${hint}`);
  };

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 20) pass(`Node.js ${process.versions.node}`);
  else fail(`Node.js ${process.versions.node} is too old`, "Install Node.js 20 or newer from https://nodejs.org");

  let installationOk = true;
  try {
    const info = describeInstallation(baseUrlFromEnv(env));
    if (info.isDefault) pass("Installation: main.metakocka.si (public)");
    else pass(`Installation: ${info.baseUrl}`);
    if (!info.secure) {
      if (info.isPrivate) warn(`Plain HTTP to ${info.host}: the secret key is not encrypted on your local network.`);
      else warn(`Plain HTTP to ${info.host}: the secret key is sent unencrypted over the internet.`, "Use https:// if the installation supports it.");
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    installationOk = false;
    fail(error.message);
  }

  const caFile = envValue(env, "NODE_EXTRA_CA_CERTS");
  if (caFile) {
    try {
      const pem = await readFile(caFile, "utf8");
      if (pem.includes("-----BEGIN CERTIFICATE-----")) pass(`Extra CA certificate: ${caFile}`);
      else fail(`${caFile} is not a PEM certificate file`, "Use the CA certificate in PEM format (text starting with -----BEGIN CERTIFICATE-----).");
    } catch {
      fail(`Cannot read the CA certificate file ${caFile}`, "Check the path in NODE_EXTRA_CA_CERTS (or the extension's \"CA certificate\" setting).");
    }
  }

  let client: MetakockaClient | undefined;
  if (installationOk) {
    try {
      const config = loadConfig(env);
      pass(`Credentials found (company ID ${config.companyId})`);
      client = new MetakockaClient({ ...config, maxRetries: 0, fetch: fetchImpl });
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      if (envValue(env, "METAKOCKA_COMPANY_ID") && envValue(env, "METAKOCKA_SECRET_KEY")) fail(error.message);
      else {
        fail(
          "Credentials are missing or invalid",
          "Set METAKOCKA_COMPANY_ID and METAKOCKA_SECRET_KEY. Guide: https://metakocka.freshdesk.com/en/support/solutions/articles/3000106126",
        );
      }
    }
  }

  if (client) {
    let connected = false;
    try {
      const warehouses = await listWarehouses(client);
      connected = true;
      pass(`Connected to ${client.host} (${warehouses.length} warehouse${warehouses.length === 1 ? "" : "s"} visible)`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), connectionHint(error));
    }

    if (connected) {
      const today = todayInLjubljana();
      const started = now();
      try {
        await searchDocuments(client, { docType: "sales_order", dateFrom: addDays(today, -30), dateTo: today, limit: 1 });
        const ms = Math.round(now() - started);
        const took = ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
        if (ms > SLOW_SEARCH_MS) {
          warn(
            `Document search is slow (${took})`,
            "Large reports may time out. Raise METAKOCKA_TIMEOUT_MS (or the extension's timeout) or ask for shorter periods.",
          );
        } else pass(`Document search works (${took})`);
      } catch (error) {
        fail(`Document search failed: ${error instanceof Error ? error.message : String(error)}`, connectionHint(error));
      }
    }
  }

  const latest = await latestPublishedVersion(fetchImpl);
  if (latest && latest !== VERSION && isNewer(latest, VERSION)) {
    log(`  ! A newer version is available: ${latest} (you have ${VERSION}). Update the extension or run: npx -y metakocka-mcp@latest`);
  } else if (latest) {
    pass("Up to date");
  }

  log(ok ? "\nAll good — the server is ready to use." : "\nSome checks failed — see above.");
  return ok ? 0 : 1;
}

function connectionHint(error: unknown): string | undefined {
  if (error instanceof NetworkError) {
    if (error.code && CERTIFICATE_ERROR_CODES.has(error.code)) {
      return "The CA certificate must be a PEM file (text starting with -----BEGIN CERTIFICATE-----). Restart after setting it.";
    }
    return "Check the Metakocka URL, your internet / VPN connection and any firewall or proxy.";
  }
  if (!(error instanceof MetakockaError)) return undefined;
  if (error.httpStatus === 401 || error.httpStatus === 403 || error.oprCode !== undefined) {
    return "Check the company ID and secret key, and that API access is enabled in Metakocka.";
  }
  if (error.httpStatus === 404 || error.httpStatus === 405) return "Check the path in the Metakocka URL (usually /rest/eshop/v1).";
  return undefined;
}

async function latestPublishedVersion(fetchImpl: typeof fetch = globalThis.fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl("https://registry.npmjs.org/metakocka-mcp/latest", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : undefined;
  } catch {
    return undefined; // offline or not published yet: not worth reporting
  }
}

function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}
