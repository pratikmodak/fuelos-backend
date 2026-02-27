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
              fp.effective_date, p.name as pump_name, p.short_name as pump_short_name
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
      petrol: parseFloat(fp.petrol || 0),
      diesel: parseFloat(fp.diesel || 0),
      cng:    parseFloat(fp.cng    || 0),
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
      `INSERT INTO fuel_prices (owner_id,pump_id,petrol,diesel,cng,effective_date)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (owner_id,pump_id,effective_date)
       DO UPDATE SET petrol=$3, diesel=$4, cng=$5`,
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
    const date  = effective_date || new Date().toISOString().slice(0, 10);
    const pumps = await db.query('SELECT id FROM pumps WHERE owner_id=$1', [ownerId]);
    for (const p of pumps.rows) {
      await db.query(
        `INSERT INTO fuel_prices (owner_id,pump_id,petrol,diesel,cng,effective_date)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (owner_id,pump_id,effective_date)
         DO UPDATE SET petrol=$3, diesel=$4, cng=$5`,
        [ownerId, p.id, rates.Petrol||rates.petrol||0, rates.Diesel||rates.diesel||0, rates.CNG||rates.cng||0, date]
      );
    }
    res.json({ ok: true, pumps: pumps.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────
// Shared static fallback — all cities including smaller ones
// ─────────────────────────────────────────────────────────────
const STATIC_PRICES = {
  // Maharashtra
  pune:        { petrol: 103.44, diesel: 89.97, cng: 74.00 },
  mumbai:      { petrol: 103.44, diesel: 89.97, cng: 74.00 },
  nagpur:      { petrol: 103.97, diesel: 90.25, cng: 76.00 },
  nashik:      { petrol: 103.55, diesel: 90.05, cng: 75.00 },
  aurangabad:  { petrol: 104.10, diesel: 90.40, cng: 0 },
  akola:       { petrol: 104.22, diesel: 90.48, cng: 0 },
  amravati:    { petrol: 104.15, diesel: 90.43, cng: 0 },
  solapur:     { petrol: 103.80, diesel: 90.18, cng: 0 },
  kolhapur:    { petrol: 103.62, diesel: 90.08, cng: 0 },
  nanded:      { petrol: 104.30, diesel: 90.55, cng: 0 },
  sangli:      { petrol: 103.70, diesel: 90.12, cng: 0 },
  satara:      { petrol: 103.65, diesel: 90.10, cng: 0 },
  jalgaon:     { petrol: 103.90, diesel: 90.30, cng: 0 },
  latur:       { petrol: 104.35, diesel: 90.58, cng: 0 },
  dhule:       { petrol: 103.95, diesel: 90.32, cng: 0 },
  ahmednagar:  { petrol: 103.75, diesel: 90.15, cng: 0 },
  yavatmal:    { petrol: 104.18, diesel: 90.45, cng: 0 },
  nandurbar:   { petrol: 104.00, diesel: 90.35, cng: 0 },
  wardha:      { petrol: 104.05, diesel: 90.38, cng: 0 },
  washim:      { petrol: 104.20, diesel: 90.47, cng: 0 },
  bhandara:    { petrol: 104.10, diesel: 90.40, cng: 0 },
  gondia:      { petrol: 104.12, diesel: 90.42, cng: 0 },
  gadchiroli:  { petrol: 104.25, diesel: 90.50, cng: 0 },
  chandrapur:  { petrol: 104.08, diesel: 90.39, cng: 0 },
  osmanabad:   { petrol: 104.28, diesel: 90.52, cng: 0 },
  parbhani:    { petrol: 104.32, diesel: 90.56, cng: 0 },
  hingoli:     { petrol: 104.26, diesel: 90.51, cng: 0 },
  buldhana:    { petrol: 104.14, diesel: 90.44, cng: 0 },
  thane:       { petrol: 103.44, diesel: 89.97, cng: 74.00 },
  raigad:      { petrol: 103.50, diesel: 90.00, cng: 0 },
  ratnagiri:   { petrol: 103.68, diesel: 90.13, cng: 0 },
  sindhudurg:  { petrol: 103.72, diesel: 90.14, cng: 0 },
  // Delhi NCR
  delhi:       { petrol: 94.72,  diesel: 87.62, cng: 74.09 },
  noida:       { petrol: 94.67,  diesel: 87.76, cng: 79.32 },
  gurgaon:     { petrol: 95.19,  diesel: 88.06, cng: 76.59 },
  faridabad:   { petrol: 95.15,  diesel: 88.02, cng: 76.59 },
  ghaziabad:   { petrol: 94.67,  diesel: 87.76, cng: 79.32 },
  // Karnataka
  bangalore:   { petrol: 102.86, diesel: 88.94, cng: 0 },
  bengaluru:   { petrol: 102.86, diesel: 88.94, cng: 0 },
  mysore:      { petrol: 102.79, diesel: 88.84, cng: 0 },
  mysuru:      { petrol: 102.79, diesel: 88.84, cng: 0 },
  hubli:       { petrol: 102.90, diesel: 88.98, cng: 0 },
  mangalore:   { petrol: 102.95, diesel: 89.02, cng: 0 },
  // Tamil Nadu
  chennai:     { petrol: 102.63, diesel: 94.24, cng: 0 },
  coimbatore:  { petrol: 102.55, diesel: 94.16, cng: 0 },
  madurai:     { petrol: 102.58, diesel: 94.19, cng: 0 },
  salem:       { petrol: 102.52, diesel: 94.14, cng: 0 },
  // Telangana
  hyderabad:   { petrol: 107.41, diesel: 95.65, cng: 0 },
  warangal:    { petrol: 108.20, diesel: 96.20, cng: 0 },
  // Gujarat
  ahmedabad:   { petrol: 96.63,  diesel: 92.38, cng: 86.00 },
  surat:       { petrol: 96.50,  diesel: 92.25, cng: 85.00 },
  vadodara:    { petrol: 96.45,  diesel: 92.20, cng: 85.00 },
  rajkot:      { petrol: 96.60,  diesel: 92.35, cng: 85.00 },
  gandhinagar: { petrol: 96.55,  diesel: 92.30, cng: 86.00 },
  // Rajasthan
  jaipur:      { petrol: 104.88, diesel: 90.36, cng: 79.00 },
  jodhpur:     { petrol: 105.20, diesel: 90.60, cng: 0 },
  udaipur:     { petrol: 105.10, diesel: 90.52, cng: 0 },
  kota:        { petrol: 105.05, diesel: 90.48, cng: 0 },
  // UP
  lucknow:     { petrol: 94.65,  diesel: 87.76, cng: 79.32 },
  kanpur:      { petrol: 94.58,  diesel: 87.69, cng: 79.32 },
  agra:        { petrol: 94.52,  diesel: 87.63, cng: 79.32 },
  varanasi:    { petrol: 94.72,  diesel: 87.92, cng: 0 },
  allahabad:   { petrol: 94.68,  diesel: 87.88, cng: 0 },
  prayagraj:   { petrol: 94.68,  diesel: 87.88, cng: 0 },
  meerut:      { petrol: 94.60,  diesel: 87.72, cng: 79.32 },
  // Punjab
  chandigarh:  { petrol: 94.24,  diesel: 82.70, cng: 0 },
  ludhiana:    { petrol: 96.22,  diesel: 84.51, cng: 0 },
  amritsar:    { petrol: 96.22,  diesel: 84.51, cng: 0 },
  // West Bengal
  kolkata:     { petrol: 103.94, diesel: 90.76, cng: 0 },
  // MP
  bhopal:      { petrol: 107.23, diesel: 92.27, cng: 0 },
  indore:      { petrol: 107.31, diesel: 92.35, cng: 0 },
  jabalpur:    { petrol: 107.18, diesel: 92.22, cng: 0 },
  gwalior:     { petrol: 107.15, diesel: 92.20, cng: 0 },
  // Bihar
  patna:       { petrol: 107.24, diesel: 94.04, cng: 0 },
  // Odisha
  bhubaneswar: { petrol: 103.19, diesel: 94.76, cng: 0 },
  // Assam
  guwahati:    { petrol: 96.01,  diesel: 83.94, cng: 0 },
  // Kerala
  kochi:       { petrol: 107.66, diesel: 96.42, cng: 0 },
  thiruvananthapuram: { petrol: 107.71, diesel: 96.47, cng: 0 },
  kozhikode:   { petrol: 107.68, diesel: 96.44, cng: 0 },
  // Goa
  panaji:      { petrol: 95.10,  diesel: 88.55, cng: 0 },
  // Haryana
  ambala:      { petrol: 95.55,  diesel: 88.25, cng: 0 },
  // Jharkhand
  ranchi:      { petrol: 99.84,  diesel: 94.55, cng: 0 },
};

function lookupStatic(city) {
  const raw = city.toLowerCase().replace(/[^a-z ]/g, '').replace(/ +/g, '');
  let p = STATIC_PRICES[raw];
  if (!p) {
    const k = Object.keys(STATIC_PRICES).find(k => raw.includes(k) || k.includes(raw));
    p = k ? STATIC_PRICES[k] : null;
  }
  return p;
}

// ─────────────────────────────────────────────────────────────
// GET /api/fuel-prices/market?city=pune
// Reads from market_rates_cache (filled by midnight scheduler)
// Falls back to static if cache miss
// ─────────────────────────────────────────────────────────────
router.get('/market', requireAuth, async (req, res) => {
  const city = (req.query.city || '').trim();
  if (!city) return res.status(400).json({ error: 'city parameter required' });

  const cityKey = city.toLowerCase().replace(/[^a-z ]/g, '').replace(/ +/g, '');
  const today   = new Date().toISOString().slice(0, 10);

  // 1. Read from DB cache
  try {
    const cached = await db.query(
      `SELECT petrol, diesel, cng, source, updated_at
       FROM market_rates_cache WHERE city=$1 AND fetch_date=$2 LIMIT 1`,
      [cityKey, today]
    );
    if (cached.rows.length > 0) {
      const r = cached.rows[0];
      return res.json({
        city, date: today,
        petrol: parseFloat(r.petrol), diesel: parseFloat(r.diesel), cng: parseFloat(r.cng),
        source: r.source === 'rapidapi' ? 'RapidAPI (live)' : 'IOC/HPCL reference',
        note:   'Fetched at 12:01 AM IST — edit if your dealer rate differs',
        cached: true, updated_at: r.updated_at,
      });
    }
  } catch (e) {
    console.warn('[fuel/market] Cache read error:', e.message);
  }

  // 2. Static fallback
  const prices = lookupStatic(city);
  if (!prices) {
    return res.status(404).json({
      error: `No data for "${city}"`,
      hint: 'City not in reference table. Enter rates manually.',
    });
  }

  // Store in cache so midnight scheduler covers it
  try {
    await db.query(
      `INSERT INTO market_rates_cache (city, state, petrol, diesel, cng, fetch_date, source)
       VALUES ($1,$2,$3,$4,$5,$6,'static') ON CONFLICT (city, fetch_date) DO NOTHING`,
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

// GET /api/fuel-prices/fetch-log — scheduler run history (for integrations tab)
router.get('/fetch-log', requireAuth, async (req, res) => {
  try {
    // Try fetch_log table — gracefully return empty if table doesn't exist yet
    const r = await db.query(
      `SELECT fetch_date, city, petrol, diesel, cng, source, status, error_msg, created_at
       FROM fetch_log ORDER BY created_at DESC LIMIT 100`
    ).catch(() => ({ rows: [] }));

    const last = await db.query(
      `SELECT MAX(created_at) as last_api,
              COUNT(*) FILTER (WHERE source='rapidapi') as api_count,
              COUNT(*) FILTER (WHERE source='static')   as static_count,
              COUNT(*) FILTER (WHERE status='failed')   as fail_count
       FROM fetch_log WHERE fetch_date >= NOW() - INTERVAL '30 days'`
    ).catch(() => ({ rows: [{}] }));

    res.json({
      logs:    r.rows,
      summary: last.rows[0] || {},
      rapidapi_configured: !!process.env.RAPIDAPI_KEY,
    });
  } catch (e) {
    res.json({ logs: [], summary: {}, rapidapi_configured: !!process.env.RAPIDAPI_KEY });
  }
});

module.exports = router;