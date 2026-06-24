import { generateInvoicePdf } from './pdfService.js';
import {
  isR2Enabled,
  getObjectBuffer,
  objectExists,
  putObject,
  deleteObject,
  getObjectUrl,
  getPublicObjectUrl
} from './r2Service.js';

// Caches rendered invoice PDFs in R2 to skip the expensive puppeteer render on
// repeat views/downloads/emails. The cache key embeds a version stamp derived
// from the invoice's updatedAt, so any edit (which bumps updatedAt on save)
// produces a new key and the next request renders fresh. Stale objects are
// cleaned up via invalidateInvoicePdf(); an R2 lifecycle rule can serve as a
// backstop for any orphans.

const versionStamp = (invoice) => {
  const ts = invoice.updatedAt ? new Date(invoice.updatedAt).getTime() : 0;
  return ts || 'v0';
};

export const invoicePdfCacheKey = (invoice) =>
  `invoices/${invoice.business}/${invoice._id}-${versionStamp(invoice)}.pdf`;

// Best-effort persistence of the current cache key onto the document so we can
// later delete the exact object on invalidate. Never throws into the caller.
// Persisted via updateOne with timestamps:false — a plain save() would bump
// updatedAt, which feeds the version stamp in the key, so the NEXT request would
// compute a different key and always miss the cache. We must not move updatedAt.
const rememberCacheKey = async (invoice, key) => {
  if (invoice.pdfCacheKey === key) return;
  if (typeof invoice.updateOne !== 'function') return;
  const previousKey = invoice.pdfCacheKey;
  invoice.pdfCacheKey = key; // keep the in-memory doc in sync; updatedAt untouched
  try {
    await invoice.updateOne({ $set: { pdfCacheKey: key } }, { timestamps: false });
    if (previousKey && previousKey !== key) {
      deleteObject(previousKey).catch(() => {});
    }
  } catch {
    // Saving the pointer is non-critical; the object is still cached and the
    // deterministic key will be recomputed on the next request.
  }
};

// Returns a rendered PDF Buffer, served from R2 when present and otherwise
// rendered, cached, and returned. Falls back to a direct render whenever R2 is
// disabled or unavailable so callers never break.
export const getOrRenderInvoicePdf = async (invoice, businessContext) => {
  if (!isR2Enabled()) {
    return generateInvoicePdf(invoice, businessContext);
  }

  const key = invoicePdfCacheKey(invoice);

  try {
    const cached = await getObjectBuffer(key);
    if (cached) return cached;
  } catch {
    // R2 read failed — fall through to render.
  }

  const pdf = await generateInvoicePdf(invoice, businessContext);

  // Cache write is fire-and-forget: a failed upload must not fail the response.
  putObject(key, pdf, { contentType: 'application/pdf' })
    .then((stored) => {
      if (stored) return rememberCacheKey(invoice, key);
    })
    .catch(() => {});

  return pdf;
};

// Returns a public/presigned URL for the cached PDF if it exists in R2, else
// null (caller should fall back to the API render endpoint).
export const getCachedInvoicePdfUrl = async (invoice) => {
  if (!isR2Enabled()) return null;
  const key = invoicePdfCacheKey(invoice);
  try {
    const cached = await getObjectBuffer(key);
    if (!cached) return null;
    return getObjectUrl(key);
  } catch {
    return null;
  }
};

// Durable public URL for an invoice's cached PDF — only returned when a public
// base URL is configured (R2_PUBLIC_BASE_URL) and the object exists. Safe for
// links that must outlive a presigned TTL (emails, WhatsApp/share messages).
// Returns null otherwise so callers fall back to the permanent API share URL.
export const getDurableCachedInvoicePdfUrl = async (invoice) => {
  if (!isR2Enabled()) return null;
  const url = getPublicObjectUrl(invoicePdfCacheKey(invoice));
  if (!url) return null;
  try {
    return (await objectExists(invoicePdfCacheKey(invoice))) ? url : null;
  } catch {
    return null;
  }
};

// Removes the cached object for an invoice (call on edit/cancel/delete). Deletes
// both the stored pointer key and the freshly-derived key to cover the window
// where updatedAt has already advanced. Safe to call when R2 is disabled.
export const invalidateInvoicePdf = async (invoice) => {
  if (!isR2Enabled()) return;
  const keys = new Set([invoicePdfCacheKey(invoice)]);
  if (invoice.pdfCacheKey) keys.add(invoice.pdfCacheKey);
  await Promise.all([...keys].map((key) => deleteObject(key).catch(() => {})));
};
