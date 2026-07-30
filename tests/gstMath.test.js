import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateInvoiceTotals } from '../src/utils/invoiceMath.js';
import {
  resolvePlaceOfSupply,
  stateCodeFromGstin,
  stateCodeFromName,
  supplyTypeFor
} from '../src/constants/gstStates.js';

const sumBy = (rows, key) => Math.round(rows.reduce((sum, row) => sum + Number(row[key] || 0), 0) * 100) / 100;

describe('GST state resolution', () => {
  it('reads the state code out of a GSTIN', () => {
    assert.equal(stateCodeFromGstin('09ABCDE1234F1Z5'), '09');
    assert.equal(stateCodeFromGstin('27AAPFU0939F1ZV'), '27');
    // 99 is not a real state code.
    assert.equal(stateCodeFromGstin('99ABCDE1234F1Z5'), '');
    assert.equal(stateCodeFromGstin(''), '');
  });

  it('maps state names, abbreviations and old spellings', () => {
    assert.equal(stateCodeFromName('Uttar Pradesh'), '09');
    assert.equal(stateCodeFromName('  uttar  pradesh '), '09');
    assert.equal(stateCodeFromName('UP'), '09');
    assert.equal(stateCodeFromName('Orissa'), '21');
    assert.equal(stateCodeFromName('Odisha'), '21');
    assert.equal(stateCodeFromName('Jammu & Kashmir'), '01');
    assert.equal(stateCodeFromName('Atlantis'), '');
  });

  it('prefers an explicit choice, then the customer GSTIN, then their address', () => {
    assert.equal(
      resolvePlaceOfSupply({ explicitCode: '33', customerGstin: '09ABCDE1234F1Z5', customerState: 'Goa', supplierStateCode: '27' }).code,
      '33'
    );
    // The GSTIN is authoritative over a mistyped address.
    assert.equal(
      resolvePlaceOfSupply({ customerGstin: '09ABCDE1234F1Z5', customerState: 'Maharashtra', supplierStateCode: '27' }).code,
      '09'
    );
    assert.equal(resolvePlaceOfSupply({ customerState: 'Kerala', supplierStateCode: '27' }).code, '32');
    // Unidentified walk-in customer: treat as a local sale.
    const walkIn = resolvePlaceOfSupply({ supplierStateCode: '27' });
    assert.equal(walkIn.code, '27');
    assert.equal(walkIn.state, 'Maharashtra');
  });

  it('treats an unknown state as intra-state rather than guessing IGST', () => {
    assert.equal(supplyTypeFor('27', '27'), 'intra');
    assert.equal(supplyTypeFor('27', '09'), 'inter');
    assert.equal(supplyTypeFor('', '09'), 'intra');
    assert.equal(supplyTypeFor('27', ''), 'intra');
  });
});

describe('GST split', () => {
  const items = [{ name: 'Rice', quantity: 2, price: 500, taxRate: 5, hsn: '1006' }];

  it('splits intra-state tax into equal CGST and SGST halves', () => {
    const result = calculateInvoiceTotals({ items, supplyType: 'intra' });

    assert.equal(result.tax.amount, 50);
    assert.equal(result.cgstTotal, 25);
    assert.equal(result.sgstTotal, 25);
    assert.equal(result.igstTotal, 0);
    assert.equal(result.total, 1050);
  });

  it('charges IGST only on an inter-state supply', () => {
    const result = calculateInvoiceTotals({ items, supplyType: 'inter' });

    assert.equal(result.igstTotal, 50);
    assert.equal(result.cgstTotal, 0);
    assert.equal(result.sgstTotal, 0);
    assert.equal(result.total, 1050);
  });

  it('keeps CGST + SGST exactly equal to the tax amount on odd paise', () => {
    // 7.77 * 18% = 1.3986 -> 1.40, which does not halve cleanly.
    const result = calculateInvoiceTotals({ items: [{ name: 'Odd', quantity: 1, price: 7.77, taxRate: 18 }] });

    assert.equal(result.tax.amount, 1.4);
    assert.equal(result.cgstTotal + result.sgstTotal, result.tax.amount);
    assert.equal(result.total, 9.17);
  });
});

