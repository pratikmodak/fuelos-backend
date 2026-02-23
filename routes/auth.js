// ═══════════════════════════════════════════════════════════
// FuelOS — Auth Routes  POST /api/auth/login  POST /api/auth/admin-otp
// ═══════════════════════════════════════════════════════════
import { Router } from 'express';
import bcrypt     from 'bcryptjs';
import { db }     from '../db.js';
import { signToken, authMiddleware } from '../middleware/auth.js';

const router = Router();

// POST /api/auth/login — owner | manager | operator
router.post('/login', (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || !role) return res.status(400).json({ error: 'email, password and role required' });

  let user;
  if (role === 'owner')    user = db.get('SELECT * FROM owners    WHERE email=?', [email]);
  if (role === 'manager')  user = db.get('SELECT * FROM managers  WHERE email=?', [email]);
  if (role === 'operator') user = db.get('SELECT * FROM operators WHERE email=?', [email]);

  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  // For demo: accept plain-text passwords OR bcrypt hashes
  const match = user.password_hash === password ||
    (user.password_hash.startsWith('$2b') && bcrypt.compareSync(password, user.password_hash));
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  // Log audit
  db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
    [crypto.randomUUID(), email, role.charAt(0).toUpperCase()+role.slice(1), 'Login', req.ip]);

  const token = signToken({ id: user.id, email: user.email, role, ownerId: user.owner_id || user.id });
  res.json({ token, user: sanitize(user), role });
});

// POST /api/auth/admin-login — step 1: verify admin password
router.post('/admin-login', (req, res) => {
  const { password } = req.body;
  const ADMIN_PASS   = process.env.ADMIN_PASSWORD || 'admin2025';
  if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Wrong password' });
  // In production: send real OTP via SMS/email
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  console.log(`[ADMIN OTP] ${otp}`); // For demo - log to console
  res.json({ success: true, message: 'OTP sent (check server logs in demo mode)' });
});

// POST /api/auth/admin-verify — step 2: verify OTP → issue admin JWT
router.post('/admin-verify', (req, res) => {
  const { otp } = req.body;
  // Demo: any 6-digit OTP accepted
  if (!otp || otp.length !== 6 || !/^\d{6}$/.test(otp)) {
    return res.status(401).json({ error: 'Invalid OTP' });
  }
  const token = signToken({ id: 'admin', email: 'admin@fuelos.in', role: 'admin' });
  db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
    [crypto.randomUUID(), 'admin@fuelos.in', 'Admin', 'Admin Login', req.ip]);
  res.json({ token, role: 'admin' });
});

// GET /api/auth/me — verify token + return current user
router.get('/me', authMiddleware, (req, res) => {
  const { role, id } = req.user;
  let user;
  if (role === 'owner')    user = db.get('SELECT * FROM owners    WHERE id=?', [id]);
  if (role === 'manager')  user = db.get('SELECT * FROM managers  WHERE id=?', [id]);
  if (role === 'operator') user = db.get('SELECT * FROM operators WHERE id=?', [id]);
  if (role === 'admin')    user = { id: 'admin', email: 'admin@fuelos.in', role: 'admin' };
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: sanitize(user), role });
});

function sanitize(u) {
  const { password_hash, ...safe } = u;
  return safe;
}

export default router;
