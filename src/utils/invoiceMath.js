const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const calculateInvoiceTotals = ({ items = [], taxRate = 0, discountType = 'flat', discountValue = 0 }) => {
  const normalizedItems = items.map((item) => {
    const quantity = Math.max(Number(item.quantity) || 1, 1);
    const price = Math.max(Number(item.price) || 0, 0);

    return {
      ...item,
      quantity,
      price: roundMoney(price),
      total: roundMoney(quantity * price)
    };
  });

  const subtotal = roundMoney(normalizedItems.reduce((sum, item) => sum + item.total, 0));
  const rawDiscount = discountType === 'percentage' ? subtotal * (Number(discountValue) / 100) : Number(discountValue);
  const discountAmount = roundMoney(Math.min(Math.max(rawDiscount || 0, 0), subtotal));
  const taxableAmount = Math.max(subtotal - discountAmount, 0);
  const taxAmount = roundMoney(taxableAmount * ((Number(taxRate) || 0) / 100));
  const total = roundMoney(taxableAmount + taxAmount);

  return {
    items: normalizedItems,
    subtotal,
    discount: {
      type: discountType,
      value: roundMoney(discountValue),
      amount: discountAmount
    },
    tax: {
      rate: roundMoney(taxRate),
      amount: taxAmount
    },
    total
  };
};