describe('per-item rates', () => {
  it('taxes each line at its own rate and reports no single document rate', () => {
    const result = calculateInvoiceTotals({
      items: [
        { name: 'Rice', quantity: 1, price: 1000, taxRate: 5, hsn: '1006' },
        { name: 'Soap', quantity: 1, price: 1000, taxRate: 18, hsn: '3401' }
      ]
    });

    assert.equal(result.tax.amount, 230);
    // Mixed rates cannot be described by one number, so the legacy field reports 0.
    assert.equal(result.tax.rate, 0);
    assert.equal(result.items[0].taxAmount, 50);
    assert.equal(result.items[1].taxAmount, 180);
    assert.equal(result.total, 2230);
  });

  it('keeps reporting the shared rate when every line agrees', () => {
    const result = calculateInvoiceTotals({
      items: [
        { name: 'A', quantity: 1, price: 100, taxRate: 18 },
        { name: 'B', quantity: 1, price: 200, taxRate: 18 }
      ]
    });

    assert.equal(result.tax.rate, 18);
  });

  it('falls back to the document rate for lines that carry none', () => {
    const result = calculateInvoiceTotals({
      items: [{ name: 'A', quantity: 1, price: 100 }, { name: 'B', quantity: 1, price: 100, taxRate: 0 }],
      taxRate: 12
    });

    assert.equal(result.items[0].taxRate, 12);
    // An explicit zero is a choice, not an absence — it must not inherit 12%.
    assert.equal(result.items[1].taxRate, 0);
    assert.equal(result.tax.amount, 12);
  });
});

describe('discount allocation', () => {
  it('spreads a document discount across lines so the parts sum to the whole', () => {
    const result = calculateInvoiceTotals({
      items: [
        { name: 'A', quantity: 1, price: 100, taxRate: 18 },
        { name: 'B', quantity: 1, price: 200, taxRate: 18 },
        { name: 'C', quantity: 1, price: 300, taxRate: 18 }
      ],
      discountType: 'flat',
      discountValue: 60
    });

    assert.equal(result.discount.amount, 60);
    // Taxable values must add back to subtotal minus discount, to the paisa.
    assert.equal(sumBy(result.items, 'taxableValue'), 540);
    assert.equal(result.taxableTotal, 540);
    assert.equal(result.tax.amount, 97.2);
    assert.equal(result.total, 637.2);
  });

  it('loses no paise on a discount that does not divide evenly', () => {
    const result = calculateInvoiceTotals({
      items: [
        { name: 'A', quantity: 1, price: 100, taxRate: 5 },
        { name: 'B', quantity: 1, price: 100, taxRate: 5 },
        { name: 'C', quantity: 1, price: 100, taxRate: 5 }
      ],
      discountType: 'flat',
      discountValue: 10
    });

    // 10 / 3 = 3.333...; the parts must still total exactly 10.
    assert.equal(sumBy(result.items, 'taxableValue'), 290);
    // Tax is computed and rounded per line (4.83 x 3 = 14.49), not on the 290 aggregate
    // (which would give 14.50). Per-line is what GST requires: the line taxes have to
    // add up to the invoice tax, and to the HSN summary that GSTR-1 is filed from.
    assert.equal(result.tax.amount, 14.49);
    assert.equal(sumBy(result.items, 'taxAmount'), result.tax.amount);
    assert.equal(result.total, 304.49);
  });

  it('applies tax on the discounted value, not the list price', () => {
    const undiscounted = calculateInvoiceTotals({ items: [{ name: 'A', quantity: 1, price: 1000, taxRate: 18 }] });
    const discounted = calculateInvoiceTotals({
      items: [{ name: 'A', quantity: 1, price: 1000, taxRate: 18 }],
      discountType: 'percentage',
      discountValue: 50
    });

    assert.equal(undiscounted.tax.amount, 180);
    assert.equal(discounted.tax.amount, 90);
    assert.equal(discounted.total, 590);
  });
});

