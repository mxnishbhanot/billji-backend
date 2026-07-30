const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Splits `amount` across `weights` so the parts always sum back to `amount` exactly.
 * Each part is rounded down to paise and the accumulated remainder lands on the last
 * non-zero-weight row — otherwise a 3-way split of a ₹10 discount loses a paisa and the
 * invoice total stops matching the sum of its lines.
 */
const allocateProportionally = (amount, weights) => {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const target = roundMoney(amount);
  if (target <= 0 || total <= 0) return weights.map(() => 0);

  const parts = weights.map((weight) => Math.floor((weight / total) * target * 100) / 100);
  const distributed = roundMoney(parts.reduce((sum, part) => sum + part, 0));
  let remainder = Math.round((target - distributed) * 100);

  // Hand the leftover paise out one at a time, largest weight first, so the correction
  // lands where it is least visible.
  const order = weights
    .map((weight, index) => ({ weight, index }))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  let cursor = 0;
  while (remainder > 0 && order.length) {
    parts[order[cursor % order.length].index] = roundMoney(parts[order[cursor % order.length].index] + 0.01);
    remainder -= 1;
    cursor += 1;
  }

  return parts;
};

/**
 * Per-item GST with a CGST/SGST or IGST split.
 *
 * @param {object} input
 * @param {Array} input.items                line items; each may carry its own `taxRate` and `hsn`
 * @param {number} input.taxRate             fallback rate for items without one (the old invoice-level rate)
 * @param {'flat'|'percentage'} input.discountType
 * @param {number} input.discountValue
 * @param {'intra'|'inter'} input.supplyType intra => CGST+SGST, inter => IGST
 * @param {boolean} input.pricesIncludeTax   item prices already contain tax (business tax setting)
 */
export const calculateInvoiceTotals = ({
  items = [],
  taxRate = 0,
  discountType = 'flat',
  discountValue = 0,
  supplyType = 'intra',
  pricesIncludeTax = false
}) => {
  const fallbackRate = Math.max(Number(taxRate) || 0, 0);
  const isInterState = supplyType === 'inter';

  const priced = items.map((item) => {
    const quantity = Math.max(Number(item.quantity) || 1, 1);
    const price = Math.max(Number(item.price) || 0, 0);
    // An item's own rate wins; only fall back to the document rate when it has none.
    const rate = Math.max(Number(item.taxRate ?? fallbackRate) || 0, 0);
    const gross = roundMoney(quantity * price);
    // With tax-inclusive pricing the line total already contains the tax, so the
    // taxable base is the amount net of it.
    const netOfTax = pricesIncludeTax ? roundMoney(gross / (1 + rate / 100)) : gross;

    return { ...item, quantity, price: roundMoney(price), total: gross, rate, netOfTax };
  });

  // Subtotal stays the sum of line totals (tax-exclusive base when prices exclude tax,
  // net-of-tax base when they include it) so subtotal + tax === total either way.
  const subtotal = roundMoney(priced.reduce((sum, item) => sum + item.netOfTax, 0));
  const rawDiscount = discountType === 'percentage' ? subtotal * (Number(discountValue) / 100) : Number(discountValue);
  const discountAmount = roundMoney(Math.min(Math.max(rawDiscount || 0, 0), subtotal));

  // A document-level discount reduces each line's taxable value proportionally — tax is
  // charged on what the customer actually pays, not on the pre-discount price.
  const discountShares = allocateProportionally(discountAmount, priced.map((item) => item.netOfTax));

  const normalizedItems = priced.map((item, index) => {
    const taxableValue = roundMoney(Math.max(item.netOfTax - discountShares[index], 0));
    const taxAmount = roundMoney(taxableValue * (item.rate / 100));
    // CGST and SGST are always half each; the halves must re-sum to taxAmount exactly.
    const cgst = isInterState ? 0 : roundMoney(taxAmount / 2);
    const sgst = isInterState ? 0 : roundMoney(taxAmount - cgst);

    return {
      ...item,
      hsn: item.hsn ? String(item.hsn).trim() : '',
      taxRate: item.rate,
      taxableValue,
      taxAmount,
      cgst,
      sgst,
      igst: isInterState ? taxAmount : 0,
      // Line total shown on the invoice stays the pre-discount gross, matching what the
      // customer sees against that row.
      total: item.total
    };
  });

  const taxTotal = roundMoney(normalizedItems.reduce((sum, item) => sum + item.taxAmount, 0));
  const taxableTotal = roundMoney(normalizedItems.reduce((sum, item) => sum + item.taxableValue, 0));
  const total = roundMoney(taxableTotal + taxTotal);

  // HSN-wise summary, the shape GSTR-1 and the printed invoice both need.
  const summaryByKey = new Map();
  for (const item of normalizedItems) {
    const key = `${item.hsn}|${item.taxRate}`;
    const row = summaryByKey.get(key) || {
      hsn: item.hsn,
      rate: item.taxRate,
      taxableValue: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      taxAmount: 0
    };
    row.taxableValue = roundMoney(row.taxableValue + item.taxableValue);
    row.cgst = roundMoney(row.cgst + item.cgst);
    row.sgst = roundMoney(row.sgst + item.sgst);
    row.igst = roundMoney(row.igst + item.igst);
    row.taxAmount = roundMoney(row.taxAmount + item.taxAmount);
    summaryByKey.set(key, row);
  }

  return {
    items: normalizedItems.map(({ rate, netOfTax, ...item }) => item),
    subtotal,
    discount: {
      type: discountType,
      value: roundMoney(discountValue),
      amount: discountAmount
    },
    // Kept as a derived aggregate: reports, the PDF, the export manifest and the mobile
    // client all read `tax.rate` / `tax.amount`. `rate` is meaningful only when every
    // line shares one rate — mixed-rate invoices report 0 and callers use taxSummary.
    tax: {
      rate: new Set(normalizedItems.map((item) => item.taxRate)).size === 1 ? normalizedItems[0]?.taxRate ?? 0 : 0,
      amount: taxTotal
    },
    taxableTotal,
    cgstTotal: roundMoney(normalizedItems.reduce((sum, item) => sum + item.cgst, 0)),
    sgstTotal: roundMoney(normalizedItems.reduce((sum, item) => sum + item.sgst, 0)),
    igstTotal: roundMoney(normalizedItems.reduce((sum, item) => sum + item.igst, 0)),
    taxSummary: [...summaryByKey.values()].sort((a, b) => a.rate - b.rate || a.hsn.localeCompare(b.hsn)),
    total
  };
};
