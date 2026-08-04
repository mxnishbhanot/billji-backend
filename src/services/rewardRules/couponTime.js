// Free time bought with a `trial_extension` / `free_period` coupon.
//
// This is not a new feature: applyCapturedPayment already granted these days, by mutating
// currentPeriodEnd in place with no ledger row, no lock and no way to reverse it on a refund. Routing
// it through the engine gives it all three and makes the engine what it claims to be — the only
// thing in the backend that hands out plan time nobody paid for.
//
// `days` is per-grant rather than fixed, so the effect is supplied by the caller from the coupon row.

export const couponTime = {
  key: 'coupon_time',
  type: 'plan_time',
  // Filled in per grant from the coupon (`couponService.timeGrant`); the planKey comes from what was
  // actually bought, so a free_period coupon on Business extends Business, not Pro.
  effect: null,
  title: 'Extra time added to your plan',
  description: 'Your coupon added free days to your BillJi subscription.'
};

export default couponTime;
