// ═══════════════════════════════════════════════════════════
// FuelOS v3 — WhatsApp Send Route
// POST /api/whatsapp/send
// Sends a free-text message to a customer via Meta WhatsApp Business API
// ═══════════════════════════════════════════════════════════
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');

const WA_TOKEN    = process.env.WA_TOKEN;     // Meta permanent token
const WA_PHONE_ID = process.env.WA_PHONE_ID;  // Meta phone number ID

router.post('/send', requireAuth, async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message)
    return res.status(400).json({ error: 'to and message are required' });

  // If WA credentials not configured, log and return ok (silent skip)
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.log('[WA] Credentials not set — skipping. Would send to', to, ':', message.slice(0, 60));
    return res.json({ ok: true, skipped: true, reason: 'WA_TOKEN / WA_PHONE_ID not configured' });
  }

  try {
    const url = 'https://graph.facebook.com/v19.0/' + WA_PHONE_ID + '/messages';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + WA_TOKEN,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message },
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('[WA] Meta API error:', data);
      return res.status(502).json({ error: (data && data.error && data.error.message) || 'Meta API error' });
    }
    console.log('[WA] Sent to', to);
    res.json({ ok: true, meta: data });
  } catch (e) {
    console.error('[WA] send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;