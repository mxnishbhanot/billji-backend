import admin from 'firebase-admin';
import { OAuth2Client } from 'google-auth-library';

// Verifies Google-issued ID tokens (public certs only, no credentials needed).
const oauthClient = new OAuth2Client();

// Lazy Firebase Admin init. Credentials come from env so the service-account JSON
// never lands in the repo. Supports two shapes:
//   1) FIREBASE_SERVICE_ACCOUNT — the full service-account JSON as one string.
//   2) FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (the
//      private key may carry literal "\n" which we unescape).
// When nothing is configured, getApp() returns null and callers (push messaging)
// degrade instead of crashing. Google sign-in does NOT need these credentials —
// see verifyGoogleIdToken below, which uses GOOGLE_OAUTH_CLIENT_IDS.

let app = null;
let initTried = false;

const loadCredential = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      return admin.credential.cert(JSON.parse(raw));
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (projectId && clientEmail && privateKey) {
    return admin.credential.cert({ projectId, clientEmail, privateKey });
  }

  return null;
};

const getApp = () => {
  if (app) return app;
  if (initTried) return null;
  initTried = true;

  if (admin.apps.length) {
    app = admin.apps[0];
    return app;
  }

  const credential = loadCredential();
  if (!credential) return null;

  app = admin.initializeApp({ credential });
  return app;
};

export const isFirebaseConfigured = () => Boolean(getApp());

// Shared app handle for other Firebase services (push messaging). Null when the
// server has no credentials — callers degrade instead of throwing.
export const getFirebaseApp = () => getApp();

// Verify a Google ID token minted on the device by @react-native-google-signin.
// That token comes from Google's OAuth endpoint, so its "aud" is our OAuth client
// ID — NOT the Firebase project. admin.auth().verifyIdToken() only accepts tokens
// minted by Firebase Auth and rejects these with an "incorrect aud" error, so we
// verify against Google's own certs instead. Returns the payload
// ({ sub, email, email_verified, name, picture, ... }) or throws.
export const verifyGoogleIdToken = async (idToken) => {
  // Comma-separated so Android/iOS client IDs can be accepted alongside the web one.
  const audience = (process.env.GOOGLE_OAUTH_CLIENT_IDS || process.env.GOOGLE_WEB_CLIENT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (!audience.length) {
    const err = new Error('Google sign-in is not configured on the server');
    err.statusCode = 503;
    throw err;
  }

  // A bad/expired/wrong-audience token is a client error, not a server fault.
  let ticket;
  try {
    ticket = await oauthClient.verifyIdToken({ idToken, audience });
  } catch (cause) {
    const err = new Error('Invalid Google sign-in token');
    err.statusCode = 401;
    err.cause = cause;
    throw err;
  }
  return ticket.getPayload();
};
