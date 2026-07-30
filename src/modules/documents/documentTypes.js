// One table describing how each sales document behaves. Everything else in this module
// reads these flags rather than branching on documentType, so adding a type means adding
// a row here plus its number prefix.
//
//  stockDirection  -1 deducts, +1 restores, 0 leaves stock alone
//  postsLedger     books accounting entries on issue
//  countsAsSale    included in reports/GST returns as a supply
//  sourceField     the document it must be raised against, if any
export const DOCUMENT_RULES = {
  quotation: {
    label: 'Quotation',
    prefixField: 'quotationPrefix',
    defaultPrefix: 'QTN',
    stockDirection: 0,
    postsLedger: false,
    countsAsSale: false,
    convertsTo: 'invoice',
    sourceField: null,
    // A quote is an offer, not a supply: nothing moves until it becomes an invoice.
    allowsExpiry: true
  },
  delivery_challan: {
    label: 'Delivery challan',
    prefixField: 'challanPrefix',
    defaultPrefix: 'DC',
    // Goods physically leave, so stock moves — but no money is recognised.
    stockDirection: -1,
    postsLedger: false,
    countsAsSale: false,
    convertsTo: 'invoice',
    sourceField: null,
    allowsExpiry: false
  },
  credit_note: {
    label: 'Credit note',
    prefixField: 'creditNotePrefix',
    defaultPrefix: 'CN',
    // A return puts goods back on the shelf and reverses the money.
    stockDirection: 1,
    postsLedger: true,
    countsAsSale: false,
    convertsTo: null,
    sourceField: 'sourceInvoice',
    allowsExpiry: false
  }
};

export const DOCUMENT_KINDS = Object.keys(DOCUMENT_RULES);

export const rulesFor = (documentType) => DOCUMENT_RULES[documentType] || null;

export const prefixFor = (business, documentType) => {
  const rules = rulesFor(documentType);
  if (!rules) return business?.invoicePrefix || 'INV';
  return business?.[rules.prefixField] || rules.defaultPrefix;
};
