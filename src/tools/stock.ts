import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { listAllProducts, listProducts, listWarehouses, searchAcrossTypes } from "../api.js";
import { MetakockaError } from "../client.js";
import { addDays, daysBetween, todayInLjubljana } from "../dates.js";
import {
  MOVEMENT_DOC_TYPES,
  productStockPosition,
  stockAlerts,
  stockMovements,
  stockValuation,
  type MovementDocType,
  type StockFlag,
  type WarehouseRef,
} from "../inventory.js";
import { str } from "../util.js";
import { isoDate } from "./documents.js";
import { READ_ONLY, resolveWarehouse, run, truncationWarning, warehouseRef, type ToolContext } from "./shared.js";

const warehouseArg = z
  .string()
  .optional()
  .describe("Only this warehouse: name, mark or id (see list_warehouses). Default: all warehouses.");

const maxProductsArg = z
  .number()
  .int()
  .min(1)
  .max(20000)
  .default(5000)
  .describe("Safety cap on products read from Metakocka (1000 per call).");

const MOVEMENT_TYPES = Object.keys(MOVEMENT_DOC_TYPES) as [MovementDocType, ...MovementDocType[]];

export function registerStockTools(server: McpServer, ctx: ToolContext): void {
  async function optionalWarehouse(wanted: string | undefined): Promise<WarehouseRef | undefined> {
    if (!wanted) return undefined;
    return warehouseRef(resolveWarehouse(await listWarehouses(ctx.getClient()), wanted));
  }

  server.registerTool(
    "low_stock",
    {
      title: "Low stock",
      description:
        "Products that need attention (nizka zaloga, zmanjkuje, za naročit): out of stock, below their safety stock (varnostna zaloga) " +
        "or a minimum you give, or with more reserved than on stock. Shows free stock, units missing, supplier orders already on the way " +
        "and how much is still left to order. Use it for 'what do we need to reorder?'.",
      inputSchema: z.object({
        warehouse: warehouseArg,
        min_stock: z
          .number()
          .min(0)
          .optional()
          .describe("Also flag products without a safety stock that have fewer than this many units available."),
        only_with_safety_stock: z
          .boolean()
          .default(false)
          .describe("Ignore products that have no safety stock set (unless min_stock is given)."),
        sales_only: z.boolean().default(true).describe("Only products marked for sale."),
        category: z.string().optional().describe("Only products in this category (exact name)."),
        max_listed: z.number().int().min(1).max(500).default(50).describe("How many products to list (out of stock first, then biggest shortfall)."),
        max_products: maxProductsArg,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const warehouse = await optionalWarehouse(args.warehouse);
        const { products, truncated } = await listAllProducts(
          ctx.getClient(),
          {
            activeOnly: true,
            goodsOnly: true,
            salesOnly: args.sales_only,
            category: args.category,
            includeStock: true,
            includeReservations: warehouse !== undefined,
            includeIncoming: true,
          },
          args.max_products,
        );
        const alerts = stockAlerts(products, {
          warehouse,
          minStock: args.min_stock,
          onlyWithSafetyStock: args.only_with_safety_stock,
        });
        const counts: Partial<Record<StockFlag, number>> = {};
        for (const a of alerts) for (const f of a.flags) counts[f] = (counts[f] ?? 0) + 1;
        return {
          warehouse: warehouse?.name ?? "all",
          products_checked: products.length,
          products_flagged: alerts.length,
          flag_counts: counts,
          products: alerts.slice(0, args.max_listed),
          ...(alerts.length > args.max_listed ? { products_not_listed: alerts.length - args.max_listed } : {}),
          ...(warehouse ? { note: "Safety stock is set per product, not per warehouse; it is compared with this warehouse's free stock." } : {}),
          ...(truncated ? { warning: "More products exist than max_products; raise it or filter by category for a complete check." } : {}),
        };
      }),
  );

  server.registerTool(
    "stock_valuation",
    {
      title: "Stock valuation",
      description:
        "Estimated value of goods on stock (vrednost zaloge) per warehouse and the most valuable products, at each product's " +
        "last purchase price. An estimate, not the accounting value (which may use average or FIFO cost).",
      inputSchema: z.object({
        warehouse: warehouseArg,
        category: z.string().optional().describe("Only products in this category (exact name)."),
        top: z.number().int().min(1).max(200).default(20).describe("How many of the most valuable products to list."),
        max_products: maxProductsArg,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const warehouse = await optionalWarehouse(args.warehouse);
        const { products, truncated } = await listAllProducts(
          ctx.getClient(),
          { goodsOnly: true, category: args.category, includeStock: true, includeLastPurchasePrice: true },
          args.max_products,
        );
        return {
          as_of: todayInLjubljana(ctx.now()),
          warehouse: warehouse?.name ?? "all",
          ...stockValuation(products, args.top, warehouse),
          note: "Valued at the last purchase price, in the company's home currency.",
          ...(truncated ? { warning: "More products exist than max_products; the total is incomplete." } : {}),
        };
      }),
  );

  server.registerTool(
    "stock_movements",
    {
      title: "Stock movements",
      description:
        "History of one product's stock (kartica artikla, gibanje zaloge) for a period: goods received (prevzemnice), shipped " +
        "(dobavnice) and moved between warehouses (medskladiščnice), in date order with partner and warehouse, plus totals in and out " +
        "and the current stock. Reads every warehouse document in the period, so keep the period short for busy companies.",
      inputSchema: z
        .object({
          product_id: z.string().optional().describe("Exact Metakocka product id (count_code)."),
          code: z.string().optional().describe("Exact product code (šifra artikla / SKU)."),
          date_from: isoDate.optional().describe("Start of the period (default: 90 days ago)."),
          date_to: isoDate.optional().describe("End of the period (default: today)."),
          warehouse: warehouseArg,
          doc_types: z
            .array(z.enum(MOVEMENT_TYPES))
            .min(1)
            .default([...MOVEMENT_TYPES])
            .describe("Warehouse document types to read."),
          max_rows: z.number().int().min(1).max(1000).default(200).describe("How many movements to list (the most recent ones)."),
          max_documents: z.number().int().min(1).max(5000).default(1000).describe("Safety cap on documents fetched per type."),
        })
        .refine((a) => a.product_id || a.code, { message: "Provide product_id or code." }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const today = todayInLjubljana(ctx.now());
        const dateTo = args.date_to ?? today;
        const dateFrom = args.date_from ?? addDays(dateTo, -90);
        if (daysBetween(dateFrom, dateTo) < 0) throw new MetakockaError("date_from must be on or before date_to.");

        const client = ctx.getClient();
        const warehouse = await optionalWarehouse(args.warehouse);
        const { products } = await listProducts(client, {
          productId: args.product_id,
          code: args.product_id ? undefined : args.code,
          exact: true,
          includeStock: true,
          includeReservations: warehouse !== undefined,
          limit: 10,
        });
        const wanted = (args.product_id ?? args.code)!.toLowerCase();
        const product = products.find((p) => str(args.product_id ? p.count_code : p.code)?.toLowerCase() === wanted);
        if (!product) {
          throw new MetakockaError(`No product with ${args.product_id ? "id" : "code"} "${args.product_id ?? args.code}". Use search_products first.`);
        }

        const { documents, truncatedTypes } = await searchAcrossTypes(
          client,
          args.doc_types,
          { dateFrom, dateTo },
          args.max_documents,
        );
        const result = stockMovements(documents, { productId: str(product.count_code), code: str(product.code) }, warehouse);
        const position = productStockPosition(product, warehouse);
        const rows = result.movements.slice(-args.max_rows);
        return {
          product: { product_id: str(product.count_code), code: str(product.code), name: str(product.name), unit: str(product.unit) },
          warehouse: warehouse?.name ?? "all",
          period: { from: dateFrom, to: dateTo },
          current_stock: position.stock,
          ...(position.free !== undefined ? { current_free_stock: position.free } : {}),
          total_in: result.total_in,
          total_out: result.total_out,
          net_change: result.net_change,
          movements: rows,
          ...(result.movements.length > rows.length ? { earlier_movements_not_listed: result.movements.length - rows.length } : {}),
          note:
            "Retail bills and work orders that move stock directly are not included. Without a warehouse filter, " +
            "transfers between warehouses do not change the total.",
          ...truncationWarning(truncatedTypes, "shorten the period or raise max_documents"),
        };
      }),
  );
}
