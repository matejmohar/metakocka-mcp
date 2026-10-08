# Creating documents and other changes

[← Back to README](https://github.com/matejmohar/metakocka-mcp/blob/main/README.md)

Writing to Metakocka is off by default, and turned on per area with `METAKOCKA_WRITE` (comma-separated) or the matching **Allow …** settings in
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
