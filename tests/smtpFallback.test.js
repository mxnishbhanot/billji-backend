import assert from 'node:assert/strict';
import test from 'node:test';

// Verifies the dev-only SMTP escape hatch: SMTP_HOST decides the provider, and the
// adapter presents the same `{ data, error }` contract as the Resend SDK so every
// caller in emailService.js works unchanged across both.
//
// No live SMTP server here — the failure case points at a closed port, which is
// enough to prove errors are returned rather than thrown.

// env.js snapshots process.env at import time and Node caches it for the life of
// the process, so re-importing resend.js can't pick up new values. Each case runs
// in its own child process instead — the only way to get a genuinely fresh config.
const loadConfig = async (overrides, body) => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `const { getResendClient, isEmailEnabled } = await import('./src/config/resend.js');\n${body}`],
    {
      cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      env: { ...process.env, ...overrides },
      encoding: 'utf8'
    }
  );
  return JSON.parse(out.trim().split('\n').pop());
};

test('SMTP failures come back as `error`, not a throw', async () => {
  const result = await loadConfig(
    {
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1', // nothing listening
      SMTP_USER: '',
      SMTP_PASS: '',
      RESEND_API_KEY: 're_ignored'
    },
    `const r = await getResendClient().emails.send({
       from: 'BillJi Dev <dev@gmail.com>', to: 'tester@yopmail.com',
       subject: 'invite', html: '<p>code</p>', text: 'code'
     });
     console.log(JSON.stringify({ enabled: isEmailEnabled(), data: r.data, message: r.error?.message }));`
  );

  assert.equal(result.enabled, true);
  // Same shape emailService.js destructures — a throw here would escape the
  // `if (error)` guard and 500 instead of returning a clean 502.
  assert.equal(result.data, null);
  assert.ok(result.message, 'error carries a message for the ApiError');
});

test('falls back to Resend when SMTP_HOST is unset', async () => {
  const result = await loadConfig(
    { SMTP_HOST: '', RESEND_API_KEY: 're_test' },
    `const c = getResendClient();
     console.log(JSON.stringify({
       hasSend: typeof c.emails?.send === 'function',
       // The adapter is a plain object literal; the SDK client is a class instance.
       isAdapter: Object.getPrototypeOf(c) === Object.prototype,
       enabled: isEmailEnabled()
     }));`
  );

  assert.equal(result.hasSend, true);
  assert.equal(result.isAdapter, false, 'uses the Resend SDK, not the SMTP adapter');
  assert.equal(result.enabled, true);
});

test('email is disabled when neither provider is configured', async () => {
  const result = await loadConfig(
    { SMTP_HOST: '', RESEND_API_KEY: '' },
    `console.log(JSON.stringify({ client: getResendClient(), enabled: isEmailEnabled() }));`
  );

  assert.equal(result.client, null);
  assert.equal(result.enabled, false);
});
