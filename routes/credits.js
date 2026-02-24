// ── routes/credits.js — Credit Customer Full CRUD + Transaction History
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

// GET /api/credits — list credit customers
router.get('/', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { pump_id, status } = req.query;
    let sql = 'SELECT * FROM credit_customers WHERE owner_id=?';
    const params = [ownerId];
    if (pump_id) { sql += ' AND pump_id=?'; params.push(pump_id); }
    if (status)  { sql += ' AND status=?'; params.push(status); }
    res.json(await db.all(sql + ' ORDER BY name', params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/credits — create customer
router.post('/', requireRole('owner'), async (req, res) => {
  try {
    const ownerId = req.user.id;
    const { pump_id, name, phone, credit_limit, notes } = req.body;
    if (!name || !credit_limit) return res.status(400).json({ error: 'name, credit_limit required' });
    const id = 'CC-' + uuid().slice(0, 8).toUpperCase();
    await db.run(
      `INSERT INTO credit_customers (id,owner_id,pump_id,name,phone,credit_limit,outstanding,last_txn,status,notes,created_at)
       VALUES (?,?,?,?,?,?,0,date('now'),'Active',?,date('now'))`,
      [id, ownerId, pump_id || null, name, phone || null, parseFloat(credit_limit), notes || null]
    );
    await db.run(`INSERT INTO audit_log VALUES(?,?,?,?,?,datetime('now'))`,
      [uuid(), ownerId, 'Owner', `Credit customer added: ${name}`, req.ip]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/credits/:id — update customer details
router.patch('/:id', requireRole('owner'), async (req, res) => {
  try {
    const { name, phone, credit_limit, status, notes, pump_id } = req.body;
    const cc = await db.get('SELECT * FROM credit_customers WHERE id=? AND owner_id=?',
      [req.params.id, req.user.id]);
    if (!cc) return res.status(404).json({ error: 'Not found' });
    await db.run(
      `UPDATE credit_customers SET
        name=COALESCE(?,name), phone=COALESCE(?,phone),
        credit_limit=COALESCE(?,credit_limit), status=COALESCE(?,status),
        notes=COALESCE(?,notes), pump_id=COALESCE(?,pump_id)
       WHERE id=?`,
      [name||null, phone||null, credit_limit?parseFloat(credit_limit):null,
       status||null, notes||null, pump_id||null, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/credits/:id
router.delete('/:id', requireRole('owner'), async (req, res) => {
  try {
    const cc = await db.get('SELECT * FROM credit_customers WHERE id=? AND owner_id=?',
      [req.params.id, req.user.id]);
    if (!cc) return res.status(404).json({ error: 'Not found' });
    if (cc.outstanding > 0)
      return res.status(400).json({ error: `Clear outstanding balance of ₹${cc.outstanding} first` });
    await db.run('DELETE FROM credit_customers WHERE id=?', [req.params.id]);
    await db.run('DELETE FROM credit_transactions WHERE customer_id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TRANSACTIONS ──

// GET /api/credits/:id/transactions
router.get('/:id/transactions', async (req, res) => {
  try {
    const cc = await db.get('SELECT * FROM credit_customers WHERE id=? AND owner_id=?',
      [req.params.id, req.user.ownerId || req.user.id]);
    if (!cc) return res.status(404).json({ error: 'Not found' });
    res.json(await db.all(
      'SELECT * FROM credit_transactions WHERE customer_id=? ORDER BY date DESC, created_at DESC LIMIT 100',
      [req.params.id]
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/credits/:id/transactions — record sale or payment
router.post('/:id/transactions', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const cc = await db.get('SELECT * FROM credit_customers WHERE id=? AND owner_id=?',
      [req.params.id, ownerId]);
    if (!cc) return res.status(404).json({ error: 'Not found' });

    const { type, amount, description, date } = req.body;
    if (!['sale', 'payment'].includes(type)) return res.status(400).json({ error: 'type must be sale or payment' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required > 0' });

    const txnDate = date || new Date().toISOString().slice(0, 10);
    const id = 'CTX-' + uuid().slice(0, 8).toUpperCase();
    const prevBalance = cc.outstanding;
    const newBalance = type === 'sale'
      ? prevBalance + parseFloat(amount)
      : Math.max(0, prevBalance - parseFloat(amount));

    // Check credit limit for sales
    if (type === 'sale' && newBalance > cc.credit_limit)
      return res.status(400).json({
        error: `Credit limit exceeded. Available: ₹${(cc.credit_limit - prevBalance).toLocaleString()}`
      });

    await db.tx(async () => {
      await db.run(
        `INSERT INTO credit_transactions (id,customer_id,owner_id,type,amount,description,date,balance_after,created_at)
         VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
        [id, cc.id, ownerId, type, parseFloat(amount), description || type, txnDate, newBalance]
      );
      await db.run(
        `UPDATE credit_customers SET outstanding=?, last_txn=? WHERE id=?`,
        [newBalance, txnDate, cc.id]
      );
    });

    await db.run(`INSERT INTO audit_log VALUES(?,?,?,?,?,datetime('now'))`,
      [uuid(), ownerId, 'Owner',
       `Credit ${type}: ${cc.name} — ₹${amount} (balance: ₹${newBalance})`, req.ip]);

    res.json({ success: true, id, balance: newBalance, type });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/credits/summary — outstanding summary for dashboard
router.get('/summary', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const customers = await db.all(
      'SELECT * FROM credit_customers WHERE owner_id=?', [ownerId]);
    const totalOutstanding = customers.reduce((s, c) => s + c.outstanding, 0);
    const totalLimit = customers.reduce((s, c) => s + c.credit_limit, 0);
    const highRisk = customers.filter(c => c.outstanding / c.credit_limit > 0.8).length;
    res.json({ total_customers: customers.length, total_outstanding: totalOutstanding,
               total_limit: totalLimit, high_risk: highRisk, utilization: totalLimit ? Math.round(totalOutstanding/totalLimit*100) : 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
