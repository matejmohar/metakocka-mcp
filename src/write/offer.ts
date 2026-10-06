/**
 * Builds an offer (ponudba / predračun) draft. Everything the document refers
 * to must already exist in Metakocka and is linked by id: the partner and its
 * address by mk_id / mk_address_id, products by mk_id. Prices and tax codes
 * come from Metakocka's catalogue, not from the model. Nothing is written here.
 */
import type { MkRecord } from "../api.js";
import { toMkDate } from "../dates.js";
import { loadCatalog } from "./catalog.js";
import {
  CHANGE_LOG_PREFIX,
  DraftError,
  duplicateWarning,
  linesAndTotals,
  oneLine,
  productLine,
  productListPayload,
  resolveAddress,
  resolvePartner,
  totalsOf,
  type BuildContext,
  type LineInput,
} from "./document.js";
import type { Draft } from "./drafts.js";

export interface OfferInput {
  partner_id: string;
  address_id?: string;
  lines: LineInput[];
  title?: string;
  note?: string;
  valid_days?: number;
  language?: "sl" | "en";
}

export async function buildOfferDraft(ctx: BuildContext, input: OfferInput): Promise<{ draft: Draft; warnings: string[] }> {
  const warnings: string[] = [];
  const partner = await resolvePartner(ctx.client, input.partner_id, { foreign: "refuse", what: "Offers" });
  const address = resolveAddress(partner, input.address_id);

  const catalog = await loadCatalog(ctx.client, ctx.cache, ctx.today);
  if (!input.lines.length) throw new DraftError("An offer needs at least one product line.");
  const lines = input.lines.map((line, i) => productLine(catalog, line, i));
  const totals = totalsOf(lines);

  const validDays = input.valid_days ?? 30;
  const payload: MkRecord = {
    doc_type: "sales_offer",
    doc_date: toMkDate(ctx.today),
    partner: { mk_id: partner.id, mk_address_id: address.id },
    currency_code: "EUR",
    valid_days: String(validDays),
    ...(input.title ? { title: input.title } : {}),
    ...(input.note ? { notes: input.note } : {}),
    product_list: productListPayload(lines),
  };

  const partnerRef = { id: partner.id, name: partner.name, taxId: partner.taxId, addressId: address.id, address: address.text };
  const same = duplicateWarning(ctx.drafts, { docType: "sales_offer", partner: partnerRef, docDate: ctx.today, totals }, "An offer");
  if (same) warnings.push(same);

  const draft = ctx.drafts.add({
    docType: "sales_offer",
    language: input.language ?? "sl",
    partner: partnerRef,
    docDate: ctx.today,
    lines,
    totals,
    payload,
    summary: "",
  });
  // The id goes into Metakocka's change log, so the document can be traced back to this draft.
  payload.document_change_log_notes = `${CHANGE_LOG_PREFIX} ${draft.id}`;
  draft.summary = summarize(draft, { title: input.title, note: input.note, validDays }, ctx.installation);
  return { draft, warnings };
}

/**
 * What the user confirms, in their language: everything that will be saved, one fact per line.
 * commit_document compares it ignoring line breaks and indentation (see sameSummary).
 */
function summarize(d: Draft, extra: { title?: string; note?: string; validDays: number }, installation: string | undefined): string {
  const t =
    d.language === "sl"
      ? { head: "Ustvari PONUDBO za", title: "Naziv", note: "Opomba", date: "Datum", valid: `velja ${extra.validDays} dni` }
      : { head: "Create an OFFER for", title: "Title", note: "Note", date: "Dated", valid: `valid ${extra.validDays} days` };
  return [
    `${t.head} ${d.partner.name}${d.partner.taxId ? ` (${d.partner.taxId})` : ""}`,
    d.partner.address,
    ...(extra.title ? [`${t.title}: ${extra.title}`] : []),
    ...(extra.note ? [`${t.note}: ${oneLine(extra.note)}`] : []),
    "",
    ...linesAndTotals(d),
    "",
    [`${t.date} ${d.docDate}`, t.valid, ...(installation ? [`Metakocka: ${installation}`] : [])].join(" · "),
  ].join("\n");
}
