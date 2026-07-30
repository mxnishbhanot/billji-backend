// GST state codes (the first two digits of a GSTIN). Place of supply is decided by
// comparing the supplier's code with the customer's: same code => CGST + SGST,
// different => IGST. Getting this wrong is a compliance error, not a rounding one.
export const GST_STATES = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other Territory' }
];

const BY_CODE = new Map(GST_STATES.map((state) => [state.code, state]));

const normalizeName = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z]/g, '');

const BY_NAME = new Map(GST_STATES.map((state) => [normalizeName(state.name), state]));
// Everyday spellings and the abbreviations people actually type into an address field.
const ALIASES = {
  orissa: '21',
  pondicherry: '34',
  uttaranchal: '05',
  delhinct: '07',
  newdelhi: '07',
  nctofdelhi: '07',
  jandk: '01',
  jk: '01',
  hp: '02',
  pb: '03',
  ch: '04',
  uk: '05',
  ua: '05',
  hr: '06',
  dl: '07',
  rj: '08',
  up: '09',
  br: '10',
  as: '18',
  wb: '19',
  jh: '20',
  od: '21',
  cg: '22',
  mp: '23',
  gj: '24',
  mh: '27',
  ka: '29',
  ga: '30',
  kl: '32',
  tn: '33',
  py: '34',
  ts: '36',
  tg: '36',
  ap: '37',
  daman: '26',
  diu: '26',
  dadraandnagarhaveli: '26'
};

/** Two-digit state code from a GSTIN, or '' when the GSTIN is unusable. */
export const stateCodeFromGstin = (gstin = '') => {
  const code = String(gstin).trim().slice(0, 2);
  return BY_CODE.has(code) ? code : '';
};

/** Best-effort code for a free-text state name ('Uttar Pradesh', 'UP', 'up '). */
export const stateCodeFromName = (name = '') => {
  const normalized = normalizeName(name);
  if (!normalized) return '';
  return BY_NAME.get(normalized)?.code || ALIASES[normalized] || '';
};

export const stateNameForCode = (code = '') => BY_CODE.get(String(code).trim())?.name || '';

/**
 * Resolves place of supply for a document.
 *
 * Order matters: an explicit choice wins, then the customer's GSTIN (authoritative —
 * it encodes their registered state), then their address, then the supplier's own state
 * (an unidentified walk-in customer is treated as a local sale, which is the correct
 * default for a counter sale).
 */
export const resolvePlaceOfSupply = ({ explicitCode, customerGstin, customerState, supplierStateCode } = {}) => {
  const code =
    (explicitCode && BY_CODE.has(String(explicitCode)) ? String(explicitCode) : '') ||
    stateCodeFromGstin(customerGstin) ||
    stateCodeFromName(customerState) ||
    (supplierStateCode && BY_CODE.has(String(supplierStateCode)) ? String(supplierStateCode) : '');

  return code ? { code, state: stateNameForCode(code) } : { code: '', state: '' };
};

/**
 * Intra-state (CGST + SGST) vs inter-state (IGST).
 *
 * Unknown either side falls back to intra-state: charging CGST+SGST on what turns out
 * to be an interstate sale is a correctable filing error, whereas defaulting to IGST on
 * every local counter sale would misfile the common case.
 */
export const supplyTypeFor = (supplierStateCode, placeOfSupplyCode) => {
  if (!supplierStateCode || !placeOfSupplyCode) return 'intra';
  return String(supplierStateCode) === String(placeOfSupplyCode) ? 'intra' : 'inter';
};
