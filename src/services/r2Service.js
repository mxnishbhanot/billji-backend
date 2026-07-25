import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

// Cloudflare R2 is S3-compatible, so we drive it with the AWS S3 SDK pointed at
// the R2 endpoint. The whole module is a no-op when R2 is not configured: callers
// check isR2Enabled() (or just rely on the PDF cache falling back to live render).

const enabled = Boolean(
  env.r2.accountId && env.r2.accessKeyId && env.r2.secretAccessKey && env.r2.bucket
);

let clientPromise = null;

const resolveEndpoint = () =>
  env.r2.endpoint || `https://${env.r2.accountId}.r2.cloudflarestorage.com`;

const getClient = () => {
  if (!clientPromise) {
    clientPromise = Promise.resolve(
      new S3Client({
        region: 'auto',
        endpoint: resolveEndpoint(),
        credentials: {
          accessKeyId: env.r2.accessKeyId,
          secretAccessKey: env.r2.secretAccessKey
        }
      })
    );
  }
  return clientPromise;
};

export const isR2Enabled = () => enabled;

export const putObject = async (key, body, { contentType = 'application/octet-stream' } = {}) => {
  if (!enabled) return false;
  const client = await getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: env.r2.bucket,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  );
  return true;
};

export const objectExists = async (key) => {
  if (!enabled) return false;
  const client = await getClient();
  try {
    await client.send(new HeadObjectCommand({ Bucket: env.r2.bucket, Key: key }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false;
    throw err;
  }
};

// Returns the object body as a Buffer, or null on a miss.
export const getObjectBuffer = async (key) => {
  if (!enabled) return null;
  const client = await getClient();
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: env.r2.bucket, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') return null;
    throw err;
  }
};

export const deleteObject = async (key) => {
  if (!enabled || !key) return false;
  const client = await getClient();
  await client.send(new DeleteObjectCommand({ Bucket: env.r2.bucket, Key: key }));
  return true;
};

// Permanent public URL for a cached object, only when a public base URL is
// configured (custom domain / r2.dev). Returns null otherwise — never presigns.
// Use for links that must survive (emails, WhatsApp/share messages).
export const getPublicObjectUrl = (key) => {
  if (!enabled || !key || !env.r2.publicBaseUrl) return null;
  return `${env.r2.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
};

// Always-presigned, always-expiring URL, with an optional download filename.
//
// Use this instead of getObjectUrl for anything sensitive: getObjectUrl returns a
// PERMANENT public URL whenever R2_PUBLIC_BASE_URL is set, which is right for invoice
// PDFs in emails and wrong for a full data export.
export const getSignedObjectUrl = async (key, { expiresIn = env.r2.signedUrlTtlSeconds, fileName = '' } = {}) => {
  if (!enabled || !key) return null;
  const client = await getClient();
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: env.r2.bucket,
      Key: key,
      ...(fileName ? { ResponseContentDisposition: `attachment; filename="${fileName}"` } : {})
    }),
    { expiresIn }
  );
};

// Public URL for a cached object. Prefers a configured public domain (zero-egress
// via Cloudflare), otherwise falls back to a short-lived presigned URL.
export const getObjectUrl = async (key) => {
  if (!enabled || !key) return null;
  if (env.r2.publicBaseUrl) {
    return `${env.r2.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
  }
  const client = await getClient();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: env.r2.bucket, Key: key }),
    { expiresIn: env.r2.signedUrlTtlSeconds }
  );
};
