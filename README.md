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

> **Read-only.** This version cannot create, change or delete anything in Metakocka.

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
| `get_document` | One document in full (line items, totals, payments, linked documents), by id or by its number, e.g. `PP-18495`. |
| `list_search_filters` | Which advanced Metakocka search filters exist for a document type. |
| **Products and stock** | |
| `search_products` | Product catalogue search by name / code, with optional stock per warehouse and price-list prices. |
| `get_product` | One product in full: stock, reserved and free per warehouse, incoming supplier orders, prices, last purchase price, bill of materials. |
| `get_stock` | Stock, reserved and free amounts per product and warehouse. |
| `low_stock` | What to reorder: products out of stock, below safety stock or a minimum, or over-reserved, with incoming orders and a suggested order quantity. |
| `stock_movements` | One product's stock history (goods received, shipped, transferred) for a period. |
| `stock_valuation` | Estimated stock value per warehouse at last purchase prices, and the most valuable products. |
| `list_warehouses` | All warehouses. |
| **Partners** | |
| `search_partners` | Customers and suppliers by name, tax number, e-mail or phone. |
| `get_partner` | One partner in full, with what they owe us and what we owe them (open, overdue, aging). |
| `partner_statement` | Statement of account: every invoice and credit note in a period with a running open balance. |
| **Reports** | |
| `get_unpaid_invoices` | Open receivables (or payables): amounts owed, days overdue, aging buckets, top debtors. |
| `sales_summary` | Revenue for a period, grouped by partner, product, month or document type; optionally compared with the previous period or last year. |
| `purchase_summary` | Spending on supplier invoices, with the same grouping and comparison. |

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

(with `METAKOCKA_COMPANY_ID` and `METAKOCKA_SECRET_KEY` set) verifies your credentials and connection, explains what to fix
if something is wrong, and tells you if a newer version exists.

### Configuration

| Variable | Required | Default |
|---|---|---|
| `METAKOCKA_COMPANY_ID` | yes | |
| `METAKOCKA_SECRET_KEY` | yes | |
| `METAKOCKA_BASE_URL` | no | `https://main.metakocka.si/rest/eshop/v1` |
| `METAKOCKA_TIMEOUT_MS` | no | `30000` |

## How it works

- Every request goes directly from your computer to Metakocka's API. Nothing passes through a third-party server.
- Requests are sent one at a time (Metakocka processes searches per company sequentially anyway) and
  retried automatically on network errors and temporary server errors.
- Responses are trimmed to the useful fields and numbers/dates are normalised, so the assistant uses less context
  and makes fewer mistakes.
- Dates are `YYYY-MM-DD` in the Europe/Ljubljana time zone.
- The secret key is never included in error messages.

## Development

```sh
npm install
npm test            # unit + end-to-end tests against a fake Metakocka API
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
  analytics.ts    aging, sales, period comparison and partner statement calculations
  inventory.ts    low stock, stock valuation and stock movement calculations
  tools/          MCP tool definitions
  prompts.ts      MCP prompts
  resources.ts    MCP resources
  server.ts       createServer() — reusable for stdio and (later) HTTP hosting
  index.ts        stdio entry point (the `metakocka-mcp` command)
```

### Releasing

```sh
npm version minor      # bumps package.json, manifest.json and src/version.ts, commits and tags
git push --follow-tags # the Release workflow builds the .mcpb, creates the GitHub release, publishes to npm
```

npm publishing needs an `NPM_TOKEN` repository secret; without it the workflow still publishes the `.mcpb`.

Metakocka's API reference: [github.com/metakocka/metakocka_api_base](https://github.com/metakocka/metakocka_api_base).

## Roadmap

- [x] Read-only tools for documents, products, stock, partners, receivables and sales
- [x] One-click Claude Desktop extension (`.mcpb`)
- [x] Partner detail and statements, product detail, low stock, stock movements and valuation, purchase summary, period comparison
- [ ] Opt-in write tools (create offers and sales orders, change order status) with previews before anything is saved
- [ ] PDF export of documents
- [ ] Hosted version: connect from Claude or ChatGPT without installing anything

## Need help?

Setup, custom automations around Metakocka, or a hosted version for your company:
get in touch at [martej.com](https://martej.com).

## License

[MIT](LICENSE)
