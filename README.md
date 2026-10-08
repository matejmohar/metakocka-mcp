# Metakocka MCP

[![npm](https://img.shields.io/npm/v/metakocka-mcp)](https://www.npmjs.com/package/metakocka-mcp)
[![CI](https://github.com/matejmohar/metakocka-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/matejmohar/metakocka-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

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
- *"How much money is on our bank accounts, and what's in the cash register?"*
- *"Prepare September's export for the accountant."*

> **Read-only by default.** Out of the box it cannot create, change or delete anything in Metakocka; the only things it
> writes are PDFs and accounting exports on your own computer, when you ask for one. Writing can be turned on per area —
> documents, payments, changes to orders, partners and products, shipping, complaints, messages to customers — and every
> write is confirmed by you: see [Creating documents](#creating-documents). It never deletes anything.

> This is an independent community project. It is not made or endorsed by Metakocka d.o.o.

## Slovenščina

Strežnik razume slovenska vprašanja in odgovarja v jeziku, v katerem pišete. Primeri:

- *»Kateri kupci imajo zapadle neplačane račune?«*
- *»Kakšna je zaloga artikla ART-1042 v skladišču Maribor?«*
- *»Pokaži prodajno naročilo PP-18495 in ali je že izdan račun.«*
- *»Pripravi opomine za pet največjih dolžnikov.«*
- *»Pokaži kartico partnerja ACME d.o.o. za zadnje leto.«*
- *»Katere artikle moramo naročiti?«*
- *»Koliko denarja imamo na računih in koliko v blagajni?«*
- *»Pripravi izvoz za računovodstvo za september.«*

Slovenski izrazi (račun, ponudba, dobavnica, dobropis, zaloga, zapadlo …) so preslikani v tipe dokumentov Metakocke,
vir `metakocka://document-types` pa vsebuje tudi vsakdanje izraze. Vsi pozivi (npr. `payment-reminders`,
`month-end-checklist`) imajo izbirni argument `language` (`sl` ali `en`).

## Setup

### Quickest: Claude Desktop extension

1. Download `metakocka-mcp-<version>.mcpb` from the [latest release](https://github.com/matejmohar/metakocka-mcp/releases/latest).
2. Double-click it (or drag it into Claude Desktop → Settings → Extensions) and click **Install**.
3. Paste your company ID and secret key (see step 1 below). The key is stored in your system keychain.

Optional settings in the extension: **Metakocka URL** (for an installation other than `main.metakocka.si`, see
[Other Metakocka installations](https://github.com/matejmohar/metakocka-mcp/blob/main/docs/installations.md)), **CA certificate**, **request timeout**,
**cache duration** and **PDF folder**.

No Node.js or config file needed. To update, download the newer `.mcpb` and open it; it replaces the old version and keeps your settings.

The manual setup below works with any MCP client.

### 1. Get your Metakocka API credentials

In Metakocka, enable API access and copy your **company ID** and **secret key**. Metakocka's step-by-step guide:
[Obtaining API key and company ID](https://metakocka.freshdesk.com/en/support/solutions/articles/3000106126-obtaining-api-key-and-company-id).

Treat the secret key like a password: anyone who has it can read your company's data.

### 2. Add the server to your AI assistant

You need [Node.js](https://nodejs.org) 22 or newer.

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
credentials and connection, shows the request limits in use, times a document search, explains what to fix if something
is wrong, and tells you if a newer version exists:

```
metakocka-mcp 0.10.0
  ✓ Node.js 22.11.0
  ✓ Installation: main.metakocka.si (public)
  ✓ Credentials found (company ID 1234)
  ✓ Requests at once: 2, of which searches: 1
  ✓ Connected to main.metakocka.si (3 warehouses visible)
  ✓ Document search works (640 ms)
  ✓ Up to date

All good — the server is ready to use.
```

## What it can do

41 tools in five areas, plus prompts for recurring reports:

- **Documents:** find and read offers, orders, invoices, warehouse documents and complaints; save PDFs; look up parcels by tracking code.
- **Products and stock:** catalogue, stock per warehouse, what to reorder, stock history and value.
- **Partners and money:** customers and suppliers, what they owe, statements of account, bank balances and statements, cash register.
- **Reports:** unpaid invoices, sales and purchase summaries with period comparison, the export for your accountant.
- **Writing** (off by default): drafts of documents, payments and other changes, saved only after you confirm.

<details>
<summary>All tools, prompts and resources</summary>

| Tool | What it does |
|---|---|
| **Documents** | |
| `search_documents` | Find offers, sales orders, invoices, purchase and warehouse documents, work orders. Filter by date, partner tax number, status, unpaid, products. |
| `get_document` | One document in full (line items, totals, payments, linked documents), by id or by its number, e.g. `PP-18495`. Also complaints (reklamacije). |
| `get_document_pdf` | Save an invoice (or any document, given its print-out's report id) as PDF on your computer, as Metakocka prints it, or get a download link valid for a day. Long print-outs are printed in the background. |
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
| `get_external_stock` | Stock kept in an external ERP (Navision, Vasco), less today's invoices and credit notes in Metakocka. |
| **Web-shop orders** | |
| `get_messages` | SMS, Viber and WhatsApp threads with customers, for one order or every thread with a reply since a date. |
| `get_proof_of_delivery` | The delivery service's proof of delivery for an order's parcel, saved as a file. |
| `get_delivery_prices` | Delivery price lists per delivery type and package weight. |
| `check_blacklist` | Whether a customer is on the company's blacklist (črna lista), by e-mail, phone or name. |
| `get_email_events` | Whether e-mails sent through Metakocka were delivered, opened, clicked or bounced. |
| **Partners** | |
| `search_partners` | Customers and suppliers by name, tax number, e-mail or phone. |
| `get_partner` | One partner in full, with what they owe us and what we owe them (open, overdue, aging). |
| `partner_statement` | Statement of account: invoices, credit notes and dated payments with a running balance, plus how quickly they pay. |
| **Reports** | |
| `get_unpaid_invoices` | Open receivables (or payables): amounts owed, days overdue, aging buckets, top debtors. |
| `sales_summary` | Revenue for a period, grouped by partner, product, month or document type; optionally for one customer and compared with the previous period or last year. |
| `purchase_summary` | Spending on supplier invoices, with the same grouping, partner filter and comparison. |
| `get_bank_balances` | How much is on each bank account, from its last statement, and how old that statement is. |
| `get_bank_statements` | Money in and out per bank account, top partners, and the individual transactions. |
| `get_cash_register` | Cash register journals (blagajna): opening and closing cash, receipts, expenses and deposits to the bank. |
| `get_compensations` | Compensations (kompenzacije): which of our invoices and the partner's were settled against each other. |
| `accounting_export` | The export for the accountant (izvoz v računovodstvo), run with your export profiles from Metakocka and saved as a ZIP. |
| **Writing** (off unless turned on, see [Creating documents](#creating-documents)); every `draft_*` tool only prepares | |
| `draft_document` | An offer, sales order, invoice, prepayment invoice or received invoice from partners and products that already exist in Metakocka. |
| `draft_credit_note` | A credit note (dobropis) to an invoice: returned goods, a financial correction, or standalone. |
| `draft_stock_document` | A purchase order, packing list, delivery or receiving order, goods received note, transfer between warehouses or work order. |
| `draft_partner` / `draft_product` | A new partner or product that isn't in Metakocka yet. |
| `draft_partner_update` / `draft_product_update` | A change to a partner's data, or to a product (e.g. its price or safety stock). |
| `draft_payment` | A payment on an existing invoice, offer or order (mark it paid, a supplier paid, a prepayment or a refund). |
| `draft_update` | A change Metakocka's API allows on an existing order (status, tracking code, shipping date, invoicing it), invoice (status) or warehouse document. |
| `draft_shipping` | Delivery labels, marking orders shipped, or a group expedition. |
| `draft_complaint` | A complaint, return or replacement for an order, or a complaint's new status. |
| `draft_message` | An SMS, Viber, WhatsApp or e-mail to a customer. |
| `commit_document` | Save (or send) a draft, exactly as prepared, after you confirm it. |
| `discard_draft` | Drop a draft. |

#### Prompts

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

</details>

## Creating documents

Off by default. Turn it on per area with `METAKOCKA_WRITE` (comma-separated), or the matching **Allow …** settings in
the Claude Desktop extension:

| Value | Lets Claude |
|---|---|
| `offers` | create offers |
| `orders` | create sales orders and invoices from them; change an order (status, tracking code, shipping date, have Metakocka invoice it) |
| `invoices` | create invoices and prepayment invoices; change an invoice's status |
| `credit_notes` | create credit notes to invoices, and enter suppliers' credit notes |
| `purchase_invoices` | enter received invoices |
| `purchase_orders` | create purchase orders |
| `warehouse` | create packing lists, goods received notes, delivery and receiving orders, transfers and work orders; change them |
| `partners` / `products` | add missing partners / products, and change existing ones |
| `payments` | record payments on invoices, offers and orders |
| `shipping` | print delivery labels, mark orders shipped, make group expeditions |
| `complaints` | create complaints, returns and replacements, and change their status |
| `messages` | send SMS, Viber, WhatsApp and e-mail to customers |

The rules are enforced by the server, not left to the assistant:

- **Draft first, then save.** Every `draft_*` tool only prepares and checks; `commit_document` saves exactly that draft, at most once, after you confirm it in your client. **Don't choose "Always allow" for `commit_document`.**
- **Only links, never creates.** Partners and products are linked by their ids; nothing new is created unless you allow `partners` / `products` and confirm it.
- **Prices and VAT come from Metakocka's price lists**, and invoices are saved not issued, for you to check and issue.
- **Never saved twice, checked afterwards, logged.** Saving is never retried blindly, the saved document is read back and compared, and every write goes to `~/.metakocka-mcp/writes.jsonl`.
- **Nothing is deleted.**

Everything per document type (invoices, received invoices, payments, orders, credit notes, foreign partners and
currencies, shipping, messages): **[docs/writing.md](https://github.com/matejmohar/metakocka-mcp/blob/main/docs/writing.md)**.

## Configuration

| Variable | Required | Default |
|---|---|---|
| `METAKOCKA_COMPANY_ID` | yes | |
| `METAKOCKA_SECRET_KEY` | yes | |
| `METAKOCKA_BASE_URL` | no | `https://main.metakocka.si/rest/eshop/v1` — see [Other Metakocka installations](https://github.com/matejmohar/metakocka-mcp/blob/main/docs/installations.md) |
| `NODE_EXTRA_CA_CERTS` | no | CA certificate (PEM file) for an installation with a company or self-signed certificate |
| `METAKOCKA_TIMEOUT_MS` | no | `30000` (or `METAKOCKA_TIMEOUT_SECONDS`) |
| `METAKOCKA_MAX_CONCURRENT` | no | `2` — requests sent to Metakocka at the same time, of any kind |
| `METAKOCKA_MAX_CONCURRENT_SEARCH` | no | `1` — searches at the same time (document, product and stock lists, bank statements, exports); never more than `METAKOCKA_MAX_CONCURRENT` |
| `METAKOCKA_QUEUE_TIMEOUT_SECONDS` | no | `300` — how long a request waits for a free slot before it fails |
| `METAKOCKA_CACHE_SECONDS` | no | `300` — how long warehouses and partner lookups are reused; `0` turns caching off |
| `METAKOCKA_PDF_DIR` | no | `Downloads/Metakocka` — where `get_document_pdf`, `get_proof_of_delivery` and `accounting_export` save files |
| `METAKOCKA_USER_EMAIL` | no | E-mail of a Metakocka user, which `check_blacklist` and `draft_complaint` send when Metakocka asks who is making the call |
| `METAKOCKA_WRITE` | no | off — comma-separated `offers`, `orders`, `invoices`, `credit_notes`, `purchase_invoices`, `purchase_orders`, `warehouse`, `partners`, `products`, `payments`, `shipping`, `complaints`, `messages`, see [Creating documents](#creating-documents) |
| `METAKOCKA_WRITE_CONFIRM` | no | `client` — you confirm each document in a prompt, or by approving the save in your client; `elicitation` — prompts only; `never` — no confirmation |
| `METAKOCKA_WRITE_TIMEOUT_SECONDS` | no | `120` — how long to wait for Metakocka to save a document |
| `METAKOCKA_WRITE_LOG` | no | `~/.metakocka-mcp/writes.jsonl` — audit log of every write |

More: [Other Metakocka installations](https://github.com/matejmohar/metakocka-mcp/blob/main/docs/installations.md) (own domain, internal network, self-signed
certificates) · [Running as an HTTP server](https://github.com/matejmohar/metakocka-mcp/blob/main/docs/http-server.md) (one server for a team).

## Troubleshooting

Start with `npx -y metakocka-mcp --check`: it names the problem and what to fix.

- **The tools don't show up in Claude Desktop.** Quit Claude Desktop completely and open it again; check that the
  config file is valid JSON. Settings → Developer shows the server's status and its log.
- **`npx` not found, or "Node.js is too old".** Install Node.js 22 or newer. If you use nvm or similar, Claude Desktop
  may not see it: put the full path to `npx` in `"command"`, or use the `.mcpb` extension, which needs no Node.js.
- **Still on an old version.** `npx` may use a cached copy: use `npx -y metakocka-mcp@latest`, or open the newer `.mcpb`.
- **Large reports time out.** Ask for shorter periods, or raise `METAKOCKA_TIMEOUT_MS` (the extension's request timeout).
- **No `draft_*` tools.** Writing is off by default; see [Creating documents](#creating-documents).

Anything else: [open an issue](https://github.com/matejmohar/metakocka-mcp/issues).

## How it works

- Every request goes directly from your computer to Metakocka's API. Nothing passes through a third-party server run
  by this project.
- **What the assistant sees:** the results of the tools it calls (documents, partners, amounts) go to your AI provider
  (e.g. Anthropic for Claude) as part of the conversation, like anything else you paste into a chat. Their data and
  retention policies apply, so check them, and your company's rules, before connecting company data.
- At most 2 requests go to Metakocka at once, and only 1 of them can be a search (Metakocka processes searches per
  company sequentially anyway, and a large one can slow the installation down). Lookups by ID and saving documents
  don't wait behind a running search. Change the limits with `METAKOCKA_MAX_CONCURRENT` and
  `METAKOCKA_MAX_CONCURRENT_SEARCH`; in HTTP mode they apply per company. Requests are
  retried automatically on network errors and temporary server errors. Warehouses and partner lookups are cached
  for a few minutes, and long reports send progress updates to clients that show them.
- Responses are trimmed to the useful fields and numbers/dates are normalised, so the assistant uses less context
  and makes fewer mistakes. The report tools (`get_unpaid_invoices`, `sales_summary`, `purchase_summary`,
  `stock_valuation`) also return typed structured output, for clients that build charts or tables from it.
- Dates are `YYYY-MM-DD` in the Europe/Ljubljana time zone.
- The secret key is never included in error messages.

## Roadmap

- [x] Read-only tools for documents, products, stock, partners, receivables and sales
- [x] One-click Claude Desktop extension (`.mcpb`)
- [x] Partner detail and statements, product detail, low stock, stock movements and valuation, purchase summary, period comparison
- [x] Opt-in creation of offers, linked only to existing partners and products, confirmed by the user
- [x] Opt-in creation of invoices (domestic and foreign, also from an offer), saved not issued
- [x] Opt-in entry of received invoices from the supplier's invoice, with its PDF attached
- [x] Opt-in adding of missing partners and products, checked for duplicates
- [x] Opt-in sales orders and order changes (status, tracking code, shipping date), payments, credit notes, warehouse documents, shipping, complaints and messages
- [x] PDF export of invoices, bank statements, payment dates, tracking codes, live API check
- [x] Any Metakocka installation (own domain, internal host or IP), HTTP server mode, structured report output
- [ ] Hosted version: connect from Claude or ChatGPT without installing anything

What changed in each version: [releases](https://github.com/matejmohar/metakocka-mcp/releases).

## Contributing

Development setup, project layout and how releases work: [CONTRIBUTING.md](https://github.com/matejmohar/metakocka-mcp/blob/main/CONTRIBUTING.md).

## Need help?

Setup, custom automations around Metakocka, or a hosted version for your company:
get in touch at [martej.com](https://martej.com).

## License

[MIT](LICENSE)
