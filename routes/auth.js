import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { signToken, authMiddleware } from '../middleware/auth.js';

const router = Router();

// ── Ensure company_users table exists
await db.run(`CREATE TABLE IF NOT EXISTS company_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL,  -- admin | superadmin | monitor | caller
  password_hash TEXT NOT NULL,
  status TEXT DEFAULT 'Active',
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT
)`);

// Seed a default admin if none exists
const adminExists = await db.get(`SELECT id FROM company_users WHERE role='admin' LIMIT 1`);
if (!adminExists) {
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin2025', 10);
  await db.run(`INSERT OR IGNORE INTO company_users (id,email,name,role,password_hash) VALUES (?,?,?,?,?)`,
    [uuid(), 'admin@fuelos.in', 'Admin', 'admin', hash]);
  console.log('[Auth] Default admin user seeded — change password via Admin panel');
}

// ── OTP store (in-memory, fine for single-server)
const otpStore = new Map(); // email → { otp, role, expires }

// ─────────────────────────────────────────────
// POST /api/auth/login — owner / manager / operator
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password || !role) return res.status(400).json({ error: 'email, password and role required' });
    let user;
    if (role === 'owner')    user = await db.get('SELECT * FROM owners    WHERE email=?', [email]);
    if (role === 'manager')  user = await db.get('SELECT * FROM managers  WHERE email=?', [email]);
    if (role === 'operator') user = await db.get('SELECT * FROM operators WHERE email=?', [email]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = user.password_hash === password ||
      (user.password_hash?.startsWith('$2b') && bcrypt.compareSync(password, user.password_hash));
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    await db.run(`UPDATE ${role}s SET last_login=datetime('now') WHERE id=?`, [user.id]);
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), email, role.charAt(0).toUpperCase()+role.slice(1), 'Login', req.ip]);
    const token = signToken({ id: user.id, email: user.email, role, ownerId: user.owner_id || user.id });
    const { password_hash, ...safe } = user;
    res.json({ token, user: { ...safe, role }, role });
  } catch (e) {
    console.error('[Login Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/admin-login — company staff (admin/superadmin/monitor/caller)
// Step 1: verify email + password, send OTP
// ─────────────────────────────────────────────
router.post('/admin-login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    const allowed = ['admin', 'superadmin', 'monitor', 'caller'];
    if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await db.get(`SELECT * FROM company_users WHERE email=? AND role=? AND status='Active'`, [email, role]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = bcrypt.compareSync(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 10 * 60 * 1000; // 10 minutes
    otpStore.set(email, { otp, role, expires });
    console.log(`[OTP for ${role}/${email}]: ${otp}`); // In production, send via email/SMS

    res.json({ success: true, message: 'OTP sent to registered email' });
  } catch (e) {
    console.error('[AdminLogin Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/admin-verify — verify OTP, return token
// ─────────────────────────────────────────────
router.post('/admin-verify', async (req, res) => {
  try {
    const { otp, role } = req.body;
    if (!otp || otp.length !== 6) return res.status(401).json({ error: 'Invalid OTP' });

    // Find the pending OTP for this role
    let foundEmail = null;
    for (const [email, entry] of otpStore.entries()) {
      if (entry.role === role && entry.otp === otp && entry.expires > Date.now()) {
        foundEmail = email;
        break;
      }
    }
    if (!foundEmail) return res.status(401).json({ error: 'Invalid or expired OTP' });
    otpStore.delete(foundEmail);

    const user = await db.get(`SELECT * FROM company_users WHERE email=? AND role=?`, [foundEmail, role]);
    if (!user) return res.status(401).json({ error: 'User not found' });

    await db.run(`UPDATE company_users SET last_login=datetime('now') WHERE id=?`, [user.id]);
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), foundEmail, role, `${role} Login`, req.ip || '']);

    const token = signToken({ id: user.id, email: user.email, role });
    const { password_hash, ...safe } = user;
    res.json({ token, user: { ...safe, role }, role });
  } catch (e) {
    console.error('[AdminVerify Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/auth/me — return current user from token
// ─────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { role, id } = req.user;
    let user;
    if (role === 'owner')    user = await db.get('SELECT * FROM owners    WHERE id=?', [id]);
    if (role === 'manager')  user = await db.get('SELECT * FROM managers  WHERE id=?', [id]);
    if (role === 'operator') user = await db.get('SELECT * FROM operators WHERE id=?', [id]);
    if (['admin','superadmin','monitor','caller'].includes(role))
      user = await db.get('SELECT * FROM company_users WHERE id=?', [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password_hash, ...safe } = user;
    res.json({ user: { ...safe, role }, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// GET /api/auth/company-users — list company staff (admin only)
// ─────────────────────────────────────────────
router.get('/company-users', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const users = await db.all(`SELECT id,email,name,role,status,created_at,last_login FROM company_users ORDER BY created_at DESC`);
  res.json(users);
});

// ─────────────────────────────────────────────
// POST /api/auth/company-users — create company staff user (admin only)
// ─────────────────────────────────────────────
router.post('/company-users', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { email, name, role, password } = req.body;
    const allowed = ['superadmin', 'monitor', 'caller'];
    if (!allowed.includes(role)) return res.status(400).json({ error: 'Role must be superadmin, monitor or caller' });
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const id = uuid();
    const hash = bcrypt.hashSync(password, 10);
    await db.run(`INSERT INTO company_users (id,email,name,role,password_hash) VALUES (?,?,?,?,?)`,
      [id, email, name || email.split('@')[0], role, hash]);
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), req.user.email, 'Admin', `Created company user: ${email} (${role})`, req.ip]);
    res.json({ success: true, id });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/auth/company-users/:id — remove company staff (admin only)
// ─────────────────────────────────────────────
router.delete('/company-users/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const user = await db.get(`SELECT * FROM company_users WHERE id=?`, [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (user.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin user' });
  await db.run(`DELETE FROM company_users WHERE id=?`, [req.params.id]);
  await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
    [uuid(), req.user.email, 'Admin', `Deleted company user: ${user.email}`, req.ip]);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// PATCH /api/auth/company-users/:id/password — change password (admin only)
// ─────────────────────────────────────────────
router.patch('/company-users/:id/password', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be 6+ chars' });
  const hash = bcrypt.hashSync(password, 10);
  await db.run(`UPDATE company_users SET password_hash=? WHERE id=?`, [hash, req.params.id]);
  res.json({ success: true });
});

export default router;
