import Role from '../models/Role.js';
import { ApiError } from '../utils/ApiError.js';

export const PERMISSIONS = {
  invoicesView: 'invoices.view',
  invoicesCreate: 'invoices.create',
  invoicesUpdate: 'invoices.update',
  invoicesDelete: 'invoices.delete',
  ordersView: 'orders.view',
  ordersCreate: 'orders.create',
  ordersManage: 'orders.manage',
  paymentsView: 'payments.view',
  paymentsRecord: 'payments.record',
  productsView: 'products.view',
  productsManage: 'products.manage',
  customersView: 'customers.view',
  customersManage: 'customers.manage',
  reportsView: 'reports.view',
  settingsView: 'settings.view',
  settingsManage: 'settings.manage',
  notificationsView: 'notifications.view',
  notificationsManage: 'notifications.manage'
};

const allPermissions = Object.values(PERMISSIONS);

export const ROLE_PERMISSIONS = {
  owner: allPermissions,
  admin: allPermissions,
  accountant: [
    PERMISSIONS.invoicesView,
    PERMISSIONS.invoicesCreate,
    PERMISSIONS.invoicesUpdate,
    PERMISSIONS.ordersView,
    PERMISSIONS.ordersCreate,
    PERMISSIONS.ordersManage,
    PERMISSIONS.paymentsView,
    PERMISSIONS.paymentsRecord,
    PERMISSIONS.customersView,
    PERMISSIONS.customersManage,
    PERMISSIONS.productsView,
    PERMISSIONS.reportsView,
    PERMISSIONS.notificationsView,
    PERMISSIONS.notificationsManage
  ],
  staff: [
    PERMISSIONS.invoicesView,
    PERMISSIONS.invoicesCreate,
    PERMISSIONS.ordersView,
    PERMISSIONS.ordersCreate,
    PERMISSIONS.customersView,
    PERMISSIONS.customersManage,
    PERMISSIONS.productsView,
    PERMISSIONS.notificationsView,
    PERMISSIONS.notificationsManage
  ],
  viewer: [
    PERMISSIONS.invoicesView,
    PERMISSIONS.ordersView,
    PERMISSIONS.paymentsView,
    PERMISSIONS.customersView,
    PERMISSIONS.productsView,
    PERMISSIONS.reportsView,
    PERMISSIONS.notificationsView,
    PERMISSIONS.settingsView
  ]
};

export const permissionsForRoleKey = (roleKey = 'viewer') => ROLE_PERMISSIONS[roleKey] || ROLE_PERMISSIONS.viewer;

export const permissionsForMembership = async (membership) => {
  if (membership?.role) {
    const role = await Role.findById(membership.role).populate('permissions');
    if (role?.permissions?.length) return role.permissions.map((permission) => permission.key);
  }

  return permissionsForRoleKey(membership?.roleKey);
};

export const requirePermission = (...requiredPermissions) => async (req, _res, next) => {
  try {
    const permissions = await permissionsForMembership(req.membership);
    const allowed = requiredPermissions.some((permission) => permissions.includes(permission));

    if (!allowed) {
      return next(new ApiError(403, 'You do not have permission to perform this action', {
        code: 'FORBIDDEN_PERMISSION',
        requiredPermissions
      }));
    }

    req.permissions = permissions;
    return next();
  } catch (error) {
    return next(error);
  }
};
