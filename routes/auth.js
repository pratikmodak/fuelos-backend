import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { signToken, authMiddleware } from '../middleware/auth.js';

const router = Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password || !role) return res.status(400).json({ error: 'email, password and role required' });
    let user;
    if (role === 'owner')    user = await db.get('SELECT * FROM owners    WHERE email=?', [email]);
    if (role === 'manager')  user = await db.get('SELECT * FROM managers  WHERE email=?', [email]);
    if (role === 'operator') user = await db.get('SELECT * FROM operators WHERE email=?', [email]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    // Debug: log user keys on first login attempt
    console.log('[Login] User found:', user.email, 'keys:', Object.keys(user).join(','));
    const match = user.password_hash === password ||
      (user.password_hash?.startsWith('$2b') && bcrypt.compareSync(password, user.password_hash));
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), email, role.charAt(0).toUpperCase()+role.slice(1), 'Login', req.ip]);
    const token = signToken({ id: user.id, email: user.email, role, ownerId: user.owner_id || user.id });
    const { password_hash, ...safe } = user;
    res.json({ token, user: safe, role });
  } catch (e) {
    console.error('[Login Error]', e.message, e.stack?.split('\n')[1]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin-login', async (req, res) => {
  const { password } = req.body;
  const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin2025';
  if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Wrong password' });
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  console.log(`[ADMIN OTP] ${otp}`);
  res.json({ success: true, message: 'OTP sent' });
});

router.post('/admin-verify', async (req, res) => {
  const { otp } = req.body;
  if (!otp || otp.length !== 6) return res.status(401).json({ error: 'Invalid OTP' });
  const token = signToken({ id: 'admin', email: 'admin@fuelos.in', role: 'admin' });
  await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
    [uuid(), 'admin@fuelos.in', 'Admin', 'Admin Login', req.ip]);
  res.json({ token, role: 'admin' });
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { role, id } = req.user;
    let user;
    if (role === 'owner')    user = await db.get('SELECT * FROM owners    WHERE id=?', [id]);
    if (role === 'manager')  user = await db.get('SELECT * FROM managers  WHERE id=?', [id]);
    if (role === 'operator') user = await db.get('SELECT * FROM operators WHERE id=?', [id]);
    if (role === 'admin')    user = { id: 'admin', email: 'admin@fuelos.in', role: 'admin' };
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password_hash, ...safe } = user;
    res.json({ user: safe, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Super admin / monitor / caller login (single password, no OTP for now)
router.post('/superadmin-login', async (req, res) => {
  const { role, password } = req.body;
  const PASSWORDS = {
    superadmin: process.env.SUPERADMIN_PASSWORD || 'super2025',
    monitor:    process.env.MONITOR_PASSWORD    || 'monitor2025',
    caller:     process.env.CALLER_PASSWORD     || 'caller2025',
  };
  const allowed = ['superadmin', 'monitor', 'caller'];
  if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (password !== PASSWORDS[role]) return res.status(401).json({ error: 'Wrong password' });
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  console.log(`[${role.toUpperCase()} OTP] ${otp}`);
  res.json({ success: true, message: 'OTP sent' });
});

router.post('/superadmin-verify', async (req, res) => {
  const { role, otp } = req.body;
  const allowed = ['superadmin', 'monitor', 'caller'];
  if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (!otp || otp.length !== 6) return res.status(401).json({ error: 'Invalid OTP' });
  const token = signToken({ id: role, email: `${role}@fuelos.in`, role });
  await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
    [uuid(), `${role}@fuelos.in`, role, `${role} Login`, req.ip]);
  res.json({ token, role });
});

export default router;
