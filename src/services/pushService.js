import admin from 'firebase-admin';
import BusinessMember from '../models/BusinessMember.js';
import DeviceToken from '../models/DeviceToken.js';
import UserNotificationPreference from '../models/UserNotificationPreference.js';
import { getFirebaseApp } from '../config/firebase.js';

// FCM caps a multicast at 500 tokens.
const MULTICAST_LIMIT = 500;
// Errors that mean "this token will never work again" — delete instead of retrying forever.
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument'
]);

// Swappable so tests can assert what would be sent without touching Firebase.
let sender = null;

/** @param {null | ((message: object) => Promise<{responses: {success: boolean, error?: {code?: string}}[]}>)} fn */
export const setPushSenderForTests = (fn) => {
  sender = fn;
};

const resolveSender = () => {
  if (sender) return sender;
  // Never reach the real FCM from the test suite. Credentials now live in .env for local
  // development, so without this a test run would push to whatever devices are registered
  // in the dev Firebase project. Tests that want to assert on delivery inject a sender.
  if (process.env.NODE_ENV === 'test') return null;
  const app = getFirebaseApp();
  if (!app) return null;
  return (message) => admin.messaging(app).sendEachForMulticast(message);
};

export const registerDeviceToken = ({ business, user, token, platform, deviceName }) =>
  DeviceToken.findOneAndUpdate(
    { token },
    { $set: { business, user, platform: platform || 'android', deviceName: deviceName || '', lastSeenAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

export const removeDeviceToken = ({ user, token }) => DeviceToken.deleteOne({ token, user });

/**
 * Tokens that should receive a notification of this type: every active member of the
 * business except the person who caused it, minus anyone who switched the type's push
 * channel off. Absence of a preference means enabled (per UserNotificationPreference).
 */
const recipientTokensFor = async (businessId, { type, excludeUserId }) => {
  const members = await BusinessMember.find({ business: businessId, status: 'active' }).select('user').lean();
  const userIds = members
    .map((member) => member.user)
    .filter((userId) => !excludeUserId || String(userId) !== String(excludeUserId));

  if (!userIds.length) return [];

  const preferences = await UserNotificationPreference.find({ business: businessId, user: { $in: userIds } })
    .select('user preferences')
    .lean();
  const optedOut = new Set(
    preferences.filter((row) => row.preferences?.[type]?.push === false).map((row) => String(row.user))
  );

  const allowed = userIds.filter((userId) => !optedOut.has(String(userId)));
  if (!allowed.length) return [];

  return DeviceToken.find({ business: businessId, user: { $in: allowed } }).select('token').lean();
};

const chunk = (items, size) => {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
};

/**
 * Fire-and-forget push for one notification. Never throws: a failed push must not fail
 * the write that produced the notification, nor make the outbox retry a dispatch that
 * already succeeded.
 *
 * @returns {Promise<{sent: number, pruned: number, skipped?: string}>}
 */
export const sendPushForNotification = async (notification, { excludeUserId = null } = {}) => {
  try {
    const send = resolveSender();
    if (!send) return { sent: 0, pruned: 0, skipped: 'not_configured' };

    const tokens = await recipientTokensFor(notification.business, { type: notification.type, excludeUserId });
    if (!tokens.length) return { sent: 0, pruned: 0, skipped: 'no_recipients' };

    let sent = 0;
    const dead = [];

    for (const batch of chunk(tokens, MULTICAST_LIMIT)) {
      const tokenValues = batch.map((row) => row.token);
      const result = await send({
        tokens: tokenValues,
        notification: { title: notification.title, body: notification.description || '' },
        // Data must be all-strings for FCM. `to` is the in-app route the app deep-links to.
        data: {
          notificationId: String(notification.notificationId || ''),
          type: String(notification.type || ''),
          to: String(notification.to || ''),
          resourceType: String(notification.resourceType || ''),
          resourceId: String(notification.resourceId || '')
        },
        android: { priority: notification.tone === 'danger' ? 'high' : 'normal' }
      });

      (result?.responses || []).forEach((response, index) => {
        if (response?.success) {
          sent += 1;
          return;
        }
        if (DEAD_TOKEN_CODES.has(response?.error?.code)) dead.push(tokenValues[index]);
      });
    }

    if (dead.length) await DeviceToken.deleteMany({ token: { $in: dead } });

    return { sent, pruned: dead.length };
  } catch (error) {
    console.error('Push delivery failed:', error.message);
    return { sent: 0, pruned: 0, skipped: 'error' };
  }
};
