/**
 * Turn raw Metakocka records into compact, model-friendly objects: real
 * numbers instead of strings, ISO dates, and only the fields that matter.
 */
import type { MkRecord } from "./api.js";
import { fromMkDate } from "./dates.js";
import { asArray, bool, compact, num, numSl, round2, str } from "./util.js";

export interface DocumentSummary {
  id?: string;
  number?: string;
  type?: string;
  date?: string;
  partner?: string;
  partner_tax_id?: string;
  partner_country?: string;
  status?: string;
  currency?: string;
  net_total?: number;
  total?: number;
  paid?: number;
  open_amount?: number;
  due_date?: string;
  customer_order_ref?: string;
  delivery_type?: string;
  payment_method?: string;
  line_count?: number;
}

export function summarizeDocument(doc: MkRecord): DocumentSummary {
  const partner = (doc.partner ?? {}) as MkRecord;
  const total = num(doc.sum_all);
  const paid = num(doc.sum_paid);
  return compact({
    id: str(doc.mk_id),
    number: str(doc.count_code),
    type: str(doc.doc_type),
    date: fromMkDate(doc.doc_date),
    partner: str(partner.customer),
    partner_tax_id: str(partner.tax_id_number),
    partner_country: str(partner.country),
    status: str(doc.status_code),
    currency: str(doc.currency_code),
    net_total: num(doc.sum_basic),
    total,
    paid,
    open_amount: total !== undefined && paid !== undefined ? round2(total - paid) : undefined,
    due_date: fromMkDate(doc.duo_payment), // sic — Metakocka's field name
    customer_order_ref: str(doc.buyer_order),
    delivery_type: str(doc.delivery_type),
    payment_method: str(doc.method_of_payment),
    line_count: asArray(doc.product_list).length || undefined,
  });
}

/** Full document, cleaned: numbers parsed, dates normalised, empty fields dropped. */
export function cleanDocument(doc: MkRecord): MkRecord {
  const { opr_code: _c, opr_time_ms: _t, opr_time: _t2, ...rest } = doc;
  return compact(normalise(rest)) as MkRecord;
}

const NUMERIC_KEYS = /^(sum_.*|amount|price|price_with_tax|discount_value|free_amount|reserved_amount|weight)$/;
const DATE_KEYS = /^(doc_date|duo_payment|service_to_date|service_from_date|date|valid_from|valid_to|exp_date|sum_full_paid_when|last_paid_date)$/;

