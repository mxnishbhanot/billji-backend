import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { signChallengeToken } from '../src/utils/jwt.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

// Regression: `protect` must reject any non-access token. The 2FA challenge token is
// signed with the same jwtSecret and would previously authorize protected calls
// because `verifyToken` never asserted typ and the sid session-check was skipped.
describe('protect token-type enforcement', () => {
  it('rejects a 2FA challenge token on a protected route', async () => {
    const { user } = await createTestContext();
    const challenge = signChallengeToken({ userId: user._id, method: 'email' });

    const res = await request(app).get('/api/v1/auth/me').set(authHeader(challenge));

    assert.equal(res.status, 401, res.text);
  });

  it('accepts a valid access token on the same route', async () => {
    const { token } = await createTestContext();

    const res = await request(app).get('/api/v1/auth/me').set(authHeader(token));

    assert.equal(res.status, 200, res.text);
  });
});
