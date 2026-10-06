/**
 * `metakocka-mcp --check` — verifies the setup without starting the MCP server,
 * and explains in plain language what to fix.
 */
import { listWarehouses } from "./api.js";
import { MetakockaClient, MetakockaError } from "./client.js";
import { ConfigError, loadConfig } from "./config.js";
import { VERSION } from "./version.js";

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/** Returns the process exit code: 0 when everything works, 1 otherwise. */
export async function runDoctor({ env = process.env, fetch: fetchImpl, log = console.log }: DoctorDeps = {}): Promise<number> {
  log(`metakocka-mcp ${VERSION}`);
  let ok = true;
  const pass = (message: string) => log(`  ✓ ${message}`);
  const fail = (message: string, hint?: string) => {
    ok = false;
    log(`  ✗ ${message}`);
    if (hint) log(`    → ${hint}`);
  };

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 20) pass(`Node.js ${process.versions.node}`);
  else fail(`Node.js ${process.versions.node} is too old`, "Install Node.js 20 or newer from https://nodejs.org");

  let client: MetakockaClient | undefined;
  try {
    const config = loadConfig(env);
    pass(`Credentials found (company ID ${config.companyId})`);
    client = new MetakockaClient({ ...config, maxRetries: 0, fetch: fetchImpl });
  } catch (error) {
    if (error instanceof ConfigError) {
      fail(
        "Credentials are missing or invalid",
        "Set METAKOCKA_COMPANY_ID and METAKOCKA_SECRET_KEY. Guide: https://metakocka.freshdesk.com/en/support/solutions/articles/3000106126",
      );
    } else throw error;
  }

  if (client) {
    try {
      const warehouses = await listWarehouses(client);
      pass(`Connected to Metakocka (${warehouses.length} warehouse${warehouses.length === 1 ? "" : "s"} visible)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof MetakockaError && error.httpStatus === undefined && error.oprCode === undefined) {
        fail(message, "Check your internet connection and any firewall or proxy.");
      } else if (error instanceof MetakockaError && (error.httpStatus === 401 || error.httpStatus === 403 || error.oprCode !== undefined)) {
        fail(message, "Check the company ID and secret key, and that API access is enabled in Metakocka.");
      } else {
        fail(message);
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
