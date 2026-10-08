# Contributing

Issues and pull requests are welcome. Metakocka's API reference: [github.com/metakocka/metakocka_api_base](https://github.com/metakocka/metakocka_api_base).

## Development

```sh
npm install
npm test            # unit + end-to-end tests against a fake Metakocka API
npm run test:live   # read-only checks against your real Metakocka company (credentials from .env)
npm run typecheck
npm run build
npm run inspect     # open the MCP Inspector against the built server
npm run doctor      # check credentials from your local .env file (copy .env.example to .env first)
npm run pack:mcpb   # build release/metakocka-mcp-<version>.mcpb
```

Project layout:

```
src/
  client.ts       HTTP client: auth, retries, timeouts, error handling
  api.ts          Metakocka operations (search, get_document, product_list, …)
  summarize.ts    raw Metakocka records → compact, typed objects
  cache.ts        short-lived cache for warehouses and partner lookups
  analytics.ts    aging, sales, period comparison, partner statement and payment calculations
  inventory.ts    low stock, stock valuation and stock movement calculations
  bank.ts         bank statement calculations
  tools/          MCP tool definitions
  write/          creating documents and register entries: drafts, rules per document, saving, audit log
  prompts.ts      MCP prompts
  resources.ts    MCP resources
  installation.ts which Metakocka installation to use: URL normalisation and checks
  config.ts       settings from environment variables
  doctor.ts       `--check`
  server.ts       createServer() — shared by stdio and HTTP
  http.ts         `--http`: Streamable HTTP server with per-request credentials
  index.ts        the `metakocka-mcp` command
```

## Releasing

```sh
npm version minor --no-git-tag-version # bumps package.json, manifest.json and src/version.ts
```

Commit that and get it onto `main` (directly or through a pull request). On every push to `main`, the Release workflow
checks whether the version in `package.json` is on GitHub releases and on npm yet; if not, it runs the tests, builds
the `.mcpb`, tags the commit `v<version>`, creates the GitHub release and publishes to npm. Pushing a `v*` tag yourself
(`npm version minor && git push --follow-tags`) still works, and a version that is already released is skipped.

Publishing to npm uses [trusted publishing](https://docs.npmjs.com/trusted-publishers): no npm token, the workflow
signs in with its GitHub identity. On npmjs.com, the package's Settings → Trusted publishing must list GitHub Actions
with `matejmohar/metakocka-mcp` and the workflow `release.yml`. npm adds provenance on its own once the repository is
public.

The **Live API check** workflow runs `npm run test:live` every morning against a real Metakocka company, to catch API
changes on Metakocka's side. It needs the `METAKOCKA_COMPANY_ID` and `METAKOCKA_SECRET_KEY` repository secrets (use a
test company); without them it is skipped. To run it against another installation, set the `METAKOCKA_BASE_URL`
repository variable.
