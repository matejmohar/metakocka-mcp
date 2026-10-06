/**
 * Which Metakocka installation the server talks to. Most companies use the
 * public one (main.metakocka.si), but an installation can also run on its own
 * domain, an internal hostname, or a bare IP address, with or without TLS.
 */
import { isIP } from "node:net";

export const DEFAULT_BASE_URL = "https://main.metakocka.si/rest/eshop/v1";
export const API_PATH = "/rest/eshop/v1";
const DEFAULT_HOST = "main.metakocka.si";

export class InstallationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationUrlError";
  }
}

/**
 * Turn whatever the user entered into the API base URL:
 *
 * - empty → the public installation
 * - no scheme → https:// (plain HTTP must be asked for explicitly)
 * - no path → /rest/eshop/v1 is added; a path that is given is kept as is
 * - hostnames, IPv4, IPv6 (with or without brackets) and ports all work
 */
export function normalizeBaseUrl(input: string | undefined): string {
  let raw = input?.trim() ?? "";
  if (!raw) return DEFAULT_BASE_URL;

  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    // A bare IPv6 address ("fd00::5") needs brackets before it can be parsed as a host.
    if (isIP(raw) === 6) raw = `[${raw}]`;
    raw = `https://${raw}`;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InstallationUrlError(`"${input}" is not a valid Metakocka URL. Example: https://erp.example.com or http://10.0.0.15:8080`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InstallationUrlError(`The Metakocka URL must start with https:// or http://, not ${url.protocol}//`);
  }
  if (url.username || url.password) {
    throw new InstallationUrlError("The Metakocka URL must not contain a user name or password.");
  }
  if (url.search || url.hash) {
    throw new InstallationUrlError("The Metakocka URL must not contain ? or #. Enter only the address of the installation.");
  }

  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path || API_PATH}`;
}

export interface InstallationInfo {
  baseUrl: string;
  /** host[:port], for messages. */
  host: string;
  /** The public installation, main.metakocka.si. */
  isDefault: boolean;
  secure: boolean;
  /** Loopback, private network or link-local address, or an internal-looking hostname. */
  isPrivate: boolean;
}

export function describeInstallation(baseUrl: string): InstallationInfo {
  const url = new URL(baseUrl);
  return {
    baseUrl,
    host: url.host,
    isDefault: url.hostname === DEFAULT_HOST && url.protocol === "https:" && url.port === "",
    secure: url.protocol === "https:",
    isPrivate: isPrivateHost(url.hostname),
  };
}

/** Whether a hostname points into a local or private network (where plain HTTP is a smaller risk). */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(host) === 6) {
    if (host === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return isPrivateHost(mapped[1]!);
    return /^f[cd]/.test(host) || /^fe[89ab]/.test(host); // unique local fc00::/7, link-local fe80::/10
  }
  // Single-label names ("erp") and the usual internal suffixes only resolve inside a network.
  return !host.includes(".") || /\.(local|internal|lan|intranet|corp|home\.arpa)$/.test(host);
}
