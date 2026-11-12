# Zamora Liquor Store — Backend API

Node.js + Express + TypeScript + Prisma (PostgreSQL) backend API for the Zamora Liquor Store Management System.

## Deploying to Render

### Option 1 — Render Blueprint (`render.yaml`)
1. In the Render Dashboard, choose **New + → Blueprint** and connect `stevedev-ops/zamora_backend`.
2. Render provisions both the `zamora-db` PostgreSQL instance and the `zamora-backend` web service.
3. When prompted for `FRONTEND_URL`, enter your Vercel frontend URL (for example, `https://zamora-frontend.vercel.app`).

### Option 2 — Manual Web Service Setup
- **Runtime**: Node
- **Build Command**: `npm install --include=dev && npm run build`
- **Start Command**: `npm start` (runs `prisma migrate deploy` then starts `dist/server.js`)
- **Health Check Path**: `/api/health`

### Required Environment Variables on Render
| Variable | Example / Notes |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Internal Database URL from your Render PostgreSQL database |
| `JWT_SECRET` | Random 32+ character secret |
| `PORTAL_JWT_SECRET` | Separate random 32+ character secret |
| `FRONTEND_URL` | Your Vercel deployment URL (e.g. `https://your-app.vercel.app`) — comma-separate multiple allowed origins if needed |
| `COOKIE_SECURE` | `true` |
| `COOKIE_SAME_SITE` | `none` |
| `DARAJA_MODE` | `simulation`, `sandbox`, or `production` |
| `SMS_PROVIDER` | `mock`, `africastalking`, or `twilio` |
| `WHATSAPP_PROVIDER` | `mock` or `whatsapp_cloud` |

### First Boot & Default Owner Login
On first boot against an empty PostgreSQL database, the server applies Prisma migrations (`npm start`) and automatically bootstraps default store settings, liquor categories, and an initial owner user (configurable via `OWNER_EMAIL`, `OWNER_PASSWORD`, and `OWNER_NAME`, defaulting to `owner@zamoraliquor.com` / `OwnerPass123!`). Change the password immediately under **Settings → Password & Security**.
