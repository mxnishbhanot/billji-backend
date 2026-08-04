export const NOTIFICATION_TYPES = [
  'invoice-created',
  'invoice-cancelled',
  'document-shared',
  'payment-received',
  'overdue-invoice',
  'due-soon-invoice',
  'old-pending-invoice',
  'low-stock',
  'negative-stock',
  'staff-activity',
  // Billing. `subscription-renewal` and `subscription-grace` have been sent since the reconciliation
  // sprint but were never listed here, so this whole family was unmutable — listing them is a fix,
  // not just scaffolding for the autopay rows below it.
  'subscription-renewal',
  'subscription-grace',
  'autopay-debit-upcoming',
  'autopay-failed',
  'autopay-halted',
  // Any reward the reward engine grants (referral signup, referral conversion, coupon free days).
  // One type rather than one per rule: to the shopkeeper they are all "you got free Pro time", and a
  // per-rule type would mean a mute switch per campaign.
  'reward-granted'
];

export const NOTIFICATION_CHANNELS = ['inApp', 'push'];
