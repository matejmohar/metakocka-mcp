import { describe, expect, it } from "vitest";
import { baseUrlFromEnv, cacheTtlMs, ConfigError, envValue, loadConfig, pdfDirectory } from "../src/config.js";
import { DEFAULT_BASE_URL, describeInstallation, InstallationUrlError, isPrivateHost, normalizeBaseUrl } from "../src/installation.js";

describe("normalizeBaseUrl", () => {
  it.each([
    [undefined, DEFAULT_BASE_URL],
    ["", DEFAULT_BASE_URL],
    ["  ", DEFAULT_BASE_URL],
    ["https://main.metakocka.si", DEFAULT_BASE_URL],
    ["https://main.metakocka.si/rest/eshop/v1/", DEFAULT_BASE_URL],
    ["https://erp.firma.local", "https://erp.firma.local/rest/eshop/v1"],
    ["http://10.0.0.15:8080", "http://10.0.0.15:8080/rest/eshop/v1"],
    ["192.168.1.20", "https://192.168.1.20/rest/eshop/v1"],
    ["192.168.1.20:8443", "https://192.168.1.20:8443/rest/eshop/v1"],
    ["erp", "https://erp/rest/eshop/v1"],
    ["localhost:3000", "https://localhost:3000/rest/eshop/v1"],
    ["https://intranet.firma.si/mk/rest/eshop/v1", "https://intranet.firma.si/mk/rest/eshop/v1"],
    ["https://intranet.firma.si/mk/", "https://intranet.firma.si/mk"],
    ["HTTPS://ERP.Firma.SI", "https://erp.firma.si/rest/eshop/v1"],
    ["fd00::5", "https://[fd00::5]/rest/eshop/v1"],
    ["http://[::1]:8080", "http://[::1]:8080/rest/eshop/v1"],
    ["https://erp.firma.si:443", "https://erp.firma.si/rest/eshop/v1"],
  ])("%j → %s", (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it.each([
    ["ftp://erp.firma.si", /https:\/\/ or http:\/\//],
    ["https://user:pass@erp.firma.si", /user name or password/],
    ["https://erp.firma.si/?company=1", /\? or #/],
    ["http://", /not a valid/],
    ["https://exa mple.com", /not a valid/],
  ])("rejects %j", (input, message) => {
    expect(() => normalizeBaseUrl(input)).toThrow(InstallationUrlError);
    expect(() => normalizeBaseUrl(input)).toThrow(message);
  });
});

describe("describeInstallation", () => {
  it("recognises the public installation", () => {
    expect(describeInstallation(DEFAULT_BASE_URL)).toMatchObject({ isDefault: true, secure: true, host: "main.metakocka.si" });
  });

  it("describes another installation", () => {
    expect(describeInstallation("http://10.0.0.15:8080/rest/eshop/v1")).toMatchObject({
      isDefault: false,
      secure: false,
      isPrivate: true,
      host: "10.0.0.15:8080",
    });
  });
});

describe("isPrivateHost", () => {
  it.each(["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10", "169.254.1.1", "::1", "[::1]", "fd12::1", "fe80::1", "::ffff:192.168.1.1", "erp", "erp.firma.local", "mk.corp", "erp.home.arpa"])(
    "%s is private",
    (host) => expect(isPrivateHost(host)).toBe(true),
  );

  it.each(["main.metakocka.si", "erp.firma.si", "8.8.8.8", "172.32.0.1", "2001:db8::1"])("%s is public", (host) =>
    expect(isPrivateHost(host)).toBe(false),
  );
});

describe("config", () => {
  const creds = { METAKOCKA_COMPANY_ID: "16", METAKOCKA_SECRET_KEY: "key" };

  it("treats unfilled Claude Desktop placeholders as empty", () => {
    expect(envValue({ X: "${user_config.pdf_dir}" }, "X")).toBeUndefined();
    expect(envValue({ X: " value " }, "X")).toBe("value");
    expect(pdfDirectory({ METAKOCKA_PDF_DIR: "${user_config.pdf_dir}" })).not.toContain("user_config");
    expect(baseUrlFromEnv({ METAKOCKA_BASE_URL: "${user_config.base_url}" })).toBe(DEFAULT_BASE_URL);
  });

  it("normalises METAKOCKA_BASE_URL and reports a bad one as a setup error", () => {
    expect(loadConfig({ ...creds, METAKOCKA_BASE_URL: "10.0.0.15:8080" }).baseUrl).toBe("https://10.0.0.15:8080/rest/eshop/v1");
    expect(() => loadConfig({ ...creds, METAKOCKA_BASE_URL: "ftp://x" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...creds, METAKOCKA_BASE_URL: "ftp://x" })).toThrow(/METAKOCKA_BASE_URL/);
  });

  it("reads the timeout in ms or seconds", () => {
    expect(loadConfig(creds).timeoutMs).toBe(30_000);
    expect(loadConfig({ ...creds, METAKOCKA_TIMEOUT_MS: "5000" }).timeoutMs).toBe(5000);
    expect(loadConfig({ ...creds, METAKOCKA_TIMEOUT_SECONDS: "90" }).timeoutMs).toBe(90_000);
    expect(() => loadConfig({ ...creds, METAKOCKA_TIMEOUT_SECONDS: "soon" })).toThrow(/METAKOCKA_TIMEOUT_SECONDS/);
  });

  it("rejects a bad cache duration on the first tool call, but still starts", () => {
    expect(cacheTtlMs({ METAKOCKA_CACHE_SECONDS: "5 min" })).toBe(300_000);
    expect(cacheTtlMs({ METAKOCKA_CACHE_SECONDS: "0" })).toBe(0);
    expect(() => loadConfig({ ...creds, METAKOCKA_CACHE_SECONDS: "5 min" })).toThrow(/METAKOCKA_CACHE_SECONDS/);
    expect(() => loadConfig({ ...creds, METAKOCKA_CACHE_SECONDS: "-1" })).toThrow(ConfigError);
  });
});
