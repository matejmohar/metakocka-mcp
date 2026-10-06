/**
 * Opt-in tools that create documents in Metakocka (METAKOCKA_WRITE).
 * draft_document builds and checks a document without saving it;
 * commit_document saves exactly that draft, after the user confirms it in
 * their client; discard_draft drops it.
 */
import { inputRequired, inputResponse, type McpServer, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { todayInLjubljana } from "../dates.js";
import { describeInstallation } from "../installation.js";
import { commitDraft, resolveUnknown } from "../write/commit.js";
import { DraftStore, type Draft } from "../write/drafts.js";
import { createJournal, type Journal } from "../write/journal.js";
import { buildOfferDraft } from "../write/offer.js";
import type { WriteSettings } from "../write/settings.js";
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

export function registerWriteTools(server: McpServer, ctx: ToolContext, write: WriteContext): void {
  const { settings, drafts, journal } = write;

  server.registerTool(
    "draft_document",
    {
      title: "Draft a document (offer)",
      description:
        "Prepare a new offer (ponudba / predračun) in Metakocka WITHOUT saving it. Everything is linked to records that " +
        "already exist: the partner by its id (from search_partners) and products by their id (from search_products). " +
        "This tool never creates partners or products; if one is missing, tell the user to add it in Metakocka. " +
        "Prices and VAT come from Metakocka's price list unless a price is given. Returns a draft_id and a summary: " +
        "show the summary to the user, then call commit_document with the draft_id to save it. Drafts expire after 15 minutes.",
      inputSchema: z.object({
        doc_type: z.enum(settings.docTypes as [string, ...string[]]).describe("sales_offer = ponudba (also used as predračun)."),
        partner_id: z.string().min(1).describe("The partner's Metakocka id (mk_id, the `id` from search_partners)."),
        address_id: z
          .string()
          .optional()
          .describe("Id of one of the partner's addresses (from get_partner). Needed only when the partner has several."),
        lines: z
          .array(
            z.object({
              product_id: z.string().optional().describe("Product's Metakocka id (the `id` from search_products)."),
              code: z.string().optional().describe("Exact product code (šifra), instead of product_id."),
              text: z.string().max(500).optional().describe("A description-only line (opisna vrstica): no product, quantity or price."),
              quantity: z.number().positive().max(1_000_000).optional(),
              price: z.number().min(0).max(10_000_000).optional().describe("Net unit price in EUR; default: the product's price list."),
              discount_percent: z.number().min(0).max(100).optional(),
            }),
          )
          .min(1)
          .max(50),
        title: z.string().max(100).optional().describe("Offer title (naziv)."),
        note: z.string().max(1000).optional().describe("Note printed on the offer."),
        valid_days: z.number().int().min(1).max(365).optional().describe("How many days the offer is valid (default 30)."),
        language: z.enum(["sl", "en"]).default("sl").describe("Language of the summary the user confirms."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const client = ctx.getClient();
        const installation = describeInstallation(client.baseUrl);
        const { draft, warnings } = await buildOfferDraft(
          {
            client,
            cache: ctx.cache,
            drafts,
            today: todayInLjubljana(ctx.now()),
            installation: installation.isDefault ? undefined : installation.host,
          },
          args,
        );
        return compact({
          draft_id: draft.id,
          expires_at: new Date(draft.expiresAt).toISOString(),
          summary: draft.summary,
          partner: draft.partner,
          lines: draft.lines.map((l) =>
            l.kind === "text"
              ? { text: l.name }
              : { product_id: l.productId, code: l.code, name: l.name, quantity: l.quantity, unit: l.unit, price: l.price, discount_percent: l.discountPercent, vat_percent: l.taxRatePercent, net: l.net, total: l.gross },
          ),
          totals: draft.totals,
          warnings,
          next:
            settings.confirm === "always"
              ? "Show the summary to the user. To save it, call commit_document with this draft_id; the user confirms it in their client."
              : "Show the summary to the user and get their agreement, then call commit_document with this draft_id.",
        });
      }),
  );

  server.registerTool(
    "commit_document",
    {
      title: "Save a drafted document",
      description:
        "Save a draft from draft_document in Metakocka, exactly as drafted. Takes only the draft_id; to change anything, " +
        "make a new draft. " +
        (settings.confirm === "always" ? "The user is asked to confirm in their client first. " : "") +
        "Each draft is saved at most once. If the result says the outcome is unknown, never draft the document again: " +
        "call commit_document with the same draft_id, which first checks whether it was saved.",
      inputSchema: z.object({ draft_id: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ draft_id }, extra: ServerContext) => {
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
                  `Several offers to this partner today match the draft (${found.candidates.join(", ")}). ` +
                  "Ask the user to check in Metakocka whether one of them is this offer. Do not save it again; discard_draft when resolved.",
              };
            }
            return found;
          });
      }

      if (drafts.isExpired(draft)) return error(`Draft ${draft_id} expired. Make a new one with draft_document.`);

      if (settings.confirm === "always") {
        const key = `confirm_${draft.id}`;
        const answer = inputResponse(extra.mcpReq.inputResponses, key);
        if (answer.kind === "missing") {
          if (!supportsElicitation(server, extra)) {
            return error(
              "Nothing was saved. Saving documents requires confirming them in the client, and this client can't show " +
                "confirmation prompts (MCP elicitation). Use a client that supports it, or create the document in Metakocka.",
            );
          }
          return inputRequired({ inputRequests: { [key]: inputRequired.elicit(confirmation(draft)) } });
        }
        if (answer.kind !== "elicit" || answer.action !== "accept" || answer.content?.confirm !== true) {
          return ok({ status: "cancelled", message: "The user did not confirm; nothing was saved. The draft stays available until it expires." });
        }
        // The draft could have been saved by a parallel call while the user was deciding.
        if (draft.status !== "open") return error(`Draft ${draft_id} is ${draft.status}; nothing more was saved.`);
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
