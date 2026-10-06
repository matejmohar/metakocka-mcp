/**
 * Output schemas of the report tools. Clients that understand structured
 * output (charts, tables, other agents) get the result as typed data in
 * `structuredContent`; everyone else still gets the same JSON as text.
 */
import * as z from "zod/v4";

const period = z.object({ from: z.string(), to: z.string() });
const warning = z.string().optional().describe("Set when results are incomplete; say so when presenting them.");

const aging = z.object({
  not_due: z.number(),
  "1_30": z.number(),
  "31_60": z.number(),
  "61_90": z.number(),
  over_90: z.number(),
});

const openInvoice = z.object({
  id: z.string().optional(),
  number: z.string().optional(),
  type: z.string().optional(),
  partner: z.string().optional(),
  partner_tax_id: z.string().optional(),
  date: z.string().optional(),
  due_date: z.string().optional(),
  currency: z.string(),
  total: z.number(),
  paid: z.number(),
  open_amount: z.number(),
  days_overdue: z.number().describe("0 when not yet due."),
});

export const unpaidInvoicesOutput = z.object({
  as_of: z.string().describe("Today, YYYY-MM-DD; days overdue are counted to this date."),
  invoice_count: z.number(),
  totals_by_currency: z.record(
    z.string(),
    z.object({ open_total: z.number(), overdue_total: z.number(), count: z.number(), aging }),
  ),
  top_partners: z.array(
    z.object({ partner: z.string(), currency: z.string(), open_total: z.number(), count: z.number(), max_days_overdue: z.number() }),
  ),
  invoices: z.array(openInvoice).describe("Most overdue first."),
  invoices_not_listed: z.number().optional(),
  warning,
});

/** One group; the grouping value sits under the group_by name (partner, product, month or document_type). */
const summaryGroup = z
  .looseObject({
    currency: z.string(),
    documents: z.number(),
    net: z.number(),
    gross: z.number().optional().describe("Not given for product groups."),
    quantity: z.number().optional().describe("Product groups only."),
    previous_net: z.number().optional(),
    change_net: z.number().optional(),
    change_percent: z.number().optional().describe("Missing when the previous value was 0."),
  })
  .describe("The group's name is under the key named by group_by.");

const decline = z.looseObject({ currency: z.string(), net: z.number(), previous_net: z.number(), change_net: z.number() });

export const summaryOutput = z.object({
  period,
  compared_with: period.optional(),
  partner: z.object({ id: z.string(), name: z.unknown() }).optional(),
  doc_types: z.array(z.string()),
  group_by: z.enum(["partner", "product", "month", "document_type"]),
  totals_by_currency: z
    .record(z.string(), z.record(z.string(), z.number()))
    .describe("Per currency: documents, net, gross; with a comparison also previous_*, change_net and change_percent."),
  groups: z.array(summaryGroup),
  previous_groups: z.array(summaryGroup).optional().describe("group_by=month with a comparison: the earlier period's months."),
  groups_not_shown: z.number().optional(),
  biggest_declines: z.array(decline).optional().describe("Groups that fell the most, including ones with no sales this period."),
  lines_without_net_price: z.number().optional(),
  note: z.string().optional(),
  warning,
});

export const stockValuationOutput = z.object({
  as_of: z.string(),
  warehouse: z.string().describe("Warehouse name, or 'all'."),
  total_value: z.number(),
  products_valued: z.number(),
  by_warehouse: z.array(z.object({ warehouse: z.string(), products: z.number(), value: z.number() })),
  top_products: z.array(
    z.object({
      product_id: z.string().optional(),
      code: z.string().optional(),
      name: z.string().optional(),
      stock: z.number(),
      unit_cost: z.number(),
      value: z.number(),
    }),
  ),
  products_on_stock_without_purchase_price: z.number().optional(),
  products_with_negative_stock: z.number().optional(),
  note: z.string(),
  warning,
});
