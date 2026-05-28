import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateInvoiceTotals } from '../src/utils/invoiceMath.js';
import { financialYearFor, formatDocumentNumber } from '../src/services/numberingService.js';
import { PERMISSIONS, permissionsForRoleKey } from '../src/middlewares/authorization.js';

describe('invoice math', () => {
  it('rounds subtotal, percentage discount, tax, and total consistently', () => {
    const result = calculateInvoiceTotals({
      items: [
        { name: 'Item A', quantity: 2, price: 99.995 },
        { name: 'Item B', quantity: 1, price: 50 }
      ],
      taxRate: 18,
      discountType: 'percentage',
      discountValue: 10
    });

    assert.equal(result.subtotal, 249.99);
    assert.equal(result.discount.amount, 25);
    assert.equal(result.tax.amount, 40.5);
    assert.equal(result.total, 265.49);
  });

  it('caps flat discount at subtotal', () => {
    const result = calculateInvoiceTotals({
      items: [{ name: 'Item A', quantity: 1, price: 100 }],
      discountType: 'flat',
      discountValue: 150,
      taxRate: 18
    });

    assert.equal(result.discount.amount, 100);
    assert.equal(result.tax.amount, 0);
    assert.equal(result.total, 0);
  });
});

describe('numbering helpers', () => {
  it('uses Indian financial year boundaries', () => {
    assert.equal(financialYearFor(new Date('2026-03-31T12:00:00Z')), '2025-26');
    assert.equal(financialYearFor(new Date('2026-04-01T12:00:00Z')), '2026-27');
  });

  it('formats document numbers with padded sequence', () => {
    assert.equal(formatDocumentNumber({ prefix: 'INV', financialYear: '2026-27', sequence: 7 }), 'INV-2026-27-0007');
  });
});

describe('role permissions', () => {
  it('keeps viewer read-only for invoices and reports', () => {
    const permissions = permissionsForRoleKey('viewer');

    assert.ok(permissions.includes(PERMISSIONS.invoicesView));
    assert.ok(permissions.includes(PERMISSIONS.reportsView));
    assert.ok(!permissions.includes(PERMISSIONS.invoicesCreate));
    assert.ok(!permissions.includes(PERMISSIONS.paymentsRecord));
  });
});
