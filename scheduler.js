// ═══════════════════════════════════════════════════════════
// FuelOS — Daily Fuel Price Scheduler
// Runs at 12:01 AM IST (18:31 UTC) every day
// 1. Fetches live prices from RapidAPI for all owner cities
// 2. Stores in market_rates_cache
// 3. Compares vs each owner's locked prices
// 4. Creates owner_notifications if price changed
// ═══════════════════════════════════════════════════════════

const db = require('./db');
const { waMessages, resolveLang } = require('./wa-messages');

// IST = UTC+5:30 → 12:01 AM IST = 18:31 UTC
const SCHEDULE_HOUR_UTC   = 18;
const SCHEDULE_MINUTE_UTC = 31;

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

const RAPID_HOSTS = [
  {
    buildUrl: (city, state) =>
      `https://daily-petrol-diesel-lpg-cng-fuel-prices-in-india.p.rapidapi.com/v1/fuel-prices/india/${state}/${city}`,
    host: 'daily-petrol-diesel-lpg-cng-fuel-prices-in-india.p.rapidapi.com',
    parse: (d) => ({
      petrol: parseFloat(d?.data?.petrol?.retailPrice || d?.petrol || 0),
      diesel: parseFloat(d?.data?.diesel?.retailPrice || d?.diesel || 0),
      cng:    parseFloat(d?.data?.cng?.retailPrice    || d?.cng    || 0),
    }),
  },
  {
    buildUrl: (city, state) =>
      `https://daily-fuel-prices-india.p.rapidapi.com/${state}/${city}`,
    host: 'daily-fuel-prices-india.p.rapidapi.com',
    parse: (d) => ({
      petrol: parseFloat(d?.petrol || d?.Petrol || 0),
      diesel: parseFloat(d?.diesel || d?.Diesel || 0),
      cng:    parseFloat(d?.cng    || d?.CNG    || 0),
    }),
  },
  {
    buildUrl: (city) =>
      `https://fuel-price-api-india-diesel-petrol-price-api-free.p.rapidapi.com/price?city=${encodeURIComponent(city)}`,
    host: 'fuel-price-api-india-diesel-petrol-price-api-free.p.rapidapi.com',
    parse: (d) => {
      const arr = Array.isArray(d) ? d : (d?.data || []);
      const p  = arr.find(x => /petrol/i.test(x.productName || x.fuel_type || ''));
      const di = arr.find(x => /diesel/i.test(x.productName || x.fuel_type || ''));
      const cn = arr.find(x => /cng/i.test(x.productName    || x.fuel_type || ''));
      return {
        petrol: parseFloat(p?.productPrice  || p?.price  || 0),
        diesel: parseFloat(di?.productPrice || di?.price || 0),
        cng:    parseFloat(cn?.productPrice || cn?.price || 0),
      };
    },
  },
];

const STATIC_PRICES = {
  pune: {petrol:103.44,diesel:89.97,cng:74.00}, mumbai: {petrol:103.44,diesel:89.97,cng:74.00},
  nagpur: {petrol:103.97,diesel:90.25,cng:76.00}, nashik: {petrol:103.55,diesel:90.05,cng:75.00},
  aurangabad: {petrol:104.10,diesel:90.40,cng:0}, akola: {petrol:104.22,diesel:90.48,cng:0},
  amravati: {petrol:104.15,diesel:90.43,cng:0}, solapur: {petrol:103.80,diesel:90.18,cng:0},
  kolhapur: {petrol:103.62,diesel:90.08,cng:0}, nanded: {petrol:104.30,diesel:90.55,cng:0},
  jalgaon: {petrol:103.90,diesel:90.30,cng:0}, latur: {petrol:104.35,diesel:90.58,cng:0},
  ahmednagar: {petrol:103.75,diesel:90.15,cng:0}, yavatmal: {petrol:104.18,diesel:90.45,cng:0},
  wardha: {petrol:104.05,diesel:90.38,cng:0}, buldhana: {petrol:104.14,diesel:90.44,cng:0},
  thane: {petrol:103.44,diesel:89.97,cng:74.00}, washim: {petrol:104.20,diesel:90.47,cng:0},
  delhi: {petrol:94.72,diesel:87.62,cng:74.09}, noida: {petrol:94.67,diesel:87.76,cng:79.32},
  gurgaon: {petrol:95.19,diesel:88.06,cng:76.59}, faridabad: {petrol:95.15,diesel:88.02,cng:76.59},
  bangalore: {petrol:102.86,diesel:88.94,cng:0}, bengaluru: {petrol:102.86,diesel:88.94,cng:0},
  mysore: {petrol:102.79,diesel:88.84,cng:0}, hubli: {petrol:102.90,diesel:88.98,cng:0},
  chennai: {petrol:102.63,diesel:94.24,cng:0}, coimbatore: {petrol:102.55,diesel:94.16,cng:0},
  hyderabad: {petrol:107.41,diesel:95.65,cng:0}, warangal: {petrol:108.20,diesel:96.20,cng:0},
  ahmedabad: {petrol:96.63,diesel:92.38,cng:86.00}, surat: {petrol:96.50,diesel:92.25,cng:85.00},
  vadodara: {petrol:96.45,diesel:92.20,cng:85.00}, rajkot: {petrol:96.60,diesel:92.35,cng:85.00},
  jaipur: {petrol:104.88,diesel:90.36,cng:79.00}, jodhpur: {petrol:105.20,diesel:90.60,cng:0},
  lucknow: {petrol:94.65,diesel:87.76,cng:79.32}, kanpur: {petrol:94.58,diesel:87.69,cng:79.32},
  agra: {petrol:94.52,diesel:87.63,cng:79.32}, varanasi: {petrol:94.72,diesel:87.92,cng:0},
  chandigarh: {petrol:94.24,diesel:82.70,cng:0}, ludhiana: {petrol:96.22,diesel:84.51,cng:0},
  kolkata: {petrol:103.94,diesel:90.76,cng:0}, bhopal: {petrol:107.23,diesel:92.27,cng:0},
  indore: {petrol:107.31,diesel:92.35,cng:0}, patna: {petrol:107.24,diesel:94.04,cng:0},
  bhubaneswar: {petrol:103.19,diesel:94.76,cng:0}, guwahati: {petrol:96.01,diesel:83.94,cng:0},
  kochi: {petrol:107.66,diesel:96.42,cng:0}, panaji: {petrol:95.10,diesel:88.55,cng:0},
  ranchi: {petrol:99.84,diesel:94.55,cng:0},
};

