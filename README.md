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

## Tools

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

## Creating documents

Off by default, and turned on per area with `METAKOCKA_WRITE` (comma-separated) or the matching **Allow …** settings in
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

For example, Claude can create:

- offers (ponudbe, also used as predračuni): *"Pripravi ponudbo za ACME za 10 ur svetovanja."*
- sales orders (prodajna naročila): *"Vnesi naročilo ACME št. PO-77 za 20 kosov, dobava do 20. 10."*
- invoices (računi), domestic and foreign: *"Naredi račun za ACME za 3 ure svetovanja."*,
  *"Izstavi račun iz ponudbe 4/2026."*, *"Izstavi račun za naročilo 1/2026."* (with `orders` on too)
- received invoices (prejeti računi), domestic and foreign, copied from the supplier's invoice:
  *"Vnesi ta račun od Avanta."* (with the PDF)

and change documents that already exist:

- payments (`payments`): *"ACME je plačal RD-2/2026."*, *"Avantu smo plačali račun 126-039951."*, a prepayment
  (avans) on an offer or order, or a refund
- an order, invoice or warehouse document (`orders`, `invoices`, `warehouse`): *"Naročilo PP-18495 je odpremljeno."*
- a partner or product (`partners`, `products`): *"Dvigni ceno artikla ART-1 na 12 €."*, *"Varnostna zaloga za ART-1 naj bo 20."*

and act for you:

- credit notes (`credit_notes`): *"Kupec je vrnil 2 kosa z računa RD-7/2026."*, *"Vnesi dobropis od Avanta."* (with the PDF)
- warehouse (`warehouse`, `purchase_orders`): *"Naredi dobavnico za naročilo 3/2026."*, *"Naroči 50 škatel pri dobavitelju X."*
- shipping (`shipping`): *"Natisni nalepke za današnja naročila."*
- complaints (`complaints`): *"Kupec vrača naročilo PP-1, paket je poškodovan."*
- messages (`messages`): *"Pošlji kupcu SMS, da je paket na poti."* — sent right away, can't be recalled

Strict rules, enforced by the server rather than left to the assistant:

