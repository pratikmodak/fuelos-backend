// FuelOS v3 — WhatsApp Webhook
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
    console.log('[WH] Verified');
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: 'Verification failed' });
});

// POST — Meta sends status updates and inbound messages here
router.post('/', express.json(), async (req, res) => {
  // Always respond 200 immediately — Meta retries if we don't
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account') return;

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const val = change.value || {};

        // ── Delivery / read status callbacks
        for (const st of (val.statuses || [])) {
          const metaId  = st.id;            // wamid.xxx — the message id Meta assigned
          const phone   = st.recipient_id;  // the phone we sent TO
          const s       = st.status;        // sent | delivered | read | failed
          console.log('[WH] status:', s, 'metaId:', metaId, 'phone:', phone);

          try {
            if (s === 'delivered') {
              // Try by meta_msg_id first, then by most recent msg to that phone
              let r = await db.query(
                `UPDATE wa_messages SET status='delivered', delivered_at=NOW() WHERE meta_msg_id=$1 RETURNING id`,
                [metaId]
              );
              if (r.rowCount === 0 && phone) {
                await db.query(
                  `UPDATE wa_messages SET status='delivered', delivered_at=NOW(), meta_msg_id=$1
                   WHERE id=(SELECT id FROM wa_messages WHERE to_phone=$2 ORDER BY created_at DESC LIMIT 1)`,
                  [metaId, phone]
                );
              }
            } else if (s === 'read') {
              let r = await db.query(
                `UPDATE wa_messages SET status='read', read_at=NOW() WHERE meta_msg_id=$1 RETURNING id`,
                [metaId]
              );
              if (r.rowCount === 0 && phone) {
                await db.query(
                  `UPDATE wa_messages SET status='read', read_at=NOW(), meta_msg_id=$1
                   WHERE id=(SELECT id FROM wa_messages WHERE to_phone=$2 ORDER BY created_at DESC LIMIT 1)`,
                  [metaId, phone]
                );
              }
            } else if (s === 'failed') {
              const errMsg = st.errors?.[0]?.message || 'Delivery failed';
              let r = await db.query(
                `UPDATE wa_messages SET status='failed', error_text=$1 WHERE meta_msg_id=$2 RETURNING id`,
                [errMsg, metaId]
              );
              if (r.rowCount === 0 && phone) {
                await db.query(
                  `UPDATE wa_messages SET status='failed', error_text=$1, meta_msg_id=$2
                   WHERE id=(SELECT id FROM wa_messages WHERE to_phone=$3 ORDER BY created_at DESC LIMIT 1)`,
                  [errMsg, metaId, phone]
                );
              }
            }
          } catch(e) { console.warn('[WH] status update error:', e.message); }
        }

        // ── Inbound replies from customers
        for (const msg of (val.messages || [])) {
          const fromPhone = msg.from;
          const replyText = msg.text?.body || '[media]';
          console.log('[WH] reply from', fromPhone, ':', replyText.slice(0, 80));
          try {
            await db.query(
              `UPDATE wa_messages SET reply_text=$1, reply_at=NOW()
               WHERE id=(SELECT id FROM wa_messages WHERE to_phone=$2 ORDER BY created_at DESC LIMIT 1)`,
              [replyText, fromPhone]
            );
          } catch(e) { console.warn('[WH] reply update error:', e.message); }
        }
      }
    }
  } catch (e) {
    console.error('[WH] Error:', e.message);
  }
});

module.exports = router;