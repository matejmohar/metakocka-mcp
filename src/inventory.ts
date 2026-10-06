/** Pure stock calculations for the inventory tools (easy to unit-test). */
import type { MkRecord } from "./api.js";
import { fromMkDate } from "./dates.js";
import { asArray, compact, num, round2, str } from "./util.js";

/** A warehouse as it can appear on product rows: by mark, name or id. */
export interface WarehouseRef {
  id?: string;
  mark?: string;
  name?: string;
}

function sameWarehouse(row: MkRecord, wh: WarehouseRef): boolean {
  const lc = (v: unknown) => str(v)?.toLowerCase();
  return (
    (wh.mark !== undefined && (lc(row.warehouse_mark) === wh.mark.toLowerCase() || lc(row.warehouse) === wh.mark.toLowerCase())) ||
    (wh.name !== undefined && lc(row.warehouse_name) === wh.name.toLowerCase()) ||
    (wh.id !== undefined && str(row.warehouse_id) === wh.id)
  );
}

function sumAmounts(rows: MkRecord[], field = "amount"): number {
  return round2(rows.reduce((s, r) => s + (num(r[field]) ?? 0), 0));
}

/** Stock, free stock and incoming orders for one product, overall or in one warehouse. */
export function productStockPosition(p: MkRecord, warehouse?: WarehouseRef) {
  const details = asArray<MkRecord>(p.amount_detail);
  const reservations = asArray<MkRecord>(p.reservation_detail);
  const incomingRows = asArray<MkRecord>(p.order_in_delivery);

  let stock: number;
  let free: number | undefined;
  let incomingList = incomingRows;
  if (warehouse) {
    stock = sumAmounts(details.filter((d) => sameWarehouse(d, warehouse)));
    const reserved = sumAmounts(reservations.filter((r) => sameWarehouse(r, warehouse)));
    free = round2(stock - reserved);
    incomingList = incomingRows.filter((r) => sameWarehouse(r, warehouse));
  } else {
    stock = num(p.amount) ?? sumAmounts(details);
    free = num(p.free_amount);
  }
  const incoming = sumAmounts(incomingList, "expect_order_amount");
  const nextDelivery = incomingList
    .map((r) => fromMkDate(r.export_order_delivery_date)) // sic — Metakocka's field name
    .filter((d): d is string => d !== undefined)
    .sort()[0];
  return { stock, free, incoming, next_delivery: nextDelivery };
}

export type StockFlag = "out_of_stock" | "below_safety_stock" | "below_min_stock" | "over_reserved";

export interface StockAlert {
  product_id?: string;
  code?: string;
  name?: string;
  unit?: string;
  flags: StockFlag[];
  stock: number;
  free?: number;
  safety_stock?: number;
  /** Units needed to get back to the safety (or minimum) stock. */
  shortfall?: number;
  incoming?: number;
  next_delivery?: string;
  /** Shortfall not covered by incoming supplier orders. */
  suggested_order?: number;
}

export interface StockAlertOptions {
  warehouse?: WarehouseRef;
  /** Flag anything with less than this many units available, for products without a safety stock. */
  minStock?: number;
  /** Ignore products that have no safety stock set (and no minStock is given). */
  onlyWithSafetyStock?: boolean;
}

/**
 * Products that need attention: out of stock, below their safety stock (or a
 * given minimum), or with more reserved than on stock. "Available" means free
 * stock when the company uses reservations, otherwise stock.
 */
export function stockAlerts(products: MkRecord[], options: StockAlertOptions = {}): StockAlert[] {
  const alerts: StockAlert[] = [];
  for (const p of products) {
    const safety = num(p.safety_stock);
    const target = safety && safety > 0 ? safety : options.minStock;
    if (options.onlyWithSafetyStock && !(safety && safety > 0) && options.minStock === undefined) continue;

    const pos = productStockPosition(p, options.warehouse);
    const available = pos.free ?? pos.stock;
    const flags: StockFlag[] = [];
    if (available <= 0) flags.push("out_of_stock");
    if (safety && safety > 0 && available < safety) flags.push("below_safety_stock");
    else if (options.minStock !== undefined && available < options.minStock) flags.push("below_min_stock");
    if (pos.free !== undefined && pos.free < 0) flags.push("over_reserved");
    if (!flags.length) continue;

    const shortfall = target !== undefined ? round2(Math.max(0, target - available)) : undefined;
    alerts.push(
      compact({
        product_id: str(p.count_code),
        code: str(p.code),
        name: str(p.name),
        unit: str(p.unit),
        flags,
        stock: pos.stock,
        free: pos.free,
        safety_stock: safety,
        shortfall,
        incoming: pos.incoming || undefined,
        next_delivery: pos.next_delivery,
        suggested_order: shortfall !== undefined ? round2(Math.max(0, shortfall - pos.incoming)) : undefined,
      }) as StockAlert,
    );
  }
  const rank = (a: StockAlert) => (a.flags.includes("out_of_stock") ? 0 : 1);
  return alerts.sort((a, b) => rank(a) - rank(b) || (b.shortfall ?? 0) - (a.shortfall ?? 0));
}

