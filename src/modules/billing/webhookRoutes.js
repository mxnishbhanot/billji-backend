import express, { Router } from 'express';
import { handleProviderWebhook } from './webhookController.js';
import { webhookLimiter } from '../../middlewares/rateLimit.js';

// Mounted in app.js BEFORE the global express.json(), because the HMAC is computed over the exact
// raw bytes: a body that has been parsed and re-stringified will not match, and the only ways out
// of that are to fix the mount or to stop verifying signatures. If this file is ever moved below
// the JSON parser, tests/billingWebhook.test.js fails on purpose.
//
// No `protect` here. A provider has no BillJi session; the signature IS the authentication.

const router = Router();

router.post(
  '/:provider',
  webhookLimiter,
  // `type: '*/*'` so a provider that sends an unexpected content-type still yields a Buffer rather
  // than an empty body that fails verification for the wrong reason.
  express.raw({ type: '*/*', limit: '1mb' }),
  handleProviderWebhook
);

export default router;
