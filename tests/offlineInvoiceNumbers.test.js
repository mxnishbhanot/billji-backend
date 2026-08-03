import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import DeviceSeries from '../src/models/DeviceSeries.js';
import Invoice from '../src/models/Invoice.js';
import NumberSequence from '../src/models/NumberSequence.js';
import Product from '../src/models/Product.js';
import {
  GST_DOCUMENT_NUMBER_MAX_LENGTH,
  MAX_DEVICE_INDEX,
  compactFinancialYear,
  financialYearFor,
  formatDeviceDocumentNumber,
  parseDeviceDocumentNumber
} from '../src/services/numberingService.js';
import {
  SYNC_DEVICE_HEADER,
  SYNC_PROTOCOL_HEADER,
  SYNC_PROTOCOL_VERSION
} from '../src/modules/sync/protocol.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

/**
 * Device numbering series, and the guard that stands between an untrusted client and a
 * legally-binding invoice number.
 *
 * A device issues numbers offline because a number printed for a customer can never change.
 * The price of that is that the server must prove every arriving number belongs to the series
 * of the device that sent it — otherwise a client picks its own invoice numbers.
 */

process.env.SYNC_SAFETY_LAG_MS = '0';

useMongoTestDb();

const api = () => request(app);

const syncHeaders = (token, deviceId) => ({
  ...authHeader(token),
  [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL_VERSION),
  ...(deviceId ? { [SYNC_DEVICE_HEADER]: deviceId } : {})
});

const registerDevice = (token, deviceId, body = {}) =>
  api().post('/api/v1/sync/device').set(syncHeaders(token, deviceId)).send(body);

const push = (token, deviceId, ops) =>
  api().post('/api/v1/sync/push').set(syncHeaders(token, deviceId)).send({ ops });

const invoiceOp = (documentNumber, { customer, product, quantity = 2, clientId = 'client-inv-1' } = {}) => ({
  opId: `op-${documentNumber || 'server'}-${clientId}`,
  entity: 'invoice',
  opType: 'create',
  clientId,
  payload: {
    customerId: String(customer._id),
    items: [{ productId: String(product._id), quantity }],
    taxRate: 0,
    discountType: 'flat',
    discountValue: 0,
    notes: '',
    allowOversell: true,
    ...(documentNumber ? { documentNumber, invoiceNumber: documentNumber } : {})
  }
});

describe('the number format', () => {
  it('keeps device 1 on the format the business already issues', () => {
    assert.equal(
      formatDeviceDocumentNumber({ prefix: 'INV', financialYear: '2026-27', deviceIndex: 1, sequence: 1 }),
      'INV-2026-27-0001'
    );
  });

  it('stays inside the 16-character GST limit for every device and every sequence', () => {
    for (let index = 1; index <= MAX_DEVICE_INDEX; index += 1) {
      const documentNumber = formatDeviceDocumentNumber({
        prefix: 'INV',
        financialYear: '2026-27',
        deviceIndex: index,
        sequence: 9999
      });
      assert.ok(
        documentNumber.length <= GST_DOCUMENT_NUMBER_MAX_LENGTH,
        `${documentNumber} is ${documentNumber.length} characters`
      );
    }

    assert.equal(compactFinancialYear('2026-27'), '2627');
    assert.equal(
      formatDeviceDocumentNumber({ prefix: 'INV', financialYear: '2026-27', deviceIndex: 2, sequence: 7 }),
      'INV-2627-D2-0007'
    );
  });

  it('reads both formats back to the same financial year', () => {
    assert.deepEqual(parseDeviceDocumentNumber('INV-2026-27-0001'), {
      prefix: 'INV',
      financialYear: '2026-27',
      compact: false,
      deviceIndex: 1,
      sequence: 1
    });
    assert.deepEqual(parseDeviceDocumentNumber('INV-2627-D2-0042'), {
      prefix: 'INV',
      financialYear: '2026-27',
      compact: true,
      deviceIndex: 2,
      sequence: 42
    });
    assert.equal(parseDeviceDocumentNumber('not-a-number'), null);
  });
});

