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
