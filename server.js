// ═══════════════════════════════════════════════════════════
// FuelOS v8 — Express Backend
// ═══════════════════════════════════════════════════════════
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

import { initDb } from './db.js';
import authRoutes from './routes/auth.js';
import ownersRoutes from './routes/owners.js';
import pumpsRoutes from './routes/pumps.js';
import shiftsRoutes from './routes/shifts.js';
import paymentsRoutes from './routes/payments.js';
import webhookRoutes from './routes/webhooks.js';
import whatsappRoutes from './routes/whatsapp.js';
import adminRoutes from './routes/admin.js';
import analyticsRoutes from './routes/analytics.js';
import indentsRoutes from './routes/indents.js';
import pricesRoutes from './routes/prices.js';
import reportsRoutes from './routes/reports.js';
import notificationsRoutes from './routes/notifications.js';
import creditsRoutes from './routes/credits.js';
import auditRoutes from './routes/audit.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, cb) => {
    const ok = [process.env.FRONTEND_URL,'http://localhost:5173','http://localhost:3000'].filter(Boolean);
    if (!origin || ok.includes(origin) || origin.includes('vercel.app') || origin.includes('onrender.com'))
      cb(null, true);
    else cb(new Error('CORS blocked'));
  },
  credentials: true,
}));
app.use(rateLimit({ windowMs: 15*60*1000, max: 300 }));
app.use(morgan('dev'));
app.use('/api/webhooks/razorpay', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth',          authRoutes);
app.use('/api/owners',        ownersRoutes);
app.use('/api/pumps',         pumpsRoutes);
app.use('/api/shifts',        shiftsRoutes);
app.use('/api/payments',      paymentsRoutes);
app.use('/api/webhooks',      webhookRoutes);
app.use('/api/whatsapp',      whatsappRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/analytics',     analyticsRoutes);
app.use('/api/indents',       indentsRoutes);
app.use('/api/prices',        pricesRoutes);
app.use('/api/reports',       reportsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/credits',       creditsRoutes);
app.use('/api/audit',         auditRoutes);

app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', version: '8.0.0', timestamp: new Date().toISOString() }));

app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

async function start() {
  await initDb();
  app.listen(PORT, () => console.log(`\n⛽  FuelOS v8 → http://localhost:${PORT}\n`));
}
start().catch(e => { console.error(e); process.exit(1); });
