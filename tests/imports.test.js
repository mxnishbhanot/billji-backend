import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Customer from '../src/models/Customer.js';
import Product from '../src/models/Product.js';
import StockMovement from '../src/models/StockMovement.js';
import { CSV_BOM } from '../src/modules/exports/csv.js';
import { parseCsv, parseCsvTable } from '../src/modules/exports/csvReader.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

let seq = 0;
const idem = () => {
  seq += 1;
  return { [IDEMPOTENCY_HEADER]: `import-${seq}` };
};

const preview = (token, payload, expected = 200) =>
  api().post('/api/v1/imports/preview').set(authHeader(token)).send(payload).expect(expected).then((res) => res.body);

const commit = (token, payload, headers = idem(), expected = 201) =>
  api().post('/api/v1/imports/commit').set(authHeader(token)).set(headers).send(payload).expect(expected).then((res) => res.body);

describe('csv reader', () => {
  it('keeps commas, newlines and escaped quotes inside quoted cells', () => {
    const rows = parseCsv('name,address\r\n"Sharma, R","Line 1\nLine 2"\r\n"He said ""hi""",Delhi\r\n');

    assert.deepEqual(rows, [
      ['name', 'address'],
      ['Sharma, R', 'Line 1\nLine 2'],
      ['He said "hi"', 'Delhi']
    ]);
  });

  it('strips a UTF-8 BOM so the first header is not mangled', () => {
    const { headers, rows } = parseCsvTable(`${CSV_BOM}name,phone\r\nAsha,9999900001\r\n`);

    assert.deepEqual(headers, ['name', 'phone']);
    assert.equal(rows[0].name, 'Asha');
    // Line numbers point at the file so an error message can name the row.
    assert.equal(rows[0].line, 2);
  });

  it('drops blank lines and tolerates plain LF endings', () => {
    const rows = parseCsv('a,b\nx,y\n\n\nz,w');

    assert.deepEqual(rows, [['a', 'b'], ['x', 'y'], ['z', 'w']]);
  });
});

describe('customer import', () => {
  it('guesses columns from the file headers and reports what will be created', async () => {
    const { token } = await createTestContext();

    const result = await preview(token, {
      type: 'customers',
      csv: 'Customer Name,Mobile,Email ID,GSTIN,City\r\nAsha Traders,9812300001,asha@example.com,29ABCDE1234F1Z5,Bengaluru\r\n'
    });

    assert.equal(result.columnMap.name, 'Customer Name');
    assert.equal(result.columnMap.phone, 'Mobile');
    assert.equal(result.columnMap.gstNumber, 'GSTIN');
    assert.equal(result.counts.create, 1);
    assert.equal(result.counts.error, 0);
  });

  it('reports a bad row without blocking the good ones', async () => {
    const { business, token } = await createTestContext();

    const csv = 'name,phone\r\nGood One,9812300002\r\n,9812300003\r\nAlso Good,9812300004\r\n';
    const analysis = await preview(token, { type: 'customers', csv });
    assert.equal(analysis.counts.error, 1);
    assert.equal(analysis.counts.create, 2);

    const result = await commit(token, { type: 'customers', csv });
    assert.equal(result.created, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.errors[0].line, 3);
    assert.match(result.errors[0].errors[0], /Name is required/);

    const stored = await Customer.find({ business: business._id }).lean();
    assert.deepEqual(stored.map((row) => row.name).sort(), ['Also Good', 'Good One']);
  });

  it('flags a phone repeated inside the file and imports it once', async () => {
    const { business, token } = await createTestContext();

    const csv = 'name,phone\r\nFirst,9812300005\r\nSecond,9812300005\r\n';
    const analysis = await preview(token, { type: 'customers', csv });
    assert.equal(analysis.counts.duplicate, 1);
    assert.equal(analysis.rows === undefined, true, 'preview must not ship every row body');

    const result = await commit(token, { type: 'customers', csv });
    assert.equal(result.created, 1);
    assert.equal(result.skipped, 1);
    assert.equal(await Customer.countDocuments({ business: business._id }), 1);
  });

  it('skips a phone that already exists, and updates it when asked to', async () => {
    const { business, token } = await createTestContext();
    await Customer.create({ business: business._id, name: 'Old Name', phone: '9812300006' });

    const csv = 'name,phone,city\r\nNew Name,9812300006,Pune\r\n';

    const skipped = await commit(token, { type: 'customers', csv });
    assert.equal(skipped.created, 0);
    assert.equal(skipped.skipped, 1);
    assert.equal((await Customer.findOne({ phone: '9812300006' }).lean()).name, 'Old Name');

    const updated = await commit(token, { type: 'customers', csv, mode: 'update' });
    assert.equal(updated.updated, 1);
    const after = await Customer.findOne({ phone: '9812300006' }).lean();
    assert.equal(after.name, 'New Name');
    assert.equal(after.billingAddress.city, 'Pune');
  });

  it('honours an explicit column map over the guess', async () => {
    const { business, token } = await createTestContext();

    const csv = 'col_a,col_b\r\nMapped Co,9812300007\r\n';
    const result = await commit(token, { type: 'customers', csv, columnMap: { name: 'col_a', phone: 'col_b' } });

    assert.equal(result.created, 1);
    assert.ok(await Customer.findOne({ business: business._id, name: 'Mapped Co' }));
  });

  it('refuses a file with no column for a required field', async () => {
    const { token } = await createTestContext();

    const res = await preview(token, { type: 'customers', csv: 'name,city\r\nNo Phone,Delhi\r\n' }, 422);
    assert.equal(res.details.code, 'IMPORT_MAP_INCOMPLETE');
    assert.deepEqual(res.details.missing, ['Phone']);
  });

  it('replays the same idempotency key instead of importing twice', async () => {
    const { business, token } = await createTestContext();

    const csv = 'name,phone\r\nOnce Only,9812300008\r\n';
    const key = idem();
    const first = await commit(token, { type: 'customers', csv }, key);
    const second = await commit(token, { type: 'customers', csv }, key);

    assert.equal(first.created, 1);
    assert.equal(second.created, 1, 'replayed response, not a second insert');
    assert.equal(await Customer.countDocuments({ business: business._id }), 1);
  });
});

