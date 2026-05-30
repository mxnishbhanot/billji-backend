import OutboxEvent from '../models/OutboxEvent.js';

export const DOMAIN_EVENTS = {
  documentIssued: 'document.issued',
  documentCancelled: 'document.cancelled',
  documentShared: 'document.shared',
  paymentRecorded: 'payment.recorded',
  stockAdjusted: 'stock.adjusted',
  draftSaved: 'draft.saved',
  customerCreated: 'customer.created'
};

const objectId = (value) => value?._id || value || null;

const compactKey = (parts) =>
  parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part) => String(part))
    .join(':')
    .slice(0, 220);

export const buildEventDedupeKey = ({ business, eventType, aggregateType, aggregateId, suffix }) =>
  compactKey([objectId(business), eventType, aggregateType, objectId(aggregateId), suffix]);

export const publishDomainEvent = async (
  {
    business,
    actor = null,
    eventType,
    aggregateType,
    aggregateId = null,
    payload = {},
    dedupeKey
  },
  { session } = {}
) => {
  const businessId = objectId(business);
  const aggregateObjectId = objectId(aggregateId);

  if (!businessId || !eventType || !aggregateType) {
    throw new Error('Domain event requires business, eventType, and aggregateType');
  }

  const key = dedupeKey || buildEventDedupeKey({ business: businessId, eventType, aggregateType, aggregateId: aggregateObjectId });

  return OutboxEvent.findOneAndUpdate(
    { business: businessId, dedupeKey: key },
    {
      $setOnInsert: {
        business: businessId,
        actor: objectId(actor),
        eventType,
        aggregateType,
        aggregateId: aggregateObjectId,
        payload,
        dedupeKey: key,
        status: 'pending',
        availableAt: new Date()
      }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
};
