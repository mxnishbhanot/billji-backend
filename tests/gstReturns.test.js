import crypto from 'crypto';
import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Business from '../src/models/Business.js';
import Invoice from '../src/models/Invoice.js';
import { b2clThresholdFor, buildGstr1, buildGstr3b, parsePeriod } from '../src/modules/gst/service.js';
import { gstr1SectionCsv } from '../src/modules/gst/csvSections.js';
import { calculateInvoiceTotals } from '../src/utils/invoiceMath.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);
const PERIOD = '2026-06';
const inPeriod = new Date(2026, 5, 15);

let seq = 0;

/** Seeds an issued invoice whose GST fields are computed by the real math. */
const seedInvoice = async (
  business,
  { items, supplyType = 'intra', gstin = '', placeOfSupplyCode = '27', placeOfSupply = 'Maharashtra', date = inPeriod, documentStatus = 'issued', discountValue = 0 }
) => {
  seq += 1;
  const totals = calculateInvoiceTotals({ items, supplyType, discountType: 'flat', discountValue });
  const number = `GST-${String(seq).padStart(4, '0')}`;

  return Invoice.create({
    business: business._id,
    documentType: 'invoice',
    documentNumber: number,
    invoiceNumber: number,
    date,
    customerSnapshot: {
      name: 'Customer',
      phone: '9876543210',
      countryCode: '+91',
      gstNumber: gstin,
      taxIdentifiers: { gstNumber: gstin },
      billingAddress: { state: placeOfSupply }
    },
    items: totals.items,
    subtotal: totals.subtotal,
    tax: totals.tax,
    discount: totals.discount,
    taxSummary: totals.taxSummary,
    supplyType,
    placeOfSupply: { code: placeOfSupplyCode, state: placeOfSupply },
    total: totals.total,
    balanceDue: totals.total,
    documentStatus,
    paymentStatus: 'unpaid',
    shareToken: crypto.randomBytes(12).toString('hex')
  });
};

const localItems = [{ name: 'Rice', quantity: 2, price: 500, taxRate: 5, hsn: '1006' }];

describe('GST period parsing', () => {
  it('accepts YYYY-MM and builds an inclusive month window', () => {
    const { period, from, to } = parsePeriod('2026-06');

    assert.equal(period, '2026-06');
    assert.equal(from.getMonth(), 5);
    assert.equal(from.getDate(), 1);
    // Exclusive upper bound at the first of the next month.
    assert.equal(to.getMonth(), 6);
    assert.equal(to.getDate(), 1);
  });

  it('rejects anything that is not a real month', () => {
    for (const bad of ['2026', '2026-13', '2026-00', 'June', '', null]) {
      assert.throws(() => parsePeriod(bad), /Period must be|between 01 and 12/);
    }
  });

  it('uses the threshold that applied on the invoice date', () => {
    // B2CL threshold dropped from 2.5L to 1L on 1 Aug 2024.
    assert.equal(b2clThresholdFor(new Date('2024-07-31')), 250000);
    assert.equal(b2clThresholdFor(new Date('2024-08-01')), 100000);
    assert.equal(b2clThresholdFor(new Date('2026-06-15')), 100000);
  });
});

