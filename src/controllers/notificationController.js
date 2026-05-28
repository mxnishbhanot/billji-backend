import NotificationRead from '../models/NotificationRead.js';
import Notification from '../models/Notification.js';
import { materializeReminderNotifications, serializeNotification } from '../services/notificationService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, paginationMeta } from '../utils/pagination.js';

const activeFilter = (businessId, dismissedIds = []) => ({
  business: businessId,
  resolvedAt: null,
  ...(dismissedIds.length ? { notificationId: { $nin: dismissedIds } } : {})
});

const userNotificationStates = async (businessId, userId) =>
  NotificationRead.find({ business: businessId, user: userId }).select('notificationId readAt dismissedAt').lean();

const stateSets = (states) => ({
  dismissedIds: states.filter((state) => state.dismissedAt).map((state) => state.notificationId),
  readIds: states.filter((state) => state.readAt && !state.dismissedAt).map((state) => state.notificationId),
  stateById: new Map(states.map((state) => [state.notificationId, state]))
});

export const listNotifications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query, { defaultLimit: 10, maxLimit: 50 });

  await materializeReminderNotifications(req.business._id);

  const states = await userNotificationStates(req.business._id, req.user._id);
  const { dismissedIds, readIds, stateById } = stateSets(states);
  const filter = activeFilter(req.business._id, dismissedIds);
  const unreadFilter = {
    ...filter,
    ...(readIds.length ? { notificationId: { $nin: [...dismissedIds, ...readIds] } } : {})
  };

  const [total, unreadCount, pageNotifications] = await Promise.all([
    Notification.countDocuments(filter),
    Notification.countDocuments(unreadFilter),
    Notification.find(filter).sort({ priority: 1, sortDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean()
  ]);

  const notifications = pageNotifications.map((notification) => serializeNotification(notification, stateById.get(notification.notificationId)));

  res.json({
    success: true,
    notifications,
    unreadCount,
    pagination: paginationMeta({ page, limit, total })
  });
});

export const markNotificationsSeen = asyncHandler(async (req, res) => {
  let notificationIds = Array.isArray(req.body.notificationIds) ? req.body.notificationIds.filter(Boolean) : [];

  if (req.body.all) {
    await materializeReminderNotifications(req.business._id);
    const states = await userNotificationStates(req.business._id, req.user._id);
    const { dismissedIds } = stateSets(states);
    notificationIds = await Notification.find(activeFilter(req.business._id, dismissedIds)).distinct('notificationId');
  }

  if (notificationIds.length) {
    await NotificationRead.bulkWrite(
      Array.from(new Set(notificationIds)).map((id) => ({
        updateOne: {
          filter: { business: req.business._id, user: req.user._id, notificationId: id },
          update: { $set: { readAt: new Date() }, $setOnInsert: { business: req.business._id, user: req.user._id, notificationId: id } },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }

  res.json({ success: true });
});

export const dismissNotifications = asyncHandler(async (req, res) => {
  const notificationIds = Array.isArray(req.body.notificationIds) ? req.body.notificationIds.filter(Boolean) : [];

  if (notificationIds.length) {
    await NotificationRead.bulkWrite(
      Array.from(new Set(notificationIds)).map((id) => ({
        updateOne: {
          filter: { business: req.business._id, user: req.user._id, notificationId: id },
          update: { $set: { dismissedAt: new Date(), readAt: new Date() }, $setOnInsert: { business: req.business._id, user: req.user._id, notificationId: id } },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }

  res.json({ success: true });
});
