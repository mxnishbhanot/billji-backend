import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env, isProduction } from './config/env.js';
import { API_PREFIX, API_VERSION, LEGACY_API_PREFIX } from './contracts/phase0Architecture.js';
import { errorHandler, notFound } from './middlewares/error.js';
import billingWebhookRoutes from './modules/billing/webhookRoutes.js';
import { apiLimiter } from './middlewares/rateLimit.js';
import routes from './routes/index.js';

const app = express();

const isLocalDevOrigin = (origin) => {
  if (isProduction || !origin) return false;

  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || /^192\.168\./.test(hostname) || /^10\./.test(hostname);
  } catch {
    return false;
  }
};

app.set('trust proxy', 1);
app.use(helmet());
app.use(compression());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || env.corsOrigins.includes(origin) || isLocalDevOrigin(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true
  })
);
// BEFORE express.json(), and it must stay there. Provider webhooks are authenticated by an HMAC
// over the exact raw bytes, so a parsed-and-restringified body cannot be verified — the only ways
// out of that would be to reject every webhook or to stop checking signatures. Guarded by
// tests/billingWebhook.test.js.
app.use(`${API_PREFIX}/billing/webhooks`, billingWebhookRoutes);
app.use(`${LEGACY_API_PREFIX}/billing/webhooks`, billingWebhookRoutes);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(apiLimiter);

if (!isProduction) {
  app.use(morgan('dev'));
}

app.get('/health', (_req, res) => {
  res.json({ success: true, status: 'ok', service: 'quickinvoice-api', apiVersion: API_VERSION });
});

app.use(API_PREFIX, routes);
app.use(LEGACY_API_PREFIX, routes);
app.use(notFound);
app.use(errorHandler);

export default app;