describe('GSTR-1 section placement', () => {
  it('files a registered buyer under B2B whatever the value', async () => {
    const { business } = await createTestContext();
    await seedInvoice(business, { items: localItems, gstin: '27AAPFU0939F1ZV' });

    const report = await buildGstr1(business, PERIOD);

    assert.equal(report.counts.b2b, 1);
    assert.equal(report.counts.b2cl, 0);
    assert.equal(report.counts.b2cs, 0);
    assert.equal(report.sections.b2b[0].gstin, '27AAPFU0939F1ZV');
    assert.equal(report.sections.b2b[0].items[0].rate, 5);
  });

  it('files a large unregistered inter-state sale under B2CL', async () => {
    const { business } = await createTestContext();
    await seedInvoice(business, {
      items: [{ name: 'Bulk', quantity: 1, price: 150000, taxRate: 18, hsn: '3401' }],
      supplyType: 'inter',
      placeOfSupplyCode: '07',
      placeOfSupply: 'Delhi'
    });

    const report = await buildGstr1(business, PERIOD);

    assert.equal(report.counts.b2cl, 1);
    assert.equal(report.counts.b2cs, 0);
    assert.equal(report.sections.b2cl[0].placeOfSupplyCode, '07');
    // Tax on an inter-state supply is IGST only.
    assert.equal(report.sections.b2cl[0].items[0].igst, 27000);
    assert.equal(report.sections.b2cl[0].items[0].cgst, 0);
  });

  it('keeps a small inter-state sale in B2CS, below the threshold', async () => {
    const { business } = await createTestContext();
    await seedInvoice(business, {
      items: [{ name: 'Small', quantity: 1, price: 5000, taxRate: 18, hsn: '3401' }],
      supplyType: 'inter',
      placeOfSupplyCode: '07',
      placeOfSupply: 'Delhi'
    });

    const report = await buildGstr1(business, PERIOD);

    assert.equal(report.counts.b2cl, 0);
    assert.equal(report.counts.b2cs, 1);
    assert.equal(report.sections.b2cs[0].supplyType, 'inter');
  });

  it('keeps a large local sale in B2CS — B2CL is inter-state only', async () => {
    const { business } = await createTestContext();
    await seedInvoice(business, { items: [{ name: 'Bulk local', quantity: 1, price: 300000, taxRate: 18, hsn: '3401' }] });

    const report = await buildGstr1(business, PERIOD);

    assert.equal(report.counts.b2cl, 0);
    assert.equal(report.counts.b2cs, 1);
  });

  it('aggregates B2CS by place of supply and rate, counting invoices once each', async () => {
    const { business } = await createTestContext();
    await seedInvoice(business, { items: localItems });
    await seedInvoice(business, { items: localItems });
    await seedInvoice(business, { items: [{ name: 'Soap', quantity: 1, price: 200, taxRate: 18, hsn: '3401' }] });

    const report = await buildGstr1(business, PERIOD);

    assert.equal(report.counts.b2cs, 2);
    const fivePercent = report.sections.b2cs.find((row) => row.rate === 5);
    assert.equal(fivePercent.invoiceCount, 2);
    assert.equal(fivePercent.taxableValue, 2000);
    assert.equal(fivePercent.taxAmount, 100);
  });

  it('counts a mixed-rate invoice once in each rate bucket', async () => {
    const { business } = await createTestContext();
    await seedInvoice(business, {
      items: [
        { name: 'Rice', quantity: 1, price: 1000, taxRate: 5, hsn: '1006' },
        { name: 'Soap', quantity: 1, price: 1000, taxRate: 18, hsn: '3401' }
      ]
    });

    const report = await buildGstr1(business, PERIOD);

    assert.equal(report.counts.b2cs, 2);
    assert.deepEqual(report.sections.b2cs.map((row) => row.invoiceCount), [1, 1]);
  });
});

