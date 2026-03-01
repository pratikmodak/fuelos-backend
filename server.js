// ═══════════════════════════════════════════════════════════
// FuelOS v3 — Backend Server
// Node.js / Express — Deploy on Render
// ═══════════════════════════════════════════════════════════
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const db      = require('./db');

const app = express();

// ── CORS — allow your Vercel frontend + localhost
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000',
  'https://fuelos.vercel.app',
  'https://fuelos-v.vercel.app',
  'https://fuelos.ligeratechnology.com',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return cb(null, true);
    // Allow ALL Vercel deployments (preview + production + any fuelos-* subdomain)
    if (origin.endsWith('.vercel.app')) return cb(null, true);
    // Allow localhost dev
    if (origin.startsWith('http://localhost')) return cb(null, true);
    // Allow explicitly listed origins
    if (allowedOrigins.some(o => o && origin.startsWith(o))) return cb(null, true);
    // Log and block unknown origins in production
    console.error('[ERROR] CORS: origin not allowed:', origin);
    cb(new Error('CORS: origin not allowed: ' + origin));
  },
  credentials: true,
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request logging (brief)
app.use((req, res, next) => {
  if (req.path !== '/api/health') {
    console.log(`[${new Date().toISOString().slice(11,19)}] ${req.method} ${req.path}`);
  }
  next();
});

// ════════════════════════════════════════════════
// HEALTH CHECK (no auth — used by Render + frontend wake-up)
// ════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  try {
    const start = Date.now();
    await db.query('SELECT 1');
    res.json({
      status:  'ok',
      db:      true,
      latency: Date.now() - start,
      version: '3.0.0',
      uptime:  Math.round(process.uptime()),
    });
  } catch (e) {
    res.status(503).json({ status: 'error', db: false, error: e.message });
  }
});

// ════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/owners',       require('./routes/owners'));
app.use('/api/pumps',        require('./routes/pumps'));
app.use('/api/shifts',       require('./routes/shifts'));
app.use('/api/fuel-prices',  require('./routes/fuel-prices'));
app.use('/api/analytics',    require('./routes/analytics'));
app.use('/api/payments',     require('./routes/payments'));
app.use('/api/admin',        require('./routes/admin'));
app.use('/api/superadmin',   require('./routes/superadmin'));
app.use('/api/ai',           require('./routes/ai'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/webhook/whatsapp',  require('./routes/whatsapp-webhook')); // Meta WA webhook
// WhatsApp log alias (admin route)
app.get('/api/whatsapp/log', require('./middleware/auth').requireAdmin, (req, res) => res.json([]));

// ════════════════════════════════════════════════
// ERROR HANDLER
// ════════════════════════════════════════════════
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

async function start() {
  // Test DB connection
  try {
    await db.query('SELECT 1');
    console.log('[FuelOS] ✓ Database connected');
  } catch (e) {
    console.error('[FuelOS] ✗ Database connection failed:', e.message);
    console.error('[FuelOS] Set DATABASE_URL in environment variables');
    // Don't exit — let Render restart it
  }

  app.listen(PORT, () => {
    console.log(`[FuelOS] ✓ Server running on port ${PORT}`);
    console.log(`[FuelOS] ✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[FuelOS] ✓ Frontend allowed: ${allowedOrigins.join(', ')}`);
    console.log(`[FuelOS] ✓ Razorpay: ${process.env.RAZORPAY_KEY_ID ? 'enabled' : 'demo mode'}`);
    console.log(`[FuelOS] ✓ Email OTP: ${process.env.EMAIL_USER ? 'enabled' : 'log-only mode'}`);
    console.log(`[FuelOS] ✓ RapidAPI: ${process.env.RAPIDAPI_KEY ? 'enabled (live fuel prices)' : 'not set (static fallback)'}`);

    // Start daily fuel price scheduler (12:01 AM IST)
    const { scheduleDaily } = require('./scheduler');
    scheduleDaily();
  });
}

start();