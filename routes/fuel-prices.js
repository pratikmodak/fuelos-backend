// routes/fuel-prices.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/fuel-prices — all rates + 30-day history
router.get('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const r = await db.query(
      `SELECT fp.id, fp.owner_id, fp.pump_id, fp.petrol, fp.diesel, fp.cng,
              fp.effective_date, fp.set_by, p.name as pump_name, p.short_name as pump_short_name
       FROM fuel_prices fp
       JOIN pumps p ON p.id = fp.pump_id
       WHERE fp.owner_id=$1
       ORDER BY fp.effective_date DESC, fp.pump_id
       LIMIT 200`,
      [ownerId]
    );
    const all = r.rows.map(fp => ({
      id: fp.id, ownerId: String(fp.owner_id), owner_id: String(fp.owner_id),
      pumpId: fp.pump_id, pump_id: fp.pump_id,
      pumpName: fp.pump_short_name || fp.pump_name,
      petrol: parseFloat(fp.petrol || 0), diesel: parseFloat(fp.diesel || 0), cng: parseFloat(fp.cng || 0),
      effectiveDate: fp.effective_date, effective_date: fp.effective_date, date: fp.effective_date,
    }));
    const latestMap = {};
    all.forEach(fp => { if (!latestMap[fp.pump_id]) latestMap[fp.pump_id] = fp; });
    res.json({ latest: Object.values(latestMap), history: all });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/fuel-prices/today?pump_id=X
