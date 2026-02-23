// ═══════════════════════════════════════════════════════════
// FuelOS v6 — Express Backend Server
// ═══════════════════════════════════════════════════════════
import express       from 'express';
import cors          from 'cors';
import helmet        from 'helmet';
import morgan        from 'morgan';
import rateLimit     from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

// ── Security middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      process.env.FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:5173',
    ].filter(Boolean);
    // Allow Vercel preview URLs and the configured frontend URL
    if (!origin || allowed.includes(origin) || origin.includes('vercel.app') || origin.includes('onrender.com')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// ── Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many login attempts' });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);

// ── Logging
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Raw body for Razorpay webhook signature verification
app.use('/api/webhooks/razorpay', express.raw({ type: 'application/json' }));

// ── JSON body parser for all other routes
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Database init
initDb().catch(e => { console.error("DB init failed:", e); process.exit(1); });

// ── API Routes
app.use('/api/auth',      authRoutes);
app.use('/api/owners',    ownersRoutes);
app.use('/api/pumps',     pumpsRoutes);
app.use('/api/shifts',    shiftsRoutes);
app.use('/api/payments',  paymentsRoutes);
app.use('/api/webhooks',  webhookRoutes);
app.use('/api/whatsapp',  whatsappRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/analytics', analyticsRoutes);

// ── Frontend is served by Vercel — no static files here

// ── Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '6.0.0', timestamp: new Date().toISOString() });
});

// ── Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

app.listen(PORT, () => {
  console.log(`\n⛽  FuelOS Backend running on http://localhost:${PORT}`);
  console.log(`    Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`    Database: ${process.env.DB_PATH || './fuelos.db'}\n`);
});
