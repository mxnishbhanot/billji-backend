import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import otplib from 'otplib';
import request from 'supertest';
import app from '../src/app.js';
import User from '../src/models/User.js';
import TrustedDevice from '../src/models/TrustedDevice.js';
import { useMongoTestDb } from './helpers/db.js';

const { authenticator } = otplib;
authenticator.options = { window: 1 };

const API = '/api/v1/auth';
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// Register a fresh user and return the session (token + refresh + user).
const registerUser = async (email = `2fa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@billji.local`) => {
  const res = await request(app).post(`${API}/register`).send({ name: 'Two Factor', email, password: 'password123' });
  assert.equal(res.status, 201, res.text);
  return { ...res.body, email, password: 'password123' };
};

// Full TOTP enrollment. Returns { token, secret }.
const enrollTotp = async (token) => {
  const setup = await request(app).post(`${API}/2fa/totp/setup`).set(bearer(token)).send();
  assert.equal(setup.status, 200, setup.text);
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
  const secret = setup.body.secret;
  const enable = await request(app)
    .post(`${API}/2fa/totp/enable`)
    .set(bearer(token))
    .send({ code: authenticator.generate(secret) });
  assert.equal(enable.status, 200, enable.text);
  assert.equal(enable.body.backupCodes.length, 10);
  return { secret, backupCodes: enable.body.backupCodes };
};

