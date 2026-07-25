// r2Service decides whether storage is available once, at import time, from env. Import
// this module BEFORE anything that pulls in src/ so the export routes see storage as
// configured. No requests are made: the API tests only queue exports, they never run the
// dispatcher, so nothing ever reaches these fake credentials.
process.env.R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || 'test-account';
process.env.R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || 'test-key';
process.env.R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || 'test-secret';
process.env.R2_BUCKET = process.env.R2_BUCKET || 'test-bucket';
