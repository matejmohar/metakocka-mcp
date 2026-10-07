/**
 * Messages to customers (send_message): SMS, Viber, WhatsApp or e-mail,
 * through the connections set up in Metakocka. A message can't be recalled,
 * so the summary shows exactly who gets what, and a call that didn't answer
 * is never repeated automatically: the user checks the sent messages first.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { findDocumentIdByNumber, INVOICE_REPORT_ID, printDocumentPdf, type MkRecord } from "../api.js";
import type { DocType } from "../doc-types.js";
import { MetakockaError } from "../client.js";
import { asArray, str } from "../util.js";
import { DraftError, type BuildContext } from "./document.js";
import type { Draft } from "./drafts.js";

export const CHANNELS = ["sms", "viber", "whatsapp", "email"] as const;

export interface MessageInput {
  channel?: (typeof CHANNELS)[number];
  /** sms / viber / whatsapp: the phone number. */
  to_number?: string;
  /** Country of the number (name or ISO code), so Metakocka reads it right. */
  country?: string;
  /** Text of an SMS / Viber / WhatsApp message. */
  text?: string;
  /** SMS: sender name (must be registered for Slovenia). */
  sender_name?: string;
  /** e-mail */
  to_emails?: string[];
  cc_emails?: string[];
  from_email?: string;
  from_name?: string;
  subject?: string;
  /** E-mail body, plain text (sent as simple HTML). */
  body?: string;
  marketing?: boolean;
  /** E-mail: documents from Metakocka to attach as PDF, e.g. an invoice. */
  attach_documents?: { doc_type: string; number: string; report_id?: string }[];
  /** E-mail: files on this computer to attach (only when the server runs locally). */
  attachment_paths?: string[];
  language?: "sl" | "en";
}

/** Document types printed with the standard invoice print-out; others need their report_id. */
const INVOICE_PRINT = new Set([
  "sales_bill_domestic",
  "sales_bill_foreign",
  "sales_bill_retail",
  "sales_bill_prepaid",
  "sales_bill_credit_note",
  "purchase_bill_domestic",
  "purchase_bill_foreign",
  "purchase_bill_credit_note",
]);
const ATTACHMENTS_MAX_BYTES = 10 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".xml": "application/xml", ".txt": "text/plain", ".csv": "text/csv" };

interface Attachment {
  file_name: string;
  content_type: string;
  file_data_base64: string;
  bytes: number;
}

