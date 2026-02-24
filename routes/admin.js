import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware, requireRole('admin', 'superadmin'));

router.get('/config', async (req, res) => {
  try {
    const rows = await db.all('SELECT key, value FROM integration_config');
    const cfg = Object.fromEntries(rows.map(r => {
      const isSecret = r.key.includes('secret') || r.key.includes('token') || r.key.includes('pass');
      return [r.key, isSecret && r.value ? '••••••••' : r.value];
    }));
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/config', async (req, res) => {
  try {
    const allowed = ['rzp_mode','rzp_live_key_id','rzp_live_key_secret','rzp_test_key_id','rzp_test_key_secret',
      'rzp_webhook_secret','rzp_currency','rzp_auto_capture','rzp_send_receipt',
      'wa_provider','wa_api_key','wa_phone_number_id','wa_waba_id','wa_twilio_account_sid',
      'wa_twilio_auth_token','wa_twilio_from','wa_namespace','wa_number',
      'wa_tpl_payment','wa_tpl_shift','wa_tpl_alert','wa_tpl_test',
      'email_provider','email_host','email_port','email_user','email_pass','email_from','email_secure',
      'sms_provider','sms_api_key','sms_sender_id','sms_dlt_id'];
    for (const [key, value] of Object.entries(req.body)) {
      if (allowed.includes(key) && value !== '••••••••') {
        await db.run(`INSERT INTO integration_config(key,value,updated_at) VALUES(?,?,datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, [key, value]);
      }
    }
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), 'admin@fuelos.in', 'Admin', 'Integration config updated', req.ip]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/owners', async (req, res) => {
  try {
    const owners = await db.all('SELECT * FROM owners ORDER BY created_at DESC');
    const enriched = await Promise.all(owners.map(async o => {
      const txns   = await db.all('SELECT * FROM transactions WHERE owner_id=?', [o.id]);
      const waMsgs = await db.all('SELECT * FROM wa_log WHERE owner_id=?', [o.id]);
      const pumps  = await db.all('SELECT id FROM pumps WHERE owner_id=?', [o.id]);
      return { ...o, password_hash: undefined, pumps: pumps.length, transactions: txns,
        paidAmt: txns.filter(t=>t.status==='Success').reduce((s,t)=>s+t.amount,0),
        failedPayments: txns.filter(t=>t.status==='Failed').length,
        waSent: waMsgs.filter(w=>w.status==='Delivered').length,
        waFailed: waMsgs.filter(w=>w.status==='Failed').length, waTotal: waMsgs.length };
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/owners/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { plan, status, extendDays } = req.body;
    if (plan) {
      const endDate = new Date(Date.now()+30*86400000).toISOString().slice(0,10);
      await db.run(`UPDATE owners SET plan=?, status='Active', start_date=date('now'), end_date=?, days_used=0, updated_at=datetime('now') WHERE id=?`, [plan, endDate, id]);
      await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
        [uuid(), 'admin@fuelos.in', 'Admin', `Admin force-changed plan → ${plan}`, req.ip]);
    }
    if (status) await db.run(`UPDATE owners SET status=?, updated_at=datetime('now') WHERE id=?`, [status, id]);
    if (extendDays) await db.run(`UPDATE owners SET end_date=date(end_date,'+'||?||' days'), updated_at=datetime('now') WHERE id=?`, [extendDays, id]);
    res.json(await db.get('SELECT * FROM owners WHERE id=?', [id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const owners  = await db.all('SELECT * FROM owners');
    const txns    = await db.all('SELECT * FROM transactions');
    const pumps   = await db.all('SELECT * FROM pumps');
    const waStats = await db.all(`SELECT owner_id, COUNT(*) AS total_messages,
      SUM(CASE WHEN status='Delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status='Failed' THEN 1 ELSE 0 END) AS failed FROM wa_log GROUP BY owner_id`);
    const mrr = owners.filter(o=>o.status==='Active')
      .reduce((s,o)=>s+({Starter:799,Pro:2499,Enterprise:5999}[o.plan]||0), 0);
    res.json({
      owners: owners.length, active: owners.filter(o=>o.status==='Active').length,
      pumps: pumps.length, mrr,
      txnOk: txns.filter(t=>t.status==='Success').length,
      txnFailed: txns.filter(t=>t.status==='Failed').length,
      waStats, planDistribution: {
        Starter: owners.filter(o=>o.plan==='Starter').length,
        Pro: owners.filter(o=>o.plan==='Pro').length,
        Enterprise: owners.filter(o=>o.plan==='Enterprise').length,
      },
      services: [
        {name:'Database',status:'Online',latency:2,uptime:99.99},
        {name:'Auth API',status:'Online',latency:18,uptime:99.99},
        {name:'Razorpay Gateway',status:'Online',latency:112,uptime:99.97},
        {name:'WhatsApp',status:'Online',latency:340,uptime:98.20},
      ]
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/transactions', async (req, res) => {
  try {
    res.json(await db.all(`SELECT t.*, o.name as owner_name, o.email as owner_email
      FROM transactions t LEFT JOIN owners o ON t.owner_id=o.id ORDER BY t.created_at DESC`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/transactions/:id/retry', async (req, res) => {
  try {
    const txn = await db.get('SELECT * FROM transactions WHERE id=?', [req.params.id]);
    if (!txn) return res.status(404).json({ error: 'Not found' });
    const endDate = txn.billing === 'yearly'
      ? new Date(Date.now()+365*86400000).toISOString().slice(0,10)
      : new Date(Date.now()+30*86400000).toISOString().slice(0,10);
    await db.tx(async () => {
      await db.run(`UPDATE transactions SET status='Success', plan_activated=1, updated_at=datetime('now') WHERE id=?`, [txn.id]);
      await db.run(`UPDATE owners SET plan=?, status='Active', start_date=date('now'), end_date=?, days_used=0, updated_at=datetime('now') WHERE id=?`,
        [txn.plan, endDate, txn.owner_id]);
      await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
        [uuid(), 'admin@fuelos.in', 'Admin', `Admin activated ${txn.plan} for txn ${txn.id}`, req.ip]);
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/audit', async (req, res) => {
  try {
    res.json(await db.all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;

// ── POST /api/admin/owners — create new owner account
router.post('/owners', async (req, res) => {
  try {
    const { name, email, phone, password, city, state, plan, gst } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!/[A-Z]/.test(password) && !/[0-9]/.test(password))
      return res.status(400).json({ error: 'Password is too weak — add uppercase letters or numbers' });
    const existing = await db.get('SELECT id FROM owners WHERE email=?', [email]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const id = 'O' + Date.now();
    const hash = bcrypt.hashSync(password, 10);
    const today = new Date().toISOString().split('T')[0];
    // Default 30-day trial on Starter plan
    const endDate = new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0];
    const chosenPlan = plan || 'Starter';
    await db.run(
      `INSERT INTO owners (id,name,email,password_hash,phone,city,state,gst,plan,billing,status,start_date,end_date,whatsapp,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [id, name, email, hash, phone||'', city||'', state||'', gst||'', chosenPlan, 'monthly', 'Active', today, endDate, 0]
    );
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), req.user?.email||'admin', 'Admin', `Created owner: ${email} (${chosenPlan})`, req.ip||'']);
    res.json({ success: true, id, email, plan: chosenPlan, endDate });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/admin/owners/:id — remove owner
router.delete('/owners/:id', async (req, res) => {
  try {
    await db.run('UPDATE owners SET status=? WHERE id=?', ['Deleted', req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
