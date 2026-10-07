/**
 * Builds an offer (ponudba / predračun) or a sales order (prodajno naročilo) draft. Everything the document refers
 * to must already exist in Metakocka and is linked by id: the partner and its
 * address by mk_id / mk_address_id, products by mk_id. Prices and tax codes
 * come from Metakocka's catalogue, not from the model. Nothing is written here.
 */
import type { MkRecord } from "../api.js";
import { isIsoDate, toMkDate } from "../dates.js";
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

export interface OrderInput extends Omit<OfferInput, "valid_days"> {
  /** The customer's own order number (naročilo kupca), shown on the order. */
  buyer_order?: string;
  /** Delivery deadline (rok dobave), YYYY-MM-DD. */
  delivery_date?: string;
}

export function buildOfferDraft(ctx: BuildContext, input: OfferInput): Promise<{ draft: Draft; warnings: string[] }> {
  return buildSalesDraft(ctx, "sales_offer", input);
}

/** A sales order: like an offer, but it reserves nothing by itself and has no validity. */
export function buildOrderDraft(ctx: BuildContext, input: OrderInput): Promise<{ draft: Draft; warnings: string[] }> {
  if (input.delivery_date !== undefined && !isIsoDate(input.delivery_date)) throw new DraftError("delivery_date must be a date as YYYY-MM-DD.");
  if (input.delivery_date !== undefined && input.delivery_date < ctx.today) throw new DraftError("delivery_date is in the past.");
  return buildSalesDraft(ctx, "sales_order", input);
}

async function buildSalesDraft(
  ctx: BuildContext,
  docType: "sales_offer" | "sales_order",
  input: OfferInput & Partial<OrderInput>,
): Promise<{ draft: Draft; warnings: string[] }> {
  const offer = docType === "sales_offer";
  const warnings: string[] = [];
  const partner = await resolvePartner(ctx.client, input.partner_id, { foreign: "refuse", what: offer ? "Offers" : "Sales orders" });
  const address = resolveAddress(partner, input.address_id);

  const catalog = await loadCatalog(ctx.client, ctx.cache, ctx.today);
  if (!input.lines.length) throw new DraftError(`${offer ? "An offer" : "A sales order"} needs at least one product line.`);
  const lines = input.lines.map((line, i) => productLine(catalog, line, i));
  const totals = totalsOf(lines);

  const validDays = offer ? input.valid_days ?? 30 : undefined;
  const buyerOrder = input.buyer_order?.trim() || undefined;
  const payload: MkRecord = {
    doc_type: docType,
    doc_date: toMkDate(ctx.today),
    partner: { mk_id: partner.id, mk_address_id: address.id },
    currency_code: "EUR",
    ...(validDays !== undefined ? { valid_days: String(validDays) } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.note ? { notes: input.note } : {}),
    ...(buyerOrder ? { buyer_order: buyerOrder } : {}),
    ...(input.delivery_date ? { delivery_deadline: toMkDate(input.delivery_date) } : {}),
    product_list: productListPayload(lines),
  };

  const partnerRef = { id: partner.id, name: partner.name, taxId: partner.taxId, addressId: address.id, address: address.text };
  const same = duplicateWarning(ctx.drafts, { docType, partner: partnerRef, docDate: ctx.today, totals }, offer ? "An offer" : "A sales order");
  if (same) warnings.push(same);

  const draft = ctx.drafts.add({
    docType,
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
  draft.summary = summarize(draft, { title: input.title, note: input.note, validDays, buyerOrder, deliveryDate: input.delivery_date }, ctx.installation);
  return { draft, warnings };
}

/**
 * What the user confirms, in their language: everything that will be saved, one fact per line.
 * commit_document compares it ignoring line breaks and indentation (see sameSummary).
 */
function summarize(
  d: Draft,
  extra: { title?: string; note?: string; validDays?: number; buyerOrder?: string; deliveryDate?: string },
  installation: string | undefined,
): string {
  const order = d.docType === "sales_order";
  const t =
    d.language === "sl"
      ? {
          head: order ? "Ustvari PRODAJNO NAROČILO za" : "Ustvari PONUDBO za",
          title: "Naziv",
          note: "Opomba",
          buyerOrder: "Naročilo kupca",
          date: "Datum",
          valid: `velja ${extra.validDays} dni`,
          delivery: "rok dobave",
        }
      : {
          head: order ? "Create a SALES ORDER for" : "Create an OFFER for",
          title: "Title",
          note: "Note",
          buyerOrder: "Customer's order",
          date: "Dated",
          valid: `valid ${extra.validDays} days`,
          delivery: "deliver by",
        };
  return [
    `${t.head} ${d.partner.name}${d.partner.taxId ? ` (${d.partner.taxId})` : ""}`,
    d.partner.address,
    ...(extra.buyerOrder ? [`${t.buyerOrder}: ${extra.buyerOrder}`] : []),
    ...(extra.title ? [`${t.title}: ${extra.title}`] : []),
    ...(extra.note ? [`${t.note}: ${oneLine(extra.note)}`] : []),
    "",
    ...linesAndTotals(d),
    "",
    [
      `${t.date} ${d.docDate}`,
      ...(extra.validDays !== undefined ? [t.valid] : []),
      ...(extra.deliveryDate ? [`${t.delivery} ${extra.deliveryDate}`] : []),
      ...(installation ? [`Metakocka: ${installation}`] : []),
    ].join(" · "),
  ].join("\n");
}
