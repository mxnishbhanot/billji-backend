import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveDocumentView } from '../src/services/invoice/invoiceHelpers.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const view = (invoiceTemplate) => deriveDocumentView({ items: [], total: 0 }, { invoiceTemplate });

describe('invoice signature block', () => {
  it('off by default: no signature image, shows system-generated note', () => {
    const derived = view({});
    assert.equal(derived.showSignature, false);
    assert.equal(derived.signatureUrl, '');
  });

  it('on with a saved signature: embeds the image', () => {
    const derived = view({ showSignature: true, signatureUrl: PNG });
    assert.equal(derived.showSignature, true);
    assert.equal(derived.signatureUrl, PNG);
  });

  it('on without an image: falls back to a blank signatory line', () => {
    const derived = view({ showSignature: true, signatureUrl: '' });
    assert.equal(derived.showSignature, true);
    assert.equal(derived.signatureUrl, '');
  });

  // A remote URL cannot be embedded — the renderer would have to fetch mid-render.
  it('ignores a signature that is not an inline image', () => {
    const derived = view({ showSignature: true, signatureUrl: 'https://cdn.example.com/sign.png' });
    assert.equal(derived.signatureUrl, '');
  });
});
