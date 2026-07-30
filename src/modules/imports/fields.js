// Field catalogue per importable entity. One table drives validation, duplicate detection,
// header auto-guessing and the mobile mapping UI — so adding a column is a one-line change
// here rather than an edit in four places.

const text = (max) => (value) => (value.length > max ? `must be ${max} characters or less` : null);

const number = ({ min = 0, integer = false } = {}) => (value) => {
  const parsed = Number(value.replace(/[,\s₹]/g, ''));
  if (!Number.isFinite(parsed)) return 'must be a number';
  if (parsed < min) return `must be ${min} or more`;
  if (integer && !Number.isInteger(parsed)) return 'must be a whole number';
  return null;
};

const toNumber = (value) => Number(String(value).replace(/[,\s₹]/g, ''));

// Aliases are matched loosely (lowercased, non-alphanumerics stripped) against the file's
// own headers, so "Customer Name", "customer_name" and "NAME" all land on `name`.
export const IMPORT_ENTITIES = {
  customers: {
    label: 'Customers',
    permission: 'customersManage',
    // Phone is how we tell two customers apart, and Customer.phone is required anyway.
    duplicateKey: 'phone',
    duplicateLabel: 'phone number',
    fields: [
      { name: 'name', label: 'Name', required: true, aliases: ['name', 'customername', 'partyname', 'party', 'client'], validate: text(120) },
      { name: 'phone', label: 'Phone', required: true, aliases: ['phone', 'mobile', 'phonenumber', 'contact', 'contactnumber'], validate: text(24) },
      { name: 'email', label: 'Email', aliases: ['email', 'emailid', 'mail'], validate: text(120) },
      { name: 'gstNumber', label: 'GSTIN', aliases: ['gstnumber', 'gstin', 'gst', 'gstno'], validate: text(32) },
      { name: 'address', label: 'Address', aliases: ['address', 'billingaddress', 'addressline1', 'street'], validate: text(500) },
      { name: 'city', label: 'City', aliases: ['city', 'town'], validate: text(80) },
      { name: 'state', label: 'State', aliases: ['state'], validate: text(80) },
      { name: 'pinCode', label: 'PIN code', aliases: ['pincode', 'pin', 'zip', 'zipcode', 'postalcode'], validate: text(16) }
    ]
  },
  products: {
    label: 'Products',
    permission: 'productsManage',
    // SKU first, barcode as the fallback — both carry a unique-per-business index.
    duplicateKey: 'sku',
    duplicateFallbackKey: 'barcode',
    duplicateLabel: 'SKU or barcode',
    fields: [
      { name: 'name', label: 'Name', required: true, aliases: ['name', 'productname', 'itemname', 'item', 'description'], validate: text(120) },
      { name: 'price', label: 'Sale price', required: true, aliases: ['price', 'saleprice', 'sellingprice', 'rate', 'mrp'], validate: number() },
      { name: 'purchasePrice', label: 'Cost price', aliases: ['purchaseprice', 'costprice', 'cost', 'buyingprice'], validate: number() },
      { name: 'stockQuantity', label: 'Stock', aliases: ['stockquantity', 'stock', 'quantity', 'qty', 'openingstock'], validate: number({ integer: true }) },
      { name: 'unit', label: 'Unit', aliases: ['unit', 'uom', 'measure'], validate: text(24) },
      { name: 'sku', label: 'SKU', aliases: ['sku', 'code', 'itemcode', 'productcode'], validate: text(64) },
      { name: 'barcode', label: 'Barcode', aliases: ['barcode', 'ean', 'upc', 'scancode'], validate: text(64) },
      { name: 'hsn', label: 'HSN / SAC', aliases: ['hsn', 'hsncode', 'sac', 'saccode', 'hsnsac'], validate: text(8) },
      { name: 'taxRate', label: 'GST %', aliases: ['taxrate', 'gst', 'gstrate', 'gstpercent', 'tax'], validate: number({ min: 0 }) },
      { name: 'category', label: 'Category', aliases: ['category', 'group', 'type'], validate: text(80) }
    ]
  }
};

export const IMPORT_TYPES = Object.keys(IMPORT_ENTITIES);

const normalizeHeader = (header) => String(header).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Guesses `{ ourField: theirHeader }` from the file's headers. Unmatched fields are absent. */
export const guessColumnMap = (entity, headers) => {
  const byNormalized = new Map(headers.filter(Boolean).map((header) => [normalizeHeader(header), header]));
  const map = {};

  for (const field of entity.fields) {
    for (const alias of [field.name, ...field.aliases]) {
      const match = byNormalized.get(normalizeHeader(alias));
      if (match && !Object.values(map).includes(match)) {
        map[field.name] = match;
        break;
      }
    }
  }

  return map;
};

/** Reads one CSV row through the column map into `{ values, errors }`. */
export const readRow = (entity, row, columnMap) => {
  const values = {};
  const errors = [];

  for (const field of entity.fields) {
    const header = columnMap[field.name];
    const raw = header ? String(row[header] ?? '').trim() : '';

    if (!raw) {
      if (field.required) errors.push(`${field.label} is required`);
      continue;
    }

    const problem = field.validate(raw);
    if (problem) {
      errors.push(`${field.label} ${problem}`);
      continue;
    }

    values[field.name] = raw;
  }

  return { values, errors };
};

/** Shapes a validated row into a Customer document body. */
export const customerDoc = (values) => ({
  name: values.name,
  phone: values.phone,
  email: (values.email || '').toLowerCase(),
  gstNumber: (values.gstNumber || '').toUpperCase(),
  address: values.address || '',
  billingAddress: {
    line1: values.address || '',
    city: values.city || '',
    state: values.state || '',
    pinCode: values.pinCode || ''
  }
});

/** Shapes a validated row into a Product document body. */
export const productDoc = (values) => ({
  name: values.name,
  price: toNumber(values.price),
  salePrice: toNumber(values.price),
  purchasePrice: values.purchasePrice ? toNumber(values.purchasePrice) : 0,
  stockQuantity: values.stockQuantity ? toNumber(values.stockQuantity) : 0,
  unit: values.unit || 'pcs',
  sku: values.sku || '',
  barcode: values.barcode || '',
  hsn: values.hsn || '',
  taxRate: values.taxRate ? Math.min(100, toNumber(values.taxRate)) : 0,
  category: values.category || ''
});

export const DOC_BUILDERS = { customers: customerDoc, products: productDoc };
