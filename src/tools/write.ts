/**
 * Opt-in tools that create documents in Metakocka (METAKOCKA_WRITE): offers and invoices.
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
import { buildInvoiceDraft, type InvoiceInfo, type InvoiceInput, type InvoiceType } from "../write/invoice.js";
import { buildOfferDraft } from "../write/offer.js";
import { INVOICE_TYPES, type WriteSettings } from "../write/settings.js";
import { compact } from "../util.js";
import { run, type ToolContext } from "./shared.js";

export interface WriteContext {
  settings: WriteSettings;
  /** Must outlive a single server instance: create it once per process (stdio) or per tenant (HTTP). */
  drafts: DraftStore;
  journal: Journal;
}

export function createWriteContext(settings: WriteSettings, options: { logToStderr?: boolean } = {}): WriteContext {
  return { settings, drafts: new DraftStore(), journal: createJournal(options.logToStderr ? undefined : settings.logPath) };
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

  const offers = settings.docTypes.includes("sales_offer");
  const invoices = settings.docTypes.some((t) => INVOICE_TYPES.includes(t));
  const what = [offers && "an offer (ponudba / predračun)", invoices && "an invoice (račun, domestic or foreign)"].filter(Boolean).join(" or ");
  const docTypeHelp = [
    offers && "sales_offer = ponudba (also used as predračun)",
    invoices && "sales_bill_domestic = račun for a domestic partner, sales_bill_foreign = tuji račun for a foreign partner",
  ].filter(Boolean).join("; ");

  server.registerTool(
    "draft_document",
    {
      title: `Draft a document (${[offers && "offer", invoices && "invoice"].filter(Boolean).join(", ")})`,
      description:
        `Prepare ${what} in Metakocka WITHOUT saving it. Everything is linked to records that ` +
        "already exist: the partner by its id (from search_partners) and products by their id (from search_products). " +
        "This tool never creates partners or products; if one is missing, tell the user to add it in Metakocka. " +
        "Prices and VAT come from Metakocka's price list unless a price is given. " +
        (invoices
          ? "Invoices are saved NOT issued: the user checks and issues (prints) them in Metakocka; they move no stock. " +
            "An invoice can also be made from an offer (from_offer: its lines, partner and a link to it). The payment term " +
            "comes from the partner (its term in Metakocka, else its last invoice) unless given. Foreign invoices take only " +
            "lines without VAT and, unless a note is given, the VAT note of the partner's last foreign invoice. "
          : "") +
        "Returns a draft_id and a summary: show the summary to the user, then call commit_document with the draft_id to save it. " +
        "Drafts expire after 15 minutes.",
      inputSchema: z.object({
        doc_type: z.enum(settings.docTypes as [string, ...string[]]).describe(`${docTypeHelp}.`),
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
              price: z.number().min(0).max(10_000_000).optional().describe("Net unit price in EUR; default: the product's price list."),
              discount_percent: z.number().min(0).max(100).optional(),
            }),
          )
          .min(1)
          .max(50)
          .optional(),
        title: z.string().max(100).optional().describe("Document title (naziv)."),
        note: z.string().max(1000).optional().describe("Note printed on the document."),
        ...(offers ? { valid_days: z.number().int().min(1).max(365).optional().describe("Offers: how many days the offer is valid (default 30).") } : {}),
        ...(invoices
          ? {
              from_offer: z.string().min(1).optional().describe("Invoices: number of the offer to invoice (e.g. \"4/2026\"), instead of lines."),
              service_from: z.string().optional().describe("Invoices: first day of the service period (YYYY-MM-DD), if it is a period."),
              service_to: z.string().optional().describe("Invoices: service date or last day of the period (YYYY-MM-DD); default today."),
              due_days: z.number().int().min(0).max(365).optional().describe("Invoices: payment term in days; default: from the partner."),
              due_date: z.string().optional().describe("Invoices: due date (YYYY-MM-DD), instead of due_days."),
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
        const a = args as typeof args & Partial<Omit<InvoiceInput, "doc_type">> & { valid_days?: number };
        let built: { draft: Draft; warnings: string[]; info?: InvoiceInfo };
        if (a.doc_type === "sales_offer") {
          const invoiceOnly = (["from_offer", "service_from", "service_to", "due_days", "due_date"] as const).filter((k) => a[k] !== undefined);
          if (invoiceOnly.length) throw new DraftError(`${invoiceOnly.join(", ")}: only for invoices.`);
          if (!a.partner_id) throw new DraftError("Give partner_id (from search_partners).");
          built = await buildOfferDraft(buildCtx, { ...a, partner_id: a.partner_id, lines: a.lines ?? [] });
        } else {
          if (a.valid_days !== undefined) throw new DraftError("valid_days: only for offers.");
          built = await buildInvoiceDraft(buildCtx, { ...a, doc_type: a.doc_type as InvoiceType });
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
                  `Several documents to this partner today match the draft (${found.candidates.join(", ")}). ` +
                  "Ask the user to check in Metakocka whether one of them is this one. Do not save it again; discard_draft when resolved.",
              };
            }
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

      return run(() => commitDraft(commitCtx, draft));
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
