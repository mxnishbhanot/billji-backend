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

- Auth: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`.
- Settings: `GET /api/settings`, `PATCH /api/settings`.
- Products: `GET /api/products`, `POST /api/products`, `PATCH /api/products/:id`, `DELETE /api/products/:id`.
- Customers: `GET /api/customers`, `POST /api/customers`, `PATCH /api/customers/:id`, `DELETE /api/customers/:id`.
- Invoices: `GET /api/invoices`, `POST /api/invoices`, `GET /api/invoices/:id`, `PATCH /api/invoices/:id/status`, `POST /api/invoices/:id/duplicate`, `DELETE /api/invoices/:id`.
- Sharing: `GET /api/invoices/:id/pdf`, `GET /api/invoices/:id/whatsapp`, `POST /api/invoices/:id/email`.
- Public PDF link: `GET /api/public/invoices/:id/:token/pdf`.
- Reports: `GET /api/reports/summary`.
- Notifications: `GET /api/notifications`, `PATCH /api/notifications/seen`.

## Deploy

Railway setup:

1. Create a Railway service from this `backend` folder.
2. Set start command to `npm start`.
3. Add all variables from `.env.example`.
4. Set `NODE_ENV=production`.
5. Set `API_PUBLIC_URL` to Railway backend URL.
6. Set `MONGODB_URI` to MongoDB Atlas connection string.

Email sending needs SMTP credentials. Without SMTP, the email endpoint returns a config error while the rest of the API works.
