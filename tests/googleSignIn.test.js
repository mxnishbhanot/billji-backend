import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { useMongoTestDb } from './helpers/db.js';

useMongoTestDb();

// Regression: Google sign-in used to run the device token through
// admin.auth().verifyIdToken(), which only accepts Firebase-minted tokens and
// rejected every real sign-in with `incorrect "aud" claim`. Verification now goes
// through Google's OAuth certs, audienced by GOOGLE_OAUTH_CLIENT_IDS — so the
// Firebase service account must be irrelevant to this route.
describe('POST /api/v1/auth/google', () => {
  const original = process.env.GOOGLE_OAUTH_CLIENT_IDS;
  const originalWeb = process.env.GOOGLE_WEB_CLIENT_ID;

  afterEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_IDS = original ?? '';
    process.env.GOOGLE_WEB_CLIENT_ID = originalWeb ?? '';
  });

  it('503s when no OAuth client ID is configured', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_IDS = '';
    process.env.GOOGLE_WEB_CLIENT_ID = '';

    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'x.y.z' });

    assert.equal(res.status, 503, res.text);
  });

  it('rejects a malformed token without touching Firebase credentials', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_IDS = '123-abc.apps.googleusercontent.com';
    delete process.env.FIREBASE_SERVICE_ACCOUNT;

    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'not-a-jwt' });

    assert.equal(res.status, 401, res.text);
  });
});