describe('POST /sync/device', () => {
  it('allocates the unsegmented series to the first device', async () => {
    const { token } = await createTestContext();

    const { body } = await registerDevice(token, 'device-alpha', { platform: 'android' }).expect(200);

    assert.equal(body.series.deviceIndex, 1);
    assert.equal(body.series.segment, '', 'device 1 has no segment, so nothing about the format changes');
    assert.equal(body.series.prefix, 'TST');
    assert.equal(body.series.financialYear, financialYearFor(new Date()));
    assert.equal(body.series.currentSequence, 0);
  });

  it('gives the second device its own series and is idempotent per device', async () => {
    const { token } = await createTestContext();
    await registerDevice(token, 'device-alpha').expect(200);

    const second = await registerDevice(token, 'device-beta').expect(200);
    assert.equal(second.body.series.deviceIndex, 2);
    assert.equal(second.body.series.segment, 'D2');

    // A reinstall that kept its id keeps its series: that series is on invoices already in
    // customers' hands.
    const again = await registerDevice(token, 'device-beta').expect(200);
    assert.equal(again.body.series.deviceIndex, 2);
    assert.equal(await DeviceSeries.countDocuments({}), 2);
  });

  it('reports where the shared series has reached, so a device cannot reissue a number', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business);

    // An invoice issued online while the device was away.
    await api()
      .post('/api/v1/invoices')
      .set(authHeader(token))
      .send({
        customerId: String(customer._id),
        items: [{ productId: String(product._id), quantity: 1 }],
        taxRate: 0,
        discountType: 'flat',
        discountValue: 0,
        notes: ''
      })
      .expect(201);

    const { body } = await registerDevice(token, 'device-alpha').expect(200);
    assert.equal(body.series.currentSequence, 1, 'the device must start above the number already issued');
  });
});

