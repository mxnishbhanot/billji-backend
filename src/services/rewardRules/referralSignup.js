// The reward a referred user gets for signing up with someone's code: one month of Pro.
//
// A rule is a static object, not a factory or a builder. It says what the reward IS; rewardEngine
// decides how to apply it and owns the ledger. Adding a reward type later means adding a file that
// looks exactly like this one.

export const referralSignup = {
  key: 'referral_signup',
  type: 'plan_time',
  // Exactly 30 days, not one calendar month: the promise on the marketing screen is "1 month free",
  // and 30 days is the same length in February as in March.
  effect: { planKey: 'pro', days: 30 },
  title: 'Your free month of BillJi Pro is live',
  description: 'You joined with a referral code, so Pro is on us for the next 30 days.'
};

export default referralSignup;
