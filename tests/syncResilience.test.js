import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Customer from '../src/models/Customer.js';
import DeviceSeries from '../src/models/DeviceSeries.js';
import Invoice from '../src/models/Invoice.js';
import Payment from '../src/models/Payment.js';
import SettlementAllocation from '../src/models/SettlementAllocation.js';
import Product from '../src/models/Product.js';
import { SYNC_DEVICE_HEADER, SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION } from '../src/modules/sync/protocol.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

/**
 * The server under the conditions a fleet of offline devices actually creates: the same
 * operation arriving twice at once, two tills collecting against one bill in the same instant,
 * a batch at the protocol's ceiling, and payloads no honest client would send.
 *
 * The theme is that /sync/push is an *untrusted* entry point which happens to reuse the online
 * controllers. Every test here asks the same question in a different way: can a client make the
 * server do something the online route would not have let it do?
 */

process.env.SYNC_SAFETY_LAG_MS = '0';

useMongoTestDb();

const api = () => request(app);

const syncHeaders = (token, deviceId) => ({
  ...authHeader(token),
  [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL_VERSION),
  ...(deviceId ? { [SYNC_DEVICE_HEADER]: deviceId } : {})
});

const push = (token, ops, deviceId) =>
  api().post('/api/v1/sync/push').set(syncHeaders(token, deviceId)).send({ ops });

const customerOp = (index, overrides = {}) => ({
  opId: `op-customer-${index}`,
  entity: 'customer',
  opType: 'create',
  clientId: `client-customer-${index}`,
  payload: { name: `Customer ${index}`, phone: `90000${String(index).padStart(5, '0')}` },
  ...overrides
});

const receiptOp = (invoiceId, { amount, opId, clientId }) => ({
  opId,
  entity: 'payment',
  opType: 'create',
  clientId,
  payload: { invoiceId: String(invoiceId), amount, method: 'cash', receivedAt: new Date().toISOString() }
});

const issueInvoice = async (token, customer, product, quantity = 2) => {
  const { body } = await api()
    .post('/api/v1/invoices')
    .set(authHeader(token))
    .send({
      customerId: String(customer._id),
      items: [{ productId: String(product._id), quantity }],
      taxRate: 0,
      discountType: 'flat',
      discountValue: 0,
      notes: ''
    })
    .expect(201);
  return body.invoice;
};

describe('the same work arriving twice at once', () => {
  it('creates one record when a retry overlaps the original request', async () => {
    const { business, token } = await createTestContext();
    const op = customerOp(1);

    // A device on a bad connection resends before the first response comes back.
    const [first, second] = await Promise.all([push(token, [op]), push(token, [op])]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const results = [first.body.results[0], second.body.results[0]];
    // Whatever the interleaving, exactly one customer exists.
    assert.equal(await Customer.countDocuments({ business: business._id }), 1);

    const accepted = results.filter((result) => result.status === 'ok');
    assert.equal(accepted.length >= 1, true, 'at least one call created the record');
    for (const result of results.filter((result) => result.status !== 'ok')) {
      // The loser of the race is told to come back, not that a person must resolve something:
      // this is the same operation in flight, not two writers disagreeing.
      assert.equal(result.statusCode, 409);
      assert.equal(result.code, 'IDEMPOTENCY_REQUEST_IN_PROGRESS');
    }
    // A serialised replay always echoes the original record.
    const replay = await push(token, [op]).expect(200);
    assert.equal(replay.body.results[0].status, 'ok');
    assert.equal(await Customer.countDocuments({ business: business._id }), 1);
  });

  it('does not overpay a bill when two receipts land together', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business);
    const invoice = await issueInvoice(token, customer, product);
    const half = Math.round((invoice.total / 2) * 100) / 100;

    // Two tills, each collecting half of the same bill, in the same instant.
    await Promise.all([
      push(token, [receiptOp(invoice._id, { amount: half, opId: 'op-pay-a', clientId: 'client-pay-a' })]),
      push(token, [receiptOp(invoice._id, { amount: half, opId: 'op-pay-b', clientId: 'client-pay-b' })])
    ]);

    const settled = await Invoice.findById(invoice._id);
    const receipts = await Payment.find({ business: business._id });
    assert.equal(receipts.length, 2, 'both receipts are recorded — the cash was taken twice');
    // Allocation is the server's, so it can total the bill but never exceed it.
    assert.ok(settled.paidAmount <= settled.total + 0.001, `paid ${settled.paidAmount} of ${settled.total}`);
    assert.equal(settled.balanceDue, Math.round((settled.total - settled.paidAmount) * 100) / 100);
    const allocated = (await SettlementAllocation.find({ invoice: invoice._id })).reduce(
      (sum, allocation) => sum + allocation.amount,
      0
    );
    assert.equal(Math.round(allocated * 100) / 100, settled.paidAmount);
  });

  it('gives two devices registering at once two different series', async () => {
    const { business, token } = await createTestContext();

    const responses = await Promise.all([
      api().post('/api/v1/sync/device').set(syncHeaders(token, 'device-alpha')).send({}),
      api().post('/api/v1/sync/device').set(syncHeaders(token, 'device-beta')).send({}),
      api().post('/api/v1/sync/device').set(syncHeaders(token, 'device-gamma')).send({})
    ]);

    const indexes = responses.map((response) => response.body.series?.deviceIndex).sort();
    // A shared index would mean two devices minting the same invoice numbers.
    assert.deepEqual(indexes, [1, 2, 3]);
    assert.equal(await DeviceSeries.countDocuments({ business: business._id }), 3);
  });
});

