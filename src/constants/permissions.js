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
    domain: 'reports',
    label: 'Reports',
    permissions: [{ name: 'reportsView', key: 'reports.view', label: 'View reports & ledger' }]
  },
  {
    domain: 'settings',
    label: 'Settings',
    permissions: [
      { name: 'settingsView', key: 'settings.view', label: 'View settings' },
      { name: 'settingsManage', key: 'settings.manage', label: 'Manage settings' }
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
