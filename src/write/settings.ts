/**
 * Opt-in settings for creating documents in Metakocka. Without
 * METAKOCKA_WRITE the server registers no write tools and stays read-only.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, envValue } from "../config.js";

/** What the write tools can create or change, by the name that turns it on. */
export const WRITABLE_TYPES = {
  offers: ["sales_offer"],
  /** Invoices, prepayment invoices (avansni računi) and an invoice's status. */
  invoices: ["sales_bill_domestic", "sales_bill_foreign", "sales_bill_prepaid", "invoice_update"],
  /** Credit notes we issue and the ones suppliers send (prejeti dobropis). */
  credit_notes: ["sales_bill_credit_note", "purchase_bill_credit_note"],
  purchase_invoices: ["purchase_bill_domestic", "purchase_bill_foreign"],
  purchase_orders: ["purchase_order"],
  /** Sales orders, invoices from them, and changes to an order (status, tracking code, shipping, invoicing it). */
  orders: ["sales_order", "order_update"],
  /** Packing lists, goods received notes, delivery and receiving orders, transfers between warehouses, work orders. */
  warehouse: [
    "warehouse_packing_list",
    "warehouse_delivery_note",
    "warehouse_receiving_note",
    "warehouse_acceptance_note",
    "transfer_order",
    "workorder",
    "warehouse_update",
  ],
  partners: ["partner", "partner_update"],
  products: ["product", "product_update"],
  /** Payments on existing invoices, offers and orders (put_transaction). */
  payments: ["payment"],
  /** Delivery labels, marking orders shipped, group expeditions. */
  shipping: ["shipping"],
  /** Complaints, returns and replacements (reklamacije). */
  complaints: ["complaint"],
  /** SMS, Viber, WhatsApp and e-mail to customers. */
  messages: ["message"],
} as const;
export type WritableDocType = (typeof WRITABLE_TYPES)[keyof typeof WRITABLE_TYPES][number];
export const INVOICE_TYPES: readonly WritableDocType[] = ["sales_bill_domestic", "sales_bill_foreign"];
export const PURCHASE_TYPES: readonly WritableDocType[] = WRITABLE_TYPES.purchase_invoices;
export const WAREHOUSE_TYPES = ["warehouse_packing_list", "warehouse_delivery_note", "warehouse_receiving_note", "warehouse_acceptance_note"] as const;
/** Register entries rather than documents: new partners and products. */
export type RecordType = "partner" | "product";
export const isRecordType = (t: WritableDocType): t is RecordType => t === "partner" || t === "product";
/** Changes to something that already exists, and messages: saved with their own calls, not put_document. */
export const CHANGE_TYPES = [
  "payment",
  "order_update",
  "invoice_update",
  "warehouse_update",
  "partner_update",
  "product_update",
  "shipping",
  "complaint",
  "message",
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
export const isChangeType = (t: WritableDocType): t is ChangeType => (CHANGE_TYPES as readonly string[]).includes(t);
/** New documents, drafted with draft_document. */
export type NewDocumentType = Exclude<WritableDocType, RecordType | ChangeType>;
export const isNewDocumentType = (t: WritableDocType): t is NewDocumentType => !isRecordType(t) && !isChangeType(t);

/** The extension's checkbox for each permission, one environment variable each. */
const WRITE_FLAGS: Record<keyof typeof WRITABLE_TYPES, string> = {
  offers: "METAKOCKA_WRITE_OFFERS",
  invoices: "METAKOCKA_WRITE_INVOICES",
  credit_notes: "METAKOCKA_WRITE_CREDIT_NOTES",
  purchase_invoices: "METAKOCKA_WRITE_PURCHASE_INVOICES",
  purchase_orders: "METAKOCKA_WRITE_PURCHASE_ORDERS",
  orders: "METAKOCKA_WRITE_ORDERS",
  warehouse: "METAKOCKA_WRITE_WAREHOUSE",
  partners: "METAKOCKA_WRITE_PARTNERS",
  products: "METAKOCKA_WRITE_PRODUCTS",
  payments: "METAKOCKA_WRITE_PAYMENTS",
  shipping: "METAKOCKA_WRITE_SHIPPING",
  complaints: "METAKOCKA_WRITE_COMPLAINTS",
  messages: "METAKOCKA_WRITE_MESSAGES",
};

export interface WriteSettings {
  docTypes: WritableDocType[];
  /**
   * How the user confirms each document before it is saved:
   * - "client" (default): a confirmation prompt (MCP elicitation) where the client supports it; otherwise the
   *   client's own approval of the commit_document call, which must carry the draft's exact summary.
   * - "elicitation": only a confirmation prompt; clients without elicitation can't save at all.
   * - "never": no confirmation.
   */
  confirm: "client" | "elicitation" | "never";
  /** Timeout for put_document; Metakocka can take well over the read timeout to insert a document. */
  timeoutMs: number;
  /** JSONL audit log of every write; undefined = log to stderr (HTTP server). */
  logPath?: string;
}

const DEFAULT_WRITE_TIMEOUT_MS = 120_000;

/**
 * METAKOCKA_WRITE=offers,invoices,… (any keys of WRITABLE_TYPES), or
 * METAKOCKA_WRITE_<KEY>=true for each, which is what the Claude Desktop extension's checkboxes set,
 * enables the write tools for those documents and registers. Returns
 * undefined when writing is off. Throws ConfigError for values it doesn't
 * understand, so a typo never silently changes what the server may do.
 */
export function writeSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): WriteSettings | undefined {
  const raw = envValue(env, "METAKOCKA_WRITE");
  const names = raw && !["off", "false", "0", "no"].includes(raw.toLowerCase()) ? raw.split(",") : [];
  for (const [name, variable] of Object.entries(WRITE_FLAGS)) if (flag(env, variable)) names.push(name);
  if (!names.length) return undefined;

  const docTypes: WritableDocType[] = [];
  for (const name of names.map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const types = WRITABLE_TYPES[name as keyof typeof WRITABLE_TYPES];
    if (!types) {
      throw new ConfigError(`METAKOCKA_WRITE: unknown value "${name}". Allowed: ${Object.keys(WRITABLE_TYPES).join(", ")}.`);
    }
    for (const type of types) if (!docTypes.includes(type)) docTypes.push(type);
  }

  // "true"/"false" come from the extension's "Confirm each document" checkbox.
  const confirmRaw = (envValue(env, "METAKOCKA_WRITE_CONFIRM") ?? "client").toLowerCase();
  const confirm = confirmRaw === "true" ? "client" : confirmRaw === "false" ? "never" : confirmRaw;
  if (confirm !== "client" && confirm !== "elicitation" && confirm !== "never") {
    throw new ConfigError('METAKOCKA_WRITE_CONFIRM must be "client" (default), "elicitation" or "never".');
  }

  const timeoutRaw = envValue(env, "METAKOCKA_WRITE_TIMEOUT_SECONDS");
  const timeoutMs = timeoutRaw === undefined ? DEFAULT_WRITE_TIMEOUT_MS : Number(timeoutRaw) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError("METAKOCKA_WRITE_TIMEOUT_SECONDS must be a positive number of seconds.");
  }

  return {
    docTypes,
    confirm,
    timeoutMs,
    logPath: envValue(env, "METAKOCKA_WRITE_LOG") ?? join(homedir(), ".metakocka-mcp", "writes.jsonl"),
  };
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = envValue(env, name)?.toLowerCase();
  if (value === undefined || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new ConfigError(`${name} must be true or false.`);
}
