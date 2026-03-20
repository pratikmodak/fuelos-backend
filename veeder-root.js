// ═══════════════════════════════════════════════════════════
// FuelOS — Veeder-Root TLS-4B Backend Route
// SECURITY:
//   - Verifies HMAC signature on every push
//   - Rejects replayed requests (timestamp check)
//   - Rate limited to 1 push per minute per owner
//   - Read-only dashboard endpoint (no write-back to device)
// ═══════════════════════════════════════════════════════════

import express from "express";
import crypto  from "crypto";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Rate limit: track last push time per owner
const lastPush = new Map();
const RATE_LIMIT_MS = 60 * 1000; // max 1 push per minute

// ── Verify HMAC signature from bridge script
function verifySignature(body, sig) {
  const secret = process.env.TLS4B_SECRET;
  if (!secret) return true; // skip if not configured (dev mode)
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(sig  || "", "hex"),
    Buffer.from(expected, "hex")
  );
}

// ── POST /api/veeder-root/sync  (called by local bridge script)
router.post("/sync", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const rawBody = req.body.toString();
    const sig     = req.headers["x-tls4b-sig"] || "";
    const ownerId = req.headers["x-tls4b-owner"] || "";

    // 1. Verify HMAC signature
    if (!verifySignature(rawBody, sig)) {
      console.warn("[TLS4B] Invalid signature from", ownerId);
      return res.status(401).json({ error: "Invalid signature" });
    }

    const { owner_id, pump_id, tanks, ts } = JSON.parse(rawBody);

    if (!owner_id || !pump_id || !Array.isArray(tanks)) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // 2. Replay attack prevention — reject if timestamp > 2 min old
    if (ts && Date.now() - ts > 2 * 60 * 1000) {
      return res.status(400).json({ error: "Request too old (replay protection)" });
    }

    // 3. Rate limiting — max 1 push per minute per owner
    const lastTime = lastPush.get(owner_id) || 0;
    if (Date.now() - lastTime < RATE_LIMIT_MS) {
      return res.status(429).json({ error: "Rate limited — max 1 push/minute" });
    }
    lastPush.set(owner_id, Date.now());

    // 4. Save readings
    const synced_at = new Date().toISOString();
    const rows = tanks.map(t => ({
      owner_id:  String(owner_id),
      pump_id:   String(pump_id),
      tank_no:   t.tank_no,
      fuel:      t.fuel || "Petrol",
      volume_l:  parseFloat(t.volume_l)  || 0,
      height_mm: parseFloat(t.height_mm) || 0,
      ullage_l:  parseFloat(t.ullage_l)  || 0,
      temp_c:    parseFloat(t.temp_c)    || 0,
      water_mm:  parseFloat(t.water_mm)  || 0,
      alarm:     t.alarm || null,
      synced_at,
    }));

    const { error } = await supabase
      .from("tls4b_readings")
      .upsert(rows, { onConflict: "owner_id,pump_id,tank_no" });

    if (error) throw error;

    console.log(`[TLS4B] ✓ ${owner_id} synced ${rows.length} tanks`);
    res.json({ ok: true, synced: rows.length, synced_at });

  } catch (e) {
    console.error("[TLS4B] sync error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/veeder-root/latest?owner_id=X&pump_id=Y  (dashboard read)
router.get("/latest", async (req, res) => {
  try {
    const { owner_id, pump_id } = req.query;
    if (!owner_id) return res.status(400).json({ error: "Missing owner_id" });

    let q = supabase
      .from("tls4b_readings")
      .select("*")
      .eq("owner_id", owner_id)
      .order("synced_at", { ascending: false })
      .limit(50);

    if (pump_id) q = q.eq("pump_id", pump_id);

    const { data, error } = await q;
    if (error) throw error;

    // Latest reading per tank
    const latest = {};
    (data || []).forEach(row => {
      const key = `${row.pump_id}_${row.tank_no}`;
      if (!latest[key]) latest[key] = row;
    });

    res.json({ tanks: Object.values(latest) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;