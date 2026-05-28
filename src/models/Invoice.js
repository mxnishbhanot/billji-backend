import mongoose from 'mongoose';
import { salesDocumentSchema } from './SalesDocument.js';

const Invoice = mongoose.models.Invoice || mongoose.model('Invoice', salesDocumentSchema, 'salesdocuments');

export default Invoice;
