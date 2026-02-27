// routes/fuel-prices.js
const router = require('express').Router();
const db = require('../db');
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
      id:            fp.id,
      ownerId:       String(fp.owner_id),
      owner_id:      String(fp.owner_id),
      pumpId:        fp.pump_id,
      pump_id:       fp.pump_id,
      pumpName:      fp.pump_short_name || fp.pump_name,
      petrol:        parseFloat(fp.petrol || 0),
      diesel:        parseFloat(fp.diesel || 0),
      cng:           parseFloat(fp.cng    || 0),
      effectiveDate: fp.effective_date,
      effective_date: fp.effective_date,
      date:          fp.effective_date,
    }));
    // Return shape frontend expects: { latest: [...], history: [...] }
    // latest = most recent entry per pump, history = all
    const latestMap = {};
    all.forEach(fp => { if (!latestMap[fp.pump_id]) latestMap[fp.pump_id] = fp; });
    res.json({ latest: Object.values(latestMap), history: all });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/fuel-prices/today?pump_id=X
router.get('/today', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { pump_id } = req.query;
    const r = await db.query(
      `SELECT * FROM fuel_prices WHERE owner_id=$1 AND pump_id=$2
       ORDER BY effective_date DESC LIMIT 1`,
      [ownerId, pump_id]
    );
    const fp = r.rows[0];
    res.json(fp ? {
      pumpId: fp.pump_id, petrol: parseFloat(fp.petrol||0),
      diesel: parseFloat(fp.diesel||0), cng: parseFloat(fp.cng||0),
      date: fp.effective_date,
    } : { pumpId: pump_id, petrol: 0, diesel: 0, cng: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fuel-prices — set rates for one pump
router.post('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { pump_id, rates, effective_date } = req.body;
    const date = effective_date || new Date().toISOString().slice(0,10);
    // Accept both capitalized (Petrol) and lowercase (petrol) keys from frontend
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

// POST /api/fuel-prices/all-pumps — set same rates for all pumps
router.post('/all-pumps', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { rates, effective_date } = req.body;
    const date = effective_date || new Date().toISOString().slice(0,10);
    const pumps = await db.query('SELECT id FROM pumps WHERE owner_id=$1', [ownerId]);
    for (const p of pumps.rows) {
      const petrol = rates.Petrol || rates.petrol || 0;
      const diesel = rates.Diesel || rates.diesel || 0;
      const cng    = rates.CNG    || rates.cng    || 0;
      await db.query(
        `INSERT INTO fuel_prices (owner_id,pump_id,petrol,diesel,cng,effective_date)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (owner_id,pump_id,effective_date)
         DO UPDATE SET petrol=$3, diesel=$4, cng=$5`,
        [ownerId, p.id, petrol, diesel, cng, date]
      );
    }
    res.json({ ok: true, pumps: pumps.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─────────────────────────────────────────────────────────────
// GET /api/fuel-prices/market?city=pune&state=maharashtra
// Fetches today's market price from mypetrolprice.com (free, no API key)
// Returns: { petrol, diesel, cng, city, date, source }
// ─────────────────────────────────────────────────────────────
router.get('/market', requireAuth, async (req, res) => {
  try {
    const city  = (req.query.city  || '').toLowerCase().trim().replace(/\s+/g, '-');
    const state = (req.query.state || '').toLowerCase().trim().replace(/\s+/g, '-');

    if (!city) return res.status(400).json({ error: 'city parameter required' });

    // Try mypetrolprice.com — free, no API key, city-level prices
    const url = `https://www.mypetrolprice.com/petrol-price-in-${city}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FuelOS/3.0)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);

    const html = await response.text();

    // Parse petrol price — pattern: ₹XX.XX or Rs.XX.XX
    const petrolMatch = html.match(/petrol[^₹]*₹\s*([\d]+\.[\d]+)/i) ||
                        html.match(/>([\d]{2,3}\.\d{2})<.*?petrol/i);
    const dieselMatch = html.match(/diesel[^₹]*₹\s*([\d]+\.[\d]+)/i) ||
                        html.match(/>([\d]{2,3}\.\d{2})<.*?diesel/i);
    const cngMatch    = html.match(/cng[^₹]*₹\s*([\d]+\.[\d]+)/i);

    const petrol = petrolMatch ? parseFloat(petrolMatch[1]) : null;
    const diesel = dieselMatch ? parseFloat(dieselMatch[1]) : null;
    const cng    = cngMatch    ? parseFloat(cngMatch[1])    : null;

    if (!petrol && !diesel) {
      return res.status(404).json({
        error: 'Could not parse prices for this city. Try a major city name.',
        hint: 'Examples: pune, mumbai, delhi, bangalore, hyderabad, chennai',
      });
    }

    res.json({
      city:   req.query.city,
      state:  req.query.state,
      date:   new Date().toISOString().slice(0, 10),
      petrol: petrol || 0,
      diesel: diesel || 0,
      cng:    cng    || 0,
      source: 'mypetrolprice.com',
    });
  } catch (e) {
    // If scraping fails, return error with manual fallback message
    console.error('[fuel-prices/market]', e.message);
    res.status(503).json({
      error: 'Live price fetch failed: ' + e.message,
      hint: 'Set rates manually or try again.',
    });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/fuel-prices/auto-set
// Fetches market price for owner's city and auto-saves to all pumps
// Body: { city, state, overwrite: true/false }
// ─────────────────────────────────────────────────────────────
router.post('/auto-set', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { city, state, overwrite = false } = req.body;

    if (!city) return res.status(400).json({ error: 'city required' });

    // Fetch market price
    const citySlug = city.toLowerCase().trim().replace(/\s+/g, '-');
    const url = `https://www.mypetrolprice.com/petrol-price-in-${citySlug}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FuelOS/3.0)' },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) throw new Error('Live price fetch failed');
    const html = await response.text();

    const petrolMatch = html.match(/petrol[^₹]*₹\s*([\d]+\.[\d]+)/i);
    const dieselMatch = html.match(/diesel[^₹]*₹\s*([\d]+\.[\d]+)/i);
    const cngMatch    = html.match(/cng[^₹]*₹\s*([\d]+\.[\d]+)/i);

    const petrol = petrolMatch ? parseFloat(petrolMatch[1]) : 0;
    const diesel = dieselMatch ? parseFloat(dieselMatch[1]) : 0;
    const cng    = cngMatch    ? parseFloat(cngMatch[1])    : 0;

    if (!petrol && !diesel) throw new Error(`Could not parse prices for "${city}"`);

    const date  = new Date().toISOString().slice(0, 10);
    const pumps = await db.query('SELECT id FROM pumps WHERE owner_id=$1', [ownerId]);

    let saved = 0;
    for (const p of pumps.rows) {
      // Check if today's price already set (skip if overwrite=false)
      if (!overwrite) {
        const existing = await db.query(
          'SELECT id FROM fuel_prices WHERE owner_id=$1 AND pump_id=$2 AND effective_date=$3',
          [ownerId, p.id, date]
        );
        if (existing.rows.length > 0) continue;
      }
      await db.query(
        `INSERT INTO fuel_prices (owner_id,pump_id,petrol,diesel,cng,effective_date)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (owner_id,pump_id,effective_date)
         DO UPDATE SET petrol=$3, diesel=$4, cng=$5`,
        [ownerId, p.id, petrol, diesel, cng, date]
      );
      saved++;
    }

    res.json({
      ok: true,
      petrol, diesel, cng,
      city, date,
      pumps_updated: saved,
      source: 'mypetrolprice.com',
    });
  } catch (e) {
    console.error('[fuel-prices/auto-set]', e.message);
    res.status(503).json({ error: e.message });
  }
});

module.exports = router;