import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Customer from '../src/models/Customer.js';
import Product from '../src/models/Product.js';
import { INCLUDE_DELETED } from '../src/models/plugins/syncable.js';
import {
  formatDocumentNumber,
  GST_DOCUMENT_NUMBER_MAX_LENGTH,
  MAX_DOCUMENT_PREFIX_LENGTH
} from '../src/services/numberingService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createProduct, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

describe('syncable: version', () => {
  it('starts at 1 and increments on save', async () => {
    const { business } = await createTestContext();
    const product = await createProduct(business);

    assert.equal(product.version, 1);

    product.name = 'Renamed';
    await product.save();

    assert.equal(product.version, 2);
  });

  it('increments on the query path too, which is where Mongoose __v does not', async () => {
    const { business } = await createTestContext();
    const customer = await Customer.create({ business: business._id, name: 'Acme', phone: '9876543210' });

    await Customer.findOneAndUpdate({ _id: customer._id }, { name: 'Acme Ltd' });
    await Customer.updateOne({ _id: customer._id }, { $set: { email: 'a@b.com' } });

    const reloaded = await Customer.findById(customer._id);
    assert.equal(reloaded.version, 3);
  });

  it('will not let a caller pin or rewind the version', async () => {
    const { business } = await createTestContext();
    const product = await createProduct(business);

    await Product.updateOne({ _id: product._id }, { $set: { name: 'Hacked', version: 99 } });

    const reloaded = await Product.findById(product._id);
    assert.equal(reloaded.name, 'Hacked');
    assert.equal(reloaded.version, 2);
  });
});

describe('syncable: soft delete', () => {
  it('hides tombstones from find, count and aggregate', async () => {
    const { business, user } = await createTestContext();
    const product = await createProduct(business, { name: 'Gone' });
    await createProduct(business, { name: 'Still here' });

    await Product.softDeleteOne({ _id: product._id, business: business._id }, { userId: user._id });

    assert.equal(await Product.countDocuments({ business: business._id }), 1);
    assert.equal((await Product.find({ business: business._id })).length, 1);

    const aggregated = await Product.aggregate([{ $match: { business: business._id } }]);
    assert.equal(aggregated.length, 1);
    assert.equal(aggregated[0].name, 'Still here');
  });

  it('keeps the row, so a delta pull can carry the deletion', async () => {
    const { business, user } = await createTestContext();
    const product = await createProduct(business);

    await Product.softDeleteOne({ _id: product._id, business: business._id }, { userId: user._id });

    const tombstone = await Product.findOne({ _id: product._id }).setOptions({ [INCLUDE_DELETED]: true });
    assert.ok(tombstone, 'the record must survive deletion');
    assert.ok(tombstone.deletedAt instanceof Date);
    assert.equal(String(tombstone.deletedBy), String(user._id));
  });

  it('returns null on a second delete, so the controller still 404s', async () => {
    const { business, user } = await createTestContext();
    const product = await createProduct(business);

    assert.ok(await Product.softDeleteOne({ _id: product._id, business: business._id }, { userId: user._id }));
    assert.equal(await Product.softDeleteOne({ _id: product._id, business: business._id }, { userId: user._id }), null);
  });

  it('frees the SKU and barcode of a deleted product for re-use', async () => {
    const { business, user } = await createTestContext();
    await Product.createIndexes();

    const original = await createProduct(business, { name: 'Rice 5kg', sku: 'SKU-1234', barcode: '8901234567890' });
    await Product.softDeleteOne({ _id: original._id, business: business._id }, { userId: user._id });

    // The whole point of A3: without deletedAt in the partial filter this throws E11000
    // against a record the user cannot see.
    const recreated = await createProduct(business, { name: 'Rice 5kg', sku: 'SKU-1234', barcode: '8901234567890' });
    assert.ok(recreated._id);
  });

  it('still rejects a duplicate SKU among live products', async () => {
    const { business } = await createTestContext();
    await Product.createIndexes();

    await createProduct(business, { name: 'One', sku: 'SKU-DUP' });
    await assert.rejects(() => createProduct(business, { name: 'Two', sku: 'SKU-DUP' }), /E11000/);
  });
});

