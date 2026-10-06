/**
 * New register entries: a partner (add_partner) or a product (json/product_add),
 * drafted, confirmed and saved like documents. Opt-in on their own
 * (METAKOCKA_WRITE=partners / products). Before drafting, the register is
 * searched so the same partner or product isn't added twice: a matching tax
 * number or product code refuses the draft, a similar name is shown in the
 * summary. Metakocka's API can delete products but not partners.
 */
import { listAllProducts, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { MetakockaError } from "../client.js";
import { asArray, bool, str } from "../util.js";
import type { CommitContext, CommitOutcome } from "./commit.js";
import { DraftError, findPartners, type BuildContext } from "./document.js";
import type { Draft } from "./drafts.js";

export interface PartnerInput {
  name?: string;
  street?: string;
  post_number?: string;
  city?: string;
  country?: string;
  tax_id?: string;
  registration_number?: string;
  /** Legal entity (pravna oseba / s.p.), as opposed to a private person. */
  business_entity?: boolean;
  /** VAT registered (davčni zavezanec). */
  taxpayer?: boolean;
  role?: "supplier" | "buyer" | "both";
  email?: string;
  language?: "sl" | "en";
}

export interface ProductInput {
  name?: string;
  code?: string;
  unit?: string;
  service?: boolean;
  purchasing?: boolean;
  sales?: boolean;
  description?: string;
  language?: "sl" | "en";
}

const HOME = new Set(["slovenija", "slovenia", "si"]);
const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** "SI 12345678" and "12345678" are the same Slovenian tax number. */
const taxDigits = (s: string | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^SI(?=\d{8}$)/, "");

export async function buildPartnerDraft(ctx: BuildContext, input: PartnerInput): Promise<{ draft: Draft; warnings: string[] }> {
  const name = input.name?.trim();
  const street = input.street?.trim();
  const postNumber = input.post_number?.trim();
  const city = input.city?.trim();
  const country = input.country?.trim() || "Slovenija";
  if (!name) throw new DraftError("Give the partner's name as on its documents.");
  if (!street || !postNumber || !city) throw new DraftError("Give the partner's street, post_number and city as on its documents.");
  if (!input.role) throw new DraftError("Give role: supplier, buyer or both.");
  if (input.business_entity === undefined) throw new DraftError("Give business_entity: true for a company or s.p., false for a private person.");
  if (input.taxpayer === undefined) throw new DraftError("Give taxpayer: whether the partner is VAT registered (davčni zavezanec), as on its documents.");
  const foreign = !HOME.has(country.toLowerCase());
  const taxId = input.tax_id?.trim() || undefined;
  if (input.business_entity && !taxId) throw new DraftError("A company needs its tax_id (davčna / VAT number) as on its documents.");

  // The same tax number refuses; a similar name is shown.
  const warnings: string[] = [];
  if (taxId) {
    const candidates = [taxId, taxDigits(taxId), `SI${taxDigits(taxId)}`].filter((v, i, a) => v && a.indexOf(v) === i);
    for (const t of candidates) {
      const same = (await findPartners(ctx.client, { taxNumber: t })).find((p) => taxDigits(str(p.tax_id_number)) === taxDigits(taxId));
      if (same) {
        throw new DraftError(`${str(same.customer)} (id ${str(same.mk_id)}) already has the tax number ${str(same.tax_id_number)}. Use that partner; nothing is added.`);
      }
    }
  }
  const similar = await similarPartners(ctx.client, name);
  if (similar.some((p) => norm(str(p.customer)) === norm(name) && !taxId)) {
    const p = similar.find((x) => norm(str(x.customer)) === norm(name))!;
    throw new DraftError(`${str(p.customer)} (id ${str(p.mk_id)}) is already in Metakocka. Use that partner; nothing is added.`);
  }
  if (similar.length) warnings.push(`Similar partners already exist: ${similar.map((p) => `${str(p.customer)} (id ${str(p.mk_id)})`).join("; ")}. Make sure this is a new one.`);

  const payload: MkRecord = {
    partner: {
      business_entity: String(input.business_entity),
      taxpayer: String(input.taxpayer),
      foreign_county: String(foreign),
      supplier: String(input.role !== "buyer"),
      buyer: String(input.role !== "supplier"),
      customer: name,
      ...(taxId ? { tax_id_number: taxId } : {}),
      ...(input.registration_number?.trim() ? { registration_number: input.registration_number.trim() } : {}),
      street,
      post_number: postNumber,
      place: city,
      country,
      ...(input.email?.trim() ? { partner_contact: { useCustomerAsContact: "true", email: input.email.trim() } } : {}),
    },
  };
  const language = input.language ?? "sl";
  const address = `${street}, ${postNumber} ${city}, ${country}`;
  const draft = ctx.drafts.add({
    docType: "partner",
    language,
    partner: { id: "", name, taxId, addressId: "", address },
    docDate: ctx.today,
    lines: [],
    totals: { net: 0, tax: 0, gross: 0, currency: "EUR" },
    payload,
    summary: "",
  });
  const sl = language === "sl";
  const yesNo = (b: boolean) => (sl ? (b ? "da" : "ne") : b ? "yes" : "no");
  const role = { supplier: sl ? "dobavitelj" : "supplier", buyer: sl ? "kupec" : "buyer", both: sl ? "dobavitelj in kupec" : "supplier and buyer" }[input.role];
  draft.summary = [
    `${sl ? "Dodaj PARTNERJA" : "Add a PARTNER"} ${name}${taxId ? ` (${taxId})` : ""}`,
    address,
    [
      role,
      input.business_entity ? (sl ? "pravna oseba" : "legal entity") : sl ? "fizična oseba" : "private person",
      `${sl ? "davčni zavezanec" : "VAT registered"}: ${yesNo(input.taxpayer)}`,
      `${sl ? "tujina" : "foreign"}: ${yesNo(foreign)}`,
    ].join(" · "),
    ...(input.registration_number?.trim() ? [`${sl ? "Matična številka" : "Registration number"}: ${input.registration_number.trim()}`] : []),
    ...(input.email?.trim() ? [`Email: ${input.email.trim()}`] : []),
    ...(similar.length ? ["", `⚠ ${sl ? "Podobni partnerji že obstajajo" : "Similar partners exist"}: ${similar.map((p) => str(p.customer)).join("; ")}`] : []),
    ...(ctx.installation ? ["", `Metakocka: ${ctx.installation}`] : []),
  ].join("\n");
  return { draft, warnings };
}

/** Partners whose name contains the new name's first word, and that word-wise resemble it. */
async function similarPartners(client: MetakockaClient, name: string): Promise<MkRecord[]> {
  const word = name.split(/[\s,.]+/).find((w) => w.length >= 3) ?? name;
  const words = new Set(name.toLowerCase().split(/[\s,.]+/).filter((w) => w.length >= 3 && !["d.o.o", "doo", "s.p", "ltd", "limited", "gmbh", "inc"].includes(w)));
  return (await findPartners(client, { name: word }))
    .filter((p) => {
      const theirs = (str(p.customer) ?? "").toLowerCase().split(/[\s,.]+/);
      return theirs.some((w) => words.has(w));
    })
    .slice(0, 5);
}

export async function buildProductDraft(ctx: BuildContext, input: ProductInput): Promise<{ draft: Draft; warnings: string[] }> {
  const name = input.name?.trim();
  const code = input.code?.trim();
  const unit = input.unit?.trim();
  if (!name) throw new DraftError("Give the product's name.");
  if (!code) throw new DraftError("Give a short product code (šifra, up to 20 characters), e.g. in the style of the existing codes.");
  if (code.length > 20) throw new DraftError("The code (šifra) can have at most 20 characters.");
  if (!unit) throw new DraftError('Give the unit, e.g. "kos", "ura" or "mesec".');
  if (input.service === undefined) throw new DraftError("Give service: true for a service, false for goods.");
  const purchasing = input.purchasing ?? false;
  const sales = input.sales ?? false;
  if (!purchasing && !sales) throw new DraftError("A product is for purchasing, for sales, or both: set purchasing and/or sales.");

  const { products } = await listAllProducts(ctx.client, {}, 20_000);
  const sameCode = products.find((p) => norm(str(p.code)) === norm(code));
  if (sameCode) throw new DraftError(`The code ${code} is already used by ${str(sameCode.name)} (id ${str(sameCode.mk_id)}). Use that product, or pick another code.`);
  const sameName = products.find((p) => norm(str(p.name)) === norm(name));
  if (sameName) throw new DraftError(`${str(sameName.name)} (code ${str(sameName.code)}, id ${str(sameName.mk_id)}) is already in Metakocka. Use that product; nothing is added.`);
  const words = new Set(name.toLowerCase().split(/\s+/).filter((w) => w.length >= 4));
  const similar = products.filter((p) => (str(p.name) ?? "").toLowerCase().split(/\s+/).some((w) => words.has(w))).slice(0, 5);
  const warnings = similar.length
    ? [`Similar products already exist: ${similar.map((p) => `${str(p.name)} (${str(p.code)}, id ${str(p.mk_id)})`).join("; ")}. Make sure a new one is needed.`]
    : [];

  const payload: MkRecord = {
    code,
    name,
    ...(input.description?.trim() ? { name_desc: input.description.trim() } : {}),
    unit,
    service: String(input.service),
    sales: String(sales),
    purchasing: String(purchasing),
  };
  const language = input.language ?? "sl";
  const sl = language === "sl";
  const draft = ctx.drafts.add({
    docType: "product",
    language,
    partner: { id: "", addressId: "" },
    docDate: ctx.today,
    lines: [],
    totals: { net: 0, tax: 0, gross: 0, currency: "EUR" },
    payload,
    summary: "",
  });
  const use = [purchasing && (sl ? "nabavni" : "purchasing"), sales && (sl ? "prodajni" : "sales")].filter(Boolean).join(sl ? " in " : " and ");
  draft.summary = [
    `${sl ? "Dodaj IZDELEK" : "Add a PRODUCT"} ${name} (${sl ? "šifra" : "code"} ${code})`,
    [`${sl ? "enota" : "unit"} ${unit}`, input.service ? (sl ? "storitev" : "service") : sl ? "blago" : "goods", use].join(" · "),
    ...(input.description?.trim() ? [`${sl ? "Opis" : "Description"}: ${input.description.trim()}`] : []),
    ...(sales ? [sl ? "Brez cenika: ceno podaš na dokumentu." : "No price list: give the price on documents."] : []),
    ...(similar.length ? ["", `⚠ ${sl ? "Podobni izdelki že obstajajo" : "Similar products exist"}: ${similar.map((p) => `${str(p.name)} (${str(p.code)})`).join("; ")}`] : []),
    ...(ctx.installation ? ["", `Metakocka: ${ctx.installation}`] : []),
  ].join("\n");
  return { draft, warnings };
}

/** Save a partner or product draft: one call, never retried, then read back. */
export async function commitRecord(ctx: CommitContext, draft: Draft): Promise<CommitOutcome> {
  const base = { draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation };
  draft.status = "committing";
  await ctx.journal({ ...base, event: "attempt", payload: draft.payload });
  let response: MkRecord;
  try {
    response =
      draft.docType === "partner"
        ? await ctx.client.call("add_partner", draft.payload, { idempotent: false, timeoutMs: ctx.timeoutMs })
        : await ctx.client.call("json/product_add", draft.payload, { idempotent: false, timeoutMs: ctx.timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof MetakockaError && error.oprCode !== undefined) {
      draft.status = "open";
      await ctx.journal({ ...base, event: "failed", error: message });
      return { status: "rejected", message: `Metakocka refused it; nothing was saved: ${message}` };
    }
    draft.status = "unknown";
    await ctx.journal({ ...base, event: "unknown", error: message });
    return { status: "unknown", message: unknownMessage(message) };
  }
  const mkId = str(response.mk_id);
  if (!mkId) {
    draft.status = "unknown";
    await ctx.journal({ ...base, event: "unknown", response });
    return { status: "unknown", message: unknownMessage("Metakocka answered without an id") };
  }
  return finishRecord(ctx, draft, mkId, str(response.count_code), []);
}

/** After an unknown outcome: look the partner (by name) or product (by code) up before anything else. */
export async function resolveUnknownRecord(ctx: CommitContext, draft: Draft): Promise<CommitOutcome | { status: "not_found" }> {
  let found: MkRecord | undefined;
  if (draft.docType === "partner") {
    const p = draft.payload.partner as MkRecord;
    found = (await findPartners(ctx.client, { name: str(p.customer) })).find((x) => norm(str(x.customer)) === norm(str(p.customer)));
  } else {
    const { products } = await listAllProducts(ctx.client, {}, 20_000);
    found = products.find((x) => norm(str(x.code)) === norm(str(draft.payload.code)));
  }
  const base = { draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation };
  await ctx.journal({ ...base, event: "resolved", found: found ? str(found.mk_id) : null });
  if (!found) {
    draft.status = "open";
    return { status: "not_found" };
  }
  return finishRecord(ctx, draft, str(found.mk_id)!, str(found.count_code), ["The save had not answered; this entry was found afterwards."]);
}

async function finishRecord(ctx: CommitContext, draft: Draft, mkId: string, number: string | undefined, warnings: string[]): Promise<CommitOutcome> {
  draft.status = "committed";
  draft.result = { mkId, number };
  try {
    if (draft.docType === "partner") {
      const stored = (await findPartners(ctx.client, { partnerId: mkId }))[0];
      const want = draft.payload.partner as MkRecord;
      if (!stored) warnings.push("CHECK IN METAKOCKA: the new partner can't be read back.");
      else if (norm(str(stored.customer)) !== norm(str(want.customer)) || bool(stored.supplier) !== (want.supplier === "true")) {
        warnings.push(`CHECK IN METAKOCKA: the partner was stored as ${str(stored.customer)} (supplier: ${str(stored.supplier)}).`);
      }
      const address = asArray<MkRecord>(stored?.partner_delivery_address_list)[0];
      if (address) draft.result.addressId = str(address.mk_id);
    }
  } catch (error) {
    warnings.push(`Saved, but reading it back failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await ctx.journal({ draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation, event: "committed", mk_id: mkId, number, warnings });
  return { status: "created", mk_id: mkId, number, ...(draft.result.addressId ? { address_id: draft.result.addressId } : {}), warnings };
}

function unknownMessage(reason: string): string {
  return (
    `It is not known whether it was saved (${reason}). Do NOT draft it again. ` +
    "Call commit_document with the same draft_id: it first looks it up in Metakocka."
  );
}
