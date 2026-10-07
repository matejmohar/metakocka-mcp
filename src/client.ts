/**
 * Minimal, typed client for the Metakocka REST API.
 *
 * Every Metakocka call is a JSON POST to `<baseUrl>/<endpoint>` with
 * `company_id` and `secret_key` in the body. A response with `opr_code` other
 * than "0" is an error, described in `opr_desc`.
 *
 * API reference: https://github.com/metakocka/metakocka_api_base
 */

import { DEFAULT_BASE_URL } from "./installation.js";

export { DEFAULT_BASE_URL };

export interface MetakockaClientOptions {
  companyId: string;
  secretKey: string;
  /** Defaults to https://main.metakocka.si/rest/eshop/v1 */
  baseUrl?: string;
  /** Per-request timeout. Defaults to 30 s (some Metakocka searches are slow). */
  timeoutMs?: number;
  /** Retries for network errors, HTTP 429 and 5xx on idempotent calls. Defaults to 2. */
  maxRetries?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected for tests, to skip backoff delays. */
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export interface CallOptions {
  /**
   * Whether the call is safe to retry. All read calls are; write calls (added
   * in a later version) must pass false so a timeout never creates duplicates.
   */
  idempotent?: boolean;
  /** Overrides the client's timeout for this call (writes can take much longer than reads). */
  timeoutMs?: number;
}

export class MetakockaError extends Error {
  constructor(
    message: string,
    /** Metakocka `opr_code`, when the API answered with an error. */
    readonly oprCode?: string,
    /** HTTP status, when the request failed at the HTTP level. */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "MetakockaError";
  }
}

type Json = Record<string, unknown>;

export interface BinaryResponse {
  contentType: string;
  bytes: Uint8Array;
}

export class MetakockaClient {
  private readonly companyId: string;
  private readonly secretKey: string;
  readonly baseUrl: string;
  /** host[:port] of the installation, for messages. */
  readonly host: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;
  /**
   * Metakocka runs searches for one company strictly in sequence on its side,
   * so sending them in parallel only makes them queue there and time out.
   * We queue locally instead.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: MetakockaClientOptions) {
    if (!options.companyId) throw new MetakockaError("Missing Metakocka company ID");
    if (!options.secretKey) throw new MetakockaError("Missing Metakocka secret key");
    this.companyId = String(options.companyId);
    this.secretKey = options.secretKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.host = new URL(this.baseUrl).host;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.userAgent = options.userAgent ?? "metakocka-mcp";
  }

  /**
   * Call an endpoint, e.g. `call("search", { doc_type: "sales_order" })` or
   * `call("json/product_list", {...})`. Credentials are added automatically.
   */
  call<T = Json>(endpoint: string, params: Json = {}, options: CallOptions = {}): Promise<T> {
    return this.enqueue(() =>
      this.withRetries(() => this.callOnce<T>(endpoint, params, options.timeoutMs), options.idempotent ?? true),
    );
  }

