// The reward a referrer gets when someone they referred pays for Pro for the first time.
//
// Once per referred user, for ever — enforced by rewardEngine's (rule, dedupeKey) lock, where the
// key is the referral id. Renewals reach the engine and lose that race, which is why no renewal
// check is needed here.

export const referralConversion = {
  key: 'referral_conversion',
  type: 'plan_time',
  effect: { planKey: 'pro', days: 30 },
  title: 'You earned a free month of Pro',
  description: 'Someone you referred just subscribed to BillJi Pro. 30 days are on us.'
};

export default referralConversion;
