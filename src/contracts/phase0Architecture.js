export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;
export const LEGACY_API_PREFIX = '/api';
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export const responseEnvelope = {
  success: 'boolean',
  data: 'resource-specific payload fields',
  pagination: 'optional page metadata for list endpoints'
};

export const errorEnvelope = {
  success: false,
  message: 'Human-readable error summary',
  details: 'Optional validation, domain, or conflict details',
  code: 'Optional stable machine-readable error code'
};

export const ownershipModel = {
  sourceOfTruth: 'business',
  authActor: 'user',
  coreEntityOwnerField: 'business',
  actorFields: ['createdBy', 'updatedBy']
};

export const coreDomains = [
  'businesses',
  'members',
  'customers',
  'products',
  'inventory',
  'sales-documents',
  'payments',
  'ledger',
  'drafts',
  'notifications',
  'reports',
  'settings'
];
