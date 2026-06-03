import NotificationRead from '../models/NotificationRead.js';
import Notification from '../models/Notification.js';
import UserNotificationPreference from '../models/UserNotificationPreference.js';
import { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES } from '../constants/notificationTypes.js';
import { materializeReminderNotifications, serializeNotification } from '../services/notificationService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, paginationMeta } from '../utils/pagination.js';

const activeFilter = (businessId, dismissedIds = [], disabledTypes = []) => ({
  business: businessId,
  resolvedAt: null,
  ...(dismissedIds.length ? { notificationId: { $nin: dismissedIds } } : {}),
  ...(disabledTypes.length ? { type: { $nin: disabledTypes } } : {})
});

const disabledTypesFor = async (businessId, userId) => {
  const doc = await UserNotificationPreference.findOne({ business: businessId, user: userId }).select('preferences').lean();
  if (!doc?.preferences) return [];
  return Object.entries(doc.preferences)
    .filter(([, channels]) => channels && channels.inApp === false)
    .map(([type]) => type);
};

const sanitizePreferences = (input) => {
  const cleaned = {};
  if (!input || typeof input !== 'object') return cleaned;
  for (const type of NOTIFICATION_TYPES) {
    const channels = input[type];
    if (!channels || typeof channels !== 'object') continue;
    const entry = {};
    for (const channel of NOTIFICATION_CHANNELS) {
      if (typeof channels[channel] === 'boolean') entry[channel] = channels[channel];
    }
    if (Object.keys(entry).length) cleaned[type] = entry;
  }
  return cleaned;
};

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

  const [states, disabledTypes] = await Promise.all([
    userNotificationStates(req.business._id, req.user._id),
    disabledTypesFor(req.business._id, req.user._id)
  ]);
  const { dismissedIds, readIds, stateById } = stateSets(states);
  const filter = activeFilter(req.business._id, dismissedIds, disabledTypes);
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
    const [states, disabledTypes] = await Promise.all([
      userNotificationStates(req.business._id, req.user._id),
      disabledTypesFor(req.business._id, req.user._id)
    ]);
    const { dismissedIds } = stateSets(states);
    notificationIds = await Notification.find(activeFilter(req.business._id, dismissedIds, disabledTypes)).distinct('notificationId');
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

export const getNotificationPreferences = asyncHandler(async (req, res) => {
  const doc = await UserNotificationPreference.findOne({ business: req.business._id, user: req.user._id }).select('preferences').lean();
  res.json({ success: true, preferences: doc?.preferences || {} });
});

export const updateNotificationPreferences = asyncHandler(async (req, res) => {
  const preferences = sanitizePreferences(req.body.preferences);
  const doc = await UserNotificationPreference.findOneAndUpdate(
    { business: req.business._id, user: req.user._id },
    { $set: { preferences }, $setOnInsert: { business: req.business._id, user: req.user._id } },
    { upsert: true, new: true, lean: true }
  );
  res.json({ success: true, preferences: doc.preferences || {} });
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
