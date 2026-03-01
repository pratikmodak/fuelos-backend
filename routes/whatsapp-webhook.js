// routes/whatsapp-webhook.js
// Meta WhatsApp Cloud API webhook — verification + incoming messages
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// Helper: get config from DB
const getCfg = async (key) => {
  try {
    const r = await db.query('SELECT value FROM app_config WHERE key=$1', [key]);
    return r.rows[0]?.value || process.env[key.toUpperCase()] || '';
  } catch { return ''; }
};

// ── GET /webhook/whatsapp
// Meta calls this to verify the webhook endpoint during setup
// Must respond with hub.challenge when hub.verify_token matches
router.get('/', async (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const savedToken = await getCfg('wa_verify_token');
  const verifyToken = savedToken || process.env.WA_VERIFY_TOKEN || 'fuelos_webhook_verify';

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[WhatsApp Webhook] ✓ Verified');
    return res.status(200).send(challenge);
  }
  console.warn('[WhatsApp Webhook] ✗ Verification failed — token mismatch');
  res.status(403).json({ error: 'Verification failed' });
});

// ── POST /webhook/whatsapp
// Meta sends incoming messages and status updates here
router.post('/', express.json(), async (req, res) => {
  try {
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account') {
      return res.sendStatus(404);
    }

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const val = change.value;

        // Incoming messages
        for (const msg of (val?.messages || [])) {
          console.log(`[WhatsApp] Message from ${msg.from}: ${msg.text?.body || '[media]'}`);
          // Store in notifications log
          try {
            await db.query(
              `INSERT INTO notifications (type, recipient, message, status, created_at)
               VALUES ('whatsapp_inbound', $1, $2, 'received', NOW())
               ON CONFLICT DO NOTHING`,
              [msg.from, msg.text?.body || '[media]']
            );
          } catch {}
        }

        // Delivery status updates
        for (const status of (val?.statuses || [])) {
          const s = status.status; // sent | delivered | read | failed
          try {
            await db.query(
              `UPDATE notifications SET status=$1, updated_at=NOW()
               WHERE meta_message_id=$2`,
              [s, status.id]
            ).catch(() => {});
          } catch {}
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('[WhatsApp Webhook] Error:', e.message);
    res.sendStatus(200); // always 200 to Meta or it retries
  }
});

module.exports = router;