describe('GSTR-1 scope and reconciliation', () => {
  it('excludes cancelled invoices from value but still reports them in the series', async () => {
    const { business } = await createTestContext();
    await seedInvoice(business, { items: localItems });
    await seedInvoice(business, { items: localItems, documentStatus: 'cancelled' });

    const report = await buildGstr1(business, PERIOD);

    assert.equal(report.totals.invoiceCount, 1);
    assert.equal(report.totals.taxableValue, 1000);
    assert.equal(report.documentSeries.cancelled, 1);
  });

  it('excludes invoices outside the period', async () => {
    const { business } = await createTestContext();
    await seedInvoice(business, { items: localItems, date: new Date(2026, 4, 31) });
    await seedInvoice(business, { items: localItems, date: new Date(2026, 6, 1) });
    await seedInvoice(business, { items: localItems, date: new Date(2026, 5, 1) });
    await seedInvoice(business, { items: localItems, date: new Date(2026, 5, 30) });

    const report = await buildGstr1(business, PERIOD);

    assert.equal(report.totals.invoiceCount, 2);
  });

  it('never mixes in another business', async () => {
    const mine = await createTestContext();
    const theirs = await createTestContext();
    await seedInvoice(theirs.business, { items: localItems });

    const report = await buildGstr1(mine.business, PERIOD);

    assert.equal(report.totals.invoiceCount, 0);
    assert.equal(report.totals.taxAmount, 0);
  });

  it('reconciles the HSN summary against every section', async () => {
    const { business } = await createTestContext();
    await seedInvoice(business, { items: localItems, gstin: '27AAPFU0939F1ZV' });
    await seedInvoice(business, { items: [{ name: 'Soap', quantity: 1, price: 200, taxRate: 18, hsn: '3401' }] });
    await seedInvoice(business, {
      items: [{ name: 'Bulk', quantity: 1, price: 150000, taxRate: 18, hsn: '3401' }],
      supplyType: 'inter',
      placeOfSupplyCode: '07',
      placeOfSupply: 'Delhi'
    });

    const report = await buildGstr1(business, PERIOD);

    const sectionTax =
      report.sections.b2b.reduce((sum, doc) => sum + doc.items.reduce((s, i) => s + i.taxAmount, 0), 0) +
      report.sections.b2cl.reduce((sum, doc) => sum + doc.items.reduce((s, i) => s + i.taxAmount, 0), 0) +
      report.sections.b2cs.reduce((sum, row) => sum + row.taxAmount, 0);

    assert.equal(Math.round(sectionTax * 100) / 100, report.totals.taxAmount);
    // Same HSN across B2CL and B2CS collapses into one summary row.
    assert.equal(report.sections.hsn.find((row) => row.hsn === '3401').taxAmount, 27036);
  });

  it('reports discounted taxable value, not list price', async () => {
    const { business } = await createTestContext();
    await seedInvoice(business, { items: localItems, discountValue: 200 });

    const report = await buildGstr1(business, PERIOD);

    assert.equal(report.totals.taxableValue, 800);
    assert.equal(report.totals.taxAmount, 40);
  });

  it('reconstructs a split for pre-GST-engine invoices and flags them', async () => {
    const { business } = await createTestContext();
    // Legacy row: single document rate, no taxSummary at all.
    seq += 1;
    await Invoice.collection.insertOne({
      business: business._id,
      documentType: 'invoice',
      documentNumber: 'OLD-1',
      invoiceNumber: 'OLD-1',
      date: inPeriod,
      customerSnapshot: { name: 'Old Buyer', phone: '9876543210' },
      items: [{ name: 'Thing', quantity: 1, price: 1000, total: 1000 }],
      subtotal: 1000,
      tax: { rate: 18, amount: 180 },
      discount: { amount: 0 },
      total: 1180,
      documentStatus: 'issued',
      paymentStatus: 'unpaid',
      shareToken: crypto.randomBytes(12).toString('hex')
    });

    const report = await buildGstr1(business, PERIOD);

    assert.equal(report.reconstructedInvoices, 1);
    assert.equal(report.totals.taxableValue, 1000);
    // No supplyType stored => treated as local, so the 180 splits into two 90s.
    assert.equal(report.totals.cgst, 90);
    assert.equal(report.totals.sgst, 90);
    assert.equal(report.totals.igst, 0);
  });
});