  /**
   * Call an endpoint that answers with a file (e.g. `report` → PDF). An
   * `application/json` answer is an error and is thrown like any other.
   */
  callBinary(endpoint: string, params: Json = {}): Promise<BinaryResponse> {
    return this.enqueue(() => this.withRetries(() => this.callBinaryOnce(endpoint, params), true));
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    // Keep the queue going whether this call succeeds or fails.
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async withRetries<T>(once: () => Promise<T>, idempotent: boolean): Promise<T> {
    const attempts = idempotent ? this.maxRetries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await once();
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === attempts) break;
        await this.sleep(500 * 3 ** (attempt - 1)); // 0.5 s, 1.5 s, 4.5 s …
      }
    }
    throw lastError;
  }

  private async callOnce<T>(endpoint: string, params: Json, timeoutMs?: number): Promise<T> {
    const response = await this.post(endpoint, params, timeoutMs);
    return this.parseJson<T>(endpoint, response, await response.text());
  }

  private async callBinaryOnce(endpoint: string, params: Json): Promise<BinaryResponse> {
    const response = await this.post(endpoint, params);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (!response.ok || contentType.includes("json")) {
      // parseJson throws for HTTP errors and opr_code ≠ 0; anything else is still not the file we asked for.
      this.parseJson(endpoint, response, await response.text());
      throw new MetakockaError(`Metakocka returned no file for ${endpoint}`);
    }
    return { contentType, bytes: new Uint8Array(await response.arrayBuffer()) };
  }

  private async post(endpoint: string, params: Json, timeoutMs = this.timeoutMs): Promise<Response> {
    const url = `${this.baseUrl}/${endpoint.replace(/^\/+/, "")}`;
    const body = JSON.stringify({ ...params, company_id: this.companyId, secret_key: this.secretKey });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": this.userAgent,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new NetworkError(`Could not reach Metakocka (${endpoint}): timed out after ${Math.round(timeoutMs / 1000)} s`, "TIMEOUT");
      }
      const code = networkErrorCode(error);
      const reason = (code && NETWORK_REASONS[code]?.(this.host)) ?? this.redact(errorText(error));
      throw new NetworkError(`Could not reach Metakocka at ${this.host} (${endpoint}): ${reason}`, code);
    }
    return response;
  }

  private parseJson<T>(endpoint: string, response: Response, text: string): T {
    const webPage = /^\s*</.test(text);
    if (webPage && !response.ok && response.status !== 404 && response.status !== 405) {
      throw new MetakockaError(`Metakocka at ${this.host} returned HTTP ${response.status} for ${endpoint}`, undefined, response.status);
    }
    if (webPage) {
      // A web page instead of the API: usually a wrong path in the Metakocka URL, or a login page / proxy in between.
      throw new MetakockaError(
        `${this.host} answered ${endpoint} with a web page (HTTP ${response.status}) instead of Metakocka API data. ` +
          `Check the Metakocka URL: the API is usually at ${new URL(this.baseUrl).origin}/rest/eshop/v1 (now: ${this.baseUrl}).`,
        undefined,
        response.ok ? undefined : response.status,
      );
    }
    if (!response.ok) {
      throw new MetakockaError(
        `Metakocka returned HTTP ${response.status} for ${endpoint}${text ? `: ${this.redact(text.slice(0, 300))}` : ""}`,
        undefined,
        response.status,
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new MetakockaError(`Metakocka returned a non-JSON response for ${endpoint}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new MetakockaError(`Metakocka returned an unexpected response for ${endpoint}`);
    }

    const oprCode = (data as Json).opr_code;
    if (oprCode !== undefined && String(oprCode) !== "0") {
      // Most endpoints describe the error in opr_desc; a few newer ones (accounting_export) in error_desc.
      const desc = (data as Json).opr_desc ?? (data as Json).error_desc;
      throw new MetakockaError(
        `Metakocka error (${endpoint}): ${this.redact(String(desc ?? `opr_code ${String(oprCode)}`))}`,
        String(oprCode),
      );
    }
    return data as T;
  }

  /** Make sure the secret key never ends up in an error message. */
  private redact(text: string): string {
    return this.secretKey ? text.split(this.secretKey).join("***") : text;
  }
}

export class NetworkError extends MetakockaError {
  constructor(
    message: string,
    /** Node's error code (ENOTFOUND, ECONNREFUSED, SELF_SIGNED_CERT_IN_CHAIN, …) or TIMEOUT, when known. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

/** Certificate problems: retrying won't help, and the fix is a trusted certificate (or the right host name). */
export const CERTIFICATE_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const CERTIFICATE_REASON = (host: string) =>
  `the TLS certificate of ${host} is not trusted. For a company or self-signed certificate, set NODE_EXTRA_CA_CERTS ` +
  "(or the extension's \"CA certificate\" setting) to its CA certificate file";

const NETWORK_REASONS: Record<string, (host: string) => string> = {
  ENOTFOUND: (host) => `host name ${host.replace(/:\d+$/, "")} was not found (check the Metakocka URL and DNS / VPN)`,
  EAI_AGAIN: (host) => `host name ${host.replace(/:\d+$/, "")} could not be resolved right now (DNS)`,
  ECONNREFUSED: (host) => `${host} refused the connection (wrong port, or the server is not running)`,
  ECONNRESET: () => "the connection was reset",
  EHOSTUNREACH: (host) => `${host} is unreachable (check the network / VPN)`,
  ENETUNREACH: (host) => `${host} is unreachable (check the network / VPN)`,
  ETIMEDOUT: (host) => `connecting to ${host} timed out (check the network / VPN / firewall)`,
  UND_ERR_CONNECT_TIMEOUT: (host) => `connecting to ${host} timed out (check the network / VPN / firewall)`,
  EPROTO: (host) => `TLS handshake with ${host} failed (does it serve plain http:// instead of https://?)`,
  ERR_SSL_WRONG_VERSION_NUMBER: (host) => `TLS handshake with ${host} failed (does it serve plain http:// instead of https://?)`,
  ...Object.fromEntries([...CERTIFICATE_ERROR_CODES].map((code) => [code, CERTIFICATE_REASON])),
};

/** fetch() wraps the real network error in `cause` (sometimes twice). */
function networkErrorCode(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code !== "UND_ERR_SOCKET") return code;
  }
  return undefined;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause && cause !== error.message ? `${error.message} (${cause})` : error.message;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof NetworkError) return !(error.code && (CERTIFICATE_ERROR_CODES.has(error.code) || error.code === "ENOTFOUND"));
  if (error instanceof MetakockaError && error.httpStatus !== undefined) {
    return error.httpStatus === 429 || error.httpStatus >= 500;
  }
  return false;
}
