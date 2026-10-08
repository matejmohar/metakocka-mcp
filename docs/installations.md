# Other Metakocka installations

[← Back to README](https://github.com/matejmohar/metakocka-mcp/blob/main/README.md)

By default the server talks to the public installation, `main.metakocka.si`. To use another one (a test or development
installation, or one on your company's own domain, internal network or IP address), set `METAKOCKA_BASE_URL`, or
**Metakocka URL** in the Claude Desktop extension. Any of these work:

| You enter | Used as |
|---|---|
| *(empty)* | `https://main.metakocka.si/rest/eshop/v1` |
| `https://erp.example.com` | `https://erp.example.com/rest/eshop/v1` |
| `http://10.0.0.15:8080` | `http://10.0.0.15:8080/rest/eshop/v1` |
| `192.168.1.20` | `https://192.168.1.20/rest/eshop/v1` |
| `https://intranet.example.com/mk/rest/eshop/v1` | used as is |

- Without `http://` or `https://`, HTTPS is used. Plain HTTP must be written out; `--check` warns about it, because the
  secret key is then sent unencrypted.
- Without a path, `/rest/eshop/v1` is added. A path you enter is kept as is.
- If the installation uses a company or self-signed TLS certificate, point `NODE_EXTRA_CA_CERTS` (or the extension's
  **CA certificate** setting) to the CA certificate in PEM format, and restart.
- When the server is not connected to `main.metakocka.si`, it tells the assistant which installation it is using, so
  data from a test installation is not presented as your real figures.

`npx -y metakocka-mcp --check` tells you if the address is wrong, the host can't be found or refuses the connection,
the certificate isn't trusted, or the address answers with a web page instead of the API.
