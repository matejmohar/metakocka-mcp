/**
 * Opt-in tools that create documents in Metakocka (METAKOCKA_WRITE): offers, invoices and received invoices,
 * and register entries: partners and products. draft_partner / draft_product draft the latter.
 * draft_document builds and checks a document without saving it;
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
import { buildOfferDraft, type OfferInput } from "../write/offer.js";
import { buildPurchaseDraft, type PurchaseInfo, type PurchaseInput } from "../write/purchase.js";
import { buildPartnerDraft, buildProductDraft } from "../write/records.js";
import { INVOICE_TYPES, isRecordType, PURCHASE_TYPES, type WriteSettings } from "../write/settings.js";
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

  const documentTypes = settings.docTypes.filter((t) => !isRecordType(t));
  const partners = settings.docTypes.includes("partner");
  const products = settings.docTypes.includes("product");
  const offers = settings.docTypes.includes("sales_offer");
  const invoices = settings.docTypes.some((t) => INVOICE_TYPES.includes(t));
  const purchases = settings.docTypes.some((t) => PURCHASE_TYPES.includes(t));
  const what = [
    offers && "an offer (ponudba / predračun)",
    invoices && "an invoice (račun, domestic or foreign)",
    purchases && "a received invoice (prejeti račun) from a supplier's invoice",
  ].filter(Boolean);
  const docTypeHelp = [
    offers && "sales_offer = ponudba (also used as predračun)",
    invoices && "sales_bill_domestic = račun for a domestic partner, sales_bill_foreign = tuji račun for a foreign partner",
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
      title: `Draft a document (${[offers && "offer", invoices && "invoice", purchases && "received invoice"].filter(Boolean).join(", ")})`,
      description:
        `Prepare ${what.join(", or ")} in Metakocka WITHOUT saving it. Everything is linked to records that ` +
        "already exist: the partner by its id (from search_partners) and products by their id (from search_products). " +
        "This tool never creates partners or products; if one is missing, tell the user to add it in Metakocka. " +
        (offers || invoices
          ? `${purchases ? `On ${[offers && "offers", invoices && "invoices"].filter(Boolean).join(" and ")}, prices` : "Prices"} and VAT come from Metakocka's price list unless a price is given. `
          : "") +
        (invoices
          ? "Invoices are saved NOT issued: the user checks and issues (prints) them in Metakocka; they move no stock. " +
            "An invoice can also be made from an offer (from_offer: its lines, partner and a link to it). The payment term " +
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
          .describe(`The partner's Metakocka id (mk_id, the \`id\` from search_partners).${invoices ? " With from_offer it can be left out." : ""}`),
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
              ...(purchases
                ? {
                    vat_percent: z.number().min(0).max(100).optional().describe("Purchase invoices: the line's VAT rate as on the invoice (e.g. 22, 9.5, 0)."),
                    description: z.string().max(200).optional().describe("Purchase invoices: the line's text on the invoice (e.g. a period or domain)."),
                  }
                : {}),
            }),
          )
          .min(1)
          .max(50)
          .optional(),
        ...(offers || invoices ? { title: z.string().max(100).optional().describe("Document title (naziv).") } : {}),
        note: z.string().max(1000).optional().describe("Note on the document."),
        ...(offers ? { valid_days: z.number().int().min(1).max(365).optional().describe("Offers: how many days the offer is valid (default 30).") } : {}),
        ...(invoices ? { from_offer: z.string().min(1).optional().describe("Invoices: number of the offer to invoice (e.g. \"4/2026\"), instead of lines.") } : {}),
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
        const kind = a.doc_type === "sales_offer" ? "offer" : a.doc_type.startsWith("sales_bill_") ? "invoice" : "purchase";
        // Fields that belong to other kinds of documents are refused rather than silently ignored.
        const allowed: Record<string, readonly string[]> = {
          valid_days: ["offer"],
          title: ["offer", "invoice"],
          from_offer: ["invoice"],
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
        if (kind !== "purchase" && a.lines?.some((l) => l.vat_percent !== undefined || l.description !== undefined)) misplaced.push("lines[].vat_percent / description");
        if (misplaced.length) throw new DraftError(`${misplaced.join(", ")}: not for ${a.doc_type}.`);

        let built: { draft: Draft; warnings: string[]; info?: InvoiceInfo | PurchaseInfo };
        try {
          if (kind === "offer") {
            if (!a.partner_id) throw new DraftError("Give partner_id (from search_partners).");
            built = await buildOfferDraft(buildCtx, { ...(a as unknown as OfferInput), lines: (a.lines ?? []) as OfferInput["lines"] });
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
          title: sl ? "Ustvari dokument v Metakocki" : "Create the document in Metakocka",
          description: sl ? "Potrdite, da se dokument shrani v Metakocko." : "Confirm to save the document in Metakocka.",
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
