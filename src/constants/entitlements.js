// Canonical entitlement catalog — the single source of truth for feature and limit KEYS.
//
// Same shape and role as constants/permissions.js: one file drives (a) plan seeding
// (bootstrap/billing.js), (b) plan-document validation, (c) the future admin plan editor,
// and (d) the mobile mirror. Nothing else in the codebase may invent a key.
//
// KEYS ARE PERMANENT AND IMMUTABLE. Every key is copied verbatim into every Subscription
// snapshot ever created, so renaming one silently revokes access for every existing
// subscriber. Labels are display-only and safe to change at any time.
//
// Business logic reads keys, never plan names: `canAccessFeature(sub, FEATURES.expenses)`,
// never `if (planKey === 'pro')`. Plan names are editable marketing copy.

/** Sentinel for "no ceiling". A limit of -1 is never compared numerically — always via isUnlimited(). */
export const UNLIMITED = -1;

/** Money is integer paise everywhere. Floats drift and break provider signature checks. */
export const CURRENCY = 'INR';

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export const FEATURE_GROUPS = [
  {
    group: 'core',
    label: 'Core',
    features: [
      { key: 'offline_mode', label: 'Offline mode' },
      { key: 'cloud_sync', label: 'Cloud sync' },
      { key: 'automatic_backup', label: 'Automatic backup' }
    ]
  },
  {
    group: 'billing',
    label: 'Billing & GST',
    features: [
      { key: 'gst_billing', label: 'GST billing' },
      { key: 'gst_invoices', label: 'GST invoices' },
      { key: 'pdf_export', label: 'PDF invoices' },
      { key: 'whatsapp_sharing', label: 'WhatsApp sharing' },
      { key: 'barcode', label: 'Barcode scanning' }
    ]
  },
  {
    group: 'inventory',
    label: 'Inventory',
    features: [
      { key: 'basic_inventory', label: 'Basic inventory' },
      { key: 'advanced_inventory', label: 'Advanced inventory' }
    ]
  },
  {
    group: 'reports',
    label: 'Dashboard & reports',
    features: [
      { key: 'basic_dashboard', label: 'Basic dashboard' },
      { key: 'basic_reports', label: 'Basic reports' },
      { key: 'advanced_reports', label: 'Advanced reports' },
      { key: 'profit_and_loss', label: 'Profit & loss' },
      { key: 'advanced_gst_reports', label: 'Advanced GST reports' },
      { key: 'advanced_analytics', label: 'Advanced analytics' }
    ]
  },
  {
    group: 'money',
    label: 'Money out & collections',
    features: [
      { key: 'expenses', label: 'Expenses' },
      { key: 'purchases', label: 'Purchases' },
      { key: 'payment_reminders', label: 'Payment reminders' }
    ]
  },
  {
    group: 'data',
    label: 'Import & export',
    features: [
      { key: 'data_import', label: 'Import' },
      { key: 'data_export', label: 'Export' },
      { key: 'excel_import', label: 'Excel import' },
      { key: 'excel_export', label: 'Excel export' }
    ]
  },
  {
    group: 'branding',
    label: 'Branding',
    features: [
      { key: 'business_logo', label: 'Business logo' },
      { key: 'custom_invoice_templates', label: 'Custom invoice templates' },
      // Absent => the rendered PDF carries the "Powered by BillJi" footer.
      { key: 'remove_branding', label: 'Remove BillJi branding' }
    ]
  },
  {
    group: 'team',
    label: 'Team & governance',
    features: [
      { key: 'teams', label: 'Teams' },
      { key: 'rbac', label: 'Role-based access control' },
      { key: 'custom_roles', label: 'Custom roles' },
      { key: 'audit_logs', label: 'Audit logs' },
      { key: 'multi_business', label: 'Multiple businesses' }
    ]
  },
  {
    group: 'support',
    label: 'Support',
    features: [
      { key: 'priority_email_support', label: 'Priority email support' },
      { key: 'priority_support', label: 'Priority support' },
      { key: 'dedicated_support', label: 'Dedicated support' },
      { key: 'training', label: 'Onboarding & training' }
    ]
  },
  {
    group: 'platform',
    label: 'Platform',
    features: [
      { key: 'api_access', label: 'API access' },
      { key: 'custom_integrations', label: 'Custom integrations' }
    ]
  }
];

/** Named map for code references: FEATURES.expenses === 'expenses'. Mirrors PERMISSIONS. */
export const FEATURES = Object.fromEntries(
  FEATURE_GROUPS.flatMap((group) => group.features.map((feature) => [camel(feature.key), feature.key]))
);

export const ALL_FEATURE_KEYS = FEATURE_GROUPS.flatMap((group) => group.features.map((feature) => feature.key));

