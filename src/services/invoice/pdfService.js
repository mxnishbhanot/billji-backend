import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { InvoiceDocument } from './InvoiceDocument.js';

// Invoices render in-process with @react-pdf/renderer: no browser, no child process,
// no warm-up. Rendering is synchronous JS on the event loop, which is the trade for
// the memory a headless Chromium used to hold.
export const generateInvoicePdf = (invoice, businessContext, options) =>
  renderToBuffer(React.createElement(InvoiceDocument, { invoice, business: businessContext, options }));
