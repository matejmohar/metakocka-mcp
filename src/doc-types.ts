/** Metakocka document types, with the Slovenian names users see in the app. */
export const DOCUMENT_TYPES = {
  sales_offer: "Ponudba (sales offer / quote)",
  sales_order: "Prodajno naročilo (sales order)",
  sales_bill_domestic: "Račun – domači (domestic sales invoice)",
  sales_bill_foreign: "Račun – tuji (foreign sales invoice)",
  sales_bill_retail: "Račun – maloprodajni (retail sales invoice)",
  sales_bill_prepaid: "Avansni račun (prepayment invoice)",
  sales_bill_credit_note: "Dobropis (credit note)",
  purchase_order: "Naročilnica (purchase order)",
  purchase_bill_domestic: "Prejeti račun – domači (domestic purchase invoice)",
  purchase_bill_foreign: "Prejeti račun – tuji (foreign purchase invoice)",
  purchase_bill_prepaid: "Prejeti avansni račun (purchase prepayment invoice)",
  purchase_bill_credit_note: "Prejeti dobropis (purchase credit note)",
  warehouse_delivery_note: "Nalog za odpremo (delivery order)",
  warehouse_packing_list: "Dobavnica (packing list / delivery note)",
  warehouse_receiving_note: "Nalog za prejem (receiving order)",
  warehouse_acceptance_note: "Prevzemnica (goods received note)",
  transfer_order: "Medskladiščni prenos (transfer order)",
  workorder: "Delovni nalog (work order)",
  complaint: "Reklamacija (complaint / return)",
} as const;

/**
 * Words users actually say (Slovenian, informal or alternative) and the type
 * they most likely mean. Shown to the model in the document-types resource and
 * the server instructions; it is guidance, not a lookup the code relies on.
 */
export const EVERYDAY_TERMS: Record<string, DocType | DocType[]> = {
  "ponudba / predračun": "sales_offer",
  "naročilo kupca / prodajno naročilo": "sales_order",
  "račun / izdani račun / faktura": ["sales_bill_domestic", "sales_bill_foreign", "sales_bill_retail"],
  "avans / avansni račun": "sales_bill_prepaid",
  "dobropis / storno": "sales_bill_credit_note",
  "naročilo dobavitelju / naročilnica": "purchase_order",
  "prejeti račun / vhodni račun": ["purchase_bill_domestic", "purchase_bill_foreign"],
  "dobavnica / odpremnica": "warehouse_packing_list",
  "prevzemnica / prevzem blaga": "warehouse_acceptance_note",
  "medskladiščnica / prenos med skladišči": "transfer_order",
  "delovni nalog / proizvodnja": "workorder",
  "reklamacija / vračilo": "complaint",
};

export type DocType = keyof typeof DOCUMENT_TYPES;

export const DOC_TYPE_VALUES = Object.keys(DOCUMENT_TYPES) as [DocType, ...DocType[]];

export const SALES_INVOICE_TYPES = [
  "sales_bill_domestic",
  "sales_bill_foreign",
  "sales_bill_retail",
] as const satisfies readonly DocType[];

export const INVOICE_TYPES = [
  "sales_bill_domestic",
  "sales_bill_foreign",
  "sales_bill_retail",
  "sales_bill_prepaid",
  "purchase_bill_domestic",
  "purchase_bill_foreign",
  "purchase_bill_prepaid",
] as const satisfies readonly DocType[];

export function isInvoiceType(t: string): boolean {
  return (INVOICE_TYPES as readonly string[]).includes(t);
}
