# FuelOS v8 — Backend API

Express.js + LibSQL (SQLite) backend for FuelOS v8.

## Deploy to Render
1. Push to GitHub
2. Create **Web Service** on Render, point to this folder
3. Set env vars (see `.env.example`)
4. Build command: `npm install`
5. Start command: `node server.js`

## Environment Variables
```
PORT=4000
DB_PATH=/tmp/fuelos.db
JWT_SECRET=your-secret-key-here
ADMIN_PASSWORD=admin2025
FRONTEND_URL=https://your-app.vercel.app
RAZORPAY_KEY_ID=rzp_test_xxx
RAZORPAY_KEY_SECRET=your-secret
WHATSAPP_PROVIDER=wati
WHATSAPP_API_KEY=your-key
SMTP_HOST=smtp.gmail.com
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password
```

## API Routes (v8)

### Auth
- `POST /api/auth/login` — owner/manager/operator login
- `POST /api/auth/admin-login` → `POST /api/auth/admin-verify`
- `GET  /api/auth/me`

### Owners & Pumps
- `GET/PATCH /api/owners/me`
- `GET/POST  /api/pumps`
- `GET/POST/DELETE /api/pumps/:id/nozzles`

### Shifts
- `GET/POST /api/shifts`

### Payments (Razorpay)
- `POST /api/payments/create-order`
- `POST /api/payments/verify`
- `GET  /api/payments/history`

### Analytics
- `GET /api/analytics/sales?days=7`
- `GET /api/analytics/summary`

### 🆕 Indents (v8)
- `GET    /api/indents`
- `POST   /api/indents`
- `PATCH  /api/indents/:id/status`
- `DELETE /api/indents/:id`

### 🆕 Fuel Prices (v8)
- `GET  /api/prices`
- `GET  /api/prices/history`
- `POST /api/prices`

### 🆕 Reports/PDF Data (v8)
- `GET /api/reports/shift/:id`
- `GET /api/reports/gst?from=&to=&pump_id=`
- `GET /api/reports/analytics?days=7`

### 🆕 Notifications (v8)
- `GET   /api/notifications`
- `POST  /api/notifications`
- `PATCH /api/notifications/:id/read`
- `PATCH /api/notifications/read-all`

### 🆕 Credits CRUD (v8)
- `GET    /api/credits`
- `POST   /api/credits`
- `PATCH  /api/credits/:id`
- `DELETE /api/credits/:id`
- `GET    /api/credits/:id/transactions`
- `POST   /api/credits/:id/transactions`
- `GET    /api/credits/summary`

### 🆕 Shift Audit (v8)
- `GET   /api/audit/shifts`
- `PATCH /api/audit/shifts/:id`
- `GET   /api/audit/shifts/:id/history`

### Admin
- `GET   /api/admin/stats`
- `GET   /api/admin/owners`
- `PATCH /api/admin/owners/:id`
- `GET   /api/admin/transactions`
- `GET   /api/admin/audit`
- `GET   /api/whatsapp/log`

## New DB Tables (v8)
- `indents` — refill orders
- `fuel_rates` — per-owner/pump rates
- `fuel_rate_log` — rate change audit
- `shift_audit_log` — shift edit history
- `notifications` — stored notifications
- `credit_transactions` — credit ledger
