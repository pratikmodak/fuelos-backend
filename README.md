# FuelOS v3 — Backend

Node.js / Express backend for FuelOS. Deploy on **Render** (free tier works).

---

## 🚀 Deploy on Render — Step by Step

### 1. Create PostgreSQL Database on Render
1. Go to [render.com](https://render.com) → **New → PostgreSQL**
2. Name: `fuelos-db`
3. Plan: Free
4. Click **Create Database**
5. Copy the **Internal Database URL** (starts with `postgresql://`)

### 2. Run the Schema
1. In Render dashboard → your database → **Connect** tab
2. Open **PSQL Command** or use any Postgres client
3. Paste and run the contents of `schema.sql`

### 3. Deploy the Backend as a Web Service
1. Push this folder to a GitHub repo (or use the zip)
2. Render → **New → Web Service**
3. Connect your GitHub repo
4. Settings:
   - **Name:** `fuelos-backend`
   - **Root Directory:** `/` (or the subfolder if nested)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free

### 4. Set Environment Variables in Render
Go to your Web Service → **Environment** tab → Add:

| Variable | Value | Required |
|----------|-------|----------|
| `DATABASE_URL` | Internal DB URL from step 1 | ✅ |
| `JWT_SECRET` | Random 64-char string | ✅ |
| `ADMIN_JWT_SECRET` | Another random 64-char string | ✅ |
| `SUPERADMIN_EMAIL` | Your superadmin email | ✅ |
| `SUPERADMIN_PASSWORD` | Your superadmin password | ✅ |
| `FRONTEND_URL` | Your Vercel app URL | ✅ |
| `NODE_ENV` | `production` | ✅ |
| `RAZORPAY_KEY_ID` | From Razorpay dashboard | Optional |
| `RAZORPAY_KEY_SECRET` | From Razorpay dashboard | Optional |
| `EMAIL_USER` | Gmail address for OTP | Optional |
| `EMAIL_PASS` | Gmail app password | Optional |

> Generate secrets: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`

### 5. Update Frontend
In your Vercel frontend → Settings → Environment Variables:
```
VITE_API_URL = https://fuelos-backend.onrender.com
```
(Replace with your actual Render service URL)

---

## 📡 API Endpoints

### Auth (no token needed for login)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Owner / Manager / Operator login |
| POST | `/api/auth/admin-login` | Admin portal step 1 (sends OTP) |
| POST | `/api/auth/admin-verify` | Admin portal step 2 (verify OTP) |
| GET  | `/api/auth/me` | Current user info |
| PATCH | `/api/auth/profile` | Update profile |
| PATCH | `/api/auth/password` | Change password |
| GET  | `/api/auth/2fa/status` | 2FA status |
| POST | `/api/auth/2fa/setup` | Setup 2FA |
| POST | `/api/auth/2fa/enable` | Enable 2FA |
| POST | `/api/auth/2fa/disable` | Disable 2FA |
| GET  | `/api/auth/company-users` | List admin users |
| POST | `/api/auth/company-users` | Create admin user |
| DELETE | `/api/auth/company-users/:id` | Delete admin user |

### Station Portal (owner/manager/operator token)
| Method | Path | Description |
|--------|------|-------------|
| GET  | `/api/owners/me` | Owner profile + plan |
| PATCH | `/api/owners/me` | Update owner profile |
| GET  | `/api/owners/staff` | All managers + operators |
| POST | `/api/owners/managers` | Add manager |
| POST | `/api/owners/operators` | Add operator |
| PATCH | `/api/owners/operators/:id` | Edit operator |
| DELETE | `/api/owners/operators/:id` | Remove operator |
| GET  | `/api/pumps` | List pumps |
| POST | `/api/pumps` | Add pump |
| PATCH | `/api/pumps/:id` | Update pump |
| GET  | `/api/pumps/:id/nozzles` | List nozzles |
| POST | `/api/pumps/:id/nozzles` | Add nozzle |
| DELETE | `/api/pumps/:id/nozzles/:nozzleId` | Remove nozzle |
| GET  | `/api/shifts` | List shift reports |
| POST | `/api/shifts` | Submit shift |
| DELETE | `/api/shifts/:id` | Undo shift |
| PATCH | `/api/shifts/:id/confirm` | Confirm shift |
| GET  | `/api/shifts/readings` | Nozzle readings |
| GET  | `/api/fuel-prices` | Price history |
| POST | `/api/fuel-prices` | Set pump rates |
| POST | `/api/fuel-prices/all-pumps` | Set rates for all pumps |
| GET  | `/api/analytics/sales` | Sales data (with ?days=30) |
| GET  | `/api/analytics/summary` | Summary stats |
| POST | `/api/payments/create-order` | Create Razorpay order |
| POST | `/api/payments/verify` | Verify payment + activate plan |
| GET  | `/api/payments/history` | Transaction history |

### Admin Portal (admin JWT)
| Method | Path | Description |
|--------|------|-------------|
| GET  | `/api/admin/stats` | Platform stats |
| GET  | `/api/admin/owners` | All owners |
| POST | `/api/admin/owners` | Create owner |
| PATCH | `/api/admin/owners/:id` | Update owner / force plan |
| DELETE | `/api/admin/owners/:id` | Suspend or hard-delete |
| GET  | `/api/admin/transactions` | All transactions |
| GET  | `/api/admin/config` | Platform config |
| GET  | `/api/admin/audit` | Audit log |
| GET  | `/api/admin/backup` | Data export |

### SuperAdmin Portal (superadmin JWT)
| Method | Path | Description |
|--------|------|-------------|
| GET  | `/api/superadmin/overview` | Platform overview counts |
| GET  | `/api/superadmin/activity` | Recent activity |
| GET  | `/api/superadmin/subscriptions` | All subscriptions |
| GET  | `/api/superadmin/health` | System health |
| GET  | `/api/superadmin/revenue` | Revenue analytics |
| GET  | `/api/superadmin/shifts` | Platform shift stats |
| GET  | `/api/superadmin/tests` | Machine test stats |
| GET  | `/api/superadmin/credits` | Credit platform stats |
| GET  | `/api/superadmin/whatsapp` | WhatsApp stats |
| GET  | `/api/superadmin/platform-analytics` | Growth analytics |
| GET  | `/api/superadmin/contacts` | Caller CRM |
| POST | `/api/superadmin/outreach-log` | Log outreach call |
| POST | `/api/superadmin/remind/:userId` | Send renewal reminder |

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET  | `/api/health` | DB + server health check |

---

## 🔑 First Login

After deploying and running the schema:

**SuperAdmin login:**
- Email: whatever you set in `SUPERADMIN_EMAIL`
- Password: whatever you set in `SUPERADMIN_PASSWORD`
- The OTP will be in your Render logs (since email isn't configured yet)

**Create your first owner:**
1. Login as Admin in the portal
2. Go to Owners tab → Add Owner
3. Or: POST `/api/admin/owners` directly

---

## ⚠️ Notes

- **Free Render tier** spins down after 15 min inactivity. First request takes ~30s. The frontend has a wake-up call built in.
- **OTP in dev:** If `EMAIL_USER`/`EMAIL_PASS` not set, OTP is logged to Render console (Logs tab).
- **Razorpay demo:** If keys not set, payments work in demo mode — plan updates immediately without real payment.
- **Tanks / Credit Customers:** These are stored in browser localStorage for now. Backend endpoints exist but are minimal. Add full CRUD if needed later.
