# QuickInvoice Backend

Express API for Billji / QuickInvoice. It manages auth, products, customers, invoices, PDF generation, email delivery, reports, notifications, and Socket.IO updates.

## Tech Stack

- Node.js 18+
- Express
- MongoDB Atlas or local MongoDB
- Mongoose
- JWT auth
- bcrypt
- Socket.IO
- pdfkit
- Nodemailer

## Required Installs

- Node.js `18.18.0` or newer.
- npm, included with Node.js.
- MongoDB Atlas account or local MongoDB connection string.

## Setup

Install dependencies and create an env file:

```bash
npm install
cp .env.example .env
```

Fill `.env`:

```env
NODE_ENV=development
PORT=5000
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/quickinvoice
JWT_SECRET=replace-with-a-long-random-secret
JWT_EXPIRES_IN=7d
CLIENT_URL=http://localhost:19006
CORS_ORIGINS=http://localhost:19006,http://localhost:8081
API_PUBLIC_URL=http://localhost:5000
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@example.com
SMTP_PASS=your-app-password
SMTP_FROM="QuickInvoice <your-email@example.com>"
```

## Run

Start dev server:

```bash
npm run dev
```

Start production server:

```bash
npm start
```

Seed demo data:

```bash
npm run seed
```

Demo login after seeding:

```text
demo@quickinvoice.app
password123
```

API URL: `http://localhost:5000`

Health check: `http://localhost:5000/health`

## API

All protected endpoints require `Authorization: Bearer <token>`.

- Versioned endpoints are mounted at `/api/v1`.
- Existing `/api` endpoints remain available as a compatibility alias.
- Auth: `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `GET /api/v1/auth/me`.
- Settings: `GET /api/v1/settings`, `PATCH /api/v1/settings`.
- Products: `GET /api/v1/products`, `POST /api/v1/products`, `PATCH /api/v1/products/:id`, `DELETE /api/v1/products/:id`.
- Customers: `GET /api/v1/customers`, `POST /api/v1/customers`, `PATCH /api/v1/customers/:id`, `DELETE /api/v1/customers/:id`.
- Invoices: `GET /api/v1/invoices`, `POST /api/v1/invoices`, `GET /api/v1/invoices/:id`, `PATCH /api/v1/invoices/:id/status`, `POST /api/v1/invoices/:id/duplicate`, `DELETE /api/v1/invoices/:id`.
- Sharing: `GET /api/v1/invoices/:id/pdf`, `GET /api/v1/invoices/:id/whatsapp`, `POST /api/v1/invoices/:id/email`.
- Public PDF link: `GET /api/public/invoices/:id/:token/pdf`.
- Reports: `GET /api/v1/reports/summary`.
- Notifications: `GET /api/v1/notifications`, `PATCH /api/v1/notifications/seen`.

## Phase 0 Contract

Backend ownership is business-scoped. Auth identifies the acting `User`; protected requests resolve `req.business` from the active `BusinessMember`. Core business records use `business` as the tenant field and `createdBy` / `updatedBy` for actor context.

Responses keep the current envelope:

```json
{ "success": true }
```

Errors keep:

```json
{ "success": false, "message": "Error summary", "details": null }
```

Critical write clients should send `Idempotency-Key` for retry-safe mutations.

## Phase 1 Backend Foundation

The backend is moving toward a modular monolith. Invoice write behavior now has a focused module boundary under `src/modules/invoices`, while legacy route imports continue to preserve public URLs.

Critical invoice writes are transaction-wrapped:

- `POST /api/v1/invoices`
- `POST /api/v1/invoices/:id/duplicate`
- `DELETE /api/v1/invoices/:id`

These routes support `Idempotency-Key`. If the same key is retried with the same request, the cached response is replayed after completion. Reusing the key with a different request returns a conflict. Requests without the header still work for compatibility, but clients should send it for duplicate-tap protection.

Invoice numbering uses `NumberSequence` per business, document type, and financial year. MongoDB transactions require a replica set or Atlas-compatible deployment.

## Deploy

Railway setup:

1. Create a Railway service from this `backend` folder.
2. Set start command to `npm start`.
3. Add all variables from `.env.example`.
4. Set `NODE_ENV=production`.
5. Set `API_PUBLIC_URL` to Railway backend URL.
6. Set `MONGODB_URI` to MongoDB Atlas connection string.

Email sending needs SMTP credentials. Without SMTP, the email endpoint returns a config error while the rest of the API works.
