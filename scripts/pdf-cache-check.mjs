// End-to-end check of the invoice PDF cache against the real R2 bucket.
//
// The cache is the one part of the PDF path where a regression is invisible: a
// stale object keeps being served and nobody sees an error — the customer just
// receives yesterday's invoice. Nothing here is mocked, so it also proves the
// bucket credentials and the renderer work together in this environment.
//
//   node scripts/pdf-cache-check.mjs              # synthetic invoice, no database needed
//   node scripts/pdf-cache-check.mjs <invoiceId>  # a real document, also checks the
//                                                 # pdfCacheKey pointer write
//
// The synthetic run writes only under its own throwaway key and cleans up after
// itself. A real run touches nothing but the pdfCacheKey pointer — which is what an
// ordinary request writes anyway — and deletes the cached object at the end, so the
// next real request re-renders it.
import { readFileSync } from 'node:fs';
import { deleteObject, getObjectBuffer, isR2Enabled, objectExists, putObject } from '../src/services/r2Service.js';
import { getOrRenderInvoicePdf, invalidateInvoicePdf, invoicePdfCacheKey } from '../src/services/invoicePdfCache.js';

const results = [];
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const bail = (message) => {
  console.error(message);
  process.exit(2);
};

if (!isR2Enabled()) {
  bail(
    'R2 is not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET).\n' +
      'With R2 off the cache is bypassed entirely and there is nothing to check.'
  );
}

// A synthetic invoice exercises the same code path: getOrRenderInvoicePdf only reads
// business/_id/updatedAt off the document, and rememberCacheKey skips a plain object
// because it has no updateOne. Its id is unmistakable so a leftover object in the
// bucket is obviously debris and not a customer's invoice.
const syntheticInvoice = () => ({
  business: 'pdf-cache-check',
  _id: `run-${Date.now()}`,
  updatedAt: new Date(),
  documentType: 'invoice',
  invoiceNumber: 'CACHE-CHECK',
  date: new Date().toISOString(),
  paymentStatus: 'unpaid',
  customerSnapshot: { name: 'Cache Check' },
  items: [{ name: 'Cache check line', quantity: 1, price: 100, total: 100 }],
  subtotal: 100,
  tax: { rate: 0, amount: 0 },
  discount: { amount: 0 },
  total: 100,
  paidAmount: 0,
  balanceDue: 100
});

const invoiceId = process.argv[2];
let disconnect = async () => {};
let invoice;
let business = { businessName: 'PDF Cache Check' };

if (invoiceId) {
  const [{ default: mongoose }, { default: Invoice }, { default: Business }] = await Promise.all([
    import('mongoose'),
    import('../src/models/Invoice.js'),
    import('../src/models/Business.js')
  ]);
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/quickinvoice');
  disconnect = () => mongoose.disconnect();
  invoice = await Invoice.findById(invoiceId);
  if (!invoice) {
    await disconnect();
    bail(`No invoice ${invoiceId} in this database.`);
  }
  business = await Business.findById(invoice.business);
} else {
  invoice = syntheticInvoice();
}

const key = invoicePdfCacheKey(invoice);
console.log(`invoice ${invoice.invoiceNumber || invoice._id}  key ${key}\n`);

// --- cold: no object, request renders and uploads --------------------------------------
await deleteObject(key).catch(() => {});
check(!(await objectExists(key)), 'starts cold', 'no cached object for this key');

const rendered = await getOrRenderInvoicePdf(invoice, business);
check(
  Buffer.isBuffer(rendered) && rendered.subarray(0, 5).toString() === '%PDF-',
  'cold request renders a PDF',
  `${rendered.length} bytes`
);

// The upload is deliberately fire-and-forget so a failed write cannot fail the
// response, which means it lands after the caller already has its buffer.
const uploaded = await (async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await objectExists(key)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
})();
check(uploaded, 'cold render uploads to R2', uploaded ? key : 'object never appeared (waited 5s)');

if (invoiceId) {
  check(invoice.pdfCacheKey === key, 'the cache key pointer is stored on the invoice', invoice.pdfCacheKey || 'not written');
}

// --- warm: request is served from R2, not re-rendered -----------------------------------
// A second render would produce the same bytes, so identical output proves nothing.
// Overwriting the object with a sentinel makes the two paths distinguishable: if the
// sentinel comes back, the bytes came from the bucket.
const SENTINEL = Buffer.from('%PDF-1.4 sentinel — served from cache');
await putObject(key, SENTINEL, { contentType: 'application/pdf' });
const warm = await getOrRenderInvoicePdf(invoice, business);
check(
  warm.equals(SENTINEL),
  'warm request is served from R2',
  warm.equals(SENTINEL) ? 'returned the cached bytes' : 're-rendered instead of reading the cache'
);

// --- an edit moves the key, so the stale object cannot be served ------------------------
// updatedAt feeds the key's version stamp. Computed on a copy: the stored document is
// never touched, and a saved edit does exactly this.
const edited = { ...(typeof invoice.toObject === 'function' ? invoice.toObject() : invoice), updatedAt: new Date(Date.now() + 60_000) };
const editedKey = invoicePdfCacheKey(edited);
check(editedKey !== key, 'an edit changes the cache key', editedKey);
check(!(await objectExists(editedKey)), 'the post-edit key misses', 'next request would render fresh');

// --- invalidate removes the object -------------------------------------------------------
await invalidateInvoicePdf(invoice);
check(!(await objectExists(key)), 'invalidateInvoicePdf deletes the cached object');
check(!(await getObjectBuffer(key)), 'the deleted object no longer reads back');

// --- the invalidate wiring is still in place ---------------------------------------------
// Deleting the object works; what silently rots is a caller that stops asking for it.
// Payment recording matters most — recording money changes the figures on the sheet.
['src/modules/payments/controller.js', 'src/modules/invoices/service.js'].forEach((path) => {
  const hits = (readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').match(/invalidateInvoicePdf\(/g) || []).length;
  check(hits > 0, `${path} still invalidates`, `${hits} call site(s)`);
});

await disconnect();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
