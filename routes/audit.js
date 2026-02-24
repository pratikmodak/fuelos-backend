// ── routes/audit.js — Shift Audit (edit submitted shifts with reason log)
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

// GET /api/audit/shifts — list audit log entries
router.get('/shifts', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { pump_id, limit = 50 } = req.query;
    let sql = 'SELECT * FROM shift_audit_log WHERE owner_id=?';
    const params = [ownerId];
    if (pump_id) { sql += ' AND pump_id=?'; params.push(pump_id); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    res.json(await db.all(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/audit/shifts/:id — edit shift with audit reason (owner only)
router.patch('/shifts/:id', requireRole('owner'), async (req, res) => {
  try {
    const ownerId = req.user.id;
    const { cash, card, upi, credit_out, variance, reason } = req.body;
    if (!reason || !reason.trim())
      return res.status(400).json({ error: 'Audit reason is required for shift edits' });

    const shift = await db.get(
      'SELECT * FROM shift_reports WHERE id=? AND owner_id=?', [req.params.id, ownerId]);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });

    // Record changes for audit trail
    const changes = {};
    if (cash !== undefined && cash !== shift.cash) changes.cash = { from: shift.cash, to: cash };
    if (card !== undefined && card !== shift.card) changes.card = { from: shift.card, to: card };
    if (upi  !== undefined && upi  !== shift.upi)  changes.upi  = { from: shift.upi,  to: upi };
    if (credit_out !== undefined && credit_out !== shift.credit_out)
      changes.credit_out = { from: shift.credit_out, to: credit_out };
    if (variance !== undefined && variance !== shift.variance)
      changes.variance = { from: shift.variance, to: variance };

    if (!Object.keys(changes).length)
      return res.status(400).json({ error: 'No changes detected' });

    await db.tx(async () => {
      // Update shift report
      await db.run(
        `UPDATE shift_reports SET
          cash=COALESCE(?,cash), card=COALESCE(?,card), upi=COALESCE(?,upi),
          credit_out=COALESCE(?,credit_out), variance=COALESCE(?,variance),
          status='Audited'
         WHERE id=?`,
        [cash ?? null, card ?? null, upi ?? null,
         credit_out ?? null, variance ?? null, shift.id]
      );
      // Record in audit log
      const auditId = uuid();
      await db.run(
        `INSERT INTO shift_audit_log
          (id,shift_id,owner_id,pump_id,date,shift,reason,changes,edited_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
        [auditId, shift.id, ownerId, shift.pump_id, shift.date, shift.shift,
         reason.trim(), JSON.stringify(changes), req.user.email]
      );
      // Also write to main audit log
      await db.run(`INSERT INTO audit_log VALUES(?,?,?,?,?,datetime('now'))`,
        [uuid(), ownerId, 'Owner',
         `Shift audit: ${shift.pump_id} ${shift.date} ${shift.shift} — ${reason.trim()}`, req.ip]);
    });

    res.json({ success: true, changes, audit_id: uuid() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/audit/shifts/:id/history — full audit trail for one shift
router.get('/shifts/:id/history', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const logs = await db.all(
      'SELECT * FROM shift_audit_log WHERE shift_id=? AND owner_id=? ORDER BY created_at DESC',
      [req.params.id, ownerId]
    );
    res.json(logs.map(l => ({
      ...l,
      changes: l.changes ? JSON.parse(l.changes) : {}
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
