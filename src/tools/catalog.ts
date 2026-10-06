import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { getStock, listProducts, searchPartners, type MkRecord } from "../api.js";
import { MetakockaError } from "../client.js";
import { summarizePartner, summarizeProduct, summarizeProductDetail, summarizeWarehouse } from "../summarize.js";
import { list, num, round2, str } from "../util.js";
import { cachedWarehouses, READ_ONLY, resolveWarehouse, run, type ToolContext } from "./shared.js";

export function registerCatalogTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description:
        "Search the product catalogue (artikli). Matches partially on name, product code or Metakocka product id. " +
        "Optionally includes stock per warehouse and prices from all price lists. Paged (use next_offset).",
      inputSchema: z.object({
        name: z.string().optional().describe("Part of the product name."),
        code: z.string().optional().describe("Part of the product code (šifra artikla / SKU)."),
        product_id: z.string().optional().describe("Part of the Metakocka product id (Id artikla / count_code)."),
        category: z.string().optional().describe("Only products in this category (exact category name)."),
        active_only: z.boolean().default(true).describe("Only active products."),
        sales_only: z.boolean().default(false).describe("Only products marked for sale."),
        include_stock: z.boolean().default(false).describe("Include stock and free (unreserved) stock per warehouse."),
        include_prices: z.boolean().default(false).describe("Include prices from all price lists (ceniki)."),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const { products, offset, limit } = await listProducts(ctx.getClient(), {
          name: args.name,
          code: args.code,
          productId: args.product_id,
          category: args.category,
          activeOnly: args.active_only,
          salesOnly: args.sales_only,
          includeStock: args.include_stock,
          includePrices: args.include_prices,
          limit: args.limit,
          offset: args.offset,
        });
        return {
          returned: products.length,
          offset,
          ...(products.length === limit ? { next_offset: offset + products.length } : {}),
          products: products.map(summarizeProduct),
        };
      }),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description:
        "One product (artikel) in full: stock, reserved and free amounts per warehouse, incoming supplier orders, " +
        "prices on all price lists (ceniki), last purchase price, minimum order quantity, bill of materials (kosovnica / normativ), " +
        "categories, units, weight and dimensions. Identify it by its exact product id or code; use search_products to find it first.",
      inputSchema: z
        .object({
          product_id: z.string().optional().describe("Exact Metakocka product id (Id artikla / count_code)."),
          code: z.string().optional().describe("Exact product code (šifra artikla / SKU)."),
        })
        .refine((a) => a.product_id || a.code, { message: "Provide product_id or code." }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const { products } = await listProducts(ctx.getClient(), {
          productId: args.product_id,
          code: args.product_id ? undefined : args.code,
          exact: true,
          includeStock: true,
          includePrices: true,
          includeReservations: true,
          includeIncoming: true,
          includeLastPurchasePrice: true,
          includeCompound: true,
          includeCategories: true,
          limit: 10,
        });
        const wantedId = args.product_id?.toLowerCase();
        const wantedCode = args.code?.toLowerCase();
        const product = products.find((p) =>
          wantedId ? str(p.count_code)?.toLowerCase() === wantedId : str(p.code)?.toLowerCase() === wantedCode,
        );
        if (!product) {
          throw new MetakockaError(
            `No product with ${args.product_id ? `id "${args.product_id}"` : `code "${args.code}"`}. Use search_products for a partial match.`,
          );
        }
        return summarizeProductDetail(product);
      }),
  );

  server.registerTool(
    "get_stock",
    {
      title: "Get stock levels",
      description:
        "Current stock (zaloga) per product and warehouse, with reserved and free amounts when the company uses reservations. " +
        "Filter by product codes and/or warehouse. Without filters it lists all stock, paged.",
      inputSchema: z.object({
        product_codes: z
          .string()
          .optional()
          .describe("Comma-separated product codes (or web-shop SKUs), e.g. 'ABC-1,ABC-2'."),
        warehouse: z
          .string()
          .optional()
          .describe("Warehouse name, mark or id (see list_warehouses). Comma-separate several."),
        hide_zero: z.boolean().default(false).describe("Leave out rows with zero stock."),
        limit: z.number().int().min(1).max(1000).default(200),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const client = ctx.getClient();
        const warehouses = await cachedWarehouses(ctx);
        const byId = new Map(warehouses.map((w) => [str(w.mk_id) ?? "", w]));

        const warehouseIds = args.warehouse
          ? list(args.warehouse).map((wanted) => str(resolveWarehouse(warehouses, wanted).mk_id)!)
          : undefined;

        const { rows, offset, limit } = await getStock(client, {
          productCodes: list(args.product_codes),
          warehouseIds,
          limit: args.limit,
          offset: args.offset,
        });

        const stock = rows
          .map((r: MkRecord) => {
            const w = byId.get(str(r.warehouse_id) ?? "");
            return {
              product_id: str(r.count_code),
              product: str(r.title),
              warehouse: w ? (str(w.name) ?? str(w.mark)) : str(r.warehouse_id),
              amount: num(r.amount) ?? 0,
              reserved: num(r.reserved_amount),
              free: num(r.free_amount),
              unit: str(r.unit),
              microlocation: str(r.microlocation),
            };
          })
          .filter((r) => !args.hide_zero || r.amount !== 0);

        const totals = new Map<string, { product_id?: string; product?: string; amount: number; free?: number }>();
        for (const r of stock) {
          const key = r.product_id ?? r.product ?? "?";
          const t = totals.get(key) ?? { product_id: r.product_id, product: r.product, amount: 0 };
          t.amount = round2(t.amount + r.amount);
          if (r.free !== undefined) t.free = round2((t.free ?? 0) + r.free);
          totals.set(key, t);
        }

        return {
          returned: rows.length,
          offset,
          ...(rows.length === limit ? { next_offset: offset + rows.length } : {}),
          totals_per_product: [...totals.values()],
          rows: stock,
        };
      }),
  );

  server.registerTool(
    "list_warehouses",
    {
      title: "List warehouses",
      description: "All warehouses (skladišča) of the company, with id, mark, name and address.",
      annotations: READ_ONLY,
    },
    async () => run(async () => (await cachedWarehouses(ctx)).map(summarizeWarehouse)),
  );

  server.registerTool(
    "search_partners",
    {
      title: "Search partners",
      description:
        "Find customers and suppliers (partnerji) by name, tax number, e-mail, phone or id. " +
        "Returns contacts, addresses, payment terms and partner discounts. Use get_partner for one partner's open balance.",
      inputSchema: z
        .object({
          name: z.string().optional().describe("Part of the partner name."),
          tax_number: z.string().optional().describe("Tax / VAT number, e.g. SI12345678."),
          email: z.string().optional(),
          phone: z.string().optional(),
          partner_id: z.string().optional().describe("Metakocka partner id."),
          limit: z.number().int().min(1).max(100).default(20).describe("Maximum partners to return."),
        })
        .refine((a) => a.name || a.tax_number || a.email || a.phone || a.partner_id, {
          message: "Provide at least one of name, tax_number, email, phone or partner_id.",
        }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const partners = await searchPartners(ctx.getClient(), {
          name: args.name,
          taxNumber: args.tax_number,
          email: args.email,
          phone: args.phone,
          partnerId: args.partner_id,
          withDiscounts: true,
        });
        return {
          total_found: partners.length,
          partners: partners.slice(0, args.limit).map(summarizePartner),
        };
      }),
  );
}
