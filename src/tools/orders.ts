/**
 * Order management around web-shop orders: messages to customers, proof of
 * delivery, delivery price lists and the customer blacklist. All read-only.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deliveryPriceLists, findDocumentIdByNumber, getDocument, getEmailEvents, getMessages, getProofOfDelivery, searchBlacklist, type MkRecord } from "../api.js";
import { MetakockaError } from "../client.js";
import { envValue, pdfDirectory } from "../config.js";
import { addDays, fromMkDate, mkDayStart, todayInLjubljana } from "../dates.js";
import { asArray, compact, num, str } from "../util.js";
import { isoDate } from "./documents.js";
import { READ_ONLY, run, type ToolContext, type ToolResult } from "./shared.js";

const MESSAGE_TYPES = ["sms", "viber", "whatsapp"] as const;

/** A sales order by its number or id, with what identifies it to the delivery service. */
async function loadOrder(ctx: ToolContext, number: string | undefined, id: string | undefined): Promise<MkRecord> {
  const client = ctx.getClient();
  const orderId = id ?? (number ? await findDocumentIdByNumber(client, "sales_order", number) : undefined);
  if (!orderId) throw new MetakockaError(`No sales order ${number} in Metakocka. Find it with search_documents (doc_type sales_order) or find_by_tracking_code.`);
  return getDocument(client, "sales_order", orderId);
}