const FEATURE_KEY_SET = new Set(ALL_FEATURE_KEYS);

export const isFeatureKey = (key) => FEATURE_KEY_SET.has(key);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
//
// `period` decides the usage bucket: 'month' rolls over on its own (a new periodKey is a
// new document, which IS the monthly reset — no job required), null means one bucket forever.
//
// `metered` decides *where the number lives*:
//   true  -> a SubscriptionUsage counter incremented by usageService (a flow: documents issued,
//            exports run, bytes stored). Only counters can drift, so only counters get one.
//   false -> counted live against the real collection at check time (a point-in-time fact:
//            how many team members exist right now). Cannot drift, needs no counter.
// teamLimitService already proves the `false` case in this codebase.

export const LIMIT_DEFINITIONS = [
  { key: 'documents_per_month', label: 'Documents per month', unit: 'count', period: 'month', metered: true },
  { key: 'businesses', label: 'Businesses', unit: 'count', period: null, metered: false },
  { key: 'team_members', label: 'Team members', unit: 'count', period: null, metered: false },
  { key: 'products', label: 'Products', unit: 'count', period: null, metered: false },
  { key: 'customers', label: 'Customers', unit: 'count', period: null, metered: false },
  { key: 'vendors', label: 'Vendors', unit: 'count', period: null, metered: false },
  { key: 'storage_bytes', label: 'Storage', unit: 'bytes', period: null, metered: true },
  { key: 'exports_per_month', label: 'Exports per month', unit: 'count', period: 'month', metered: true },
  { key: 'imports_per_month', label: 'Imports per month', unit: 'count', period: 'month', metered: true },
  // Defined so the engine is provably generic and so add-ons/AI/API tiers need no schema
  // change later. Every plan currently grants UNLIMITED — no product decision is encoded here.
  { key: 'api_calls_per_month', label: 'API calls per month', unit: 'count', period: 'month', metered: true },
  { key: 'ai_credits_per_month', label: 'AI credits per month', unit: 'count', period: 'month', metered: true }
];

export const LIMITS = Object.fromEntries(LIMIT_DEFINITIONS.map((limit) => [camel(limit.key), limit.key]));

export const ALL_LIMIT_KEYS = LIMIT_DEFINITIONS.map((limit) => limit.key);

const LIMIT_BY_KEY = new Map(LIMIT_DEFINITIONS.map((limit) => [limit.key, limit]));

export const isLimitKey = (key) => LIMIT_BY_KEY.has(key);

export const limitDefinition = (key) => LIMIT_BY_KEY.get(key) || null;

// ---------------------------------------------------------------------------
// Plan seeds
// ---------------------------------------------------------------------------

const featureMap = (keys) => Object.fromEntries(keys.map((key) => [key, true]));

// Each tier is the previous tier plus its own additions, so "Everything in Pro, PLUS..."
// is expressed once and cannot drift out of sync with the pricing page.
const STARTER_FEATURES = [
  'offline_mode',
  'cloud_sync',
  'automatic_backup',
  'gst_billing',
  'gst_invoices',
  'pdf_export',
  'whatsapp_sharing',
  'barcode',
  'basic_inventory',
  'basic_dashboard',
  'basic_reports'
];

const PRO_FEATURES = [
  ...STARTER_FEATURES,
  'expenses',
  'purchases',
  'advanced_inventory',
  'advanced_reports',
  'profit_and_loss',
  'payment_reminders',
  'data_import',
  'data_export',
  'excel_import',
  'excel_export',
  'business_logo',
  'custom_invoice_templates',
  'remove_branding',
  'advanced_gst_reports',
  'priority_email_support'
];

const BUSINESS_FEATURES = [
  ...PRO_FEATURES,
  'teams',
  'rbac',
  'custom_roles',
  'audit_logs',
  'advanced_analytics',
  'multi_business',
  'priority_support'
];

const ENTERPRISE_FEATURES = [...BUSINESS_FEATURES, 'dedicated_support', 'custom_integrations', 'training', 'api_access'];

// Limits not named by a plan fall back to UNLIMITED. Only ceilings that actually exist are
// written, so a plan row reads as the product's promise rather than a wall of -1s.
const withLimitDefaults = (limits) => ({
  ...Object.fromEntries(ALL_LIMIT_KEYS.map((key) => [key, UNLIMITED])),
  ...limits
});

/**
 * Seeded idempotently by bootstrap/billing.js. Admins may edit these rows afterwards;
 * the seeder only creates what is missing and refreshes presentation fields, so it never
 * stomps a deliberate admin change to price/features/limits (see bootstrap/billing.js).
 */
