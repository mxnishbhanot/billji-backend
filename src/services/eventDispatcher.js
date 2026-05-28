import OutboxEvent from '../models/OutboxEvent.js';
import { emitBusinessEvent } from './socketService.js';
import { DOMAIN_EVENTS } from './eventBus.js';
import { projectNotificationsForEvent } from './notificationService.js';
import { invalidateReportSummaryCache } from './reportService.js';

const MAX_ATTEMPTS = 5;

const SOCKET_EVENTS_BY_DOMAIN_EVENT = {
  [DOMAIN_EVENTS.documentIssued]: ['invoices:changed', 'notifications:changed'],
  [DOMAIN_EVENTS.documentCancelled]: ['invoices:changed', 'notifications:changed'],
  [DOMAIN_EVENTS.documentShared]: ['invoices:changed', 'notifications:changed'],
  [DOMAIN_EVENTS.paymentRecorded]: ['payments:changed', 'invoices:changed', 'customers:changed', 'notifications:changed'],
  [DOMAIN_EVENTS.stockAdjusted]: ['products:changed', 'notifications:changed'],
  [DOMAIN_EVENTS.customerCreated]: ['customers:changed', 'notifications:changed']
};

const retryDelayMs = (attempts) => Math.min(60_000, 2_000 * 2 ** attempts);

const REPORT_INVALIDATING_EVENTS = new Set([
  DOMAIN_EVENTS.documentIssued,
  DOMAIN_EVENTS.documentCancelled,
  DOMAIN_EVENTS.paymentRecorded
]);

export const dispatchOutboxEvent = async (event) => {
  await projectNotificationsForEvent(event);

  if (REPORT_INVALIDATING_EVENTS.has(event.eventType)) {
    invalidateReportSummaryCache(event.business);
  }

  const socketEvents = SOCKET_EVENTS_BY_DOMAIN_EVENT[event.eventType] || [];
  socketEvents.forEach((socketEvent) => {
    emitBusinessEvent(event.business, socketEvent, {
      reason: event.eventType,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId
    });
  });
};

export const processPendingOutboxEvents = async ({ batchSize = 25 } = {}) => {
  const now = new Date();
  const candidates = await OutboxEvent.find({
    status: { $in: ['pending', 'failed'] },
    attempts: { $lt: MAX_ATTEMPTS },
    availableAt: { $lte: now }
  })
    .sort({ createdAt: 1 })
    .limit(batchSize);

  for (const candidate of candidates) {
    const event = await OutboxEvent.findOneAndUpdate(
      { _id: candidate._id, status: candidate.status },
      { $set: { status: 'processing', lockedAt: new Date() } },
      { new: true }
    );

    if (!event) continue;

    try {
      await dispatchOutboxEvent(event);
      event.status = 'processed';
      event.processedAt = new Date();
      event.lastError = '';
      await event.save();
    } catch (error) {
      event.status = 'failed';
      event.attempts += 1;
      event.availableAt = new Date(Date.now() + retryDelayMs(event.attempts));
      event.lastError = error.message || 'Unknown event dispatch error';
      await event.save();
    }
  }
};

let dispatcherTimer = null;

export const startOutboxDispatcher = ({ intervalMs = 2500 } = {}) => {
  if (dispatcherTimer) return () => {};

  const tick = () => {
    processPendingOutboxEvents().catch((error) => {
      console.error('Outbox dispatcher failed:', error.message);
    });
  };

  dispatcherTimer = setInterval(tick, intervalMs);
  dispatcherTimer.unref?.();

  const immediate = setTimeout(tick, 100);
  immediate.unref?.();

  return () => {
    clearInterval(dispatcherTimer);
    dispatcherTimer = null;
  };
};