describe('syncable: clientId', () => {
  it('is unique per business but ignores records that have none', async () => {
    const { business } = await createTestContext();
    await Product.createIndexes();

    await createProduct(business, { name: 'No client id A' });
    await createProduct(business, { name: 'No client id B' });

    await createProduct(business, { name: 'From device', clientId: '01927b3e-0000-7000-8000-000000000001' });
    await assert.rejects(
      () => createProduct(business, { name: 'Retried push', clientId: '01927b3e-0000-7000-8000-000000000001' }),
      /E11000/
    );
  });

  it('does not collide across businesses', async () => {
    const first = await createTestContext();
    const second = await createTestContext();
    await Product.createIndexes();

    const clientId = '01927b3e-0000-7000-8000-000000000002';
    await createProduct(first.business, { clientId });
    await createProduct(second.business, { clientId });
  });
});

describe('product and customer delete endpoints', () => {
  it('tombstones instead of removing, and 404s on the second call', async () => {
    const { business, token } = await createTestContext();
    const product = await createProduct(business);

    await api().delete(`/api/v1/products/${product._id}`).set(authHeader(token)).expect(200);
    await api().delete(`/api/v1/products/${product._id}`).set(authHeader(token)).expect(404);

    const tombstone = await Product.findOne({ _id: product._id }).setOptions({ [INCLUDE_DELETED]: true });
    assert.ok(tombstone.deletedAt);

    const listed = (await api().get('/api/v1/products').set(authHeader(token)).expect(200)).body.products;
    assert.equal(listed.length, 0);
  });

  it('replays a repeated create carrying the same idempotency key', async () => {
    const { token } = await createTestContext();
    const key = 'test-idempotency-key-1';
    const payload = { name: 'Idempotent product', price: 50, stockQuantity: 5 };

    const first = await api().post('/api/v1/products').set(authHeader(token)).set('Idempotency-Key', key).send(payload).expect(201);
    const second = await api().post('/api/v1/products').set(authHeader(token)).set('Idempotency-Key', key).send(payload).expect(201);

    assert.equal(String(first.body.product._id), String(second.body.product._id));
    assert.equal(await Product.countDocuments({}), 1);
  });
});

describe('GST document number length', () => {
  it('renders exactly 16 characters at the maximum prefix', async () => {
    const prefix = 'A'.repeat(MAX_DOCUMENT_PREFIX_LENGTH);
    const number = formatDocumentNumber({ prefix, financialYear: '2026-27', sequence: 1 });

    assert.equal(number, `${prefix}-2026-27-0001`);
    assert.equal(number.length, GST_DOCUMENT_NUMBER_MAX_LENGTH);
  });

  it('rejects an over-long prefix rather than issuing an illegal number', () => {
    assert.throws(
      () => formatDocumentNumber({ prefix: 'QUICKMART', financialYear: '2026-27', sequence: 1 }),
      (error) => error.details?.code === 'DOCUMENT_NUMBER_TOO_LONG'
    );
  });

  it('rejects a sequence that overflows four digits', () => {
    assert.throws(
      () => formatDocumentNumber({ prefix: 'INV', financialYear: '2026-27', sequence: 10000 }),
      (error) => error.details?.code === 'DOCUMENT_NUMBER_TOO_LONG'
    );
  });

  it('refuses to save a business prefix that cannot render a compliant number', async () => {
    const { token } = await createTestContext();

    await api().patch('/api/v1/settings').set(authHeader(token)).send({ invoicePrefix: 'QUICKMART' }).expect(422);
    await api().patch('/api/v1/settings').set(authHeader(token)).send({ invoicePrefix: 'QMT' }).expect(200);
  });
});
