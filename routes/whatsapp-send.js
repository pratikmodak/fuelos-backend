// FuelOS v3 — WhatsApp Send Route — logs every message to wa_messages
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../db');

const WA_TOKEN    = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;

const ensureWaTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_messages (
      id            TEXT PRIMARY KEY,
      owner_id      TEXT,
      sender_id     TEXT,
      sender_role   TEXT,
      sender_name   TEXT,
      to_phone      TEXT,
      customer_name TEXT,
      message       TEXT,
      category      TEXT DEFAULT 'other',
      status        TEXT DEFAULT 'sent',
      meta_msg_id   TEXT,
      error_text    TEXT,
      reply_text    TEXT,
      reply_at      TIMESTAMPTZ,
      delivered_at  TIMESTAMPTZ,
      read_at       TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_wa_msg_owner ON wa_messages(owner_id, created_at DESC)`).catch(()=>{});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_wa_msg_meta  ON wa_messages(meta_msg_id)`).catch(()=>{});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_wa_msg_phone ON wa_messages(to_phone)`).catch(()=>{});
};

const detectCategory = (msg) => {
  if (!msg) return 'other';
  if (msg.includes('Credit Purchase Alert') || msg.includes('Credit purchase')) return 'credit_purchase';
  if (msg.includes('Payment Received')      || msg.includes('Collected'))       return 'credit_collect';
  if (msg.includes('Shift Confirmed')       || msg.includes('shift confirmed')) return 'shift_confirm';
  if (msg.includes('Shift Submitted')       || msg.includes('shift submitted')) return 'shift';
  if (msg.includes('Low Stock')             || msg.includes('low stock'))       return 'alert';
  if (msg.includes('Payment'))                                                   return 'payment';
  return 'other';
};

const nanoid = () => 'wa_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);

router.post('/send', requireAuth, async (req, res) => {
  const { to, message, customerName } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });

  await ensureWaTable().catch(() => {});

  const logId      = nanoid();
  const senderRole = req.user.role || 'unknown';
  const senderName = req.user.name || req.user.email || req.user.id;
  const ownerId    = req.user.owner_id || (senderRole === 'owner' ? req.user.id : null);
  const category   = detectCategory(message);
  const base       = [logId, ownerId, req.user.id, senderRole, senderName, to, customerName||null, message, category];

  if (!WA_TOKEN || !WA_PHONE_ID) {
    await db.query(
      `INSERT INTO wa_messages (id,owner_id,sender_id,sender_role,sender_name,to_phone,customer_name,message,category,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'skipped')`,
      base
    ).catch(()=>{});
    return res.json({ ok:true, skipped:true, reason:'WA_TOKEN / WA_PHONE_ID not configured' });
  }

  try {
    const r = await fetch('https://graph.facebook.com/v19.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+WA_TOKEN },
      body: JSON.stringify({ messaging_product:'whatsapp', to, type:'text', text:{ body:message } }),
    });
    const data = await r.json();

    if (!r.ok) {
      const errText = (data?.error?.message) || 'Meta API error';
      await db.query(
        `INSERT INTO wa_messages (id,owner_id,sender_id,sender_role,sender_name,to_phone,customer_name,message,category,status,error_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'failed',$10)`,
        [...base, errText]
      ).catch(()=>{});
      return res.status(502).json({ error: errText });
    }

    const metaMsgId = data?.messages?.[0]?.id || null;
    await db.query(
      `INSERT INTO wa_messages (id,owner_id,sender_id,sender_role,sender_name,to_phone,customer_name,message,category,status,meta_msg_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sent',$10)`,
      [...base, metaMsgId]
    ).catch(()=>{});

    res.json({ ok:true, meta:data });
  } catch (e) {
    await db.query(
      `INSERT INTO wa_messages (id,owner_id,sender_id,sender_role,sender_name,to_phone,customer_name,message,category,status,error_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'failed',$10)`,
      [...base, e.message]
    ).catch(()=>{});
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;