import Role from '../models/Role.js';
import { ApiError } from '../utils/ApiError.js';
import { ALL_PERMISSION_KEYS, PERMISSIONS } from '../constants/permissions.js';

export { PERMISSIONS };

const allPermissions = ALL_PERMISSION_KEYS;

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
    // An accountant is exactly who should be booking money going out.
    PERMISSIONS.expensesView,
    PERMISSIONS.expensesManage,
    PERMISSIONS.purchasesView,
    PERMISSIONS.purchasesManage,
    PERMISSIONS.reportsView,
    // Sees what the business is paying and can pull invoices; cannot change the plan.
    PERMISSIONS.billingView,
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
    PERMISSIONS.expensesView,
    PERMISSIONS.purchasesView,
    PERMISSIONS.reportsView,
    PERMISSIONS.billingView,
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
