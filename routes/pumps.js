// FuelOS — Pumps CRUD
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

router.get('/', (req, res) => {
  const ownerId = req.user.role === 'admin' ? undefined : req.user.ownerId || req.user.id;
  const pumps = ownerId
    ? db.all('SELECT * FROM pumps WHERE owner_id=?', [ownerId])
    : db.all('SELECT * FROM pumps');
  res.json(pumps);
});

router.post('/', (req, res) => {
  const { id, name, short_name, city, state, address, gst } = req.body;
  const ownerId = req.user.ownerId || req.user.id;
  db.run('INSERT INTO pumps VALUES (?,?,?,?,?,?,?,?,?,date("now"))',
    [id, ownerId, name, short_name || name, city, state, address, gst, 'Active']);
  res.json(db.get('SELECT * FROM pumps WHERE id=? AND owner_id=?', [id, ownerId]));
});

router.patch('/:id', (req, res) => {
  const { name, short_name, city, state, address, gst, status } = req.body;
  const ownerId = req.user.ownerId || req.user.id;
  db.run(`UPDATE pumps SET name=COALESCE(?,name), short_name=COALESCE(?,short_name),
          city=COALESCE(?,city), state=COALESCE(?,state), address=COALESCE(?,address),
          gst=COALESCE(?,gst), status=COALESCE(?,status) WHERE id=? AND owner_id=?`,
    [name, short_name, city, state, address, gst, status, req.params.id, ownerId]);
  res.json({ success: true });
});

// Nozzles
router.get('/:pumpId/nozzles', (req, res) => {
  const nozzles = db.all('SELECT * FROM nozzles WHERE pump_id=?', [req.params.pumpId]);
  res.json(nozzles);
});

router.post('/:pumpId/nozzles', (req, res) => {
  const { id, fuel, open_reading, operator, status } = req.body;
  const ownerId = req.user.ownerId || req.user.id;
  db.run('INSERT INTO nozzles VALUES (?,?,?,?,?,?,?,?)',
    [id, req.params.pumpId, ownerId, fuel, open_reading || 0, null, operator || '', status || 'Active']);
  res.json({ success: true });
});

router.delete('/:pumpId/nozzles/:nozzleId', (req, res) => {
  db.run('DELETE FROM nozzles WHERE id=? AND pump_id=?', [req.params.nozzleId, req.params.pumpId]);
  res.json({ success: true });
});

export default router;