/**
 * Stock value per warehouse at each product's last purchase price — a quick
 * estimate, not the accounting value (which may use average or FIFO cost).
 */
export function stockValuation(products: MkRecord[], top: number, warehouse?: WarehouseRef) {
  const byWarehouse = new Map<string, { warehouse: string; products: number; value: number }>();
  const valued: { product_id?: string; code?: string; name?: string; stock: number; unit_cost: number; value: number }[] = [];
  let withoutPrice = 0;
  let negative = 0;

  for (const p of products) {
    const cost = num(p.last_purchase_price);
    const details = asArray<MkRecord>(p.amount_detail).filter((d) => !warehouse || sameWarehouse(d, warehouse));
    const stock = sumAmounts(details);
    if (stock < 0) negative++;
    if (stock <= 0) continue;
    if (cost === undefined) {
      withoutPrice++;
      continue;
    }
    // amount_detail has one row per warehouse *and* serial / lot / expiry date, so sum per warehouse first.
    const perWarehouse = new Map<string, number>();
    for (const d of details) {
      const name = str(d.warehouse_name) ?? str(d.warehouse_mark) ?? "?";
      perWarehouse.set(name, (perWarehouse.get(name) ?? 0) + (num(d.amount) ?? 0));
    }
    for (const [name, amount] of perWarehouse) {
      if (amount <= 0) continue;
      const w = byWarehouse.get(name) ?? { warehouse: name, products: 0, value: 0 };
      w.products++;
      w.value = round2(w.value + amount * cost);
      byWarehouse.set(name, w);
    }
    valued.push({ product_id: str(p.count_code), code: str(p.code), name: str(p.name), stock, unit_cost: round2(cost), value: round2(stock * cost) });
  }

  valued.sort((a, b) => b.value - a.value);
  return {
    total_value: round2(valued.reduce((s, v) => s + v.value, 0)),
    products_valued: valued.length,
    by_warehouse: [...byWarehouse.values()].sort((a, b) => b.value - a.value),
    top_products: valued.slice(0, top),
    ...(withoutPrice ? { products_on_stock_without_purchase_price: withoutPrice } : {}),
    ...(negative ? { products_with_negative_stock: negative } : {}),
  };
}

/** Which way each warehouse document moves goods. */
export const MOVEMENT_DOC_TYPES = {
  warehouse_acceptance_note: "in",
  warehouse_packing_list: "out",
  transfer_order: "transfer",
} as const;

export type MovementDocType = keyof typeof MOVEMENT_DOC_TYPES;

export interface ProductRef {
  productId?: string;
  code?: string;
}

function sameProduct(line: MkRecord, product: ProductRef): boolean {
  if (product.productId && str(line.count_code)?.toLowerCase() === product.productId.toLowerCase()) return true;
  return !!product.code && str(line.code)?.toLowerCase() === product.code.toLowerCase();
}

/** Every line of the given warehouse documents that moves this product, oldest first, with totals. */
export function stockMovements(docs: MkRecord[], product: ProductRef, warehouse?: WarehouseRef) {
  const rows: MkRecord[] = [];
  let totalIn = 0;
  let totalOut = 0;

  for (const doc of docs) {
    const type = str(doc.doc_type) as MovementDocType | undefined;
    const direction = type ? MOVEMENT_DOC_TYPES[type] : undefined;
    if (!direction) continue;

    const from = str(doc.warehouse_mark_from);
    const to = str(doc.warehouse_mark_to);
    const docWarehouse = str(doc.warehouse);
    if (warehouse) {
      const touches =
        direction === "transfer"
          ? sameWarehouse({ warehouse_mark: from, warehouse_id: doc.warehouseIdFrom }, warehouse) ||
            sameWarehouse({ warehouse_mark: to, warehouse_id: doc.warehouseIdTo }, warehouse)
          : sameWarehouse({ warehouse_mark: docWarehouse }, warehouse);
      if (!touches) continue;
    }

    for (const line of asArray<MkRecord>(doc.product_list)) {
      if (!sameProduct(line, product)) continue;
      const qty = num(line.amount) ?? 0;
      // A transfer seen from one warehouse is an in or an out; seen from all, it changes nothing.
      let signed = direction === "in" ? qty : direction === "out" ? -qty : 0;
      if (direction === "transfer" && warehouse) {
        signed = sameWarehouse({ warehouse_mark: to, warehouse_id: doc.warehouseIdTo }, warehouse) ? qty : -qty;
      }
      if (signed > 0) totalIn += signed;
      else totalOut -= signed;
      const partner = (doc.partner ?? {}) as MkRecord;
      rows.push(
        compact({
          date: fromMkDate(doc.doc_date),
          number: str(doc.count_code),
          type,
          direction,
          quantity: signed || qty,
          partner: str(partner.customer),
          warehouse: direction === "transfer" ? `${from ?? "?"} → ${to ?? "?"}` : docWarehouse,
          price: num(line.price),
        }),
      );
    }
  }

  rows.sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
  return {
    movements: rows,
    total_in: round2(totalIn),
    total_out: round2(totalOut),
    net_change: round2(totalIn - totalOut),
  };
}