describe('product import', () => {
  it('imports prices, stock and tax fields, writing an opening-stock movement', async () => {
    const { business, token } = await createTestContext();

    const csv = 'Item Name,Rate,Qty,HSN,GST %,Item Code\r\nBasmati Rice,320,12,1006,5,RICE-1\r\n';
    const result = await commit(token, { type: 'products', csv });

    assert.equal(result.created, 1);
    const product = await Product.findOne({ business: business._id }).lean();
    assert.equal(product.price, 320);
    assert.equal(product.salePrice, 320);
    assert.equal(product.stockQuantity, 12);
    assert.equal(product.hsn, '1006');
    assert.equal(product.taxRate, 5);
    assert.equal(product.sku, 'RICE-1');

    const movements = await StockMovement.find({ business: business._id, product: product._id }).lean();
    assert.equal(movements.length, 1);
    assert.equal(movements[0].type, 'opening_stock');
    assert.equal(movements[0].stockAfter, 12);
  });

  it('strips currency formatting from a number and rejects text in a price', async () => {
    const { business, token } = await createTestContext();

    const csv = 'name,price\r\nFormatted,"1,250"\r\nBroken,abc\r\n';
    const result = await commit(token, { type: 'products', csv });

    assert.equal(result.created, 1);
    assert.equal(result.failed, 1);
    assert.equal((await Product.findOne({ business: business._id, name: 'Formatted' }).lean()).price, 1250);
  });

  it('matches an existing product on SKU and never overwrites live stock on update', async () => {
    const { business, token } = await createTestContext();
    await Product.create({ business: business._id, name: 'Old Rice', price: 300, stockQuantity: 4, sku: 'RICE-2' });

    const csv = 'name,price,sku,stock\r\nNew Rice,350,RICE-2,99\r\n';
    const analysis = await preview(token, { type: 'products', csv });
    assert.equal(analysis.counts.update, 1);

    const result = await commit(token, { type: 'products', csv, mode: 'update' });
    assert.equal(result.updated, 1);
    const product = await Product.findOne({ business: business._id, sku: 'RICE-2' }).lean();
    assert.equal(product.name, 'New Rice');
    assert.equal(product.price, 350);
    assert.equal(product.stockQuantity, 4, 'the file column is an opening balance, not a live count');
  });

  it('falls back to barcode when the row has no SKU', async () => {
    const { business, token } = await createTestContext();
    await Product.create({ business: business._id, name: 'Scanned', price: 50, barcode: '8901234567890' });

    const analysis = await preview(token, {
      type: 'products',
      csv: 'name,price,barcode\r\nScanned Again,60,8901234567890\r\n'
    });

    assert.equal(analysis.counts.update, 1);
    assert.equal(await Product.countDocuments({ business: business._id }), 1);
  });
});

describe('import access', () => {
  it('needs the matching manage permission for the type being imported', async () => {
    const { token } = await createTestContext({ roleKey: 'viewer' });

    await api()
      .post('/api/v1/imports/preview')
      .set(authHeader(token))
      .send({ type: 'customers', csv: 'name,phone\r\nX,1\r\n' })
      .expect(403);
  });

  it('rejects an unknown import type at validation', async () => {
    const { token } = await createTestContext();

    await api().post('/api/v1/imports/preview').set(authHeader(token)).send({ type: 'invoices', csv: 'a\r\nb\r\n' }).expect(422);
  });
});
