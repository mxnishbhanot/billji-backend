import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Product from '../src/models/Product.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createProduct, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);
const searchProducts = async (token, search) =>
  (await api().get('/api/v1/products').query({ search }).set(authHeader(token)).expect(200)).body.products;

describe('barcode search', () => {
  it('returns only the scanned product, even when other names contain the digits', async () => {
    const { business, token } = await createTestContext();
    const scanned = await createProduct(business, { name: 'Parle-G Biscuit', barcode: '5901234123457' });
    // A decoy whose name embeds the same digits — a plain text search would rank it too.
    await createProduct(business, { name: 'Combo 5901234123457 pack', sku: 'COMBO-1' });

    const results = await searchProducts(token, '5901234123457');

    assert.equal(results.length, 1);
    assert.equal(String(results[0]._id), String(scanned._id));
    assert.equal(results[0].barcode, '5901234123457');
  });

  it('still finds products by partial barcode when nothing matches exactly', async () => {
    const { business, token } = await createTestContext();
    await createProduct(business, { name: 'Rice 5kg', barcode: '8901234567890' });

    // Partial scan / typed fragment falls through to the regex search.
    const results = await searchProducts(token, '890123456');

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Rice 5kg');
  });

  it('leaves name and SKU search working', async () => {
    const { business, token } = await createTestContext();
    await createProduct(business, { name: 'Toor Dal', sku: 'DAL-01', barcode: '1111111111111' });

    assert.equal((await searchProducts(token, 'toor')).length, 1);
    assert.equal((await searchProducts(token, 'DAL-01')).length, 1);
  });

  it('never resolves a barcode belonging to another business', async () => {
    const mine = await createTestContext();
    const theirs = await createTestContext();
    await createProduct(theirs.business, { name: 'Their Product', barcode: '7777777777777' });

    assert.equal((await searchProducts(mine.token, '7777777777777')).length, 0);
  });
});

describe('barcode assignment', () => {
  it('saves and clears a barcode through the API', async () => {
    const { token } = await createTestContext();

    const created = await api()
      .post('/api/v1/products')
      .set(authHeader(token))
      .send({ name: 'Sugar 1kg', price: 45, stockQuantity: 10, barcode: '8901030865278' })
      .expect(201);
    assert.equal(created.body.product.barcode, '8901030865278');

    // PATCH validates with the full productRules (name and price required), so an update
    // resends the product rather than the single changed field.
    const cleared = await api()
      .patch(`/api/v1/products/${created.body.product._id}`)
      .set(authHeader(token))
      .send({ name: 'Sugar 1kg', price: 45, stockQuantity: 10, barcode: '' })
      .expect(200);
    assert.equal(cleared.body.product.barcode, '');
  });

  it('rejects the same barcode on two products in one business', async () => {
    const { business, token } = await createTestContext();
    await Product.init(); // ensure the unique partial index exists before racing it
    await createProduct(business, { name: 'First', barcode: '4006381333931' });

    const res = await api()
      .post('/api/v1/products')
      .set(authHeader(token))
      .send({ name: 'Second', price: 10, stockQuantity: 1, barcode: '4006381333931' });

    assert.ok(res.status >= 400, `expected a failure, got ${res.status}`);
  });

  it('allows many products with no barcode at all', async () => {
    const { business, token } = await createTestContext();
    await Product.init();
    await createProduct(business, { name: 'Loose rice' });
    await createProduct(business, { name: 'Loose wheat' });

    // Empty barcodes must not collide on the unique index.
    const res = await api().get('/api/v1/products').set(authHeader(token)).expect(200);
    assert.equal(res.body.products.length, 2);
  });

  it('lets two businesses use the same barcode', async () => {
    const first = await createTestContext();
    const second = await createTestContext();
    await Product.init();

    await createProduct(first.business, { name: 'Coke 300ml', barcode: '5449000000996' });
    await createProduct(second.business, { name: 'Coke 300ml', barcode: '5449000000996' });

    assert.equal((await searchProducts(first.token, '5449000000996')).length, 1);
    assert.equal((await searchProducts(second.token, '5449000000996')).length, 1);
  });
});
