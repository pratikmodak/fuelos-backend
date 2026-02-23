// FuelOS — Owners CRUD
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

// GET /api/owners/me
router.get('/me', (req, res) => {
  const owner = db.get('SELECT * FROM owners WHERE id=?', [req.user.id]);
  if (!owner) return res.status(404).json({ error: 'Not found' });
  const { password_hash, ...safe } = owner;
  res.json(safe);
});

// PATCH /api/owners/me — update profile
router.patch('/me', (req, res) => {
  const { name, phone, city, state, address, gst, whatsapp, whatsapp_num } = req.body;
  db.run(`UPDATE owners SET name=COALESCE(?,name), phone=COALESCE(?,phone), city=COALESCE(?,city),
          state=COALESCE(?,state), address=COALESCE(?,address), gst=COALESCE(?,gst),
          whatsapp=COALESCE(?,whatsapp), whatsapp_num=COALESCE(?,whatsapp_num),
          updated_at=datetime('now') WHERE id=?`,
    [name, phone, city, state, address, gst, whatsapp, whatsapp_num, req.user.id]);
  const updated = db.get('SELECT * FROM owners WHERE id=?', [req.user.id]);
  const { password_hash, ...safe } = updated;
  res.json(safe);
});

export default router;
