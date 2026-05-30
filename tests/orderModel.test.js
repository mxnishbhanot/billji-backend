import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import mongoose from 'mongoose';
import Order from '../src/models/Order.js';
import SalesDocument from '../src/models/SalesDocument.js';
import StockMovement from '../src/models/StockMovement.js';
import { formatOrderNumber, ORDER_NUMBER_PREFIX } from '../src/services/numberingService.js';

const validOrder = () => ({
  business: new mongoose.Types.ObjectId(),
  customerSnapshot: { name: 'Acme', phone: '9999999999' },
  orderNumber: 'INV-2026-27-0001',
  items: [{ name: 'Widget', quantity: 2, price: 100, total: 200 }],
  subtotal: 200,
  total: 200
});

describe('OR-0 Order model', () => {
  it('validates a well-formed order with default statuses', () => {
    const order = new Order(validOrder());
    assert.equal(order.validateSync(), undefined);
    assert.equal(order.orderStatus, 'draft');
    assert.equal(order.fulfillmentStatus, 'pending');
    assert.equal(order.paymentStatus, 'unpaid');
    assert.equal(order.paidAmount, 0);
    assert.equal(order.balanceDue, 0);
  });

  it('requires at least one item', () => {
    const order = new Order({ ...validOrder(), items: [] });
    assert.notEqual(order.validateSync(), undefined);
  });

  it('rejects an unknown orderStatus', () => {
    const order = new Order({ ...validOrder(), orderStatus: 'shipped' });
    assert.notEqual(order.validateSync(), undefined);
  });
});

describe('OR-0 SalesDocument.sourceOrder link', () => {
  it('exposes a nullable sourceOrder ref defaulting to null', () => {
    const path = SalesDocument.schema.path('sourceOrder');
    assert.ok(path, 'sourceOrder path should exist');
    assert.equal(path.options.ref, 'Order');
    const doc = new SalesDocument({});
    assert.equal(doc.sourceOrder, null);
  });
});

describe('OR-0 order numbering format', () => {
  it('formats as ORD- + 6-digit zero-padded sequence, no financial year', () => {
    assert.equal(formatOrderNumber({ sequence: 1 }), 'ORD-000001');
    assert.equal(formatOrderNumber({ sequence: 42 }), 'ORD-000042');
    assert.equal(formatOrderNumber({ sequence: 1234567 }), 'ORD-1234567');
    assert.equal(ORDER_NUMBER_PREFIX, 'ORD');
  });

  it('honours a custom business order prefix', () => {
    assert.equal(formatOrderNumber({ prefix: 'SO', sequence: 7 }), 'SO-000007');
  });
});

describe('OR-0 StockMovement reserved vocab', () => {
  it('accepts reservation and reservation_released types', () => {
    const enumValues = StockMovement.schema.path('type').enumValues;
    assert.ok(enumValues.includes('reservation'));
    assert.ok(enumValues.includes('reservation_released'));
  });
});