/** Print each document as PDF and read each local file, within the size limit. */
async function collectAttachments(ctx: BuildContext & { localFiles?: boolean }, input: MessageInput): Promise<Attachment[]> {
  const files: Attachment[] = [];
  for (const d of input.attach_documents ?? []) {
    const reportId = d.report_id ?? (INVOICE_PRINT.has(d.doc_type) ? INVOICE_REPORT_ID : undefined);
    if (!reportId) throw new DraftError(`${d.doc_type} ${d.number}: give its report_id (the print-out to attach); only invoices and credit notes print without one.`);
    const id = await findDocumentIdByNumber(ctx.client, d.doc_type as DocType, d.number);
    if (!id) throw new DraftError(`No ${d.doc_type} ${d.number} in Metakocka to attach.`);
    const bytes = await printDocumentPdf(ctx.client, id, reportId);
    files.push({ file_name: `${d.number.replace(/[^\p{L}\p{N}._-]+/gu, "-")}.pdf`, content_type: "application/pdf", file_data_base64: Buffer.from(bytes).toString("base64"), bytes: bytes.length });
  }
  for (const path of input.attachment_paths ?? []) {
    if (!ctx.localFiles) throw new DraftError("Attaching files from disk is only possible when the server runs on the user's computer (not in HTTP mode).");
    if (!isAbsolute(path)) throw new DraftError(`${path}: give an absolute path.`);
    const type = CONTENT_TYPES[extname(path).toLowerCase()];
    if (!type) throw new DraftError(`${path}: only ${Object.keys(CONTENT_TYPES).join(", ")} files can be attached.`);
    let size: number;
    try {
      const s = await stat(path);
      if (!s.isFile()) throw new Error("not a file");
      size = s.size;
    } catch {
      throw new DraftError(`Can't read ${path}.`);
    }
    if (size > ATTACHMENTS_MAX_BYTES) throw new DraftError(`${path} is larger than 10 MB.`);
    const data = await readFile(path);
    files.push({ file_name: basename(path), content_type: type, file_data_base64: data.toString("base64"), bytes: data.length });
  }
  if (files.reduce((s, f) => s + f.bytes, 0) > ATTACHMENTS_MAX_BYTES) throw new DraftError("The attachments are larger than 10 MB together.");
  return files;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function buildMessageDraft(ctx: BuildContext & { localFiles?: boolean }, input: MessageInput): Promise<{ draft: Draft; warnings: string[] }> {
  const channel = input.channel;
  if (!channel) throw new DraftError("Give channel: sms, viber, whatsapp or email.");
  const sl = (input.language ?? "sl") === "sl";
  const warnings: string[] = [];
  let message: MkRecord;
  let lines: string[];
  let attachments: Attachment[] = [];
  if (channel === "email") {
    for (const k of ["to_number", "country", "text", "sender_name"] as const) if (input[k] !== undefined) throw new DraftError(`${k} is not for e-mail (use to_emails, subject, body).`);
    const to = (input.to_emails ?? []).map((e) => e.trim()).filter(Boolean);
    const cc = (input.cc_emails ?? []).map((e) => e.trim()).filter(Boolean);
    if (!to.length) throw new DraftError("Give to_emails.");
    const bad = [...to, ...cc, input.from_email ?? ""].filter((e) => !EMAIL.test(e));
    if (!input.from_email) throw new DraftError("Give from_email: an address on a domain verified for sending in Metakocka's e-mail settings.");
    if (bad.length) throw new DraftError(`Not valid e-mail addresses: ${bad.join(", ")}.`);
    if (!input.subject?.trim()) throw new DraftError("Give the subject.");
    if (!input.body?.trim()) throw new DraftError("Give the body.");
    attachments = await collectAttachments(ctx, input);
    message = {
      type: "email",
      email_from: input.from_email,
      ...(input.from_name ? { email_sender_name: input.from_name } : {}),
      email_to_list: to.join(","),
      ...(cc.length ? { email_cc_list: cc.join(",") } : {}),
      email_subject: input.subject.trim(),
      email_html_body: input.body.trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join(""),
      message_type: input.marketing ? "marketing" : "transactional",
      sender_message_id: "m1",
      ...(attachments.length ? { attached_file_list: attachments.map(({ bytes: _b, ...f }) => f) } : {}),
    };
    warnings.push("Metakocka accepts the e-mail even when from_email's domain isn't verified for sending, and then it silently isn't delivered; check with get_email_events afterwards.");
    lines = [
      `${sl ? "Od" : "From"}: ${input.from_name ? `${input.from_name} <${input.from_email}>` : input.from_email}`,
      `${sl ? "Za" : "To"}: ${to.join(", ")}`,
      ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
      `${sl ? "Zadeva" : "Subject"}: ${input.subject.trim()}`,
      ...(attachments.length ? [`${sl ? "Priponke" : "Attachments"}: ${attachments.map((f) => `${f.file_name} (${Math.max(1, Math.round(f.bytes / 1024))} KB)`).join(", ")}`] : []),
      "",
      input.body.trim(),
    ];
  } else {
    for (const k of ["to_emails", "cc_emails", "from_email", "from_name", "subject", "body", "attach_documents", "attachment_paths"] as const) {
      if (input[k] !== undefined) throw new DraftError(`${k} is only for e-mail (use to_number and text).`);
    }
    if (channel !== "sms" && input.sender_name !== undefined) throw new DraftError("sender_name is only for SMS.");
    const number = input.to_number?.trim();
    if (!number || number.replace(/\D/g, "").length < 6) throw new DraftError("Give to_number: the customer's phone number.");
    if (!input.text?.trim()) throw new DraftError("Give the text.");
    if (!input.country) warnings.push("Without country Metakocka may misread a number without an international prefix.");
    if (channel === "viber") warnings.push("Viber connections may only allow approved templates, not free text; Metakocka refuses otherwise.");
    message = {
      type: channel,
      to_number: number,
      ...(input.country ? { receiver_country: input.country } : {}),
      message: input.text.trim(),
      message_type: input.marketing ? "marketing" : "transactional",
      ...(channel === "sms" && input.sender_name ? { sender_message_id: input.sender_name } : {}),
    };
    lines = [`${sl ? "Za" : "To"}: ${number}${input.country ? ` (${input.country})` : ""}`, ...(input.sender_name ? [`${sl ? "Pošiljatelj" : "Sender"}: ${input.sender_name}`] : []), "", input.text.trim()];
  }

  const label = { sms: "SMS", viber: "Viber", whatsapp: "WhatsApp", email: "E-mail" }[channel];
  const draft = ctx.drafts.add({
    docType: "message",
    language: sl ? "sl" : "en",
    partner: { id: "", addressId: "" },
    docDate: ctx.today,
    lines: [],
    totals: { net: 0, tax: 0, gross: 0, currency: "EUR" },
    payload: { message_list: [message] },
    summary: "",
    change: {
      endpoint: "../send_message",
      interpret: (r) => {
        const row = asArray<MkRecord>(r.message_list)[0];
        if (row && str(row.status) === "error") throw new MetakockaError(`Metakocka did not send the message: ${str(row.error_desc) ?? "error"}`);
        return { mkId: str(row?.mk_id), details: { message_id: str(row?.mk_id), status: str(row?.status) } };
      },
      manualCheck: channel === "email" ? "check the sent e-mails in Metakocka" : "check with get_messages whether it was sent",
      // The audit log keeps the attachments' names and sizes, not their content.
      ...(attachments.length
        ? { logPayload: { message_list: [{ ...message, attached_file_list: attachments.map((f) => ({ file_name: f.file_name, content_type: f.content_type, bytes: f.bytes })) }] } }
        : {}),
    },
  });
  draft.summary = [
    `${sl ? `POŠLJI ${label} (takoj, ni ga mogoče preklicati)` : `SEND ${label} (right away, can't be recalled)`}${input.marketing ? (sl ? " — trženjsko" : " — marketing") : ""}`,
    ...lines,
    ...(ctx.installation ? ["", `Metakocka: ${ctx.installation}`] : []),
  ].join("\n");
  return { draft, warnings };
}
