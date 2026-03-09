// FuelOS v3 — WhatsApp Webhook — delivery status + reply logging
const express = require('express');
const router  = express.Router();
const db      = require('../db');

const getCfg = async (key) => {
  try { const r = await db.query('SELECT value FROM app_config WHERE key=$1',[key]); return r.rows[0]?.value || process.env[key.toUpperCase()] || ''; }
  catch { return ''; }
};

// GET — Meta webhook verification
router.get('/', async (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = (await getCfg('wa_verify_token')) || process.env.WA_VERIFY_TOKEN || 'fuelos_webhook_verify';
  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[WhatsApp Webhook] Verified');
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: 'Verification failed' });
});

// POST — incoming messages and status updates from Meta
router.post('/', express.json(), async (req, res) => {
  try {
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account') return res.sendStatus(404);

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const val = change.value;

        // Delivery / read status updates — update existing wa_messages row
        for (const status of (val?.statuses || [])) {
          const s = status.status; // sent | delivered | read | failed
          const metaId = status.id;
          const toPhone = status.recipient_id || null; // phone number that received
          try {
            // Match by meta_msg_id (exact), fallback to most recent sent msg to that phone
            const matchClause = metaId
              ? `(meta_msg_id=$1 OR (to_phone=$2 AND status='sent' AND id=(SELECT id FROM wa_messages WHERE to_phone=$2 AND (status='sent' OR status='skipped') ORDER BY created_at DESC LIMIT 1)))`
              : `to_phone=$2 AND id=(SELECT id FROM wa_messages WHERE to_phone=$2 ORDER BY created_at DESC LIMIT 1)`;
            const matchParams = metaId ? [metaId, toPhone] : [null, toPhone];

            if (s === 'delivered') {
              await db.query(
                `UPDATE wa_messages SET status='delivered', delivered_at=NOW(), meta_msg_id=COALESCE(meta_msg_id,$1) WHERE ${matchClause}`,
                [metaId, ...matchParams]
              );
            } else if (s === 'read') {
              await db.query(
                `UPDATE wa_messages SET status='read', read_at=NOW(), meta_msg_id=COALESCE(meta_msg_id,$1) WHERE ${matchClause}`,
                [metaId, ...matchParams]
              );
            } else if (s === 'failed') {
              const errMsg = status.errors?.[0]?.message || 'Delivery failed';
              await db.query(
                `UPDATE wa_messages SET status='failed', error_text=$3 WHERE ${matchClause}`,
                [...matchParams, errMsg]
              );
            }
            console.log('[WH] status', s, 'for meta_id:', metaId, 'phone:', toPhone);
          } catch(e) { console.warn('[WH] status update error:', e.message); }
        }

        // Incoming messages (customer replies) — store as reply on outbound row
        for (const msg of (val?.messages || [])) {
          const fromPhone = msg.from;
          const replyText = msg.text?.body || '[media/other]';
          console.log('[WhatsApp] Reply from', fromPhone, ':', replyText.slice(0,80));
          try {
            // Attach reply to the most recent outbound message to this phone
            await db.query(
              `UPDATE wa_messages SET reply_text=$1, reply_at=NOW()
               WHERE id = (
                 SELECT id FROM wa_messages
                 WHERE to_phone=$2
                 ORDER BY created_at DESC LIMIT 1
               )`,
              [replyText, fromPhone]
            );
          } catch(e) { console.warn('[WH] reply update error:', e.message); }
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('[WhatsApp Webhook] Error:', e.message);
    res.sendStatus(200); // always 200 to Meta
  }
});

module.exports = router;