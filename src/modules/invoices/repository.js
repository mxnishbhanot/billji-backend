import Invoice from '../../models/Invoice.js';

export const createInvoiceRecord = async (payload, { session } = {}) => {
  const [invoice] = await Invoice.create([payload], { session });
  return invoice;
};

export const deleteInvoiceRecord = (invoice, { session } = {}) => invoice.deleteOne({ session });
