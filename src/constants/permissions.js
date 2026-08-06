// Canonical permission catalog — the single source of truth for RBAC.
//
// Grouped by category (each group's `domain` maps to Permission.domain) so the same
// definition drives (a) route guards via the derived PERMISSIONS map, (b) idempotent
// RBAC seeding (bootstrap/rbac.js), and (c) the mobile permission-matrix UI (served by
// GET /permissions). To add a permission or category: add an entry here and re-seed.
export const PERMISSION_GROUPS = [
  {
    domain: 'invoices',
    label: 'Invoices',
    permissions: [
      { name: 'invoicesView', key: 'invoices.view', label: 'View invoices' },
      { name: 'invoicesCreate', key: 'invoices.create', label: 'Create invoices' },
      { name: 'invoicesUpdate', key: 'invoices.update', label: 'Edit invoices' },
      { name: 'invoicesDelete', key: 'invoices.delete', label: 'Delete invoices' }
    ]
  },
  {
    domain: 'orders',
    label: 'Orders',
    permissions: [
      { name: 'ordersView', key: 'orders.view', label: 'View orders' },
      { name: 'ordersCreate', key: 'orders.create', label: 'Create orders' },
      { name: 'ordersManage', key: 'orders.manage', label: 'Manage orders' }
    ]
  },
  {
    domain: 'payments',
    label: 'Payments',
    permissions: [
      { name: 'paymentsView', key: 'payments.view', label: 'View payments' },
      { name: 'paymentsRecord', key: 'payments.record', label: 'Record payments' }
    ]
  },
  {
    domain: 'products',
    label: 'Inventory',
    permissions: [
      { name: 'productsView', key: 'products.view', label: 'View products' },
      { name: 'productsManage', key: 'products.manage', label: 'Manage products' }
    ]
  },
  {
    domain: 'customers',
    label: 'Customers',
    permissions: [
      { name: 'customersView', key: 'customers.view', label: 'View customers' },
      { name: 'customersManage', key: 'customers.manage', label: 'Manage customers' }
    ]
  },
  {
    domain: 'expenses',
    label: 'Expenses & purchases',
    permissions: [
      { name: 'expensesView', key: 'expenses.view', label: 'View expenses' },
      { name: 'expensesManage', key: 'expenses.manage', label: 'Record & edit expenses' },
      { name: 'purchasesView', key: 'purchases.view', label: 'View purchases & vendors' },
      { name: 'purchasesManage', key: 'purchases.manage', label: 'Record purchases & pay vendors' }
    ]
  },
  {
    domain: 'reports',
    label: 'Reports',
    permissions: [{ name: 'reportsView', key: 'reports.view', label: 'View reports & ledger' }]
  },
  {
    domain: 'settings',
    label: 'Settings',
    permissions: [
      { name: 'settingsView', key: 'settings.view', label: 'View settings' },
      { name: 'settingsManage', key: 'settings.manage', label: 'Manage settings' },
      { name: 'settingsExport', key: 'settings.export', label: 'Export business data' }
    ]
  },
  {
    domain: 'notifications',
    label: 'Notifications',
    permissions: [
      { name: 'notificationsView', key: 'notifications.view', label: 'View notifications' },
      { name: 'notificationsManage', key: 'notifications.manage', label: 'Manage notifications' }
    ]
  },
  {
    domain: 'team',
    label: 'Team',
    permissions: [
      { name: 'teamView', key: 'team.view', label: 'View team members' },
      { name: 'teamManage', key: 'team.manage', label: 'Invite & manage team members' }
    ]
  },
  {
    domain: 'billing',
    label: 'Plan & billing',
    // Separate from settings.manage on purpose: letting a manager edit invoice templates is not
    // the same as letting them spend the owner's money.
    //
    // Granular by design. A permission here answers "should this person SEE this control" — it
    // never answers "may this person commit the business to a payment". That second question is
    // ownership, enforced by requireBillingOwner (middlewares/authorization.js) on top of these.
    permissions: [
      { name: 'billingView', key: 'billing.view', label: 'View plan & usage' },
      { name: 'billingInvoices', key: 'billing.invoices', label: 'View invoices & payment history' },
      { name: 'billingPaymentMethod', key: 'billing.payment_method', label: 'Manage payment method & autopay' },
      { name: 'billingSubscriptionChange', key: 'billing.subscription_change', label: 'Buy, upgrade, downgrade or cancel the plan' },
      // The umbrella. Kept under its original key so seeded Permission documents and existing
      // custom Roles keep working with no migration — route guards accept it OR the specific key.
      { name: 'billingManage', key: 'billing.manage', label: 'Full billing control' }
    ]
  },
  {
    domain: 'roles',
    label: 'Roles',
    permissions: [
      { name: 'rolesView', key: 'roles.view', label: 'View roles' },
      { name: 'rolesManage', key: 'roles.manage', label: 'Create & edit custom roles' }
    ]
  }
];

// Named-key map (e.g. PERMISSIONS.invoicesView === 'invoices.view') consumed by route guards.
export const PERMISSIONS = Object.fromEntries(
  PERMISSION_GROUPS.flatMap((group) => group.permissions.map((permission) => [permission.name, permission.key]))
);

export const ALL_PERMISSION_KEYS = PERMISSION_GROUPS.flatMap((group) => group.permissions.map((permission) => permission.key));

/**
 * Roles whose members may commit the business to a payment. NOT a permission — deliberately.
 *
 * A permission answers "should this person see this control". This answers "may this person bind
 * the business to a charge", and no permission key can grant it: not an admin's, not a custom
 * Role's, not one a future edit to the role table hands out by accident.
 *
 * A single named list, not an inline comparison, because this is the seam a Billing Admin role
 * grows out of: adding one is `['owner', 'billing_admin']` here plus that role's permission row —
 * no route changes, no new middleware, no client release.
 *
 * Lives here rather than in the middleware so both the guard and the DTO can read it without the
 * contracts layer importing middleware.
 */
export const BILLING_OWNER_ROLES = ['owner'];

/** Fails closed: an absent membership has no roleKey and matches nothing in the whitelist. */
export const canManageBillingFor = (membership) =>
  Boolean(membership) && BILLING_OWNER_ROLES.includes(membership.roleKey);
