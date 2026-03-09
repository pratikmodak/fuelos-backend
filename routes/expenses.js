// ═══════════════════════════════════════════════════════════
// FuelOS v3 — Expenses Routes
// /api/expenses
// ═══════════════════════════════════════════════════════════
const router = require('express').Router();
const db     = require('../db');
const { logOp } = require('../middleware/audit-middleware');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// ─── helpers ────────────────────────────────────────────────
const CATEGORIES = [
  'Fuel Purchase', 'Salary', 'Maintenance', 'Utilities',
  'Rent', 'Consumables', 'Transport', 'Miscellaneous',
];

// ─── GET /api/expenses ──────────────────────────────────────
// Owner: all expenses across all pumps
// Manager: only expenses for their pump (any role that submitted)
router.get('/', async (req, res) => {
  try {
    const { role, owner_id, pump_id } = req.user;
    const { from, to, pump, category, limit = 200 } = req.query;

    let where = ['e.owner_id = $1'];
    let params = [owner_id];
    let idx = 2;

    // Manager can only see their pump
    if (role === 'manager') {
      where.push(`e.pump_id = $${idx++}`);
      params.push(pump_id);
    } else if (pump) {
      where.push(`e.pump_id = $${idx++}`);
      params.push(pump);
    }

    if (from)     { where.push(`e.date >= $${idx++}`); params.push(from); }
    if (to)       { where.push(`e.date <= $${idx++}`); params.push(to); }
    if (category) { where.push(`e.category = $${idx++}`); params.push(category); }

    const sql = `
      SELECT e.*,
        p.name AS pump_name,
        p.short_name AS pump_short
      FROM expenses e
      LEFT JOIN pumps p ON p.id = e.pump_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.date DESC, e.created_at DESC
      LIMIT $${idx}
    `;
    params.push(parseInt(limit));

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('[expenses GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/expenses/summary ──────────────────────────────
// Category totals for current month + previous month
router.get('/summary', async (req, res) => {
  try {
    const { owner_id, role, pump_id } = req.user;
    const { from, to, pump } = req.query;

    const pumpFilter = role === 'manager' ? pump_id : (pump || null);

    const params = [owner_id];
    let pumpClause = '';
    if (pumpFilter) { params.push(pumpFilter); pumpClause = `AND pump_id = $${params.length}`; }

    // This month
    const thisMonth = new Date();
    const firstOfMonth = new Date(thisMonth.getFullYear(), thisMonth.getMonth(), 1).toISOString().slice(0,10);
    const today = new Date().toISOString().slice(0,10);

    const fromDate = from || firstOfMonth;
    const toDate   = to   || today;

    params.push(fromDate); const fromIdx = params.length;
    params.push(toDate);   const toIdx   = params.length;

    const { rows: byCategory } = await db.query(`
      SELECT category,
        SUM(amount)::NUMERIC(12,2) AS total,
        COUNT(*) AS count
      FROM expenses
      WHERE owner_id = $1 ${pumpClause}
        AND date BETWEEN $${fromIdx} AND $${toIdx}
      GROUP BY category
      ORDER BY total DESC
    `, params);

    const { rows: byDay } = await db.query(`
      SELECT date::TEXT,
        SUM(amount)::NUMERIC(12,2) AS total,
        COUNT(*) AS count
      FROM expenses
      WHERE owner_id = $1 ${pumpClause}
        AND date BETWEEN $${fromIdx} AND $${toIdx}
      GROUP BY date
      ORDER BY date ASC
    `, params);

    const { rows: grandTotal } = await db.query(`
      SELECT
        SUM(amount)::NUMERIC(12,2) AS total,
        COUNT(*) AS count
      FROM expenses
      WHERE owner_id = $1 ${pumpClause}
        AND date BETWEEN $${fromIdx} AND $${toIdx}
    `, params);

    res.json({
      byCategory,
      byDay,
      total:  parseFloat(grandTotal[0]?.total || 0),
      count:  parseInt(grandTotal[0]?.count  || 0),
      from:   fromDate,
      to:     toDate,
    });
  } catch (e) {
    console.error('[expenses summary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/expenses ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { owner_id, role, pump_id: userPumpId, name } = req.user;
    const {
      date, category, subcategory = '', description, amount,
      payment_mode = 'Cash', vendor = '', reference = '',
      notes = '', pump_id,
    } = req.body;

    if (!category || !description || !amount || !date)
      return res.status(400).json({ error: 'date, category, description, amount are required' });

    if (!CATEGORIES.includes(category))
      return res.status(400).json({ error: `Invalid category. Valid: ${CATEGORIES.join(', ')}` });

    // Manager can only log to their pump
    const effectivePumpId = role === 'manager' ? userPumpId : (pump_id || userPumpId || null);

    const { rows } = await db.query(`
      INSERT INTO expenses
        (owner_id, pump_id, date, category, subcategory, description,
         amount, payment_mode, vendor, reference, notes,
         added_by, added_by_role, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [
      owner_id, effectivePumpId, date, category, subcategory, description,
      parseFloat(amount), payment_mode, vendor, reference, notes,
      name || 'Unknown', role, role === 'manager' ? 'pending' : 'approved',
    ]);

    await logOp(req, { category:'expense', action:'Expense added', entityType:'expense', entityId:rows[0]?.id, details:{ category:rows[0]?.category, amount:rows[0]?.amount, status:rows[0]?.status } });
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[expenses POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/expenses/:id ────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const { owner_id, role } = req.user;

    // Check ownership
    const { rows: existing } = await db.query(
      'SELECT * FROM expenses WHERE id = $1 AND owner_id = $2',
      [req.params.id, owner_id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Expense not found' });

    // Managers can only edit pending expenses they added
    if (role === 'manager' && existing[0].status !== 'pending')
      return res.status(403).json({ error: 'Cannot edit approved/rejected expenses' });

    const {
      date, category, subcategory, description, amount,
      payment_mode, vendor, reference, notes, status,
    } = req.body;

    const fields = [];
    const vals   = [req.params.id, owner_id];
    let i = 3;
    const set = (col, val) => { if (val !== undefined) { fields.push(`${col} = $${i++}`); vals.push(val); } };

    set('date',         date);
    set('category',     category);
    set('subcategory',  subcategory);
    set('description',  description);
    set('amount',       amount ? parseFloat(amount) : undefined);
    set('payment_mode', payment_mode);
    set('vendor',       vendor);
    set('reference',    reference);
    set('notes',        notes);
    // Only owner can approve/reject
    if (role === 'owner' && status) set('status', status);

    fields.push(`updated_at = NOW()`);
    if (!fields.length) return res.json(existing[0]);

    const { rows } = await db.query(
      `UPDATE expenses SET ${fields.join(', ')} WHERE id = $1 AND owner_id = $2 RETURNING *`,
      vals
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[expenses PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/expenses/:id ───────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { owner_id, role } = req.user;
    const { rows } = await db.query(
      'SELECT * FROM expenses WHERE id=$1 AND owner_id=$2', [req.params.id, owner_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // Managers can only delete their own pending expenses
    if (role === 'manager' && (rows[0].added_by_role !== 'manager' || rows[0].status !== 'pending'))
      return res.status(403).json({ error: 'Cannot delete this expense' });

    await db.query('DELETE FROM expenses WHERE id=$1 AND owner_id=$2', [req.params.id, owner_id]);
    await logOp(req, { category:'expense', action:'Expense deleted', entityType:'expense', entityId:req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/expenses/categories ───────────────────────────
router.get('/categories', (req, res) => res.json(CATEGORIES));

module.exports = router;