export function registerOrderTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_messages",
    {
      title: "Messages to customers",
      description:
        "SMS, Viber and WhatsApp messages Metakocka exchanged with customers (sporočila): the whole thread for one sales " +
        "order, or every thread with a reply from a customer since a date. Each message has its direction (outbound = sent " +
        "from Metakocka, inbound = the customer's reply), status and times. E-mails are not included.",
      inputSchema: z.object({
        order_number: z.string().min(1).optional().describe("A sales order's number: that order's threads."),
        order_id: z.string().min(1).optional().describe("Or the sales order's Metakocka id."),
        replies_since: isoDate.optional().describe("Without an order: threads with customer replies since this date (default: 7 days ago)."),
        types: z.array(z.enum(MESSAGE_TYPES)).min(1).default([...MESSAGE_TYPES]).describe("Which channels (default all)."),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const client = ctx.getClient();
        if ((args.order_number || args.order_id) && args.replies_since) throw new MetakockaError("Give either an order or replies_since, not both.");
        const order = args.order_number || args.order_id ? await loadOrder(ctx, args.order_number, args.order_id) : undefined;
        const since = order ? undefined : args.replies_since ?? addDays(todayInLjubljana(ctx.now()), -7);

        const threads: Record<string, unknown>[] = [];
        for (const type of args.types) {
          const list = await getMessages(client, { type, docId: order ? str(order.mk_id) : undefined, inboundSince: since && mkDayStart(since) });
          for (const t of list) {
            const messages = asArray<MkRecord>(t.message_list).map((m) =>
              compact({
                direction: str(m.direction),
                text: str(m.message),
                status: str(m.status),
                created: str(m.create_time),
                received: str(m.receive_time) ?? str(m.received_time),
                seen: str(m.seen_time),
              }),
            );
            threads.push(
              compact({
                type: str(t.type) ?? type,
                customer_number: str(t.to_number),
                from: str(t.from_number),
                order: str(t.doc_count_code),
                order_id: str(t.doc_id),
                customer_order: str(t.customer_order),
                messages,
                last_message: messages.at(-1)?.created,
                awaiting_reply: messages.at(-1)?.direction === "inbound" ? true : undefined,
              }),
            );
          }
        }
        threads.sort((a, b) => String(b.last_message ?? "").localeCompare(String(a.last_message ?? "")));
        return {
          ...(order ? { order: str(order.count_code) } : { replies_since: since }),
          threads: threads.length,
          ...(threads.length ? {} : { note: order ? "No SMS, Viber or WhatsApp messages for this order." : "No customer replies in this period." }),
          awaiting_reply: threads.filter((t) => t.awaiting_reply).length,
          message_threads: threads,
        };
      }),
  );

  const embedded = ctx.pdfDelivery === "embedded";
  server.registerTool(
    "get_proof_of_delivery",
    {
      title: "Proof of delivery",
      description:
        "The delivery service's proof of delivery (potrdilo o dostavi) for a sales order's parcel, as a file " +
        (embedded ? "returned with the answer. " : "saved on this computer (by default in Downloads/Metakocka). ") +
        "Give the sales order (its customer order number and tracking code are read from it), or the customer order number " +
        "and tracking code directly. Only for delivery services that provide one.",
      inputSchema: z.object({
        order_number: z.string().min(1).optional().describe("The sales order's number in Metakocka."),
        order_id: z.string().min(1).optional().describe("Or its Metakocka id."),
        buyer_order: z.string().min(1).optional().describe("Or the customer's order number (naročilo kupca) …"),
        tracking_code: z.string().min(1).optional().describe("… with the parcel's tracking code."),
      }),
      annotations: embedded ? READ_ONLY : { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args): Promise<ToolResult> => {
      let file: { name: string; bytes: Uint8Array; contentType: string; path?: string } | undefined;
      const result = await run(async () => {
        let buyerOrder = args.buyer_order;
        let trackingCode = args.tracking_code;
        let number: string | undefined;
        if (args.order_number || args.order_id) {
          const order = await loadOrder(ctx, args.order_number, args.order_id);
          number = str(order.count_code);
          buyerOrder ??= str(order.buyer_order);
          trackingCode ??= str(order.tracking_code);
          if (!buyerOrder) throw new MetakockaError(`Sales order ${number} has no customer order number (buyer_order), which Metakocka needs for this.`);
          if (!trackingCode) throw new MetakockaError(`Sales order ${number} has no tracking code yet: it hasn't been handed to a delivery service.`);
        }
        if (!buyerOrder || !trackingCode) throw new MetakockaError("Give the sales order, or buyer_order and tracking_code.");

        const { bytes, contentType } = await getProofOfDelivery(ctx.getClient(), buyerOrder, trackingCode);
        const extension = contentType.includes("pdf") ? "pdf" : contentType.includes("png") ? "png" : contentType.includes("jpeg") ? "jpg" : "bin";
        const name = `proof_of_delivery_${(number ?? buyerOrder).replace(/[^\p{L}\p{N}._-]+/gu, "-")}.${extension}`;
        const sizeKb = Math.round(bytes.length / 102.4) / 10;
        file = { name, bytes, contentType };
        const base = { order: number, buyer_order: buyerOrder, tracking_code: trackingCode, size_kb: sizeKb };
        if (embedded) return { ...base, file_name: name };
        const dir = ctx.pdfDir ?? pdfDirectory();
        const path = join(dir, name);
        await mkdir(dir, { recursive: true });
        await writeFile(path, bytes);
        file.path = path;
        return { ...base, saved_to: path };
      });
      if (file && embedded) {
        result.content.push({
          type: "resource",
          resource: { uri: `metakocka://file/${encodeURIComponent(file.name)}`, mimeType: file.contentType, blob: Buffer.from(file.bytes).toString("base64") },
        });
      } else if (file?.path) {
        result.content.push({ type: "resource_link", uri: pathToFileURL(file.path).href, name: file.name, mimeType: file.contentType });
      }
      return result;
    },
  );

  server.registerTool(
    "get_delivery_prices",
    {
      title: "Delivery price lists",
      description:
        "What delivery costs, per delivery type (dostavna služba, e.g. GLS Slovenija): the price list rows by package weight " +
        "with transport, delivery, cash-on-delivery (odkupnina) and return costs, and their validity. Also which parcel " +
        "statuses count as delivered or returned.",
      inputSchema: z.object({
        delivery_type: z.string().optional().describe("Only delivery types whose name contains this text."),
        valid_on: isoDate.optional().describe("Only rows valid on this date (default: all rows)."),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const lists = await deliveryPriceLists(ctx.getClient());
        const wanted = args.delivery_type?.toLowerCase();
        const result = lists
          .filter((l) => !wanted || str(l.delivery_type)?.toLowerCase().includes(wanted))
          .map((l) =>
            compact({
              delivery_type: str(l.delivery_type),
              currency: str(l.currency_code) ?? "EUR",
              delivered_statuses: asArray<string>(l.package_delivered_status_list),
              returned_statuses: asArray<string>(l.package_return_status_list),
              rows: asArray<MkRecord>(l.pricelist_rows)
                .map((r) => ({
                  up_to_kg: num(r.package_weight),
                  transport: num(r.transport_cost),
                  delivery: num(r.package_delivery_cost),
                  cash_on_delivery: num(r.cod_cost),
                  return: num(r.return_cost),
                  valid_from: fromMkDate(r.valid_from),
                  valid_to: fromMkDate(r.valid_to),
                }))
                .filter((r) => !args.valid_on || ((!r.valid_from || r.valid_from <= args.valid_on) && (!r.valid_to || r.valid_to >= args.valid_on)))
                .sort((a, b) => (a.up_to_kg ?? 0) - (b.up_to_kg ?? 0)),
            }),
          );
        return result.length
          ? { delivery_types: result }
          : { delivery_types: [], note: lists.length ? "No delivery type matches." : "No delivery price lists in Metakocka." };
      }),
  );

  server.registerTool(
    "check_blacklist",
    {
      title: "Check the blacklist",
      description:
        "Whether a customer is on the company's blacklist (črna lista, e.g. for refused cash-on-delivery parcels), by e-mail, " +
        "phone number or name. Use before accepting a risky order.",
      inputSchema: z
        .object({
          email: z.string().min(3).optional(),
          phone: z.string().min(3).optional().describe("Mobile number (GSM)."),
          name: z.string().min(2).optional().describe("Full name."),
        })
        .refine((a) => a.email || a.phone || a.name, { message: "Give email, phone or name." }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const hits = await searchBlacklist(ctx.getClient(), { ...args, userEmail: envValue(process.env, "METAKOCKA_USER_EMAIL") });
        return {
          blacklisted: hits.length > 0,
          matches: hits.map((p) => compact({ name: str(p.customer), email: str(p.email), phone: str(p.gsm) ?? str(p.phone) })),
        };
      }),
  );

  server.registerTool(
    "get_email_events",
    {
      title: "E-mail delivery",
      description:
        "What happened to e-mails sent through Metakocka (e.g. with draft_message): sent, delivered, opened, clicked, " +
        "bounced (with the reason) or reported as spam. Give the message ids from the send result. Events arrive over time; " +
        "right after sending there may be none yet.",
      inputSchema: z.object({ message_ids: z.array(z.string().min(1)).min(1).max(1000).describe("Message ids (mk_id) from the send result.") }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const rows = await getEmailEvents(ctx.getClient(), [...new Set(args.message_ids)]);
        const messages = rows.map((r) => {
          const events = asArray<MkRecord>(r.events)
            .map((e) => compact({ time: str(e.event_time), event: str(e.event_type), reason: str(e.event_sub_type) }))
            .sort((a, b) => String(a.time ?? "").localeCompare(String(b.time ?? "")));
          const kinds = new Set(events.map((e) => e.event));
          const status = kinds.has("hard_bounce") || kinds.has("complaint")
            ? "failed"
            : kinds.has("open") || kinds.has("click")
              ? "opened"
              : kinds.has("delivered")
                ? "delivered"
                : kinds.has("soft_bounce") || kinds.has("delivery_delay")
                  ? "delayed"
                  : kinds.has("send")
                    ? "sent"
                    : "no events yet";
          return { message_id: str(r.mk_id), status, events };
        });
        return { messages };
      }),
  );
}