router.get('/today', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const r = await db.query(
      'SELECT * FROM fuel_prices WHERE owner_id=$1 AND pump_id=$2 ORDER BY effective_date DESC LIMIT 1',
      [ownerId, req.query.pump_id]
    );
    const fp = r.rows[0];
    res.json(fp
      ? { pumpId: fp.pump_id, petrol: parseFloat(fp.petrol||0), diesel: parseFloat(fp.diesel||0), cng: parseFloat(fp.cng||0), date: fp.effective_date }
      : { pumpId: req.query.pump_id, petrol: 0, diesel: 0, cng: 0 }
    );
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fuel-prices — set rates for one pump
router.post('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { pump_id, rates, effective_date } = req.body;
    const date   = effective_date || new Date().toISOString().slice(0, 10);
    const petrol = rates.Petrol || rates.petrol || 0;
    const diesel = rates.Diesel || rates.diesel || 0;
    const cng    = rates.CNG    || rates.cng    || 0;
    await db.query(
      `INSERT INTO fuel_prices (owner_id,pump_id,petrol,diesel,cng,effective_date,set_by)
       VALUES ($1,$2,$3,$4,$5,$6,'manual')
       ON CONFLICT (owner_id,pump_id,effective_date)
       DO UPDATE SET petrol=$3, diesel=$4, cng=$5, set_by='manual'`,
      [ownerId, pump_id, petrol, diesel, cng, date]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fuel-prices/all-pumps
router.post('/all-pumps', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { rates, effective_date } = req.body;
    const date   = effective_date || new Date().toISOString().slice(0, 10);
    const pumps  = await db.query('SELECT id FROM pumps WHERE owner_id=$1', [ownerId]);
    for (const p of pumps.rows) {
      await db.query(
        `INSERT INTO fuel_prices (owner_id,pump_id,petrol,diesel,cng,effective_date,set_by)
         VALUES ($1,$2,$3,$4,$5,$6,'manual')
         ON CONFLICT (owner_id,pump_id,effective_date)
         DO UPDATE SET petrol=$3, diesel=$4, cng=$5, set_by='manual'`,
        [ownerId, p.id, rates.Petrol||rates.petrol||0, rates.Diesel||rates.diesel||0, rates.CNG||rates.cng||0, date]
      );
    }
    res.json({ ok: true, pumps: pumps.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/fuel-prices/market?city=pune
// Reads from market_rates_cache — populated by scheduler at 12:01 AM IST
// Zero RapidAPI calls per request — all fetching done by scheduler
// ─────────────────────────────────────────────────────────────
router.get('/market', requireAuth, async (req, res) => {
  const city = (req.query.city || '').trim();
  if (!city) return res.status(400).json({ error: 'city parameter required' });

  const cityKey = city.toLowerCase().replace(/[^a-z ]/g, '').replace(/ +/g, '');
  const today   = new Date().toISOString().slice(0, 10);

  // 1. Read from DB cache (filled by midnight scheduler)
  try {
    const cached = await db.query(
      `SELECT petrol, diesel, cng, source, updated_at
       FROM market_rates_cache
       WHERE city=$1 AND fetch_date=$2 LIMIT 1`,
      [cityKey, today]
    );
    if (cached.rows.length > 0) {
      const r = cached.rows[0];
      return res.json({
        city, date: today,
        petrol: parseFloat(r.petrol),
        diesel: parseFloat(r.diesel),
        cng:    parseFloat(r.cng),
        source: r.source === 'rapidapi' ? 'RapidAPI (live)' : 'IOC/HPCL reference',
        note:   'Fetched at 12:01 AM IST — edit if your dealer rate differs',
        cached: true,
        updated_at: r.updated_at,
      });
    }
  } catch (e) {
    console.warn('[fuel/market] Cache read error:', e.message);
  }

  // 2. Cache miss — use static fallback + store so midnight scheduler covers it next run
  const FALLBACK = {
    pune:        { petrol: 103.44, diesel: 89.97, cng: 74.00 },
    mumbai:      { petrol: 103.44, diesel: 89.97, cng: 74.00 },
    nagpur:      { petrol: 103.97, diesel: 90.25, cng: 76.00 },
    nashik:      { petrol: 103.55, diesel: 90.05, cng: 75.00 },
    aurangabad:  { petrol: 104.10, diesel: 90.40, cng: 0      },
    delhi:       { petrol: 94.72,  diesel: 87.62, cng: 74.09  },
    noida:       { petrol: 94.67,  diesel: 87.76, cng: 79.32  },
    gurgaon:     { petrol: 95.19,  diesel: 88.06, cng: 76.59  },
    bangalore:   { petrol: 102.86, diesel: 88.94, cng: 0       },
    bengaluru:   { petrol: 102.86, diesel: 88.94, cng: 0       },
    chennai:     { petrol: 102.63, diesel: 94.24, cng: 0       },
    hyderabad:   { petrol: 107.41, diesel: 95.65, cng: 0       },
    ahmedabad:   { petrol: 96.63,  diesel: 92.38, cng: 86.00  },
    surat:       { petrol: 96.50,  diesel: 92.25, cng: 85.00  },
    kolkata:     { petrol: 103.94, diesel: 90.76, cng: 0       },
    jaipur:      { petrol: 104.88, diesel: 90.36, cng: 79.00  },
    lucknow:     { petrol: 94.65,  diesel: 87.76, cng: 79.32  },
    chandigarh:  { petrol: 94.24,  diesel: 82.70, cng: 0       },
    bhopal:      { petrol: 107.23, diesel: 92.27, cng: 0       },
    indore:      { petrol: 107.31, diesel: 92.35, cng: 0       },
    patna:       { petrol: 107.24, diesel: 94.04, cng: 0       },
    kochi:       { petrol: 107.66, diesel: 96.42, cng: 0       },
    guwahati:    { petrol: 96.01,  diesel: 83.94, cng: 0       },
    ranchi:      { petrol: 99.84,  diesel: 94.55, cng: 0       },
  };

  let prices = FALLBACK[cityKey];
  if (!prices) {
    const k = Object.keys(FALLBACK).find(k => cityKey.includes(k) || k.includes(cityKey));
    prices = k ? FALLBACK[k] : null;
  }
  if (!prices) {
    return res.status(404).json({
      error: `No data for "${city}"`,
      hint: 'Supported: pune, mumbai, delhi, bangalore, hyderabad, chennai, ahmedabad, kolkata, jaipur...',
    });
  }

  // Store fallback in cache so next midnight run knows to refresh this city
  try {
    await db.query(
      `INSERT INTO market_rates_cache (city, state, petrol, diesel, cng, fetch_date, source)
       VALUES ($1,$2,$3,$4,$5,$6,'static')
       ON CONFLICT (city, fetch_date) DO NOTHING`,
      [cityKey, req.query.state || '', prices.petrol, prices.diesel, prices.cng || 0, today]
    );
  } catch (_) {}

  res.json({
    city, date: today,
    petrol: prices.petrol, diesel: prices.diesel, cng: prices.cng || 0,
    source: 'IOC/HPCL reference',
    note:   'Reference rates — live prices fetch at 12:01 AM IST. Edit if your dealer rate differs.',
    cached: false,
  });
});

// GET /api/fuel-prices/fetch-log — last 30 days of scheduler runs (API health)
router.get('/fetch-log', requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT fetch_date, city, petrol, diesel, cng, source, status, error_msg, created_at
       FROM fetch_log
       ORDER BY created_at DESC
       LIMIT 100`
    );
    // Also get last successful API call time
    const last = await db.query(
      `SELECT MAX(created_at) as last_api, COUNT(*) FILTER (WHERE source='rapidapi') as api_count,
              COUNT(*) FILTER (WHERE source='static') as static_count,
              COUNT(*) FILTER (WHERE status='failed') as fail_count
       FROM fetch_log WHERE fetch_date >= NOW() - INTERVAL '30 days'`
    );
    res.json({
      logs:    r.rows,
      summary: last.rows[0],
      rapidapi_configured: !!process.env.RAPIDAPI_KEY,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;