import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const ownerId = req.user.role === 'admin' ? undefined : req.user.ownerId || req.user.id;
    const pumps = ownerId
      ? await db.all('SELECT * FROM pumps WHERE owner_id=?', [ownerId])
      : await db.all('SELECT * FROM pumps');
    res.json(pumps);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { id, name, short_name, city, state, address, gst } = req.body;
    const ownerId = req.user.ownerId || req.user.id;
    await db.run(`INSERT INTO pumps VALUES (?,?,?,?,?,?,?,?,?,date('now'))`,
      [id, ownerId, name, short_name || name, city, state, address, gst, 'Active']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const { name, short_name, city, state, address, gst, status } = req.body;
    const ownerId = req.user.ownerId || req.user.id;
    await db.run(`UPDATE pumps SET name=COALESCE(?,name), short_name=COALESCE(?,short_name),
      city=COALESCE(?,city), state=COALESCE(?,state), address=COALESCE(?,address),
      gst=COALESCE(?,gst), status=COALESCE(?,status) WHERE id=? AND owner_id=?`,
      [name, short_name, city, state, address, gst, status, req.params.id, ownerId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:pumpId/nozzles', async (req, res) => {
  try {
    const nozzles = await db.all('SELECT * FROM nozzles WHERE pump_id=?', [req.params.pumpId]);
    res.json(nozzles);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:pumpId/nozzles', async (req, res) => {
  try {
    const { id, fuel, open_reading, operator, status } = req.body;
    const ownerId = req.user.ownerId || req.user.id;
    await db.run('INSERT INTO nozzles VALUES (?,?,?,?,?,?,?,?)',
      [id, req.params.pumpId, ownerId, fuel, open_reading || 0, null, operator || '', status || 'Active']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:pumpId/nozzles/:nozzleId', async (req, res) => {
  try {
    await db.run('DELETE FROM nozzles WHERE id=? AND pump_id=?', [req.params.nozzleId, req.params.pumpId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