describe('tax-inclusive pricing', () => {
  it('backs the tax out of a tax-inclusive price', () => {
    // 1180 inclusive of 18% => 1000 taxable + 180 tax.
    const result = calculateInvoiceTotals({
      items: [{ name: 'A', quantity: 1, price: 1180, taxRate: 18 }],
      pricesIncludeTax: true
    });

    assert.equal(result.subtotal, 1000);
    assert.equal(result.tax.amount, 180);
    // The customer still pays the sticker price.
    assert.equal(result.total, 1180);
  });

  it('handles mixed rates when prices include tax', () => {
    const result = calculateInvoiceTotals({
      items: [
        { name: 'Rice', quantity: 1, price: 1050, taxRate: 5 },
        { name: 'Soap', quantity: 1, price: 1180, taxRate: 18 }
      ],
      pricesIncludeTax: true
    });

    assert.equal(result.subtotal, 2000);
    assert.equal(result.tax.amount, 230);
    assert.equal(result.total, 2230);
  });
});

describe('HSN tax summary', () => {
  it('groups by HSN and rate, and reconciles to the invoice tax', () => {
    const result = calculateInvoiceTotals({
      items: [
        { name: 'Rice 5kg', quantity: 1, price: 500, taxRate: 5, hsn: '1006' },
        { name: 'Rice 10kg', quantity: 1, price: 900, taxRate: 5, hsn: '1006' },
        { name: 'Soap', quantity: 2, price: 100, taxRate: 18, hsn: '3401' }
      ],
      supplyType: 'intra'
    });

    assert.equal(result.taxSummary.length, 2);
    const rice = result.taxSummary.find((row) => row.hsn === '1006');
    const soap = result.taxSummary.find((row) => row.hsn === '3401');

    assert.equal(rice.rate, 5);
    assert.equal(rice.taxableValue, 1400);
    assert.equal(rice.taxAmount, 70);
    assert.equal(rice.cgst + rice.sgst, 70);
    assert.equal(soap.taxableValue, 200);
    assert.equal(soap.taxAmount, 36);
    assert.equal(sumBy(result.taxSummary, 'taxAmount'), result.tax.amount);
  });

  it('separates the same HSN billed at two different rates', () => {
    const result = calculateInvoiceTotals({
      items: [
        { name: 'A', quantity: 1, price: 100, taxRate: 5, hsn: '1006' },
        { name: 'B', quantity: 1, price: 100, taxRate: 12, hsn: '1006' }
      ]
    });

    assert.equal(result.taxSummary.length, 2);
    assert.deepEqual(result.taxSummary.map((row) => row.rate), [5, 12]);
  });

  it('still summarises when no HSN codes are set', () => {
    const result = calculateInvoiceTotals({ items: [{ name: 'Service', quantity: 1, price: 1000, taxRate: 18 }] });

    assert.equal(result.taxSummary.length, 1);
    assert.equal(result.taxSummary[0].hsn, '');
    assert.equal(result.taxSummary[0].taxAmount, 180);
  });

  it('carries zero-rated lines through without inventing tax', () => {
    const result = calculateInvoiceTotals({
      items: [
        { name: 'Exempt', quantity: 1, price: 500, taxRate: 0, hsn: '0401' },
        { name: 'Taxed', quantity: 1, price: 500, taxRate: 18, hsn: '3401' }
      ]
    });

    const exempt = result.taxSummary.find((row) => row.hsn === '0401');
    assert.equal(exempt.taxAmount, 0);
    assert.equal(exempt.taxableValue, 500);
    assert.equal(result.tax.amount, 90);
    assert.equal(result.total, 1090);
  });
});