describe('GSTR-3B', () => {
  it('summarises outward supplies by tax head', async () => {
    const { business } = await createTestContext();
    await seedInvoice(business, { items: localItems });
    await seedInvoice(business, {
      items: [{ name: 'Bulk', quantity: 1, price: 150000, taxRate: 18, hsn: '3401' }],
      supplyType: 'inter',
      placeOfSupplyCode: '07',
      placeOfSupply: 'Delhi'
    });

    const report = await buildGstr3b(business, PERIOD);

    assert.equal(report.outwardTaxableSupplies.taxableValue, 151000);
    assert.equal(report.outwardTaxableSupplies.igst, 27000);
    assert.equal(report.outwardTaxableSupplies.cgst, 25);
    assert.equal(report.outwardTaxableSupplies.sgst, 25);
    assert.equal(report.invoiceCount, 2);
  });
});

describe('GST return API', () => {
  it('serves GSTR-1 JSON and per-section CSV', async () => {
    const { business, token } = await createTestContext();
    await Business.updateOne({ _id: business._id }, { $set: { gstNumber: '27AAPFU0939F1ZV', stateCode: '27' } });
    await seedInvoice(business, { items: localItems, gstin: '29AAPFU0939F1ZV' });

    const json = await api().get(`/api/v1/gst/gstr1?period=${PERIOD}`).set(authHeader(token)).expect(200);
    assert.equal(json.body.report.counts.b2b, 1);

    const csv = await api().get(`/api/v1/gst/gstr1?period=${PERIOD}&format=csv&section=b2b`).set(authHeader(token)).expect(200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.headers['content-disposition'], /GSTR1-2026-06-b2b\.csv/);
    assert.match(csv.text, /GSTIN\/UIN of Recipient/);
    assert.match(csv.text, /29AAPFU0939F1ZV/);
  });

  it('rejects a bad period, an unknown section, and CSV without a section', async () => {
    const { token } = await createTestContext();

    await api().get('/api/v1/gst/gstr1?period=2026-13').set(authHeader(token)).expect(422);
    await api().get('/api/v1/gst/gstr1?period=June').set(authHeader(token)).expect(422);
    await api().get(`/api/v1/gst/gstr1?period=${PERIOD}&format=csv&section=nonsense`).set(authHeader(token)).expect(422);
    await api().get(`/api/v1/gst/gstr1?period=${PERIOD}&format=csv`).set(authHeader(token)).expect(422);
  });

  it('serves GSTR-3B as JSON and CSV', async () => {
    const { business, token } = await createTestContext();
    await seedInvoice(business, { items: localItems });

    const json = await api().get(`/api/v1/gst/gstr3b?period=${PERIOD}`).set(authHeader(token)).expect(200);
    assert.equal(json.body.report.outwardTaxableSupplies.taxableValue, 1000);

    const csv = await api().get(`/api/v1/gst/gstr3b?period=${PERIOD}&format=csv`).set(authHeader(token)).expect(200);
    assert.match(csv.text, /Nature of Supplies/);
    assert.match(csv.text, /Outward taxable supplies/);
  });

  it('denies a member without reports access', async () => {
    const { token } = await createTestContext({ roleKey: 'staff' });

    await api().get(`/api/v1/gst/gstr1?period=${PERIOD}`).set(authHeader(token)).expect(403);
  });
});

describe('GSTR-1 CSV shape', () => {
  it('emits one row per rate for a mixed-rate B2B invoice', async () => {
    const { business } = await createTestContext();
    await seedInvoice(business, {
      items: [
        { name: 'Rice', quantity: 1, price: 1000, taxRate: 5, hsn: '1006' },
        { name: 'Soap', quantity: 1, price: 1000, taxRate: 18, hsn: '3401' }
      ],
      gstin: '27AAPFU0939F1ZV'
    });

    const report = await buildGstr1(business, PERIOD);
    const lines = gstr1SectionCsv(report, 'b2b').trim().split('\r\n');

    // Header + two rate rows, with the invoice header repeated on each.
    assert.equal(lines.length, 3);
    assert.ok(lines[1].includes('GST-'));
    assert.ok(lines[2].includes('GST-'));
  });
});