async function fetchCityPrice(city, state) {
  if (!RAPIDAPI_KEY) return null;
  const citySlug  = city.toLowerCase().replace(/\s+/g, '-');
  const stateSlug = (state || 'maharashtra').toLowerCase().replace(/\s+/g, '-');
  for (const host of RAPID_HOSTS) {
    try {
      const resp = await fetch(host.buildUrl(citySlug, stateSlug), {
        headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': host.host },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) continue;
      const prices = host.parse(await resp.json());
      if (prices.petrol > 0 || prices.diesel > 0) return { ...prices, source: 'rapidapi' };
    } catch (_) {}
  }
  return null;
}

function getStaticPrice(city) {
  const raw = city.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, '');
  let p = STATIC_PRICES[raw];
  if (!p) {
    const k = Object.keys(STATIC_PRICES).find(k => raw.includes(k) || k.includes(raw));
    p = k ? STATIC_PRICES[k] : null;
  }
  return p ? { ...p, source: 'static' } : null;
}

// ── Compare market price vs locked price, create notification if changed ──
async function checkPriceLocks(cityKey, newPrices, date) {
  try {
    // Find all owners in this city who have price locks
    const owners = await db.query(
      `SELECT o.id as owner_id, o.name as owner_name,
              pl.pump_id, pl.petrol as locked_petrol, pl.diesel as locked_diesel, pl.cng as locked_cng,
              p.name as pump_name, p.short_name as pump_short_name
       FROM owners o
       JOIN price_locks pl ON pl.owner_id = o.id
       JOIN pumps p ON p.id = pl.pump_id
       WHERE LOWER(TRIM(o.city)) = $1`,
      [cityKey]
    );

    for (const row of owners.rows) {
      const changes = [];
      const diff = (locked, market, fuel) => {
        if (!locked || !market) return;
        const delta = parseFloat((market - locked).toFixed(2));
        const pct   = ((Math.abs(delta) / locked) * 100).toFixed(1);
        if (Math.abs(delta) >= 0.01) {
          changes.push({
            fuel,
            locked:  parseFloat(locked),
            market:  parseFloat(market),
            delta,
            pct:     parseFloat(pct),
            up:      delta > 0,
          });
        }
      };

      if (newPrices.petrol > 0) diff(row.locked_petrol, newPrices.petrol, 'Petrol');
      if (newPrices.diesel > 0) diff(row.locked_diesel, newPrices.diesel, 'Diesel');
      if (newPrices.cng    > 0) diff(row.locked_cng,    newPrices.cng,    'CNG');

      if (!changes.length) continue;

      const pumpName = row.pump_short_name || row.pump_name;
      const changeLines = changes.map(c =>
        `${c.fuel}: ₹${c.locked} → ₹${c.market} (${c.up ? '+' : ''}${c.delta})`
      ).join(', ');

      const title = `⛽ Market price changed for ${pumpName}`;
      const body  = `${changeLines}. Your locked rates differ from today's market. Tap to review and update.`;

      // Avoid duplicate notifications for same day
      const existing = await db.query(
        `SELECT id FROM owner_notifications
         WHERE owner_id=$1 AND type='price_change'
           AND DATE(created_at)=$2 AND data->>'pump_id'=$3`,
        [row.owner_id, date, row.pump_id]
      );
      if (existing.rows.length > 0) continue;

      await db.query(
        `INSERT INTO owner_notifications (owner_id, type, title, body, data)
         VALUES ($1, 'price_change', $2, $3, $4)`,
        [
          row.owner_id,
          title,
          body,
          JSON.stringify({
            pump_id:   row.pump_id,
            pump_name: pumpName,
            date,
            changes,
            market:    newPrices,
          }),
        ]
      );

      console.log(`[Scheduler] 🔔 Notification sent to owner ${row.owner_id} for ${pumpName}: ${changeLines}`);
    }
  } catch (e) {
    console.error('[Scheduler] checkPriceLocks error:', e.message);
  }
}

// ── Main daily fetch job ──
async function runDailyFetch() {
  const date = new Date().toISOString().slice(0, 10);
  console.log(`[Scheduler] ─── Daily fuel price fetch: ${date} ───`);

  try {
    const result = await db.query(
      `SELECT DISTINCT LOWER(TRIM(city)) as city, LOWER(TRIM(state)) as state
       FROM owners WHERE city IS NOT NULL AND city != ''`
    );
    const cities = result.rows;
    if (!cities.length) { console.log('[Scheduler] No owner cities — skipping'); return; }

    console.log(`[Scheduler] Cities to fetch: ${cities.map(c => c.city).join(', ')}`);

    for (const { city, state } of cities) {
      try {
        let prices = await fetchCityPrice(city, state);
        if (!prices) prices = getStaticPrice(city);
        if (!prices) { console.warn(`[Scheduler] No data for: ${city}`); continue; }

        await db.query(
          `INSERT INTO market_rates_cache (city, state, petrol, diesel, cng, fetch_date, source, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT (city, fetch_date)
           DO UPDATE SET petrol=$3, diesel=$4, cng=$5, source=$7, updated_at=NOW()`,
          [city, state||'', prices.petrol||0, prices.diesel||0, prices.cng||0, date, prices.source]
        );

        console.log(`[Scheduler] ✓ ${city}: ₹${prices.petrol} petrol / ₹${prices.diesel} diesel (${prices.source})`);

        // Check price locks and notify owners if market changed
        await checkPriceLocks(city, prices, date);
      } catch (e) {
        console.error(`[Scheduler] ✗ ${city}:`, e.message);
      }
    }
    console.log('[Scheduler] ─── Done ───');
    await runGraceJob();
  } catch (e) {
    console.error('[Scheduler] Fatal:', e.message);
  }
}

// ── Schedule at 12:01 AM IST = 18:31 UTC ──
function scheduleDaily() {
  function msUntilNext() {
    const now  = new Date();
    const next = new Date(now);
    next.setUTCHours(SCHEDULE_HOUR_UTC, SCHEDULE_MINUTE_UTC, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }
  function go() {
    const ms  = msUntilNext();
    const hrs = Math.floor(ms / 3600000);
    const min = Math.floor((ms % 3600000) / 60000);
    console.log(`[Scheduler] Next fetch in ${hrs}h ${min}m (12:01 AM IST)`);
    setTimeout(async () => { await runDailyFetch(); go(); }, ms);
  }
  go();
}


// ═══════════════════════════════════════════════════════════
// GRACE PERIOD JOB — runs daily at 12:01 AM IST
// Auto-grants 1-month grace on expiry, sends WA at day 5/15/25,
// deactivates if grace_until also passed and not renewed
// ═══════════════════════════════════════════════════════════

async function sendGraceWA(owner, daysLeftInGrace) {
  const WA_TOKEN    = process.env.WA_TOKEN;
  const WA_PHONE_ID = process.env.WA_PHONE_ID;
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.log('[Grace] WA credentials missing — skipping for', owner.name);
    return;
  }
    const raw   = (owner.whatsapp_num || owner.phone || '').replace(/\D/g, '');
  if (!raw)   { console.log('[Grace] No phone for', owner.name); return; }
  const to    = raw.startsWith('91') ? raw : '91' + raw;
  const lang  = resolveLang(owner, 'en');
  const body  = waMessages.graceAlert(owner, daysLeftInGrace, lang);

  try {
    const r = await fetch('https://graph.facebook.com/v19.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + WA_TOKEN },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    const d = await r.json();
    if (r.ok) {
      console.log('[Grace WA] ✓ Sent to', owner.name, '(', to, ') —', daysLeftInGrace, 'days left');
      // Log to wa_messages table
      const logId = 'grace_' + String(owner.id) + '_d' + daysLeftInGrace + '_' + Date.now();
      await db.query(
        `INSERT INTO wa_messages (id,owner_id,sender_id,sender_role,sender_name,to_phone,customer_name,message,category,status,meta_msg_id)
         VALUES ($1,$2,'system','system','FuelOS Scheduler',$3,$4,$5,'renewal','sent',$6) ON CONFLICT DO NOTHING`,
        [logId, String(owner.id), to, owner.name, body, d?.messages?.[0]?.id || null]
      ).catch(() => {});
    } else {
      console.warn('[Grace WA] ✗ Failed for', owner.name, ':', d?.error?.message);
    }
  } catch(e) {
    console.warn('[Grace WA] Error for', owner.name, ':', e.message);
  }
}

async function runGraceJob() {
  console.log('[Grace] ── Starting grace period check ──');
  try {
    // STEP 1: Auto-grant 1-month grace to owners whose subscription just expired
    const justExpired = await db.query(`
      SELECT * FROM owners
      WHERE status = 'Active'
        AND end_date IS NOT NULL
        AND end_date < CURRENT_DATE
        AND (grace_until IS NULL OR grace_until < end_date)
    `).catch(() => ({ rows: [] }));

    for (const o of justExpired.rows) {
      const base  = new Date(o.end_date);
      const grace = new Date(base);
      grace.setMonth(grace.getMonth() + 1);
      const graceStr = grace.toISOString().slice(0, 10);
      await db.query(
        `UPDATE owners
         SET grace_until=$1, grace_granted_at=NOW(), grace_granted_by='auto-scheduler',
             grace_wa_day5=FALSE, grace_wa_day15=FALSE, grace_wa_day25=FALSE, updated_at=NOW()
         WHERE id=$2`,
        [graceStr, o.id]
      );
      console.log('[Grace] ✓ Granted grace to', o.name, '— until', graceStr);
    }

    // STEP 2: Send WA reminders for owners currently in grace period
    const inGrace = await db.query(`
      SELECT * FROM owners
      WHERE status = 'Active'
        AND end_date IS NOT NULL
        AND end_date < CURRENT_DATE
        AND grace_until IS NOT NULL
        AND grace_until >= CURRENT_DATE
    `).catch(() => ({ rows: [] }));

    for (const o of inGrace.rows) {
      const graceEnd   = new Date(o.grace_until);
      const today      = new Date();
      const daysLeft   = Math.ceil((graceEnd - today) / 86400000);
      const grantedAt  = o.grace_granted_at ? new Date(o.grace_granted_at) : new Date(o.end_date);
      const daysSince  = Math.floor((today - grantedAt) / 86400000);

      if      (daysSince >= 5  && daysSince < 9  && !o.grace_wa_day5) {
        await sendGraceWA(o, daysLeft);
        await db.query(`UPDATE owners SET grace_wa_day5=TRUE  WHERE id=$1`, [o.id]);
      }
      else if (daysSince >= 15 && daysSince < 19 && !o.grace_wa_day15) {
        await sendGraceWA(o, daysLeft);
        await db.query(`UPDATE owners SET grace_wa_day15=TRUE WHERE id=$1`, [o.id]);
      }
      else if (daysSince >= 25 && daysSince < 29 && !o.grace_wa_day25) {
        await sendGraceWA(o, daysLeft);
        await db.query(`UPDATE owners SET grace_wa_day25=TRUE WHERE id=$1`, [o.id]);
      }
    }

    // STEP 3: Deactivate owners whose grace period has expired without renewal
    const graceExpired = await db.query(`
      SELECT * FROM owners
      WHERE status = 'Active'
        AND grace_until IS NOT NULL
        AND grace_until < CURRENT_DATE
    `).catch(() => ({ rows: [] }));

    for (const o of graceExpired.rows) {
      await db.query(
        `UPDATE owners SET status='Suspended', updated_at=NOW() WHERE id=$1`,
        [o.id]
      );
      await db.query(
        `INSERT INTO audit_log (user_email, role, action) VALUES ('system','system',$1)`,
        [`Auto-suspended: grace expired for ${o.name} (${o.email}) grace_until=${o.grace_until}`]
      ).catch(() => {});
      console.log('[Grace] ✗ Suspended', o.name, '— grace expired on', o.grace_until);
    }

    console.log('[Grace] Done —',
      justExpired.rows.length, 'grace granted |',
      inGrace.rows.length, 'in grace |',
      graceExpired.rows.length, 'suspended'
    );
  } catch(e) {
    console.error('[Grace] Fatal:', e.message);
  }
}

module.exports = { scheduleDaily, runDailyFetch, runGraceJob, STATIC_PRICES };