describe('a batch at the ceiling', () => {
  it('applies fifty operations, reporting each one', async () => {
    const { business, token } = await createTestContext();
    const ops = Array.from({ length: 50 }, (_, index) => customerOp(index));

    const { body } = await push(token, ops).expect(200);

    assert.equal(body.results.length, 50);
    assert.equal(body.results.filter((result) => result.status === 'ok').length, 50);
    assert.equal(await Customer.countDocuments({ business: business._id }), 50);
  });

  it('keeps a bad operation from taking the rest of the batch down', async () => {
    const { business, token } = await createTestContext();

    const { body } = await push(token, [
      customerOp(1),
      // No name: the same validator chain the online route uses refuses it.
      { opId: 'op-bad-shape', entity: 'customer', opType: 'create', clientId: 'client-bad', payload: { phone: '9000000000' } },
      customerOp(2)
    ]).expect(200);

    assert.deepEqual(
      body.results.map((result) => result.status),
      ['ok', 'rejected', 'ok']
    );
    assert.equal(body.results[1].statusCode, 422, 'a shape problem is not retryable');
    assert.equal(await Customer.countDocuments({ business: business._id }), 2);
  });
});

describe('payloads no honest client would send', () => {
  it('refuses a payload of the wrong shape instead of failing the request', async () => {
    const { token } = await createTestContext();

    const { body } = await push(token, [
      {
        opId: 'op-wrong-types',
        entity: 'invoice',
        opType: 'create',
        clientId: 'client-wrong-types',
        payload: { customerId: 'not-an-id', items: 'a string, not a list', taxRate: 'lots' }
      }
    ]).expect(200);

    assert.equal(body.results[0].status, 'rejected');
    assert.equal(body.results[0].statusCode, 422);
  });

  it('ignores server-owned fields a client tries to set', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 100 });

    const { body } = await push(token, [
      {
        opId: 'op-forged',
        entity: 'invoice',
        opType: 'create',
        clientId: 'client-forged',
        payload: {
          customerId: String(customer._id),
          items: [{ productId: String(product._id), quantity: 1 }],
          taxRate: 0,
          discountType: 'flat',
          discountValue: 0,
          notes: '',
          // None of these are the client's to decide.
          paidAmount: 999999,
          balanceDue: 0,
          paymentStatus: 'paid',
          business: 'some-other-business'
        }
      }
    ]).expect(200);

    assert.equal(body.results[0].status, 'ok', body.results[0].message);
    const invoice = await Invoice.findById(body.results[0].serverId);
    assert.equal(invoice.paidAmount, 0, 'a bill is paid by a receipt, not by a payload field');
    assert.equal(invoice.paymentStatus, 'unpaid');
    assert.equal(invoice.balanceDue, invoice.total);
    assert.equal(String(invoice.business), String(business._id));
  });

  it('refuses an operation naming another business\'s record', async () => {
    const mine = await createTestContext();
    const theirs = await createTestContext();
    const theirCustomer = await createCustomer(theirs.business);
    const product = await createProduct(mine.business);

    const { body } = await push(mine.token, [
      {
        opId: 'op-cross-tenant',
        entity: 'invoice',
        opType: 'create',
        clientId: 'client-cross-tenant',
        payload: {
          customerId: String(theirCustomer._id),
          items: [{ productId: String(product._id), quantity: 1 }],
          taxRate: 0,
          discountType: 'flat',
          discountValue: 0,
          notes: ''
        }
      }
    ]).expect(200);

    assert.notEqual(body.results[0].status, 'ok');
    assert.equal(await Invoice.countDocuments({ business: mine.business._id }), 0);
  });
});

describe('stock under a queued day of billing', () => {
  it('applies every queued sale to the level, and records the oversell', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 5 });

    const ops = Array.from({ length: 4 }, (_, index) => ({
      opId: `op-inv-${index}`,
      entity: 'invoice',
      opType: 'create',
      clientId: `client-inv-${index}`,
      payload: {
        customerId: String(customer._id),
        items: [{ productId: String(product._id), quantity: 2 }],
        taxRate: 0,
        discountType: 'flat',
        discountValue: 0,
        notes: '',
        // The goods left the counter before the device could ask anyone.
        allowOversell: true
      }
    }));

    const { body } = await push(token, ops).expect(200);

    assert.equal(body.results.filter((result) => result.status === 'ok').length, 4);
    // 5 in stock, 8 sold: the level is honest about being short rather than clamped at zero.
    assert.equal((await Product.findById(product._id)).stockQuantity, -3);
  });
});
