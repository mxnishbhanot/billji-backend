import admin from 'firebase-admin';

// Lazy Firebase Admin init. Credentials come from env so the service-account JSON
// never lands in the repo. Supports two shapes:
//   1) FIREBASE_SERVICE_ACCOUNT — the full service-account JSON as one string.
//   2) FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (the
//      private key may carry literal "\n" which we unescape).
// When nothing is configured, verifyGoogleIdToken throws a clean 503-style error
// instead of crashing the server — Google sign-in stays disabled, the rest works.

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

// Verify a Google ID token minted on the device. Returns the decoded token
// ({ uid, email, name, picture, email_verified, ... }) or throws.
export const verifyGoogleIdToken = async (idToken) => {
  const firebaseApp = getApp();
  if (!firebaseApp) {
    const err = new Error('Google sign-in is not configured on the server');
    err.statusCode = 503;
    throw err;
  }
  return admin.auth(firebaseApp).verifyIdToken(idToken);
};