export const PLAN_SEEDS = [
  {
    key: 'starter',
    name: 'BillJi Starter',
    tagline: 'Free forever',
    description: 'Everything a single shop needs to bill customers and stay GST-compliant.',
    sortOrder: 10,
    visibility: 'public',
    isDefault: true,
    prices: [{ interval: 'free', amount: 0 }],
    features: featureMap(STARTER_FEATURES),
    limits: withLimitDefaults({ documents_per_month: 200, businesses: 1, team_members: 1 }),
    trial: { enabled: false, days: 0 },
    grace: { days: 0 },
    meta: { branding: 'Powered by BillJi', support: 'community' }
  },
  {
    key: 'pro',
    name: 'BillJi Pro',
    tagline: 'For growing single-owner businesses',
    description: 'Unlimited documents, expenses, purchases, advanced reports and your own branding.',
    badge: 'Most Popular',
    sortOrder: 20,
    visibility: 'public',
    prices: [
      { interval: 'month', amount: 24900 },
      { interval: 'year', amount: 199900 }
    ],
    features: featureMap(PRO_FEATURES),
    limits: withLimitDefaults({ businesses: 1, team_members: 1 }),
    trial: { enabled: true, days: 14 },
    grace: { days: 7 },
    meta: { support: 'priority_email' }
  },
  {
    key: 'business',
    name: 'BillJi Business',
    tagline: 'For teams and multiple businesses',
    description: 'Everything in Pro plus teams, roles, audit logs, analytics and multiple businesses.',
    sortOrder: 30,
    visibility: 'public',
    prices: [
      { interval: 'month', amount: 49900 },
      { interval: 'year', amount: 499900 }
    ],
    features: featureMap(BUSINESS_FEATURES),
    // Businesses are UNLIMITED by decision, not 10 — the ceiling lives in data, so raising
    // or lowering it later is an admin edit, never a deploy.
    limits: withLimitDefaults({ team_members: 10 }),
    trial: { enabled: true, days: 14 },
    grace: { days: 7 },
    meta: { support: 'priority' }
  },
  {
    key: 'enterprise',
    name: 'BillJi Enterprise',
    tagline: 'Custom pricing',
    description: 'Unlimited everything, dedicated support, custom integrations, training and API access.',
    sortOrder: 40,
    // Never listed in the app: assigned by a platform admin after a sales conversation,
    // then tuned per customer via Subscription.overrides.
    visibility: 'private',
    prices: [{ interval: 'custom', amount: 0 }],
    features: featureMap(ENTERPRISE_FEATURES),
    limits: withLimitDefaults({}),
    trial: { enabled: false, days: 0 },
    grace: { days: 30 },
    meta: { support: 'dedicated', requiresSalesContact: true }
  },
  {
    // Grandfathering plan (approved Decision 2). Every business that existed before billing
    // shipped is backfilled onto this in P7: Pro entitlements, ₹0, no expiry, price locked.
    // Nobody is ever silently downgraded, and it costs nothing — these users pay nothing today.
    key: 'legacy_pro',
    name: 'BillJi Pro (Founding Member)',
    tagline: 'Locked forever',
    description: 'Pro entitlements at no cost, for businesses that were with BillJi before paid plans.',
    sortOrder: 90,
    visibility: 'private',
    prices: [{ interval: 'lifetime', amount: 0 }],
    features: featureMap(PRO_FEATURES),
    // team_members is 2, not Pro's 1, on purpose: teamLimitService has always allowed a free
    // business 2 seats, so a business already running with two members would lose one the day
    // billing shipped. Decision 2 says never silently downgrade an existing user, and that
    // outranks tier symmetry. This plan is grandfathering, not Pro.
    limits: withLimitDefaults({ businesses: 1, team_members: 2 }),
    trial: { enabled: false, days: 0 },
    grace: { days: 0 },
    meta: { grandfathered: true, priceLocked: true }
  }
];

/** The plan a brand-new business lands on, and the fallback when a subscription expires. */
export const DEFAULT_PLAN_KEY = 'starter';

/** Target plan for the pre-billing backfill (P7). */
export const LEGACY_PLAN_KEY = 'legacy_pro';

export const PLAN_STATUSES = ['active', 'archived', 'disabled'];
export const PLAN_VISIBILITIES = ['public', 'private', 'hidden'];
export const BILLING_INTERVALS = ['free', 'month', 'year', 'lifetime', 'custom'];

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'in_grace',
  'cancelled',
  'expired',
  // Schema-only, future-ready: no pause logic exists yet.
  'paused'
];

/** camelCase accessor name from an immutable snake_case key (documents_per_month -> documentsPerMonth). */
function camel(key) {
  return key.replace(/_([a-z0-9])/g, (_match, char) => char.toUpperCase());
}
