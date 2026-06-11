import puppeteer from 'puppeteer';
import { buildInvoiceHtml } from './invoiceHtml.js';

// A single shared headless-Chromium instance renders every invoice. Launching is
// expensive (~hundreds of ms) so we keep one browser warm and open a page per PDF.
let browserPromise = null;

const getBrowser = async () => {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    // If a launch fails, clear the cache so the next call retries instead of
    // resolving a rejected promise forever.
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
};

export const generateInvoicePdf = async (invoice, businessContext) => {
  const html = buildInvoiceHtml(invoice, businessContext, { mode: 'print' });
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
};

export const closePdfBrowser = async () => {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    if (browser) await browser.close();
  }
};
