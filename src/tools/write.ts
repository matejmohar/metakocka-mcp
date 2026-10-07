/**
 * Opt-in tools that write to Metakocka (METAKOCKA_WRITE), each turned on by its own permission:
 * - new documents: offers, sales orders, invoices, prepayment invoices and received invoices (draft_document),
 *   credit notes (draft_credit_note), purchase orders and warehouse documents (draft_stock_document);
 * - register entries: new partners and products (draft_partner / draft_product) and changes to them
 *   (draft_partner_update / draft_product_update);
 * - changes to existing documents: payments (draft_payment), fields Metakocka lets change (draft_update);
 * - shipping (draft_shipping), complaints (draft_complaint) and messages to customers (draft_message).
 * Each draft_* tool builds and checks the change without saving it;
 * commit_document saves exactly that draft, after the user confirms it in
 * their client (see WriteSettings.confirm); discard_draft drops it.
 */
import { inputRequired, inputResponse, type McpServer, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { todayInLjubljana } from "../dates.js";
import { describeInstallation } from "../installation.js";
import { commitDraft, resolveUnknown } from "../write/commit.js";
import { DraftStore, type Draft } from "../write/drafts.js";
import { createJournal, type Journal } from "../write/journal.js";
import { DraftError, sameSummary } from "../write/document.js";
import { buildInvoiceDraft, type InvoiceInfo, type InvoiceInput } from "../write/invoice.js";
import { buildOfferDraft, buildOrderDraft, type OfferInput, type OrderInput } from "../write/offer.js";
import { buildPaymentDraft, PAYABLE_TYPES, type PaymentInput } from "../write/payment.js";
import { buildComplaintDraft, CLAIM_TYPES, type ComplaintInput } from "../write/complaint.js";
import { buildCreditNoteDraft, type CreditNoteInput } from "../write/creditnote.js";
import { buildMessageDraft, CHANNELS, type MessageInput } from "../write/message.js";
import { buildPartnerUpdateDraft, buildProductUpdateDraft } from "../write/recordupdate.js";
import { buildShippingDraft, type ShippingInput } from "../write/shipping.js";
import { buildStockDocDraft, type StockDocInput, type StockDocType } from "../write/stockdocs.js";
import { buildUpdateDraft, INVOICE_UPDATE_TYPES, ORDER_UPDATE_TYPES, WAREHOUSE_UPDATE_TYPES, type UpdateInput } from "../write/update.js";
import { envValue } from "../config.js";
import { buildPurchaseDraft, type PurchaseInfo, type PurchaseInput } from "../write/purchase.js";
import { buildPartnerDraft, buildProductDraft } from "../write/records.js";
import { INVOICE_TYPES, PURCHASE_TYPES, type WritableDocType, type WriteSettings } from "../write/settings.js";

/** What draft_document makes; the other new documents have their own tools. */
const SALES_DOCUMENT_TYPES: readonly WritableDocType[] = [
  "sales_offer",
  "sales_order",
  "sales_bill_domestic",
  "sales_bill_foreign",
  "sales_bill_prepaid",
  "purchase_bill_domestic",
  "purchase_bill_foreign",
];
const STOCK_DOCUMENT_TYPES: readonly StockDocType[] = [
  "purchase_order",
  "warehouse_packing_list",
  "warehouse_delivery_note",
  "warehouse_receiving_note",
  "warehouse_acceptance_note",
  "transfer_order",
  "workorder",
];
import { compact } from "../util.js";
import { run, type ToolContext } from "./shared.js";

export interface WriteContext {
  settings: WriteSettings;
  /** Must outlive a single server instance: create it once per process (stdio) or per tenant (HTTP). */
  drafts: DraftStore;
  journal: Journal;
  /** Whether draft_document may read files on this machine (attachments); never for the HTTP server. */
  localFiles?: boolean;
}

export function createWriteContext(settings: WriteSettings, options: { logToStderr?: boolean; localFiles?: boolean } = {}): WriteContext {
  return {
    settings,
    drafts: new DraftStore(),
    journal: createJournal(options.logToStderr ? undefined : settings.logPath),
    localFiles: options.localFiles ?? false,
  };
}

const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

const NEXT_STEP: Record<WriteSettings["confirm"], string> = {
  elicitation: "Show the summary to the user. To save it, call commit_document with this draft_id; the user confirms it in their client.",
  client:
    "Show the summary to the user. To save it, call commit_document with this draft_id and confirm_summary set to the summary, " +
    "copied exactly; the user approves that call in their client.",
  never: "Show the summary to the user and get their agreement, then call commit_document with this draft_id.",
};

const COMMIT_CONFIRMATION: Record<WriteSettings["confirm"], string> = {
  elicitation: "The user is asked to confirm in their client first. ",
  client:
    "Pass confirm_summary: the draft's summary, copied exactly (it is checked). The user confirms in their client, " +
    "either in a confirmation prompt or by approving this call. ",
  never: "",
};

export function registerWriteTools(server: McpServer, ctx: ToolContext, write: WriteContext): void {
  const { settings, drafts, journal } = write;

  const has = (t: WritableDocType) => settings.docTypes.includes(t);
  const documentTypes = settings.docTypes.filter((t) => SALES_DOCUMENT_TYPES.includes(t));
  const prepaid = has("sales_bill_prepaid");
  const partners = settings.docTypes.includes("partner");
  const products = settings.docTypes.includes("product");
  const payments = settings.docTypes.includes("payment");
  const orders = settings.docTypes.includes("sales_order");
  const offers = settings.docTypes.includes("sales_offer");
  const invoices = settings.docTypes.some((t) => INVOICE_TYPES.includes(t));
  const purchases = settings.docTypes.some((t) => PURCHASE_TYPES.includes(t));
  const what = [
    offers && "an offer (ponudba / predračun)",
    orders && "a sales order (prodajno naročilo)",
    invoices && "an invoice (račun, domestic or foreign)",
    purchases && "a received invoice (prejeti račun) from a supplier's invoice",
  ].filter(Boolean);
  const docTypeHelp = [
    offers && "sales_offer = ponudba (also used as predračun)",
    orders && "sales_order = prodajno naročilo",
    invoices && "sales_bill_domestic = račun for a domestic partner, sales_bill_foreign = tuji račun for a foreign partner",
    prepaid && "sales_bill_prepaid = avansni račun (prepayment invoice, domestic partners)",
    purchases && "purchase_bill_domestic / purchase_bill_foreign = prejeti račun from a domestic / foreign supplier",
  ].filter(Boolean).join("; ");
  const forDates = [invoices && "Invoices", purchases && "purchase invoices"].filter(Boolean).join(" and ");

  /** Where a missing partner or product sends the user, depending on what may be added here. */
  const missingHint = (error: unknown) => {
    if (!(error instanceof DraftError)) return error;
    let message = error.message;
    if (partners && /never creates partners/.test(message)) message += " Or, if the user agrees, add it with draft_partner (data from the document) and then draft this again.";
    if (products && /never creates products/.test(message)) message += " Or, if the user agrees, add it with draft_product and then draft this again.";
    return message === error.message ? error : new DraftError(message);
  };

  if (documentTypes.length) server.registerTool(
    "draft_document",
    {
      title: `Draft a document (${[offers && "offer", orders && "sales order", invoices && "invoice", purchases && "received invoice"].filter(Boolean).join(", ")})`,
      description:
        `Prepare ${what.join(", or ")} in Metakocka WITHOUT saving it. Everything is linked to records that ` +
        "already exist: the partner by its id (from search_partners) and products by their id (from search_products). " +
        "This tool never creates partners or products; if one is missing, tell the user to add it in Metakocka. " +
        (offers || orders || invoices
          ? `${purchases ? `On ${[offers && "offers", orders && "orders", invoices && "invoices"].filter(Boolean).join(" and ")}, prices` : "Prices"} and VAT come from Metakocka's price list unless a price is given. `
          : "") +
        (orders
          ? "A sales order can carry the customer's own order number (buyer_order), a delivery date, a delivery type and " +
            "another existing partner as receiver (prejemnik); a missing receiver is added with draft_partner first, never made up. "
          : "") +
        (invoices
          ? "Invoices are saved NOT issued: the user checks and issues (prints) them in Metakocka; they move no stock. " +
            `An invoice can also be made from an offer (from_offer: its lines, partner and a link to it)${orders ? " or a sales order (from_order)" : ""}. The payment term ` +
            "comes from the partner (its term in Metakocka, else its last invoice) unless given. Foreign invoices take only " +
            "lines without VAT and, unless a note is given, the VAT note of the partner's last foreign invoice. "
          : "") +
        (purchases
          ? "Received invoices are copied from the supplier's invoice (e.g. a PDF the user gave you): supplier_invoice_number, " +
            "invoice_date, invoice_total and every line with its net unit price, vat_percent and description. Book each line to " +
            "a product marked for purchasing — the one the supplier's earlier invoices use (search_documents). Give a credit " +
            "line as a negative price: Metakocka's API can't take it, so it is left out and the user adds it by hand. The lines " +
            "must add up to invoice_total. Saving also makes the stock receipt (prevzemnica). Pass attachment_path to attach " +
            "the supplier's PDF. An invoice number already entered for that supplier is refused. "
          : "") +
        "Returns a draft_id and a summary: show the summary to the user, then call commit_document with the draft_id to save it. " +
        "Drafts expire after 15 minutes.",
      inputSchema: z.object({
        doc_type: z.enum(documentTypes as [string, ...string[]]).describe(`${docTypeHelp}.`),
        partner_id: z
          .string()
          .min(1)
          .optional()
          .describe(`The partner's Metakocka id (mk_id, the \`id\` from search_partners).${invoices ? ` With from_offer${orders ? " / from_order" : ""} it can be left out.` : ""}`),
        address_id: z
          .string()
          .optional()
          .describe("Id of one of the partner's addresses (from get_partner). Needed only when the partner has several."),
        lines: z
          .array(
            z.object({
              product_id: z.string().optional().describe("Product's Metakocka id (the `id` from search_products)."),
              code: z.string().optional().describe("Exact product code (šifra), instead of product_id."),
              quantity: z.number().positive().max(1_000_000).optional(),
              price: z
                .number()
                .min(purchases ? -10_000_000 : 0)
                .max(10_000_000)
                .optional()
                .describe(
                  "Net unit price in EUR; default: the product's price list." + (purchases ? " Purchase invoices: as on the invoice, required; negative for a credit line." : ""),
                ),
              discount_percent: z.number().min(0).max(100).optional(),
              vat_percent: z
                .number()
                .min(0)
                .max(100)
                .optional()
                .describe(
                  "VAT rate of the line. Sales documents: default the price list's, and 0 (reverse charge, export) for foreign partners; " +
                    "give it to charge another rate." +
                    (purchases ? " Purchase invoices: required, as on the invoice (e.g. 22, 9.5, 0)." : ""),
                ),
              ...(purchases
                ? { description: z.string().max(200).optional().describe("Purchase invoices: the line's text on the invoice (e.g. a period or domain).") }
                : {}),
            }),
          )
          .min(1)
          .max(50)
          .optional(),
        ...(offers || orders || invoices ? { title: z.string().max(100).optional().describe("Document title (naziv).") } : {}),
        note: z.string().max(1000).optional().describe("Note on the document."),
        ...(offers ? { valid_days: z.number().int().min(1).max(365).optional().describe("Offers: how many days the offer is valid (default 30).") } : {}),
        ...(invoices ? { from_offer: z.string().min(1).optional().describe("Invoices: number of the offer to invoice (e.g. \"4/2026\"), instead of lines.") } : {}),
        ...(invoices && orders ? { from_order: z.string().min(1).optional().describe("Invoices: number of the sales order to invoice, instead of lines.") } : {}),
        ...(orders
          ? {
              buyer_order: z.string().max(30).optional().describe("Sales orders: the customer's own order number (naročilo kupca)."),
              receiver_partner_id: z.string().optional().describe("Sales orders: deliver to another existing partner (prejemnik), by id from search_partners."),
              receiver_address_id: z.string().optional().describe("Sales orders: that receiver's address, when it has several."),
              delivery_type: z.string().max(100).optional().describe("Sales orders: delivery type (način dostave) as in Metakocka, e.g. GLS."),
              delivery_date: z.string().optional().describe("Sales orders: delivery deadline (rok dobave), YYYY-MM-DD."),
            }
          : {}),
        ...(invoices || purchases
          ? {
              service_from: z.string().optional().describe(`${forDates}: first day of the service period (YYYY-MM-DD), if it is a period.`),
              service_to: z.string().optional().describe(`${forDates}: service date or last day of the period (YYYY-MM-DD).`),
              due_days: z.number().int().min(0).max(365).optional().describe(`${forDates}: payment term in days; default: from the partner.`),
              due_date: z.string().optional().describe(`${forDates}: due date (YYYY-MM-DD), instead of due_days.`),
            }
          : {}),
        ...(purchases
          ? {
              supplier_invoice_number: z.string().min(1).max(100).optional().describe("Purchase invoices: the invoice number as printed on the supplier's invoice."),
              invoice_date: z.string().optional().describe("Purchase invoices: the date on the supplier's invoice (YYYY-MM-DD)."),
              received_date: z.string().optional().describe("Purchase invoices: when it was received (YYYY-MM-DD); default invoice_date."),
              invoice_total: z.number().optional().describe("Purchase invoices: the total with VAT as printed on the invoice, credit lines included."),
              attachment_path: z.string().optional().describe("Purchase invoices: absolute path of the supplier's invoice file (PDF), attached once saved."),
            }
          : {}),
        currency: z.string().length(3).optional().describe("ISO currency, e.g. USD, GBP; default EUR (or the offer's / order's). Price lists are in EUR, so other currencies need every price."),
        language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const client = ctx.getClient();
        const installation = describeInstallation(client.baseUrl);
        const buildCtx = {
          client,
          cache: ctx.cache,
          drafts,
          today: todayInLjubljana(ctx.now()),
          installation: installation.isDefault ? undefined : installation.host,
        };
        const a = args as Record<string, unknown> & { doc_type: string; lines?: Record<string, unknown>[] };
        const kind = a.doc_type === "sales_offer" ? "offer" : a.doc_type === "sales_order" ? "order" : a.doc_type.startsWith("sales_bill_") ? "invoice" : "purchase";
        // Fields that belong to other kinds of documents are refused rather than silently ignored.
        const allowed: Record<string, readonly string[]> = {
          valid_days: ["offer"],
          title: ["offer", "order", "invoice"],
          from_offer: ["invoice"],
          from_order: ["invoice"],
          buyer_order: ["order"],
          receiver_partner_id: ["order"],
          receiver_address_id: ["order"],
          delivery_type: ["order"],
          delivery_date: ["order"],
          service_from: ["invoice", "purchase"],
          service_to: ["invoice", "purchase"],
          due_days: ["invoice", "purchase"],
          due_date: ["invoice", "purchase"],
          supplier_invoice_number: ["purchase"],
          invoice_date: ["purchase"],
          received_date: ["purchase"],
          invoice_total: ["purchase"],
          attachment_path: ["purchase"],
        };
        const misplaced = Object.keys(allowed).filter((k) => a[k] !== undefined && !allowed[k]!.includes(kind));
        if (kind !== "purchase" && a.lines?.some((l) => l.description !== undefined)) misplaced.push("lines[].description");
        if (misplaced.length) throw new DraftError(`${misplaced.join(", ")}: not for ${a.doc_type}.`);

        let built: { draft: Draft; warnings: string[]; info?: InvoiceInfo | PurchaseInfo };
        try {
          if (kind === "offer") {
            if (!a.partner_id) throw new DraftError("Give partner_id (from search_partners).");
            built = await buildOfferDraft(buildCtx, { ...(a as unknown as OfferInput), lines: (a.lines ?? []) as OfferInput["lines"] });
          } else if (kind === "order") {
            if (!a.partner_id) throw new DraftError("Give partner_id (from search_partners).");
            built = await buildOrderDraft(buildCtx, { ...(a as unknown as OrderInput), lines: (a.lines ?? []) as OrderInput["lines"] });
          } else if (kind === "invoice") {
            built = await buildInvoiceDraft(buildCtx, a as unknown as InvoiceInput);
          } else {
            built = await buildPurchaseDraft({ ...buildCtx, localFiles: write.localFiles === true }, a as unknown as PurchaseInput);
          }
        } catch (error) {
          throw missingHint(error);
        }
        const { draft, warnings, info } = built;
        return compact({
          draft_id: draft.id,
          expires_at: new Date(draft.expiresAt).toISOString(),
          summary: draft.summary,
          partner: draft.partner,
          lines: draft.lines.map((l) => ({ product_id: l.productId, code: l.code, name: l.name, quantity: l.quantity, unit: l.unit, price: l.price, discount_percent: l.discountPercent, vat_percent: l.taxRatePercent, net: l.net, total: l.gross })),
          totals: draft.totals,
          ...info,
          warnings,
          next: NEXT_STEP[settings.confirm],
        });
      }),
  );

  const recordContext = () => {
    const client = ctx.getClient();
    const installation = describeInstallation(client.baseUrl);
    return { client, cache: ctx.cache, drafts, today: todayInLjubljana(ctx.now()), installation: installation.isDefault ? undefined : installation.host };
  };
  const recordAnswer = ({ draft, warnings }: { draft: Draft; warnings: string[] }) =>
    compact({ draft_id: draft.id, expires_at: new Date(draft.expiresAt).toISOString(), summary: draft.summary, warnings, next: NEXT_STEP[settings.confirm] });
  /** A drafted document's answer: also its lines and totals. */
  const withLines = ({ draft, warnings }: { draft: Draft; warnings: string[] }) =>
    compact({
      draft_id: draft.id,
      expires_at: new Date(draft.expiresAt).toISOString(),
      summary: draft.summary,
      partner: draft.partner,
      lines: draft.lines.map((l) => ({ product_id: l.productId, code: l.code, name: l.name, quantity: l.quantity, unit: l.unit, price: l.price, vat_percent: l.taxRatePercent, total: l.gross })),
      totals: draft.totals,
      warnings,
      next: NEXT_STEP[settings.confirm],
    });

  if (partners) {
    server.registerTool(
      "draft_partner",
      {
        title: "Draft a new partner",
        description:
          "Prepare a new partner (supplier or customer) for Metakocka WITHOUT saving it — only when the user agrees to add one " +
          "that search_partners doesn't find. Copy its data from its documents (e.g. the supplier's invoice): name, address, " +
          "tax number, whether it is a company and VAT registered. A partner with the same tax number is refused; similar names " +
          "are shown. Partners can't be deleted through the API, so get this right. Returns a draft_id and a summary: show it, " +
          "then commit_document; the answer has the new partner's id and address_id.",
        inputSchema: z.object({
          name: z.string().min(1).max(100).describe("Name as on its documents (naziv)."),
          street: z.string().min(1).max(150),
          post_number: z.string().min(1).max(20),
          city: z.string().min(1).max(100),
          country: z.string().max(50).optional().describe('Country name, e.g. "Slovenija" (default), "Ireland".'),
          tax_id: z.string().max(50).optional().describe("Tax / VAT number (davčna številka), e.g. SI12345678; required for a company."),
          registration_number: z.string().max(50).optional().describe("Registration number (matična številka), if on its documents."),
          business_entity: z.boolean().describe("true for a company or s.p., false for a private person."),
          taxpayer: z.boolean().describe("VAT registered (davčni zavezanec), e.g. its tax number starts with SI / the invoice charges VAT as a VAT payer."),
          role: z.enum(["supplier", "buyer", "both"]).describe("supplier (dobavitelj), buyer (kupec) or both."),
          email: z.string().max(255).optional(),
          language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => run(async () => recordAnswer(await buildPartnerDraft(recordContext(), args))),
    );
  }

  if (products) {
    server.registerTool(
      "draft_product",
      {
        title: "Draft a new product",
        description:
          "Prepare a new product (artikel) for Metakocka WITHOUT saving it — only when the user agrees to add one that " +
          "search_products doesn't find, e.g. to book a received invoice's line to. A product with the same code or name is " +
          "refused; similar ones are shown, so prefer an existing general product (e.g. one for equipment) when it fits. " +
          "No price list is made. Returns a draft_id and a summary: show it, then commit_document; the answer has the new product's id.",
        inputSchema: z.object({
          name: z.string().min(1).max(200).describe("Product name (naziv artikla)."),
          code: z.string().min(1).max(20).describe("Short unique code (šifra), in the style of the existing codes."),
          unit: z.string().min(1).max(20).describe('Unit from Metakocka\'s register, e.g. "kos", "ura", "mesec", "kpl".'),
          service: z.boolean().describe("true for a service, false for goods (blago)."),
          purchasing: z.boolean().optional().describe("Used on received invoices (nabavni)."),
          sales: z.boolean().optional().describe("Used on offers and invoices (prodajni)."),
          description: z.string().max(700).optional().describe("Longer description (dodatni opis)."),
          language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => run(async () => recordAnswer(await buildProductDraft(recordContext(), args))),
    );
  }

  if (payments) {
    server.registerTool(
      "draft_payment",
      {
        title: "Draft a payment",
        description:
          "Prepare a payment on a document that already exists in Metakocka WITHOUT saving it: a customer paid an invoice " +
          "(mark it paid), we paid a supplier's invoice, a prepayment (avans) on an offer or sales order, or a refund. " +
          "Identify the document by its number (search_documents) and type. The amount defaults to everything still open; " +
          "it can't be more than that. The payment type defaults to the one the company's earlier payments use (usually " +
          "\"Transakcijski račun\" for a bank transfer). Check the bank statement (get_bank_statements) first when the user " +
          "isn't sure the money came in. Returns a draft_id and a summary: show it, then commit_document.",
        inputSchema: z.object({
          doc_type: z.enum(PAYABLE_TYPES).describe("Type of the paid document, e.g. sales_bill_domestic (izdani račun), purchase_bill_domestic (prejeti račun)."),
          number: z.string().min(1).optional().describe("Document number as shown in Metakocka, e.g. \"RD-2/2026\"."),
          id: z.string().min(1).optional().describe("Or the document's Metakocka id."),
          amount: z.number().positive().max(100_000_000).optional().describe("Amount in the document's currency; default: everything still open (for a refund: everything paid)."),
          date: z.string().optional().describe("When it was paid, YYYY-MM-DD; default today."),
          mode: z.enum(["payment", "prepayment", "return"]).default("payment").describe("payment (plačilo), prepayment (avans, on offers and orders) or return (vračilo)."),
          payment_type: z.string().max(100).optional().describe('As in Metakocka, e.g. "Transakcijski račun", "Gotovina", "Kartica"; default: the usual one.'),
          cash_register: z.string().max(100).optional().describe("Cash payments with several cash registers: which one."),
          note: z.string().max(100).optional(),
          language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => run(async () => recordAnswer(await buildPaymentDraft(recordContext(), args as PaymentInput))),
    );
  }

  if (partners) {
    server.registerTool(
      "draft_partner_update",
      {
        title: "Draft a change to a partner",
        description:
          "Prepare a change to an existing partner's data WITHOUT saving it: name, address, tax or registration number, VAT " +
          "status, role. Only the fields given change; the summary shows old and new values. Returns a draft_id and a summary: " +
          "show it, then commit_document.",
        inputSchema: z.object({
          partner_id: z.string().min(1).describe("The partner's Metakocka id (from search_partners)."),
          name: z.string().max(100).optional(),
          street: z.string().max(150).optional(),
          post_number: z.string().max(20).optional(),
          city: z.string().max(100).optional(),
          country: z.string().max(50).optional(),
          tax_id: z.string().max(50).optional(),
          registration_number: z.string().max(50).optional(),
          taxpayer: z.boolean().optional().describe("VAT registered (davčni zavezanec)."),
          role: z.enum(["supplier", "buyer", "both"]).optional(),
          language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => run(async () => recordAnswer(await buildPartnerUpdateDraft(recordContext(), args))),
    );
  }

  if (products) {
    server.registerTool(
      "draft_product_update",
      {
        title: "Draft a change to a product",
        description:
          "Prepare a change to an existing product WITHOUT saving it: name, description, unit, barcode, active, sales / " +
          "purchasing, safety stock (varnostna zaloga), minimum order quantity, weight, or its sales price (only when it has " +
          "one untiered sales price in EUR). Only the fields given change. Returns a draft_id and a summary: show it, then commit_document.",
        inputSchema: z.object({
          product_id: z.string().min(1).describe("The product's Metakocka id (from search_products)."),
          name: z.string().max(200).optional(),
          description: z.string().max(700).optional().describe('Longer description; "" removes it.'),
          unit: z.string().max(20).optional(),
          barcode: z.string().max(50).optional().describe('"" removes it.'),
          active: z.boolean().optional(),
          sales: z.boolean().optional(),
          purchasing: z.boolean().optional(),
          safety_stock: z.number().min(0).optional(),
          minimal_order_quantity: z.number().min(0).optional(),
          weight_kg: z.number().min(0).optional(),
          price: z.number().min(0).optional().describe("New net sales price in EUR."),
          language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => run(async () => recordAnswer(await buildProductUpdateDraft(recordContext(), args))),
    );
  }

  if (has("sales_bill_credit_note")) {
    server.registerTool(
      "draft_credit_note",
      {
        title: "Draft a credit note",
        description:
          "Prepare a credit note WITHOUT saving it: one we issue (dobropis, side sales) or one a supplier sent (prejeti " +
          "dobropis, side purchase: copied from their document with supplier_number, credit_note_date, credit_note_total and " +
          "every line's price and vat_percent). goods = returned goods, credited at the invoice's prices (all its lines, or " +
          "the ones given with smaller quantities); financial = a discount or correction afterwards, on service products; " +
          "standalone = not linked to an invoice. Our credit notes are saved not issued; none can credit more than its " +
          "invoice. Returns a draft_id and a summary: show it, then commit_document.",
        inputSchema: z.object({
          side: z.enum(["sales", "purchase"]).default("sales").describe("sales: we credit a customer; purchase: a supplier's credit note to us."),
          credit_type: z.enum(["goods", "financial", "standalone"]),
          from_invoice: z.string().min(1).optional().describe("goods / financial: number of the invoice it credits (for purchase: the supplier's invoice number, as entered)."),
          supplier_number: z.string().max(100).optional().describe("Purchase: the number printed on the supplier's credit note."),
          credit_note_date: z.string().optional().describe("Purchase: the date on it (YYYY-MM-DD), default today."),
          credit_note_total: z.number().optional().describe("Purchase: its total with VAT as printed, checked against the lines."),
          currency: z.string().length(3).optional().describe("Standalone: ISO currency, default EUR; linked credit notes take the invoice's."),
          partner_id: z.string().min(1).optional().describe("standalone: the partner's id."),
          address_id: z.string().optional(),
          lines: z
            .array(
              z.object({
                product_id: z.string().optional(),
                code: z.string().optional(),
                quantity: z.number().positive().optional(),
                price: z.number().min(0).optional().describe("financial / standalone: net unit price; default the price list (purchase: required)."),
                discount_percent: z.number().min(0).max(100).optional(),
                vat_percent: z.number().min(0).max(100).optional().describe("VAT rate; default the price list's (0 for foreign partners); purchase: required."),
              }),
            )
            .max(50)
            .optional()
            .describe("goods: which invoice lines and how many (default all); financial / standalone: the lines."),
          due_days: z.number().int().min(0).max(365).optional(),
          due_date: z.string().optional(),
          note: z.string().max(1000).optional(),
          language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => run(async () => withLines(await buildCreditNoteDraft(recordContext(), args as CreditNoteInput))),
    );
  }

  const stockTypes = STOCK_DOCUMENT_TYPES.filter((t) => has(t));
  if (stockTypes.length) {
    server.registerTool(
      "draft_stock_document",
      {
        title: "Draft a purchase or warehouse document",
        description:
          "Prepare WITHOUT saving it: " +
          [
            has("purchase_order") && "a purchase order to a supplier (naročilnica: purchasing products with price and vat_percent)",
            has("warehouse_packing_list") &&
              "a packing list (dobavnica, takes goods out of stock) or delivery order (nalog za odpremo) to a customer, from lines or from_order; " +
                "a goods received note (prevzemnica, puts goods into stock) or receiving order (nalog za prevzem) from a supplier, from lines " +
                "(with price and vat_percent) or from_purchase_order; a transfer between warehouses (transfer_order, confirm moves the stock); " +
                "a work order (delovni nalog: its head, e.g. from_order)",
          ]
            .filter(Boolean)
            .join("; ") +
          ". Partners and products by id, as for draft_document. Returns a draft_id and a summary: show it, then commit_document.",
        inputSchema: z.object({
          doc_type: z.enum(stockTypes as [StockDocType, ...StockDocType[]]),
          partner_id: z.string().min(1).optional(),
          address_id: z.string().optional(),
          lines: z
            .array(
              z.object({
                product_id: z.string().optional(),
                code: z.string().optional(),
                quantity: z.number().positive().max(1_000_000).optional(),
                price: z.number().min(0).optional().describe("Net unit price; required for purchase-side documents."),
                discount_percent: z.number().min(0).max(100).optional(),
                vat_percent: z.number().min(0).max(100).optional().describe("Purchase-side documents: the VAT rate."),
              }),
            )
            .max(100)
            .optional(),
          warehouse: z.string().optional().describe("Warehouse name, mark or id; for a transfer the source."),
          to_warehouse: z.string().optional().describe("Transfers: the target warehouse."),
          confirm: z.boolean().optional().describe("Transfers: confirm at once (moves the stock)."),
          from_order: z.string().optional().describe("Packing lists, delivery orders, work orders: the sales order's number."),
          from_purchase_order: z.string().optional().describe("Goods received notes, receiving orders: the purchase order's number."),
          supplier_document: z.string().max(50).optional().describe("Goods received notes: the supplier's delivery note number."),
          currency: z.string().length(3).optional().describe("ISO currency, default EUR (or the source document's); other currencies need every price."),
          delivery_date: z.string().optional().describe("Purchase orders: expected delivery; work orders: deadline (YYYY-MM-DD)."),
          start_date: z.string().optional().describe("Work orders: start (YYYY-MM-DD), default today."),
          title: z.string().max(100).optional(),
          note: z.string().max(1000).optional(),
          language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) =>
        run(async () => {
          try {
            return withLines(await buildStockDocDraft({ ...recordContext(), tool: ctx }, args as StockDocInput));
          } catch (error) {
            throw missingHint(error);
          }
        }),
    );
  }

  const updatable = [
    ...(has("order_update") ? ORDER_UPDATE_TYPES : []),
    ...(has("invoice_update") ? INVOICE_UPDATE_TYPES : []),
    ...(has("warehouse_update") ? WAREHOUSE_UPDATE_TYPES : []),
  ];
  if (updatable.length) {
    server.registerTool(
      "draft_update",
      {
        title: "Draft a change to a document",
        description:
          "Prepare a change to an existing document WITHOUT saving it, limited to what Metakocka's API can change: " +
          [
            has("order_update") &&
              "sales orders: status, tracking_code (only once the order has an invoice), delivery_type, shipped_date, note, or create_invoice " +
                "(Metakocka makes the invoice by its own order settings, possibly with a packing list; to control the invoice use draft_document with from_order)",
            has("invoice_update") && "invoices: status",
            has("warehouse_update") && "warehouse documents: title, status, note, buyer_order, delivery_type; transfers: confirm_transfer",
          ]
            .filter(Boolean)
            .join("; ") +
          ". Statuses are the company's own; the draft names the ones in use. Returns a draft_id and a summary with old and new values: show it, then commit_document.",
        inputSchema: z.object({
          doc_type: z.enum(updatable as [string, ...string[]]),
          number: z.string().min(1).optional().describe("Document number as shown in Metakocka."),
          id: z.string().min(1).optional().describe("Or its Metakocka id."),
          status: z.string().max(100).optional().describe('New status as in Metakocka; on an invoice "" clears it.'),
          ...(has("order_update")
            ? {
                tracking_code: z.string().max(100).optional(),
                shipped_date: z.string().optional().describe("YYYY-MM-DD"),
                create_invoice: z.boolean().optional().describe("Sales orders: have Metakocka make the invoice."),
              }
            : {}),
          ...(has("order_update") || has("warehouse_update") ? { delivery_type: z.string().max(100).optional(), note: z.string().max(1000).optional() } : {}),
          ...(has("warehouse_update")
            ? { title: z.string().max(100).optional(), buyer_order: z.string().max(30).optional(), confirm_transfer: z.boolean().optional() }
            : {}),
          language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => run(async () => recordAnswer(await buildUpdateDraft(recordContext(), args as UpdateInput))),
    );
  }

  if (has("shipping")) {
    server.registerTool(
      "draft_shipping",
      {
        title: "Draft shipping",
        description:
          "Prepare WITHOUT doing it: labels = delivery service labels for sales orders (registers the parcels with the " +
          "delivery service; the answer has the tracking codes and label PDFs); mark_shipped = mark orders shipped; group = " +
          "put orders into a group expedition (one parent order and delivery). Returns a draft_id and a summary: show it, then commit_document.",
        inputSchema: z.object({
          action: z.enum(["labels", "mark_shipped", "group"]),
          orders: z.array(z.string().min(1)).max(100).optional().describe("Sales order numbers."),
          group_number: z.string().max(30).optional().describe("group: the group's customer order number (existing or new)."),
          partner_id: z.string().optional().describe("group, new group: partner of the parent order."),
          delivery_type: z.string().max(100).optional().describe("group, new group: delivery type as in Metakocka."),
          language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => run(async () => recordAnswer(await buildShippingDraft(recordContext(), args as ShippingInput))),
    );
  }

  if (has("complaint")) {
    server.registerTool(
      "draft_complaint",
      {
        title: "Draft a complaint",
        description:
          "Prepare WITHOUT saving it: create = a new complaint (reklamacija), return (vračilo) or replacement (zamenjava) for a " +
          "sales order, with the products from the order and how many (replacements also with the replacement products and " +
          "their gross prices); update = a complaint's new status, note or return tracking code. Returns a draft_id and a " +
          "summary: show it, then commit_document.",
        inputSchema: z.object({
          action: z.enum(["create", "update"]),
          claim_type: z.enum(CLAIM_TYPES).optional(),
          order_number: z.string().optional().describe("create: the sales order's number."),
          products: z
            .array(z.object({ product_id: z.string().optional(), code: z.string().optional(), quantity: z.number().positive(), reason: z.string().max(100).optional(), description: z.string().max(500).optional() }))
            .max(50)
            .optional(),
          replacement_products: z
            .array(z.object({ product_id: z.string().optional(), code: z.string().optional(), quantity: z.number().positive(), price_with_tax: z.number().min(0) }))
            .max(50)
            .optional(),
          reason: z.string().max(100).optional().describe("Complaint reason as in Metakocka's register."),
          description: z.string().max(1000).optional(),
          iban: z.string().max(40).optional().describe("Customer's account for a refund."),
          return_tracking_code: z.string().max(100).optional(),
          complaint_number: z.string().optional().describe("update: the complaint's number."),
          status: z.string().max(100).optional().describe("Status as in Metakocka (draft, progress, completed or the company's own); required for update."),
          note: z.string().max(1000).optional().describe("update: a note."),
          language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) =>
        run(async () => recordAnswer(await buildComplaintDraft({ ...recordContext(), userEmail: envValue(process.env, "METAKOCKA_USER_EMAIL") }, args as ComplaintInput))),
    );
  }

  if (has("message")) {
    server.registerTool(
      "draft_message",
      {
        title: "Draft a message to a customer",
        description:
          "Prepare an SMS, Viber, WhatsApp or e-mail to a customer, sent through Metakocka's connections, WITHOUT sending it. " +
          "Once committed it is sent right away and can't be recalled: write exactly what the user asked for, and show them " +
          "the summary. Returns a draft_id and a summary: show it, then commit_document.",
        inputSchema: z.object({
          channel: z.enum(CHANNELS),
          to_number: z.string().max(30).optional().describe("sms / viber / whatsapp: the phone number."),
          country: z.string().max(50).optional().describe("Country of the number, e.g. SI."),
          text: z.string().max(1000).optional().describe("sms / viber / whatsapp: the message."),
          sender_name: z.string().max(11).optional().describe("SMS: the sender name (registered in Metakocka)."),
          to_emails: z.array(z.string()).max(20).optional(),
          cc_emails: z.array(z.string()).max(20).optional(),
          from_email: z.string().optional().describe("E-mail: an address on a domain verified for sending in Metakocka."),
          from_name: z.string().max(100).optional(),
          subject: z.string().max(200).optional(),
          body: z.string().max(20_000).optional().describe("E-mail: plain text; blank lines separate paragraphs."),
          marketing: z.boolean().default(false).describe("A marketing message (default: transactional)."),
          attach_documents: z
            .array(z.object({ doc_type: z.string(), number: z.string(), report_id: z.string().regex(/^\d+$/).optional() }))
            .max(10)
            .optional()
            .describe("E-mail: Metakocka documents to attach as PDF, e.g. [{doc_type: \"sales_bill_domestic\", number: \"RD-2/2026\"}]; other than invoices and credit notes they need report_id."),
          attachment_paths: z.array(z.string()).max(10).optional().describe("E-mail: absolute paths of files on this computer to attach (PDF, images, XML, TXT, CSV)."),
          language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => run(async () => recordAnswer(await buildMessageDraft({ ...recordContext(), localFiles: write.localFiles === true }, args as MessageInput))),
    );
  }

  server.registerTool(
    "commit_document",
    {
      title: "Save a drafted document",
      description:
        "Save a draft from draft_document in Metakocka, exactly as drafted; to change anything, make a new draft. " +
        COMMIT_CONFIRMATION[settings.confirm] +
        "Each draft is saved at most once. If the result says the outcome is unknown, never draft the document again: " +
        "call commit_document with the same draft_id, which first checks whether it was saved.",
      inputSchema: z.object({
        draft_id: z.string().min(1),
        confirm_summary: z
          .string()
          .optional()
          .describe(
            "The draft's `summary` from draft_document, copied exactly. Shown to the user in the client's approval prompt; " +
              "the document is saved only if it matches the draft.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ draft_id, confirm_summary }, extra: ServerContext) => {
      const draft = drafts.get(draft_id);
      if (!draft) return error(`No draft ${draft_id}. Drafts last 15 minutes and are lost when the server restarts; make a new one with draft_document.`);
      const client = ctx.getClient();
      const commitCtx = { client, drafts, journal, timeoutMs: settings.timeoutMs, installation: client.host };

      switch (draft.status) {
        case "committed":
          return ok({ status: "already_created", number: draft.result?.number, mk_id: draft.result?.mkId, message: "This draft was already saved; nothing new was created." });
        case "discarded":
          return error(`Draft ${draft_id} was discarded.`);
        case "committing":
          return error(`Draft ${draft_id} is being saved right now. Wait for that call to finish.`);
        case "unknown":
          return run(async () => {
            const found = await resolveUnknown(commitCtx, draft);
            if (found.status === "not_found") {
              return {
                status: "not_saved",
                message: "The earlier attempt did not create the document. Call commit_document again to save it (the user confirms again).",
              };
            }
            if (found.status === "ambiguous" && draft.docType === "payment") {
              return {
                status: "unknown",
                message:
                  `The document's paid amount changed, but not by exactly this payment (${found.candidates.join(", ")}). ` +
                  "Ask the user to check its payments in Metakocka. Do not save it again; discard_draft when resolved.",
              };
            }
            if (found.status === "ambiguous") {
              return {
                status: "unknown",
                message:
                  `Several documents to this partner on that date match the draft (${found.candidates.join(", ")}). ` +
                  "Ask the user to check in Metakocka whether one of them is this one. Do not save it again; discard_draft when resolved.",
              };
            }
            if (found.status === "created") ctx.cache.clear();
            return found;
          });
      }

      if (drafts.isExpired(draft)) return error(`Draft ${draft_id} expired. Make a new one with draft_document.`);

      if (settings.confirm !== "never") {
        const elicitation = supportsElicitation(server, extra);
        if (elicitation) {
          const key = `confirm_${draft.id}`;
          const answer = inputResponse(extra.mcpReq.inputResponses, key);
          if (answer.kind === "missing") return inputRequired({ inputRequests: { [key]: inputRequired.elicit(confirmation(draft)) } });
          if (answer.kind !== "elicit" || answer.action !== "accept" || answer.content?.confirm !== true) {
            return ok({ status: "cancelled", message: "The user did not confirm; nothing was saved. The draft stays available until it expires." });
          }
          // The draft could have been saved by a parallel call while the user was deciding.
          if (draft.status !== "open") return error(`Draft ${draft_id} is ${draft.status}; nothing more was saved.`);
        } else if (settings.confirm === "elicitation") {
          return error(
            "Nothing was saved. Saving documents requires confirming them in the client, and this client can't show " +
              "confirmation prompts (MCP elicitation). Use a client that supports it, or create the document in Metakocka.",
          );
        } else if (confirm_summary === undefined || !sameSummary(confirm_summary, draft.summary)) {
          // "client": the user approves this call in the client's own prompt, which shows confirm_summary.
          // It must be the draft's summary, so what the user approves is exactly what is saved.
          return error(
            confirm_summary === undefined
              ? "Nothing was saved. Pass confirm_summary: the draft's summary from draft_document, copied exactly, so the user sees it when approving this call."
              : "Nothing was saved: confirm_summary does not match the draft. Copy the draft's summary from draft_document exactly.",
          );
        }
      }

      return run(async () => {
        const outcome = await commitDraft(commitCtx, draft);
        // New records must show up in searches and the catalogue right away.
        if (outcome.status === "created") ctx.cache.clear();
        return outcome;
      });
    },
  );

  server.registerTool(
    "discard_draft",
    {
      title: "Discard a draft",
      description: "Drop a draft from draft_document without saving it.",
      inputSchema: z.object({ draft_id: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ draft_id }) => {
      const draft = drafts.get(draft_id);
      if (!draft) return error(`No draft ${draft_id}.`);
      if (draft.status === "committed") return error(`Draft ${draft_id} was already saved as ${draft.result?.number ?? draft.result?.mkId}; discarding it changes nothing in Metakocka.`);
      if (draft.status === "committing") return error(`Draft ${draft_id} is being saved right now.`);
      const wasUnknown = draft.status === "unknown";
      draft.status = "discarded";
      return ok({
        status: "discarded",
        ...(wasUnknown ? { message: "It is still not known whether this document was saved; check in Metakocka." } : {}),
      });
    },
  );
}

/** The form the user sees. Short, with everything that identifies the document. */
function confirmation(draft: Draft) {
  const sl = draft.language === "sl";
  return {
    message: draft.summary,
    requestedSchema: {
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          title: sl ? "Shrani v Metakocko" : "Save in Metakocka",
          description: sl ? "Potrdite, da se to shrani v Metakocko." : "Confirm to save this in Metakocka.",
        },
      },
      required: ["confirm"],
    },
  };
}

function supportsElicitation(server: McpServer, extra: ServerContext): boolean {
  const envelope = extra.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = (envelope?.[CLIENT_CAPABILITIES] ?? server.server.getClientCapabilities()) as { elicitation?: { form?: unknown; url?: unknown } } | undefined;
  const elicitation = caps?.elicitation;
  // An empty elicitation capability means form mode (the spec's backwards-compatible default).
  return elicitation !== undefined && (elicitation.form !== undefined || elicitation.url === undefined);
}

function ok(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function error(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
