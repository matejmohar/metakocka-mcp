# Metakocka MCP

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server for
[Metakocka](https://www.metakocka.si), the Slovenian ERP and e-commerce back office.

Connect it to Claude (or any MCP-capable assistant) and ask questions about your business in plain language:

- *"Which customers owe us money, and how long overdue are they?"*
- *"What were our top 10 products last month, compared with August?"*
- *"Do we have enough of ART-1042 in stock in Maribor for an order of 50?"*
- *"Show me sales order PP-18495 and whether it has been invoiced."*
- *"Draft polite payment reminders for the five most overdue customers."*
- *"What do we need to reorder, and what is already on the way?"*
- *"How did our September sales compare with last September, and which customers dropped off?"*

> **Read-only by default.** Out of the box it cannot create, change or delete anything in Metakocka; the only thing it
> writes is a PDF on your own computer, when you ask for one. Creating offers can be turned on: see
> [Creating offers](#creating-offers). It never changes or deletes anything.

> This is an independent community project. It is not made or endorsed by Metakocka d.o.o.

## Slovenščina

Strežnik razume slovenska vprašanja in odgovarja v jeziku, v katerem pišete. Primeri:

- *»Kateri kupci imajo zapadle neplačane račune?«*
- *»Kakšna je zaloga artikla ART-1042 v skladišču Maribor?«*
- *»Pokaži prodajno naročilo PP-18495 in ali je že izdan račun.«*
- *»Pripravi opomine za pet največjih dolžnikov.«*
- *»Pokaži kartico partnerja ACME d.o.o. za zadnje leto.«*
- *»Katere artikle moramo naročiti?«*

Slovenski izrazi (račun, ponudba, dobavnica, dobropis, zaloga, zapadlo …) so preslikani v tipe dokumentov Metakocke,
vir `metakocka://document-types` pa vsebuje tudi vsakdanje izraze. Vsi pozivi (npr. `payment-reminders`,
`month-end-checklist`) imajo izbirni argument `language` (`sl` ali `en`).

## Tools

| Tool | What it does |
|---|---|
| **Documents** | |
| `search_documents` | Find offers, sales orders, invoices, purchase and warehouse documents, work orders. Filter by date, partner tax number, status, unpaid, products. |
| `get_document` | One document in full (line items, totals, payments, linked documents), by id or by its number, e.g. `PP-18495`. Also complaints (reklamacije). |
| `get_document_pdf` | Save an invoice (or any document, given its print-out's report id) as PDF on your computer, as Metakocka prints it. |
| `find_by_tracking_code` | The sales order behind a parcel tracking code, return tracking code or sticker number. |
| `list_search_filters` | Which advanced Metakocka search filters exist for a document type. |
| **Products and stock** | |
| `search_products` | Product catalogue search by name / code, with optional stock per warehouse and price-list prices. |
| `get_product` | One product in full: stock, reserved and free per warehouse, incoming supplier orders, prices, last purchase price, bill of materials. |
| `get_stock` | Stock, reserved and free amounts per product and warehouse. |
| `low_stock` | What to reorder: products out of stock, below safety stock or a minimum, or over-reserved, with incoming orders and a suggested order quantity. |
| `stock_movements` | One product's stock history (goods received, shipped, sold over the counter, transferred) for a period. |
| `stock_valuation` | Estimated stock value per warehouse at last purchase prices, and the most valuable products. |
| `list_warehouses` | All warehouses. |
| **Partners** | |
| `search_partners` | Customers and suppliers by name, tax number, e-mail or phone. |
| `get_partner` | One partner in full, with what they owe us and what we owe them (open, overdue, aging). |
| `partner_statement` | Statement of account: invoices, credit notes and dated payments with a running balance, plus how quickly they pay. |
| **Reports** | |
| `get_unpaid_invoices` | Open receivables (or payables): amounts owed, days overdue, aging buckets, top debtors. |
| `sales_summary` | Revenue for a period, grouped by partner, product, month or document type; optionally for one customer and compared with the previous period or last year. |
| `purchase_summary` | Spending on supplier invoices, with the same grouping, partner filter and comparison. |
| `get_bank_statements` | Money in and out per bank account, top partners, and the individual transactions. |
| **Creating documents** (off unless turned on, see [Creating offers](#creating-offers)) | |
| `draft_document` | Prepare an offer from partners and products that already exist in Metakocka, without saving it. |
| `commit_document` | Save a prepared offer, exactly as prepared, after you confirm it. |
| `discard_draft` | Drop a prepared offer. |

### Prompts

| Prompt | What it does |
|---|---|
| `monthly-sales-report` | Revenue, top customers and products for a month, compared with the month before. |
| `weekly-business-digest` | One page on the past week: sales, new orders, overdue payments, stock to reorder. |
| `month-end-checklist` | Figures and checks for closing a month before handing over to the accountant. |
| `customer-review` | One customer at a glance: revenue vs. last year, payment behaviour, open orders, suggestions. |
| `overdue-invoices` | Who owes money and for how long, with suggested follow-up e-mails. |
| `payment-reminders` | Reminder e-mails per customer, firmer the longer the invoice is overdue. Never sends anything. |
| `stock-check` | Stock for a few products, flagging anything low or out of stock. |

All prompts take an optional `language` (`sl` or `en`). Resources: `metakocka://warehouses` and `metakocka://document-types`.

## Setup

### Quickest: Claude Desktop extension

1. Download `metakocka-mcp-<version>.mcpb` from the [latest release](https://github.com/matejmohar/metakocka-mcp/releases/latest).
2. Double-click it (or drag it into Claude Desktop → Settings → Extensions) and click **Install**.
3. Paste your company ID and secret key (see step 1 below). The key is stored in your system keychain.

Optional settings in the extension: **Metakocka URL** (for an installation other than `main.metakocka.si`, see
[Other Metakocka installations](#other-metakocka-installations)), **CA certificate**, **request timeout**,
**cache duration** and **PDF folder**.

No Node.js or config file needed. To update, download the newer `.mcpb` and open it; it replaces the old version and keeps your settings.

The manual setup below works with any MCP client.

### 1. Get your Metakocka API credentials

In Metakocka, enable API access and copy your **company ID** and **secret key**. Metakocka's step-by-step guide:
[Obtaining API key and company ID](https://metakocka.freshdesk.com/en/support/solutions/articles/3000106126-obtaining-api-key-and-company-id).

Treat the secret key like a password: anyone who has it can read your company's data.

### 2. Add the server to your AI assistant

You need [Node.js](https://nodejs.org) 20 or newer.

**Claude Desktop** — Settings → Developer → Edit Config, and add:

```json
{
  "mcpServers": {
    "metakocka": {
      "command": "npx",
      "args": ["-y", "metakocka-mcp"],
      "env": {
        "METAKOCKA_COMPANY_ID": "your-company-id",
        "METAKOCKA_SECRET_KEY": "your-secret-key"
      }
    }
  }
}
```

Restart Claude Desktop; the Metakocka tools appear under the tools icon.

**Claude Code**

```sh
claude mcp add metakocka \
  -e METAKOCKA_COMPANY_ID=your-company-id \
  -e METAKOCKA_SECRET_KEY=your-secret-key \
  -- npx -y metakocka-mcp
```

**Cursor, VS Code and other MCP clients** — use the same command (`npx -y metakocka-mcp`) and environment variables.

### Check your setup

```sh
npx -y metakocka-mcp --check
```

(with `METAKOCKA_COMPANY_ID` and `METAKOCKA_SECRET_KEY` set) shows which installation it connects to, verifies your
credentials and connection, times a document search, explains what to fix if something is wrong, and tells you if a
newer version exists.

### Configuration

| Variable | Required | Default |
|---|---|---|
| `METAKOCKA_COMPANY_ID` | yes | |
| `METAKOCKA_SECRET_KEY` | yes | |
| `METAKOCKA_BASE_URL` | no | `https://main.metakocka.si/rest/eshop/v1` — see [Other Metakocka installations](#other-metakocka-installations) |
| `NODE_EXTRA_CA_CERTS` | no | CA certificate (PEM file) for an installation with a company or self-signed certificate |
| `METAKOCKA_TIMEOUT_MS` | no | `30000` (or `METAKOCKA_TIMEOUT_SECONDS`) |
| `METAKOCKA_CACHE_SECONDS` | no | `300` — how long warehouses and partner lookups are reused; `0` turns caching off |
| `METAKOCKA_PDF_DIR` | no | `Downloads/Metakocka` — where `get_document_pdf` saves files |
| `METAKOCKA_WRITE` | no | off — `offers` allows creating offers, see [Creating offers](#creating-offers) |
| `METAKOCKA_WRITE_CONFIRM` | no | `client` — you confirm each document in a prompt, or by approving the save in your client; `elicitation` — prompts only; `never` — no confirmation |
| `METAKOCKA_WRITE_TIMEOUT_SECONDS` | no | `120` — how long to wait for Metakocka to save a document |
| `METAKOCKA_WRITE_LOG` | no | `~/.metakocka-mcp/writes.jsonl` — audit log of every write |

### Other Metakocka installations

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

### Running as an HTTP server

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

## Creating offers

Off by default. Turn it on with `METAKOCKA_WRITE=offers`, or **Allow creating offers** in the Claude Desktop extension.
Claude can then create offers (ponudbe, also used as predračuni): *"Pripravi ponudbo za ACME za 10 ur svetovanja."*

Strict rules, enforced by the server rather than left to the assistant:

- **Only links, never creates.** The partner and its address are sent to Metakocka by their ids, and every product
  line by the product's id. If the partner or a product doesn't exist yet, nothing happens: add it in Metakocka first.
  (Sent with names or addresses instead, Metakocka would silently create a new partner when it can't match one.)
- **Prices and VAT come from Metakocka.** Each product's price and tax code are taken from its price list. A product
  without a clear sales price in EUR, or with more than one tax code, can't be used until it is fixed in Metakocka.
  You can still set a price or discount for a line.
- **Draft first, then save.** `draft_document` checks everything and returns a summary; nothing is saved yet.
  `commit_document` saves exactly that draft and nothing else, at most once. Drafts expire after 15 minutes.
- **You confirm every offer** in your client before it is saved:
  - in a confirmation prompt, where the client supports them (MCP elicitation);
  - otherwise (Claude Desktop, Claude Code) by approving the `commit_document` call: the approval prompt shows the
    offer's summary, and the server saves only if that summary is exactly the draft's. **Don't choose "Always allow"
    for `commit_document`**, or there is no prompt left to confirm in.

  `METAKOCKA_WRITE_CONFIRM=elicitation` accepts only confirmation prompts (clients without them can't save);
  `never` saves without asking (or turn off **Confirm each document** in the extension).
- **Never saved twice.** Saving is never retried automatically. If Metakocka doesn't answer, the result says the
  outcome is unknown, and the next attempt first looks for the offer in Metakocka.
- **Checked afterwards.** The saved offer is read back and compared with what you confirmed; any difference is
  reported.
- **Logged.** Every attempt and its outcome is appended to `~/.metakocka-mcp/writes.jsonl` (`METAKOCKA_WRITE_LOG`),
  without the secret key. Each offer also carries `metakocka-mcp <draft id>` in Metakocka's change log.

Not supported yet: foreign partners, partners with category discounts, currencies other than EUR, and lines that aren't
products (Metakocka's API has no description-only lines). Nothing can be changed or deleted.

In HTTP mode, writing also requires `METAKOCKA_HTTP_TOKEN`; drafts are kept per company and key.

## How it works

- Every request goes directly from your computer to Metakocka's API. Nothing passes through a third-party server.
- Requests are sent one at a time (Metakocka processes searches per company sequentially anyway) and
  retried automatically on network errors and temporary server errors. Warehouses and partner lookups are cached
  for a few minutes, and long reports send progress updates to clients that show them.
- Responses are trimmed to the useful fields and numbers/dates are normalised, so the assistant uses less context
  and makes fewer mistakes. The report tools (`get_unpaid_invoices`, `sales_summary`, `purchase_summary`,
  `stock_valuation`) also return typed structured output, for clients that build charts or tables from it.
- Dates are `YYYY-MM-DD` in the Europe/Ljubljana time zone.
- The secret key is never included in error messages.

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
  write/          creating documents: drafts, catalogue, offer rules, saving and checking, audit log
  prompts.ts      MCP prompts
  resources.ts    MCP resources
  installation.ts which Metakocka installation to use: URL normalisation and checks
  config.ts       settings from environment variables
  doctor.ts       `--check`
  server.ts       createServer() — shared by stdio and HTTP
  http.ts         `--http`: Streamable HTTP server with per-request credentials
  index.ts        the `metakocka-mcp` command
```

### Releasing

```sh
npm version minor      # bumps package.json, manifest.json and src/version.ts, commits and tags
git push --follow-tags # the Release workflow builds the .mcpb, creates the GitHub release, publishes to npm
```

Only push the tag when you want to release: the Release workflow then creates a GitHub release with the `.mcpb`.
Publishing to npm needs an `NPM_TOKEN` repository secret; without it that step is skipped with a notice. npm provenance
is added automatically once the repository is public.

The **Live API check** workflow runs `npm run test:live` every morning against a real Metakocka company, to catch API
changes on Metakocka's side. It needs the `METAKOCKA_COMPANY_ID` and `METAKOCKA_SECRET_KEY` repository secrets (use a
test company); without them it is skipped. To run it against another installation, set the `METAKOCKA_BASE_URL`
repository variable.

Metakocka's API reference: [github.com/metakocka/metakocka_api_base](https://github.com/metakocka/metakocka_api_base).

## Roadmap

- [x] Read-only tools for documents, products, stock, partners, receivables and sales
- [x] One-click Claude Desktop extension (`.mcpb`)
- [x] Partner detail and statements, product detail, low stock, stock movements and valuation, purchase summary, period comparison
- [x] Opt-in creation of offers, linked only to existing partners and products, confirmed by the user
- [ ] Invoices, sales orders and order status changes
- [x] PDF export of invoices, bank statements, payment dates, tracking codes, live API check
- [x] Any Metakocka installation (own domain, internal host or IP), HTTP server mode, structured report output
- [ ] Hosted version: connect from Claude or ChatGPT without installing anything

## Need help?

Setup, custom automations around Metakocka, or a hosted version for your company:
get in touch at [martej.com](https://martej.com).

## License

[MIT](LICENSE)