function normalise(value: unknown, key = ""): unknown {
  if (key === "mark_paid") {
    // Payment amounts are in Slovenian format ("5.985" = 5985), unlike the rest of the document.
    return asArray<MkRecord>(value).map((p) => ({ ...(normalise(p) as MkRecord), amount: numSl(p.amount) ?? p.amount }));
  }
  if (key === "additional_data" && typeof value === "string") {
    try {
      return normalise(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((v) => normalise(v, key));
  if (value && typeof value === "object") {
    const out: MkRecord = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalise(v, k);
    return out;
  }
  if (typeof value === "string") {
    // Dates first: sum_full_paid_when matches both patterns.
    if (DATE_KEYS.test(key)) return fromMkDate(value) ?? value;
    if (NUMERIC_KEYS.test(key)) return num(value) ?? value;
  }
  return value;
}

export function summarizeProduct(p: MkRecord): MkRecord {
  const byWarehouse = new Map<string, number>();
  for (const d of asArray<MkRecord>(p.amount_detail)) {
    const wh = str(d.warehouse_name) ?? str(d.warehouse_mark) ?? "?";
    byWarehouse.set(wh, round2((byWarehouse.get(wh) ?? 0) + (num(d.amount) ?? 0)));
  }
  const prices = asArray<MkRecord>(p.pricelist).map((pl) => {
    const def = (pl.price_def ?? {}) as MkRecord;
    return compact({
      pricelist: str(pl.title) ?? str(pl.count_code),
      type: str(pl.sales_purchase),
      currency: str(pl.currency_code),
      price: num(def.price),
      price_with_tax: num(def.price_with_tax),
      discount_percent: num(def.discount),
      tax_rate_percent: num(def.tax_desc),
      from_quantity: num(def.amount_from),
      to_quantity: num(def.amount_to),
      valid_from: fromMkDate(pl.valid_from),
      valid_to: fromMkDate(pl.valid_to),
      buyer: str(pl.buyer),
    });
  });
  return compact({
    id: str(p.mk_id),
    product_id: str(p.count_code),
    code: str(p.code),
    barcode: str(p.barcode),
    name: str(p.name),
    description: str(p.name_desc),
    unit: str(p.unit),
    service: bool(p.service),
    sales: bool(p.sales),
    purchasing: bool(p.purchasing),
    active: bool(p.activated ?? p.active),
    stock: num(p.amount),
    free_stock: num(p.free_amount),
    safety_stock: num(p.safety_stock),
    stock_by_warehouse: byWarehouse.size ? Object.fromEntries(byWarehouse) : undefined,
    prices,
    categories: p.category_tree_list,
  });
}

/** summarizeProduct plus everything get_product asks Metakocka for. */
export function summarizeProductDetail(p: MkRecord): MkRecord {
  const reservedByWarehouse = new Map<string, number>();
  for (const r of asArray<MkRecord>(p.reservation_detail)) {
    const wh = str(r.warehouse_name) ?? str(r.warehouse_mark) ?? "?";
    reservedByWarehouse.set(wh, round2((reservedByWarehouse.get(wh) ?? 0) + (num(r.amount) ?? 0)));
  }
  return compact({
    ...summarizeProduct(p),
    reserved_by_warehouse: reservedByWarehouse.size ? Object.fromEntries(reservedByWarehouse) : undefined,
    incoming_orders: asArray<MkRecord>(p.order_in_delivery).map((o) =>
      compact({
        amount: num(o.expect_order_amount),
        expected_date: fromMkDate(o.export_order_delivery_date), // sic
        warehouse: str(o.warehouse_mark),
      }),
    ),
    last_purchase_price: num(p.last_purchase_price),
    minimal_order_quantity: num(p.minimal_order_quantity),
    unit2: str(p.unit2),
    unit_factor: num(p.unit_factor),
    weight: num(p.weight),
    gross_weight: num(p.gross_weight),
    dimensions: [p.height, p.width, p.depth].some((v) => v !== undefined)
      ? compact({ height: num(p.height), width: num(p.width), depth: num(p.depth) })
      : undefined,
    country_of_origin: str(p.country),
    customs_code: str(p.customs_fee),
    tracks: compact({
      serial_numbers: bool(p.serial_numbers) || undefined,
      lot_numbers: bool(p.lot_numbers) || undefined,
      expiration_dates: bool(p.expiration_dates) || undefined,
    }),
    bill_of_materials: p.compound_type
      ? compact({
          type: str(p.compound_type) === "norm" ? "norm (normativ)" : "compound (kosovnica)",
          components: asArray<MkRecord>(p.compounds).map((c) =>
            compact({
              product_id: str(c.product_count_code),
              code: str(c.product_code),
              name: str(c.product_title),
              amount: num(c.amount),
            }),
          ),
        })
      : undefined,
    extra_fields: asArray<MkRecord>(p.extra_column).length
      ? Object.fromEntries(asArray<MkRecord>(p.extra_column).map((c) => [str(c.name) ?? "?", c.value]))
      : undefined,
    created: fromMkDate(p.created_ts),
  });
}

export function summarizePartner(p: MkRecord): MkRecord {
  return compact({
    id: str(p.mk_id),
    code: str(p.count_code),
    name: str(p.customer),
    tax_id: str(p.tax_id_number),
    business_entity: bool(p.business_entity),
    taxpayer: bool(p.taxpayer),
    foreign: bool(p.foreign_county), // sic
    buyer: bool(p.buyer),
    supplier: bool(p.supplier),
    contacts: asArray<MkRecord>(p.partner_contact_list).map((c) =>
      compact({ name: str(c.name), email: str(c.email), phone: str(c.phone), mobile: str(c.gsm), address: str(c.contact_address) }),
    ),
    addresses: asArray<MkRecord>(p.partner_delivery_address_list).map((a) =>
      compact({
        type: str(a.address_type),
        street: str(a.street),
        post_number: str(a.post_number),
        city: str(a.city),
        country: str(a.country),
        payment_due_days: num(a.payment_due_days),
        currency: str(a.currency),
      }),
    ),
    discounts: p.discounts,
  });
}

export function summarizeWarehouse(w: MkRecord): MkRecord {
  return compact({
    id: str(w.mk_id),
    mark: str(w.mark),
    name: str(w.name),
    main: bool(w.main_warehouse),
    active: bool(w.active),
    type: str(w.warehouse_type),
    address: [str(w.street), [str(w.post), str(w.place)].filter(Boolean).join(" "), str(w.country)]
      .filter(Boolean)
      .join(", "),
  });
}