describe('Two-factor authentication', () => {
  useMongoTestDb();

  it('enrolls TOTP and reflects status', async () => {
    const { accessToken } = await registerUser();
    const { secret } = await enrollTotp(accessToken);
    assert.ok(secret);

    const status = await request(app).get(`${API}/2fa/status`).set(bearer(accessToken)).send();
    assert.equal(status.status, 200);
    assert.equal(status.body.twoFactor.method, 'totp');
    assert.equal(status.body.twoFactor.enabled, true);
    assert.equal(status.body.twoFactor.backupCodesRemaining, 10);
  });

  it('rejects TOTP enable with a wrong code', async () => {
    const { accessToken } = await registerUser();
    await request(app).post(`${API}/2fa/totp/setup`).set(bearer(accessToken)).send();
    const enable = await request(app).post(`${API}/2fa/totp/enable`).set(bearer(accessToken)).send({ code: '000000' });
    assert.equal(enable.status, 422);
  });

  it('requires a second step on login once TOTP is enabled, then issues a session', async () => {
    const { accessToken, email, password } = await registerUser();
    const { secret } = await enrollTotp(accessToken);

    // Password login now returns a challenge, not a session.
    const login = await request(app).post(`${API}/login`).send({ email, password });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.body.twoFactorRequired, true);
    assert.equal(login.body.method, 'totp');
    assert.ok(login.body.challengeToken);
    assert.equal(login.body.token, undefined);

    // Verify with the current TOTP code -> full session.
    const verify = await request(app)
      .post(`${API}/2fa/verify`)
      .send({ challengeToken: login.body.challengeToken, code: authenticator.generate(secret) });
    assert.equal(verify.status, 200, verify.text);
    assert.ok(verify.body.accessToken);
    assert.ok(verify.body.refreshToken);
    assert.equal(verify.body.user.email, email);
  });

  it('rejects 2FA verify with a wrong code', async () => {
    const { accessToken, email, password } = await registerUser();
    await enrollTotp(accessToken);
    const login = await request(app).post(`${API}/login`).send({ email, password });
    const verify = await request(app)
      .post(`${API}/2fa/verify`)
      .send({ challengeToken: login.body.challengeToken, code: '000000' });
    assert.equal(verify.status, 422);
  });

  it('accepts a backup code at login and consumes it', async () => {
    const { accessToken, email, password } = await registerUser();
    const { backupCodes } = await enrollTotp(accessToken);

    const login = await request(app).post(`${API}/login`).send({ email, password });
    const verify = await request(app)
      .post(`${API}/2fa/verify`)
      .send({ challengeToken: login.body.challengeToken, code: backupCodes[0] });
    assert.equal(verify.status, 200, verify.text);

    // Same backup code can't be reused.
    const login2 = await request(app).post(`${API}/login`).send({ email, password });
    const reuse = await request(app)
      .post(`${API}/2fa/verify`)
      .send({ challengeToken: login2.body.challengeToken, code: backupCodes[0] });
    assert.equal(reuse.status, 422);

    const status = await request(app).get(`${API}/2fa/status`).set(bearer(verify.body.accessToken)).send();
    assert.equal(status.body.twoFactor.backupCodesRemaining, 9);
  });

  it('remembers a trusted device so the next login skips 2FA', async () => {
    const { accessToken, email, password } = await registerUser();
    const { secret } = await enrollTotp(accessToken);

    const login = await request(app).post(`${API}/login`).send({ email, password });
    const verify = await request(app)
      .post(`${API}/2fa/verify`)
      .send({ challengeToken: login.body.challengeToken, code: authenticator.generate(secret), rememberDevice: true });
    assert.equal(verify.status, 200, verify.text);
    const trustToken = verify.body.trustedDeviceToken;
    assert.ok(trustToken);

    // Next login carrying the trusted-device token gets a session directly.
    const login2 = await request(app).post(`${API}/login`).set({ 'x-trusted-device': trustToken }).send({ email, password });
    assert.equal(login2.status, 200, login2.text);
    assert.equal(login2.body.twoFactorRequired, undefined);
    assert.ok(login2.body.accessToken);

    // Without it, still challenged.
    const login3 = await request(app).post(`${API}/login`).send({ email, password });
    assert.equal(login3.body.twoFactorRequired, true);
  });

  it('enrolls email 2FA using the emailed code and challenges on login', async () => {
    const { accessToken, email, password } = await registerUser();

    const setup = await request(app).post(`${API}/2fa/email/setup`).set(bearer(accessToken)).send();
    assert.equal(setup.status, 200, setup.text);
    assert.ok(setup.body.devCode, 'dev code echoed when email provider absent');

    const enable = await request(app).post(`${API}/2fa/email/enable`).set(bearer(accessToken)).send({ code: setup.body.devCode });
    assert.equal(enable.status, 200, enable.text);
    assert.equal(enable.body.method, 'email');

    const login = await request(app).post(`${API}/login`).send({ email, password });
    assert.equal(login.body.twoFactorRequired, true);
    assert.equal(login.body.method, 'email');
    assert.ok(login.body.devCode);

    const verify = await request(app)
      .post(`${API}/2fa/verify`)
      .send({ challengeToken: login.body.challengeToken, code: login.body.devCode });
    assert.equal(verify.status, 200, verify.text);
    assert.ok(verify.body.accessToken);
  });

  it('disables 2FA with a valid code and clears trusted devices', async () => {
    const { accessToken, email, password } = await registerUser();
    const { secret } = await enrollTotp(accessToken);

    // Trust a device first.
    const login = await request(app).post(`${API}/login`).send({ email, password });
    await request(app)
      .post(`${API}/2fa/verify`)
      .send({ challengeToken: login.body.challengeToken, code: authenticator.generate(secret), rememberDevice: true });
    assert.ok((await TrustedDevice.countDocuments({})) >= 1);

    const disable = await request(app).post(`${API}/2fa/disable`).set(bearer(accessToken)).send({ code: authenticator.generate(secret) });
    assert.equal(disable.status, 200, disable.text);

    const user = await User.findOne({ email });
    assert.equal(user.twoFactor.method, 'none');
    assert.equal(await TrustedDevice.countDocuments({ user: user._id }), 0);

    // Login no longer challenges.
    const login2 = await request(app).post(`${API}/login`).send({ email, password });
    assert.ok(login2.body.accessToken);
    assert.equal(login2.body.twoFactorRequired, undefined);
  });

  it('does not allow enrolling a second method while one is active', async () => {
    const { accessToken } = await registerUser();
    await enrollTotp(accessToken);
    const setup = await request(app).post(`${API}/2fa/email/setup`).set(bearer(accessToken)).send();
    assert.equal(setup.status, 409);
  });

  it('stores the TOTP secret encrypted, not in plaintext', async () => {
    const { accessToken, email } = await registerUser();
    const { secret } = await enrollTotp(accessToken);
    const user = await User.findOne({ email }).select('+twoFactor.totpSecret');
    assert.ok(user.twoFactor.totpSecret);
    assert.notEqual(user.twoFactor.totpSecret, secret);
    assert.match(user.twoFactor.totpSecret, /^[^.]+\.[^.]+\.[^.]+$/); // iv.tag.ct
  });
});
