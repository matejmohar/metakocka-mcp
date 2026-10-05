# Metakocka MCP

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server for
[Metakocka](https://www.metakocka.si), the Slovenian ERP and e-commerce back office.

Connect it to Claude (or any MCP-capable assistant) and ask questions about your business in plain language:

- *"Which customers owe us money, and how long overdue are they?"*
- *"What were our top 10 products last month, compared with August?"*
- *"Do we have enough of ART-1042 in stock in Maribor for an order of 50?"*
- *"Show me sales order PP-18495 and whether it has been invoiced."*
- *"Draft polite payment reminders for the five most overdue customers."*

> **Read-only.** This version cannot create, change or delete anything in Metakocka.

> This is an independent community project. It is not made or endorsed by Metakocka d.o.o.

## Tools

| Tool | What it does |
|---|---|
| `search_documents` | Find offers, sales orders, invoices, purchase and warehouse documents, work orders. Filter by date, partner tax number, status, unpaid, products. |
| `get_document` | One document in full (line items, totals, payments, linked documents), by id or by its number, e.g. `PP-18495`. |
| `list_search_filters` | Which advanced Metakocka search filters exist for a document type. |
| `search_products` | Product catalogue search by name / code, with optional stock per warehouse and price-list prices. |
| `get_stock` | Stock, reserved and free amounts per product and warehouse. |
| `list_warehouses` | All warehouses. |
| `search_partners` | Customers and suppliers by name, tax number, e-mail or phone. |
| `get_unpaid_invoices` | Open receivables (or payables): amounts owed, days overdue, aging buckets, top debtors. |
| `sales_summary` | Revenue for a period, grouped by partner, product, month or document type. |

There are also three ready-made prompts (`monthly-sales-report`, `overdue-invoices`, `stock-check`) and two
resources (`metakocka://warehouses`, `metakocka://document-types`).

## Setup

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
```

Project layout:

```
src/
  client.ts       HTTP client: auth, retries, timeouts, error handling
  api.ts          Metakocka operations (search, get_document, product_list, …)
  summarize.ts    raw Metakocka records → compact, typed objects
  analytics.ts    aging and sales calculations
  tools/          MCP tool definitions
  prompts.ts      MCP prompts
  resources.ts    MCP resources
  server.ts       createServer() — reusable for stdio and (later) HTTP hosting
  index.ts        stdio entry point (the `metakocka-mcp` command)
```

Metakocka's API reference: [github.com/metakocka/metakocka_api_base](https://github.com/metakocka/metakocka_api_base).

## Roadmap

- [x] Read-only tools for documents, products, stock, partners, receivables and sales
- [ ] One-click Claude Desktop extension (`.mcpb`)
- [ ] Opt-in write tools (create offers and sales orders, change order status) with previews before anything is saved
- [ ] PDF export of documents
- [ ] Hosted version: connect from Claude or ChatGPT without installing anything

## Need help?

Setup, custom automations around Metakocka, or a hosted version for your company:
get in touch at [martej.com](https://martej.com).

## License

[MIT](LICENSE)
