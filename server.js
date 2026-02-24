// ═══════════════════════════════════════════════════════════
// FuelOS v6 — Express Backend Server
// ═══════════════════════════════════════════════════════════
import express       from 'express';
import cors          from 'cors';
import helmet        from 'helmet';
import morgan        from 'morgan';
import rateLimit     from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname }   from 'path';
import 'dotenv/config';

import { initDb }         from './db.js';
import authRoutes         from './routes/auth.js';
import ownersRoutes       from './routes/owners.js';
import pumpsRoutes        from './routes/pumps.js';
import shiftsRoutes       from './routes/shifts.js';
import paymentsRoutes     from './routes/payments.js';
import webhookRoutes      from './routes/webhooks.js';
import whatsappRoutes     from './routes/whatsapp.js';
import adminRoutes        from './routes/admin.js';
import analyticsRoutes    from './routes/analytics.js';
import superAdminRoutes   from './routes/superadmin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 4000;

// ── Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [process.env.FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5173'].filter(Boolean);
    if (!origin || allowed.includes(origin) || origin.includes('vercel.app') || origin.includes('onrender.com')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));
app.use(morgan('dev'));
app.use('/api/webhooks/razorpay', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Routes
app.use('/api/auth',      authRoutes);
app.use('/api/owners',    ownersRoutes);
app.use('/api/pumps',     pumpsRoutes);
app.use('/api/shifts',    shiftsRoutes);
app.use('/api/payments',  paymentsRoutes);
app.use('/api/webhooks',  webhookRoutes);
app.use('/api/whatsapp',  whatsappRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/superadmin', superAdminRoutes);

// ── Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '6.0.0', timestamp: new Date().toISOString() });
});

// ── Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

// ══════════════════════════════════════════════════════════
// START — await DB init BEFORE accepting any requests
// ══════════════════════════════════════════════════════════
async function start() {
  try {
    console.log('⏳ Initializing database...');
    await initDb();                          // ← tables created, demo data seeded
    console.log('✓ Database ready');

    app.listen(PORT, () => {
      console.log(`\n⛽  FuelOS Backend → http://localhost:${PORT}`);
      console.log(`    DB: ${process.env.DB_PATH || '/tmp/fuelos.db'}\n`);
    });
  } catch (e) {
    console.error('❌ Startup failed:', e);
    process.exit(1);
  }
}

start();
