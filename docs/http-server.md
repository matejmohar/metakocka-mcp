# Running as an HTTP server

[← Back to README](https://github.com/matejmohar/metakocka-mcp/blob/main/README.md)

For a team, run one server and connect to it over HTTP instead of installing it on every computer:

```sh
npx -y metakocka-mcp --http --port 3000
```

The MCP endpoint is `http://127.0.0.1:3000/mcp` (`/health` answers health checks). Each client sends its own
credentials in the `X-Metakocka-Company-Id` and `X-Metakocka-Secret-Key` headers, so one server can serve several
companies, each with its own request queue and cache. The installation is set on the server (`METAKOCKA_BASE_URL`);
clients can't change it. In HTTP mode `get_document_pdf` returns the PDF inside the tool result instead of saving it on
the server.

| Variable | Default |
|---|---|
| `METAKOCKA_HTTP_PORT` / `--port` | `3000` |
| `METAKOCKA_HTTP_HOST` / `--host` | `127.0.0.1` (this computer only). Use `0.0.0.0` to accept connections from other computers |
| `METAKOCKA_HTTP_TOKEN` | Require `Authorization: Bearer <token>` on every request. Requests with the token but without credential headers use the server's own `METAKOCKA_COMPANY_ID` / `METAKOCKA_SECRET_KEY`, which are never used without a token |
| `METAKOCKA_HTTP_ALLOWED_HOSTS` | Comma-separated host names clients connect with. On `127.0.0.1` only `localhost` names are accepted, which protects against DNS rebinding |

The server speaks plain HTTP. When other computers connect to it, put it behind a reverse proxy that terminates TLS,
because secret keys travel in the request headers.

Writing (`METAKOCKA_WRITE`) in HTTP mode also requires `METAKOCKA_HTTP_TOKEN`; drafts are kept per company and key.
