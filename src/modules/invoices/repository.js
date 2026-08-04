import Invoice from '../../models/Invoice.js';

export const createInvoiceRecord = async (payload, { session } = {}) => {
  const [invoice] = await Invoice.create([payload], { session });
  return invoice;
};

// Tombstoned rather than removed. The caller has already proven the document is
// unprocessed (no payments, stock or ledger entries), so nothing points at it — but the
// delta stream still needs a record to carry the deletion to every other device.
export const deleteInvoiceRecord = (invoice, { userId = null, session } = {}) =>
  invoice.softDelete({ userId, session });
