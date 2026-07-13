import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildInvoiceHtml } from '../src/services/invoiceHtml.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const render = (invoiceTemplate) => buildInvoiceHtml({ items: [], total: 0 }, { invoiceTemplate });

describe('invoice signature block', () => {
  it('off by default: no signature image, shows system-generated note', () => {
    const html = render({});
    assert.ok(!html.includes('class="sign-img"'));
    assert.ok(html.includes('no signature is required'));
  });

  it('on with a saved signature: embeds the image', () => {
    const html = render({ showSignature: true, signatureUrl: PNG });
    assert.ok(html.includes('class="sign-img"'));
    assert.ok(html.includes(PNG));
  });

  it('on without an image: falls back to a blank signatory line', () => {
    const html = render({ showSignature: true, signatureUrl: '' });
    assert.ok(!html.includes('class="sign-img"'));
    assert.ok(html.includes('Authorized signatory'));
  });
});
