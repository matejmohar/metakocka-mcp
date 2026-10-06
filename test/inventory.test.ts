import { describe, expect, it } from "vitest";
import { productStockPosition, stockAlerts, stockMovements, stockValuation } from "../src/inventory.js";

const product = (over: Record<string, unknown> = {}) => ({
  count_code: "P1",
  code: "WID",
  name: "Widget",
  unit: "kos",
  amount: "10",
  free_amount: "10",
  amount_detail: [
    { warehouse_mark: "glavno", warehouse_name: "Glavno skladišče", amount: "6" },
    { warehouse_mark: "mb", warehouse_name: "Maribor", amount: "4" },
  ],
  ...over,
});

const MARIBOR = { id: "2", mark: "mb", name: "Maribor" };

describe("productStockPosition", () => {
  it("uses one warehouse's stock, reservations and incoming orders when asked", () => {
    const p = product({
      reservation_detail: [{ warehouse_mark: "mb", amount: "3" }],
      order_in_delivery: [
        { warehouse_mark: "mb", expect_order_amount: "5", export_order_delivery_date: "2026-10-20" },
        { warehouse_mark: "mb", expect_order_amount: "2", export_order_delivery_date: "2026-10-12" },
        { warehouse_mark: "glavno", expect_order_amount: "100", export_order_delivery_date: "2026-10-01" },
      ],
    });
    expect(productStockPosition(p, MARIBOR)).toEqual({ stock: 4, free: 1, incoming: 7, next_delivery: "2026-10-12" });
    expect(productStockPosition(p)).toMatchObject({ stock: 10, free: 10, incoming: 107, next_delivery: "2026-10-01" });
  });
});

describe("stockAlerts", () => {
  it("flags out of stock, below safety stock and over-reserved products, out of stock first", () => {
    const products = [
      product({ count_code: "OK", safety_stock: "5" }),
      product({ count_code: "LOW", safety_stock: "20", order_in_delivery: [{ expect_order_amount: "4" }] }),
      product({ count_code: "OUT", amount: "2", free_amount: "-1", amount_detail: [] }),
      product({ count_code: "NOSAFETY" }),
    ];
    const alerts = stockAlerts(products);
    expect(alerts.map((a) => [a.product_id, a.flags])).toEqual([
      ["OUT", ["out_of_stock", "over_reserved"]],
      ["LOW", ["below_safety_stock"]],
    ]);
    expect(alerts[1]).toMatchObject({ shortfall: 10, incoming: 4, suggested_order: 6 });
  });

  it("applies min_stock to products without a safety stock", () => {
    const alerts = stockAlerts([product({ count_code: "NOSAFETY" })], { minStock: 12 });
    expect(alerts[0]).toMatchObject({ flags: ["below_min_stock"], shortfall: 2 });
  });

  it("can skip products without a safety stock", () => {
    expect(stockAlerts([product({ amount: "0", free_amount: "0" })], { onlyWithSafetyStock: true })).toEqual([]);
  });
});

describe("stockValuation", () => {
  it("values stock per warehouse at the last purchase price", () => {
    const r = stockValuation(
      [
        product({ last_purchase_price: "2.5000000000" }),
        product({ count_code: "P2", amount_detail: [{ warehouse_name: "Maribor", amount: "3" }] }), // no price
        product({ count_code: "P3", amount_detail: [{ warehouse_name: "Maribor", amount: "-2" }], last_purchase_price: "9" }),
      ],
      5,
    );
    expect(r.total_value).toBe(25);
    expect(r.by_warehouse).toEqual([
      { warehouse: "Glavno skladišče", products: 1, value: 15 },
      { warehouse: "Maribor", products: 1, value: 10 },
    ]);
    expect(r.products_on_stock_without_purchase_price).toBe(1);
    expect(r.products_with_negative_stock).toBe(1);
  });

  it("limits to one warehouse", () => {
    expect(stockValuation([product({ last_purchase_price: "1" })], 5, MARIBOR).total_value).toBe(4);
  });
});

describe("stockMovements", () => {
  const docs = [
    {
      doc_type: "warehouse_packing_list",
      count_code: "DOB-2",
      doc_date: "2026-09-20+02:00",
      warehouse: "mb",
      partner: { customer: "ACME" },
      product_list: [{ count_code: "P1", amount: "3", price: "10" }, { count_code: "OTHER", amount: "99" }],
    },
    {
      doc_type: "warehouse_acceptance_note",
      count_code: "PRE-1",
      doc_date: "2026-09-01+02:00",
      warehouse: "glavno",
      product_list: [{ code: "wid", amount: "20" }],
    },
    {
      doc_type: "transfer_order",
      count_code: "SM-1",
      doc_date: "2026-09-10+02:00",
      warehouse_mark_from: "glavno",
      warehouse_mark_to: "mb",
      product_list: [{ count_code: "P1", amount: "5" }],
    },
  ];

  it("lists the product's movements in date order with totals", () => {
    const r = stockMovements(docs, { productId: "P1", code: "WID" });
    expect(r.movements.map((m) => [m.number, m.direction, m.quantity])).toEqual([
      ["PRE-1", "in", 20],
      ["SM-1", "transfer", 5],
      ["DOB-2", "out", -3],
    ]);
    expect(r).toMatchObject({ total_in: 20, total_out: 3, net_change: 17 });
  });

  it("treats transfers as in or out when looking at one warehouse", () => {
    const r = stockMovements(docs, { productId: "P1" }, MARIBOR);
    expect(r.movements.map((m) => [m.number, m.quantity])).toEqual([
      ["SM-1", 5],
      ["DOB-2", -3],
    ]);
    expect(r.net_change).toBe(2);
  });
});
