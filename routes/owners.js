import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

router.get('/me', async (req, res) => {
  try {
    const owner = await db.get('SELECT * FROM owners WHERE id=?', [req.user.id]);
    if (!owner) return res.status(404).json({ error: 'Not found' });
    const { password_hash, ...safe } = owner;
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/me', async (req, res) => {
  try {
    const { name, phone, city, state, address, gst, whatsapp, whatsapp_num } = req.body;
    await db.run(`UPDATE owners SET name=COALESCE(?,name), phone=COALESCE(?,phone),
      city=COALESCE(?,city), state=COALESCE(?,state), address=COALESCE(?,address),
      gst=COALESCE(?,gst), whatsapp=COALESCE(?,whatsapp), whatsapp_num=COALESCE(?,whatsapp_num),
      updated_at=datetime('now') WHERE id=?`,
      [name, phone, city, state, address, gst, whatsapp, whatsapp_num, req.user.id]);
    const updated = await db.get('SELECT * FROM owners WHERE id=?', [req.user.id]);
    const { password_hash, ...safe } = updated;
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;

// ── GET /api/owners/staff — fetch managers + operators for logged-in owner
router.get('/staff', async (req, res) => {
  try {
    const ownerId = req.user?.id || req.user?.ownerId;
    if (!ownerId) return res.status(401).json({ error: 'Not authenticated' });
    const managers  = await db.all(`SELECT * FROM managers  WHERE owner_id=? ORDER BY created_at DESC`, [ownerId]);
    const operators = await db.all(`SELECT * FROM operators WHERE owner_id=? ORDER BY created_at DESC`, [ownerId]);
    res.json({ managers, operators });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/owners/staff — create manager or operator
router.post('/staff', async (req, res) => {
  try {
    const ownerId = req.user?.id || req.user?.ownerId;
    if (!ownerId) return res.status(401).json({ error: 'Not authenticated' });
    const { role, id, name, email, phone, pump_id, pumpId, shift, salary, nozzles, password_hash, status } = req.body;
    const pid = pump_id || pumpId;
    const sid = id || ('STAFF'+Date.now());
    if (role === 'manager') {
      await db.run(`INSERT OR IGNORE INTO managers (id,owner_id,pump_id,name,email,password_hash,phone,shift,salary,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
        [sid, ownerId, pid, name, email, password_hash||'', phone||'', shift||'Morning', salary||0, status||'Active']);
    } else {
      await db.run(`INSERT OR IGNORE INTO operators (id,owner_id,pump_id,name,email,password_hash,phone,shift,nozzles,salary,present,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,?,datetime('now'))`,
        [sid, ownerId, pid, name, email, password_hash||'', phone||'', shift||'Morning', JSON.stringify(nozzles||[]), salary||0, status||'Active']);
    }
    res.json({ success: true, id: sid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/owners/credit-customers — create credit customer
router.post('/credit-customers', async (req, res) => {
  try {
    const ownerId = req.user?.id || req.user?.ownerId;
    if (!ownerId) return res.status(401).json({ error: 'Not authenticated' });
    const { id, name, phone, pump_id, pumpId, limit, credit_limit } = req.body;
    const cid = id || ('CC'+Date.now());
    await db.run(`INSERT OR IGNORE INTO credit_customers (id,owner_id,pump_id,name,phone,credit_limit,outstanding,status)
      VALUES (?,?,?,?,?,?,0,'Active')`,
      [cid, ownerId, pump_id||pumpId, name, phone||'', limit||credit_limit||0]);
    res.json({ success: true, id: cid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
