/**
 * Shipping sales orders: delivery labels from the delivery service
 * (generate_sticker), marking orders shipped (mark_orders_as_shipped), and
 * group expeditions (group_expedition: several orders under one parent order
 * and one delivery). Labels register parcels with the delivery service, so a
 * call that didn't answer is checked by the orders' tracking codes before
 * anything is sent again.
 */
import { findDocumentIdByNumber, getDocument, searchDocuments, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { MetakockaError } from "../client.js";
import { toMkDate } from "../dates.js";
import { asArray, str } from "../util.js";
import type { ChangeCheck } from "./change.js";
import { DraftError, resolvePartner, type BuildContext } from "./document.js";
import type { Draft } from "./drafts.js";

export interface ShippingInput {
  /** labels: delivery labels; mark_shipped: mark orders shipped; group: put orders into one group expedition. */
  action?: "labels" | "mark_shipped" | "group";
  /** Sales order numbers as in Metakocka. */
  orders?: string[];
  /** group: the group's own customer order number (new or existing group). */
  group_number?: string;
  /** group, new group: partner of the parent order and the delivery type. */
  partner_id?: string;
  delivery_type?: string;
  language?: "sl" | "en";
}

const MAX_ORDERS = 100;

export async function buildShippingDraft(ctx: BuildContext, input: ShippingInput): Promise<{ draft: Draft; warnings: string[] }> {
  const action = input.action;
  if (!action) throw new DraftError("Give action: labels, mark_shipped or group.");
  const numbers = [...new Set((input.orders ?? []).map((n) => n.trim()).filter(Boolean))];
  if (action !== "group" && !numbers.length) throw new DraftError("Give the sales orders (their numbers).");
  if (numbers.length > MAX_ORDERS) throw new DraftError(`At most ${MAX_ORDERS} orders at a time.`);
  for (const k of ["group_number", "partner_id", "delivery_type"] as const) {
    if (action !== "group" && input[k] !== undefined) throw new DraftError(`${k} is only for action group.`);
  }

  const warnings: string[] = [];
  const orders: { id: string; number: string; doc: MkRecord }[] = [];
  for (const number of numbers) {
    const id = await findDocumentIdByNumber(ctx.client, "sales_order", number);
    if (!id) throw new DraftError(`No sales order ${number} in Metakocka.`);
    orders.push({ id, number, doc: await getDocument(ctx.client, "sales_order", id) });
  }
  const sl = (input.language ?? "sl") === "sl";
  const list = orders.map((o) => o.number).join(", ");

  let payload: MkRecord;
  let endpoint: string;
  let head: string;
  let check: ((client: MetakockaClient) => Promise<ChangeCheck>) | undefined;
  let manualCheck: string | undefined;
  let interpret: ((r: MkRecord) => { warnings?: string[]; details?: Record<string, unknown> }) | undefined;

  if (action === "labels") {
    const labelled = orders.filter((o) => str(o.doc.tracking_code));
    if (labelled.length) {
      warnings.push(`Already have a tracking code (a label may exist; another one registers another parcel): ${labelled.map((o) => `${o.number} ${str(o.doc.tracking_code)}`).join(", ")}.`);
    }
    const before = new Map(orders.map((o) => [o.id, str(o.doc.tracking_code)]));
    endpoint = "generate_sticker";
    payload = { order_id_list: orders.map((o) => o.id) };
    head = sl ? `Natisni NALEPKE dostavne službe za ${orders.length} naročil(a): ${list}` : `Print delivery LABELS for ${orders.length} order(s): ${list}`;
    interpret = (r) => {
      const rows = asArray<MkRecord>(r.generate_sticker);
      const ok = rows.filter((x) => str(x.opr_code) === "0");
      const failed = rows.filter((x) => str(x.opr_code) !== "0");
      const details = {
        labels: ok.map((x) => ({ order: str(x.sales_order_count_code), tracking_code: str(x.tracking_code), carrier_tracking_code: str(x.carrier_tracking_code), label_url: str(x.sticker_public_url) })),
        failed: failed.map((x) => ({ order: str(x.sales_order_count_code), error: str(x.error_desc)?.replace(/\s*\|\s*$/, "") })),
        all_labels_pdf: str(r.generate_sticker_join_document),
      };
      if (!ok.length && failed.length) throw new MetakockaError(`No label was made: ${details.failed.map((f) => `${f.order}: ${f.error}`).join("; ")}`);
      return { details, warnings: failed.length ? [`No label for ${details.failed.map((f) => `${f.order} (${f.error})`).join(", ")}.`] : [] };
    };
    // A label gives the order a (new) tracking code.
    check = async (client) => {
      const now = await Promise.all(orders.map(async (o) => str((await getDocument(client, "sales_order", o.id)).tracking_code)));
      const changed = orders.filter((o, i) => now[i] && now[i] !== before.get(o.id));
      return { done: changed.length > 0, warnings: changed.length && changed.length < orders.length ? [`Only ${changed.map((o) => o.number).join(", ")} got a tracking code.`] : [] };
    };
  } else if (action === "mark_shipped") {
    endpoint = "mark_orders_as_shipped";
    payload = { sales_order_id_list: orders.map((o) => o.id) };
    head = sl ? `Označi kot ODPREMLJENA ${orders.length} naročil(a): ${list}` : `Mark ${orders.length} order(s) as SHIPPED: ${list}`;
    manualCheck = `look in Metakocka whether ${list} are marked shipped`;
  } else {
    const groupNumber = input.group_number?.trim();
    if (!groupNumber) throw new DraftError("Give group_number: the group's customer order number (an existing group's, or a new unique one).");
    // A group is identified by its parent order's customer order number.
    const { documents } = await searchDocuments(ctx.client, { docType: "sales_order", query: groupNumber, limit: 50 });
    const existingId = str(documents.find((d) => str(d.buyer_order)?.toLowerCase() === groupNumber.toLowerCase())?.mk_id);
    endpoint = "../group_expedition";
    payload = { buyer_order: groupNumber, sales_order_list: orders.map((o) => ({ count_code: o.number })) };
    if (!existingId) {
      if (!input.partner_id || !input.delivery_type) {
        throw new DraftError("A new group needs partner_id (the parent order's partner) and delivery_type (as in Metakocka's register of delivery types).");
      }
      const partner = await resolvePartner(ctx.client, input.partner_id, { foreign: "allow", what: "Group expeditions", discounts: "ignore" });
      payload = { ...payload, doc_date: toMkDate(ctx.today), partner: { mk_id: partner.id }, delivery_type: input.delivery_type.trim() };
      warnings.push(`Makes a new group ${groupNumber} (a parent sales order with status "group"). Metakocka needs a web shop named "Group expedition" and a sales order status "group" for this.`);
    }
    head = sl
      ? `${existingId ? "Dodaj v SKUPINSKO ODPREMO" : "Ustvari SKUPINSKO ODPREMO"} ${groupNumber}${orders.length ? `: ${list}` : ""}`
      : `${existingId ? "Add to GROUP EXPEDITION" : "Create GROUP EXPEDITION"} ${groupNumber}${orders.length ? `: ${list}` : ""}`;
    manualCheck = `look in Metakocka at group ${groupNumber}`;
  }

  const draft = ctx.drafts.add({
    docType: "shipping",
    language: sl ? "sl" : "en",
    partner: { id: "", addressId: "" },
    docDate: ctx.today,
    lines: [],
    totals: { net: 0, tax: 0, gross: 0, currency: "EUR" },
    payload,
    summary: [head, ...(input.delivery_type && action === "group" ? [`${sl ? "Dostava" : "Delivery"}: ${input.delivery_type}`] : []), ...(ctx.installation ? ["", `Metakocka: ${ctx.installation}`] : [])].join("\n"),
    target: { docType: "sales_order", mkId: orders[0]?.id ?? "", number: action === "group" ? input.group_number : list },
    change: { endpoint, interpret, check, manualCheck },
  });
  return { draft, warnings };
}