describe('pushing an invoice that carries its own number', () => {
  it('accepts a number from the device series and records the position', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10 });
    const { body: registration } = await registerDevice(token, 'device-beta').expect(200);
    assert.equal(registration.series.deviceIndex, 1);

    const documentNumber = formatDeviceDocumentNumber({
      prefix: 'TST',
      financialYear: financialYearFor(new Date()),
      deviceIndex: 1,
      sequence: 1
    });

    const { body } = await push(token, 'device-beta', [invoiceOp(documentNumber, { customer, product })]).expect(200);

    assert.equal(body.results[0].status, 'ok', body.results[0].message);
    const invoice = await Invoice.findById(body.results[0].serverId);
    // The number the customer already holds, unchanged.
    assert.equal(invoice.documentNumber, documentNumber);
    assert.equal(invoice.invoiceNumber, documentNumber);
    assert.equal(invoice.clientId, 'client-inv-1');

    // Stock moved, and the shared sequence was advanced so nothing else can take that number.
    assert.equal((await Product.findById(product._id)).stockQuantity, 8);
    const sequence = await NumberSequence.findOne({ business: business._id, documentType: 'invoice' });
    assert.equal(sequence.current, 1);
  });

  it('rejects a number from another device series', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business);
    await registerDevice(token, 'device-alpha').expect(200); // takes index 1
    await registerDevice(token, 'device-beta').expect(200); // index 2

    // Device beta claiming device alpha's unsegmented series.
    const { body } = await push(token, 'device-beta', [
      invoiceOp('TST-2026-27-0001', { customer, product })
    ]).expect(200);

    assert.equal(body.results[0].status, 'rejected');
    assert.equal(body.results[0].statusCode, 422);
    assert.equal(body.results[0].code, 'DOCUMENT_NUMBER_OUT_OF_SERIES');
    assert.equal(await Invoice.countDocuments({}), 0, 'nothing was written');
  });

  it('rejects a number the device has already used, rather than renumbering it', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 20 });
    await registerDevice(token, 'device-alpha').expect(200);

    const documentNumber = formatDeviceDocumentNumber({
      prefix: 'TST',
      financialYear: financialYearFor(new Date()),
      deviceIndex: 1,
      sequence: 1
    });

    await push(token, 'device-alpha', [invoiceOp(documentNumber, { customer, product })]).expect(200);
    const { body } = await push(token, 'device-alpha', [
      invoiceOp(documentNumber, { customer, product, clientId: 'client-inv-2' })
    ]).expect(200);

    // A duplicate serial number is an integrity incident, so it is reported as a conflict for
    // a person to resolve — never silently reassigned.
    assert.equal(body.results[0].status, 'conflict');
    assert.equal(body.results[0].code, 'DOCUMENT_NUMBER_DUPLICATE');
    assert.equal(await Invoice.countDocuments({}), 1);
  });

  it('rejects a future-dated invoice from a device whose clock has run ahead', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business);
    await registerDevice(token, 'device-alpha').expect(200);

    const op = invoiceOp('TST-2026-27-0001', { customer, product });
    op.payload.date = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();

    const { body } = await push(token, 'device-alpha', [op]).expect(200);

    // Otherwise a device with its date pushed forward bills into the next financial year.
    assert.equal(body.results[0].code, 'DOCUMENT_DATE_IN_FUTURE');
    assert.equal(await Invoice.countDocuments({}), 0);
  });

  it('accepts a bill dated days ago — an offline queue is meant to be old', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10 });
    await registerDevice(token, 'device-alpha').expect(200);

    const date = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const documentNumber = formatDeviceDocumentNumber({
      prefix: 'TST',
      financialYear: financialYearFor(date),
      deviceIndex: 1,
      sequence: 1
    });
    const op = invoiceOp(documentNumber, { customer, product });
    op.payload.date = date.toISOString();

    const { body } = await push(token, 'device-alpha', [op]).expect(200);

    assert.equal(body.results[0].status, 'ok', body.results[0].message);
    // The financial year follows the date of the sale, not the date of the sync.
    assert.equal((await Invoice.findById(body.results[0].serverId)).documentNumber, documentNumber);
  });

  it('rejects a numbered document from a device with no series', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business);

    const { body } = await push(token, 'device-ghost', [
      invoiceOp('TST-2026-27-0001', { customer, product })
    ]).expect(200);

    assert.equal(body.results[0].code, 'DEVICE_NOT_REGISTERED');
  });

  it('still lets the server do the numbering when the payload carries none', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business);

    const { body } = await push(token, 'device-alpha', [invoiceOp(null, { customer, product })]).expect(200);

    assert.equal(body.results[0].status, 'ok', body.results[0].message);
    const invoice = await Invoice.findById(body.results[0].serverId);
    assert.equal(invoice.documentNumber, 'TST-2026-27-0001'.replace('2026-27', financialYearFor(new Date())));
  });

  it('replays a create instead of issuing a second invoice for the same clientId', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 20 });
    await registerDevice(token, 'device-alpha').expect(200);

    const documentNumber = formatDeviceDocumentNumber({
      prefix: 'TST',
      financialYear: financialYearFor(new Date()),
      deviceIndex: 1,
      sequence: 1
    });
    const op = invoiceOp(documentNumber, { customer, product });

    const first = await push(token, 'device-alpha', [op]).expect(200);
    // The response was lost on the way back and the device retried the same operation.
    const second = await push(token, 'device-alpha', [op]).expect(200);

    assert.equal(second.body.results[0].status, 'ok');
    assert.equal(second.body.results[0].serverId, first.body.results[0].serverId);
    assert.equal(await Invoice.countDocuments({}), 1, 'a duplicate invoice is a compliance problem');
    assert.equal((await Product.findById(product._id)).stockQuantity, 18, 'and stock moved once');
  });
});
