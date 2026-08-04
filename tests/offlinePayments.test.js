import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import CustomerBalance from '../src/models/CustomerBalance.js';
import Invoice from '../src/models/Invoice.js';
import LedgerEntry from '../src/models/LedgerEntry.js';
import Payment from '../src/models/Payment.js';
import PaymentAllocation from '../src/models/PaymentAllocation.js';
import { SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION } from '../src/modules/sync/protocol.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createTestContext } from './helpers/fixtures.js';

/**
 * Receipts taken offline, pushed.
 *
 * The rule this file exists to hold: the device records that cash was taken, and the server
 * decides what it settled. Allocation, the customer balance and the ledger are computed here
 * and never accepted from a client — a device cannot see the invoices another till has already
 * collected against.
 */

process.env.SYNC_SAFETY_LAG_MS = '0';

useMongoTestDb();

const api = () => request(app);
const syncHeaders = (token) => ({ ...authHeader(token), [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL_VERSION) });
const push = (token, ops) => api().post('/api/v1/sync/push').set(syncHeaders(token)).send({ ops });

const pushedInvoice = async (token, customer, { total = 1000, opId }) => {
  const { body } = await push(token, [
    {
      opId,
      entity: 'invoice',
      opType: 'create',
      clientId: `client-${opId}`,
      payload: {
        customerId: String(customer._id),
        items: [{ name: 'Goods', quantity: 1, price: total }],
        taxRate: 0,
        discountType: 'flat',
        discountValue: 0,
        notes: ''
      }
    }
  ]).expect(200);

  assert.equal(body.results[0].status, 'ok', body.results[0].message);
  return body.results[0].serverId;
};

const receipt = (invoiceId, { amount, opId, clientId }) => ({
  opId,
  entity: 'payment',
  opType: 'create',
  clientId,
  payload: { invoiceId, amount, method: 'cash', receivedAt: new Date().toISOString() }
});

describe('pushing a receipt taken offline', () => {
  it('records it and lets the server allocate, balance and post the ledger', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const invoiceId = await pushedInvoice(token, customer, { opId: 'op-inv-1' });

    const { body } = await push(token, [
      receipt(invoiceId, { amount: 400, opId: 'op-pay-1', clientId: 'client-pay-1' })
    ]).expect(200);

    assert.equal(body.results[0].status, 'ok', body.results[0].message);
    const invoice = await Invoice.findById(invoiceId);
    assert.equal(invoice.paidAmount, 400);
    assert.equal(invoice.balanceDue, 600);
    assert.equal(invoice.paymentStatus, 'partial');

    // None of these came from the device.
    assert.equal(await PaymentAllocation.countDocuments({ invoice: invoiceId }), 1);
    assert.ok((await LedgerEntry.countDocuments({ business: business._id })) >= 2, 'double entry posted');
    const balance = await CustomerBalance.findOne({ business: business._id, customer: customer._id });
    assert.ok(balance, 'the customer balance was recomputed');
  });

  it('replays a retried receipt instead of taking the money twice', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const invoiceId = await pushedInvoice(token, customer, { opId: 'op-inv-2' });
    const op = receipt(invoiceId, { amount: 400, opId: 'op-pay-2', clientId: 'client-pay-2' });

    const first = await push(token, [op]).expect(200);
    // The response was lost on the way back to a device with no signal.
    const second = await push(token, [op]).expect(200);

    assert.equal(second.body.results[0].status, 'ok');
    assert.equal(second.body.results[0].serverId, first.body.results[0].serverId);
    assert.equal(await Payment.countDocuments({ business: business._id }), 1);
    assert.equal(await PaymentAllocation.countDocuments({ invoice: invoiceId }), 1);
    // The decisive assertion: the bill was settled once, not twice.
    assert.equal((await Invoice.findById(invoiceId)).paidAmount, 400);
  });

  it('accepts more than the bill and parks the excess as customer credit', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const invoiceId = await pushedInvoice(token, customer, { total: 1000, opId: 'op-inv-3' });

    const { body } = await push(token, [
      receipt(invoiceId, { amount: 1600, opId: 'op-pay-3', clientId: 'client-pay-3' })
    ]).expect(200);

    assert.equal(body.results[0].status, 'ok', body.results[0].message);
    const payment = await Payment.findById(body.results[0].serverId);
    // Refusing the cash would not un-receive it; it would only lose ₹600 from the books.
    assert.equal(payment.allocatedAmount, 1000);
    assert.equal(payment.unappliedAmount, 600);
    assert.equal((await Invoice.findById(invoiceId)).paymentStatus, 'paid');
  });

  it('reports a receipt against a bill cancelled elsewhere as a conflict, not a rejection', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const invoiceId = await pushedInvoice(token, customer, { opId: 'op-inv-4' });

    // Another till cancelled the bill while this device was offline.
    await Invoice.updateOne({ _id: invoiceId }, { $set: { documentStatus: 'cancelled', status: 'cancelled' } });

    const { body } = await push(token, [
      receipt(invoiceId, { amount: 400, opId: 'op-pay-4', clientId: 'client-pay-4' })
    ]).expect(200);

    // A conflict, so the device keeps the receipt for a person to resolve. Money is never
    // dropped on the client and never applied to a reversed document on the server.
    assert.equal(body.results[0].status, 'conflict');
    assert.equal(body.results[0].statusCode, 409);
    assert.equal(await Payment.countDocuments({ business: business._id }), 0);
  });

  it('settles several bills with one receipt, in the order the device sent them', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const first = await pushedInvoice(token, customer, { total: 1000, opId: 'op-inv-5' });
    const second = await pushedInvoice(token, customer, { total: 600, opId: 'op-inv-6' });

    const { body } = await push(token, [
      {
        opId: 'op-pay-5',
        entity: 'customerPayment',
        opType: 'create',
        clientId: 'client-pay-5',
        payload: {
          customerId: String(customer._id),
          invoiceIds: [first, second],
          amount: 1400,
          method: 'cash'
        }
      }
    ]).expect(200);

    assert.equal(body.results[0].status, 'ok', body.results[0].message);
    // Greedy, oldest first — the same walk the device showed the user, redone against the
    // server's own balances.
    assert.equal((await Invoice.findById(first)).paymentStatus, 'paid');
    assert.equal((await Invoice.findById(second)).paidAmount, 400);
    assert.equal((await Invoice.findById(second)).balanceDue, 200);
    assert.equal(await PaymentAllocation.countDocuments({ business: business._id }), 2);
  });

  it('re-splits a dues collection itself when another till got there first', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const first = await pushedInvoice(token, customer, { total: 1000, opId: 'op-inv-7' });
    const second = await pushedInvoice(token, customer, { total: 600, opId: 'op-inv-8' });

    // The first bill was settled from another device while this one was offline.
    await push(token, [receipt(first, { amount: 1000, opId: 'op-pay-6', clientId: 'client-pay-6' })]).expect(200);

    const { body } = await push(token, [
      {
        opId: 'op-pay-7',
        entity: 'customerPayment',
        opType: 'create',
        clientId: 'client-pay-7',
        payload: { customerId: String(customer._id), invoiceIds: [first, second], amount: 600, method: 'cash' }
      }
    ]).expect(200);

    assert.equal(body.results[0].status, 'ok', body.results[0].message);
    // The device expected ₹600 to go to the first bill. The server knows it is already paid,
    // so the whole receipt lands on the second — which is why the client never allocates.
    assert.equal((await Invoice.findById(first)).paidAmount, 1000);
    assert.equal((await Invoice.findById(second)).paymentStatus, 'paid');
  });
});