- **Only links, never creates.** The partner and its address are sent to Metakocka by their ids, and every product
  line by the product's id. If the partner or a product doesn't exist yet, nothing happens: add it in Metakocka first.
  (Sent with names or addresses instead, Metakocka would silently create a new partner when it can't match one.)
- **Prices and VAT come from Metakocka.** Each product's price and tax code are taken from its price list. A product
  without a clear sales price in EUR, or with more than one tax code, can't be used until it is fixed in Metakocka.
  You can still set a price or discount for a line.
- **Draft first, then save.** `draft_document` checks everything and returns a summary; nothing is saved yet.
  `commit_document` saves exactly that draft and nothing else, at most once. Drafts expire after 15 minutes.
- **You confirm every document** in your client before it is saved:
  - in a confirmation prompt, where the client supports them (MCP elicitation);
  - otherwise (Claude Desktop, Claude Code) by approving the `commit_document` call: the approval prompt shows the
    document's summary, and the server saves only if that summary is exactly the draft's. **Don't choose "Always allow"
    for `commit_document`**, or there is no prompt left to confirm in.

  `METAKOCKA_WRITE_CONFIRM=elicitation` accepts only confirmation prompts (clients without them can't save);
  `never` saves without asking (or turn off **Confirm each document** in the extension).
- **Never saved twice.** Saving is never retried automatically. If Metakocka doesn't answer, the result says the
  outcome is unknown, and the next attempt first looks for the document in Metakocka.
- **Checked afterwards.** The saved document is read back and compared with what you confirmed; any difference is
  reported.
- **Logged.** Every attempt and its outcome is appended to `~/.metakocka-mcp/writes.jsonl` (`METAKOCKA_WRITE_LOG`),
  without the secret key. Each document also carries `metakocka-mcp <draft id>` in Metakocka's change log.

Invoices in particular:

- **Saved not issued.** An invoice is saved in Metakocka as not yet issued (not printed): check it there and issue it
  yourself. It moves no stock (no packing list is made).
- **From an offer.** *From offer 4/2026* takes the offer's partner and its lines exactly as they are on the offer, and
  links the invoice to it. If the offer already has an invoice, the draft says so.
- **Payment term from the partner.** Unless you give one, the due date follows the partner's payment term in Metakocka,
  or else the term of its last invoice (e.g. 14 days). With neither, Claude asks you.
- **Service date** is the invoice date unless you give a date or a period (e.g. 1.–30. 9.).
- **Foreign invoices** (`sales_bill_foreign`, for partners marked foreign in Metakocka) take only lines without VAT
  (reverse charge, export). The VAT note is copied from the partner's last foreign invoice unless you give one; the
  summary shows it.

Received invoices in particular:

- **Copied from the supplier's invoice, and checked.** Claude reads the supplier's invoice (e.g. the PDF you give it)
  and passes its number, dates, total and every line with its net price, VAT rate and text. The lines must add up to
  the invoice's total to the cent, or nothing is drafted.
- **Booked to products marked for purchasing**, usually the one the supplier's earlier invoices use. The VAT rate is
  mapped to the tax code the supplier's earlier invoices or the catalogue use for it.
- **Never twice.** An invoice number already entered for that supplier is refused (Metakocka itself would accept it).
- **Negative lines** (credits, e.g. unused time) can't be sent through Metakocka's API. They are left out, listed in
  the invoice's note and in the summary, for you to add by hand.
- **Stock receipt.** Saving makes the receipt (prevzemnica), as Metakocka's own form does.
- **Payment term** as on the invoice, else from the supplier (its term in Metakocka or its last invoice).
- **The PDF is attached** to the invoice in Metakocka when Claude passes its path (only when the server runs on your
  computer, not in HTTP mode).

New partners and products (`partners`, `products`):

- **Only when you agree.** Documents still link only to existing records. When a supplier or product is missing, Claude
  asks whether to add it, drafts it (a supplier's data copied from its invoice), you confirm it, and then the document
  is drafted with it.
- **No duplicates.** A partner with the same tax number (with or without the SI prefix) or name, or a product with the
  same code or name, is refused; similar names are shown in the summary.
- **Partners can't be deleted through Metakocka's API**, only in Metakocka itself. Products can be.
- New products get no price list: give the price on the document.

Payments in particular:

- **Never more than is open.** The amount defaults to what is still open on the document (for a refund: what was paid)
  and can't be more. An invoice paid in full is refused.
- **Payment type** as on the document's earlier payments, else the one most used on the latest documents of its type
  (usually *Transakcijski račun*). Metakocka refuses a type that isn't in its register.
- **Checked twice.** If the document's paid amount changed since the draft (e.g. someone entered the payment in
  Metakocka meanwhile), nothing is saved. After saving, the paid amount must have moved by exactly the payment.

Sales orders in particular:

- **Like offers**: the partner, address and products by id, prices from the price list, plus the customer's order number,
  delivery date and delivery type. A different **receiver** (prejemnik) is an existing partner, sent in full with its id
  (Metakocka would otherwise take the buyer, or create a new partner). Metakocka silently leaves out a delivery type it
  doesn't know, so the draft checks it against the types in use and the saved order is read back.
- **Invoice from an order.** *From order 1/2026* takes the order's partner and lines and links the invoice to it.
- **Status** must be one of the company's own statuses (Šifranti → Prodajna naročila - status), spelled exactly. The API
  can't list them; the statuses on existing orders are offered as hints.
- **Tracking code** only once the order has an invoice (Metakocka's rule).
- **create_invoice** lets Metakocka make the invoice by the company's order settings (its type, numbering, and possibly a
  packing list), not by this server's checks. To control the invoice, draft it *from order* instead.

Credit notes, warehouse documents and other changes in particular:

- **Credit notes** are saved not issued and can't credit more than their invoice; returned goods are credited at the
  invoice's prices, a financial credit note takes only services. A supplier's credit note is copied as printed (its
  number, date, lines with VAT, checked against its total) and refused if already entered; for returned goods Metakocka
  also makes a goods received note.

Foreign partners and currencies:

- **Foreign partners** can get offers, orders, invoices and prepayment invoices. Lines carry no VAT by default (reverse
  charge, export: the catalogue's 0 % tax code); a line's `vat_percent` charges VAT. The draft warns when a
  VAT-registered foreign business is charged VAT, or a foreign private person isn't. An invoice without VAT takes the
  VAT note of the partner's last foreign invoice unless one is given.
- **Other currencies** (`currency`, e.g. USD) on sales documents, received invoices and credit notes: price lists are in
  EUR, so every price is given. A document made from another one takes its currency; payments are in the document's.
- **Stock**: packing lists take goods out of stock, goods received notes and confirmed transfers put them in; the
  summary says so.
- **Changes** show every old and new value in the summary, send only what changes, and are read back afterwards.
- **Labels** register parcels with the delivery service. If the call doesn't answer, the orders' tracking codes are
  checked before anything is printed again.
- **Messages** are sent the moment you confirm and can't be recalled; a call that doesn't answer is never repeated
  automatically. Check e-mails with `get_email_events`. E-mails can carry Metakocka documents as PDF (e.g. the invoice)
  and, when the server runs on your computer, files from it; the audit log keeps only their names and sizes.

Partner discounts: a partner's discounts per product category (popusti partnerja) apply to lines priced from the price
list — the best matching category, replacing the price list's own discount only where Metakocka marks the partner
discount so. Lines with a price given by hand get none, and the draft says when one would have applied.

Not supported yet: products with tiered or several prices when changing a price.
Lines must be products (Metakocka's API has no description-only lines). Only the fields Metakocka's API allows can be
changed, and nothing can be deleted.

In HTTP mode, writing also requires `METAKOCKA_HTTP_TOKEN`; drafts are kept per company and key.

## How it works

- Every request goes directly from your computer to Metakocka's API. Nothing passes through a third-party server.
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

### Releasing

```sh
npm version minor --no-git-tag-version # bumps package.json, manifest.json and src/version.ts
```

Commit that and get it onto `main` (directly or through a pull request). On every push to `main`, the Release workflow
checks whether the version in `package.json` has a GitHub release yet; if not, it runs the tests, builds the `.mcpb`,
tags the commit `v<version>`, creates the GitHub release and publishes to npm. Pushing a `v*` tag yourself
(`npm version minor && git push --follow-tags`) still works, and a version that is already released is skipped.
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
- [x] Opt-in creation of invoices (domestic and foreign, also from an offer), saved not issued
- [x] Opt-in entry of received invoices from the supplier's invoice, with its PDF attached
- [x] Opt-in adding of missing partners and products, checked for duplicates
- [ ] Sales orders and order status changes
- [x] PDF export of invoices, bank statements, payment dates, tracking codes, live API check
- [x] Any Metakocka installation (own domain, internal host or IP), HTTP server mode, structured report output
- [ ] Hosted version: connect from Claude or ChatGPT without installing anything

## Need help?

Setup, custom automations around Metakocka, or a hosted version for your company:
get in touch at [martej.com](https://martej.com).

## License

[MIT](LICENSE)
