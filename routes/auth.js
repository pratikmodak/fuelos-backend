import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { signToken, authMiddleware } from '../middleware/auth.js';

const router = Router();

// ── Ensure company_users table exists on startup
await db.run(`CREATE TABLE IF NOT EXISTS company_users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  role        TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status      TEXT DEFAULT 'Active',
  created_at  TEXT DEFAULT (datetime('now')),
  last_login  TEXT
)`);

// ── Seed first SuperAdmin if none exists
// SuperAdmin is the TOP role — seeded once from env, never created via UI
const saExists = await db.get(`SELECT id FROM company_users WHERE role='superadmin' LIMIT 1`);
if (!saExists) {
  const email = process.env.SUPERADMIN_EMAIL    || 'superadmin@fuelos.in';
  const pass  = process.env.SUPERADMIN_PASSWORD || 'super2025';
  const hash  = bcrypt.hashSync(pass, 10);
  await db.run(
    `INSERT OR IGNORE INTO company_users (id,email,name,role,password_hash) VALUES (?,?,?,?,?)`,
    [uuid(), email, 'Super Admin', 'superadmin', hash]
  );
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  FuelOS First-Time Setup                         ║`);
  console.log(`║  SuperAdmin seeded:                              ║`);
  console.log(`║  Email:    ${email.padEnd(38)}║`);
  console.log(`║  Password: ${pass.padEnd(38)}║`);
  console.log(`║  Set SUPERADMIN_EMAIL + SUPERADMIN_PASSWORD env  ║`);
  console.log(`║  vars to change these before going live.         ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);
}

// ── In-memory OTP store  { email → { otp, role, expires } }
const otpStore = new Map();

// ─────────────────────────────────────────────────────────
// POST /api/auth/login  — Owner / Manager / Operator
// ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password || !role)
      return res.status(400).json({ error: 'email, password and role required' });

    let user;
    if (role === 'owner')    user = await db.get('SELECT * FROM owners    WHERE email=?', [email]);
    if (role === 'manager')  user = await db.get('SELECT * FROM managers  WHERE email=?', [email]);
    if (role === 'operator') user = await db.get('SELECT * FROM operators WHERE email=?', [email]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match =
      user.password_hash === password ||
      (user.password_hash?.startsWith('$2b') && bcrypt.compareSync(password, user.password_hash));
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const table = role === 'owner' ? 'owners' : role === 'manager' ? 'managers' : 'operators';
    await db.run(`UPDATE ${table} SET last_login=datetime('now') WHERE id=?`, [user.id]).catch(()=>{});
    await db.run(
      `INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), email, role.charAt(0).toUpperCase()+role.slice(1), 'Login', req.ip]
    ).catch(()=>{});

    const token = signToken({ id: user.id, email: user.email, role, ownerId: user.owner_id || user.id });
    const { password_hash, ...safe } = user;
    res.json({ token, user: { ...safe, role }, role });
  } catch (e) {
    console.error('[Login]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/admin-login  — Company portal (superadmin/admin/monitor/caller)
// Step 1: verify email + password → send OTP
// ─────────────────────────────────────────────────────────
router.post('/admin-login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    const allowed = ['superadmin', 'admin', 'monitor', 'caller'];
    if (!allowed.includes(role))
      return res.status(400).json({ error: 'Invalid role' });
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const user = await db.get(
      `SELECT * FROM company_users WHERE email=? AND role=? AND status='Active'`,
      [email, role]
    );
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (!bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(email, { otp, role, expires: Date.now() + 10 * 60 * 1000 });
    console.log(`[OTP] ${role} / ${email} → ${otp}`);

    // Return OTP in dev mode so it shows on screen
    const isDev = process.env.NODE_ENV !== 'production';
    res.json({ success: true, ...(isDev ? { dev_otp: otp } : {}) });
  } catch (e) {
    console.error('[AdminLogin]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/admin-verify  — Step 2: verify OTP → return JWT
// ─────────────────────────────────────────────────────────
router.post('/admin-verify', async (req, res) => {
  try {
    const { otp, role } = req.body;
    if (!otp || otp.length !== 6)
      return res.status(401).json({ error: 'Enter 6-digit OTP' });

    let foundEmail = null;
    for (const [email, entry] of otpStore.entries()) {
      if (entry.role === role && entry.otp === otp && entry.expires > Date.now()) {
        foundEmail = email; break;
      }
    }
    if (!foundEmail)
      return res.status(401).json({ error: 'Invalid or expired OTP' });
    otpStore.delete(foundEmail);

    const user = await db.get(
      `SELECT * FROM company_users WHERE email=? AND role=?`,
      [foundEmail, role]
    );
    if (!user) return res.status(401).json({ error: 'User not found' });

    await db.run(`UPDATE company_users SET last_login=datetime('now') WHERE id=?`, [user.id]);
    await db.run(
      `INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), foundEmail, role, `${role} Login`, req.ip || '']
    ).catch(()=>{});

    const token = signToken({ id: user.id, email: user.email, role });
    const { password_hash, ...safe } = user;
    res.json({ token, user: { ...safe, role }, role });
  } catch (e) {
    console.error('[AdminVerify]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { role, id } = req.user;
    let user;
    if (role === 'owner')    user = await db.get('SELECT * FROM owners    WHERE id=?', [id]);
    if (role === 'manager')  user = await db.get('SELECT * FROM managers  WHERE id=?', [id]);
    if (role === 'operator') user = await db.get('SELECT * FROM operators WHERE id=?', [id]);
    if (['superadmin','admin','monitor','caller'].includes(role))
      user = await db.get('SELECT * FROM company_users WHERE id=?', [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password_hash, ...safe } = user;
    res.json({ user: { ...safe, role }, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// GET /api/auth/company-users
// SuperAdmin → sees all (admin/monitor/caller)
// Admin → no access
// ─────────────────────────────────────────────────────────
router.get('/company-users', authMiddleware, async (req, res) => {
  if (req.user.role !== 'superadmin')
    return res.status(403).json({ error: 'SuperAdmin only' });
  const users = await db.all(
    `SELECT id,email,name,role,status,created_at,last_login
     FROM company_users ORDER BY created_at DESC`
  );
  res.json(users);
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/company-users  — SuperAdmin creates admin/monitor/caller
// ─────────────────────────────────────────────────────────
router.post('/company-users', authMiddleware, async (req, res) => {
  if (req.user.role !== 'superadmin')
    return res.status(403).json({ error: 'SuperAdmin only' });
  try {
    const { email, name, role, password } = req.body;
    // SuperAdmin can create: admin, monitor, caller  (not another superadmin)
    const allowed = ['admin', 'monitor', 'caller'];
    if (!allowed.includes(role))
      return res.status(400).json({ error: 'Role must be admin, monitor or caller' });
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const id   = uuid();
    const hash = bcrypt.hashSync(password, 10);
    await db.run(
      `INSERT INTO company_users (id,email,name,role,password_hash) VALUES (?,?,?,?,?)`,
      [id, email, name || email.split('@')[0], role, hash]
    );
    await db.run(
      `INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), req.user.email, 'SuperAdmin', `Created ${role} account: ${email}`, req.ip]
    ).catch(()=>{});
    res.json({ success: true, id });
  } catch (e) {
    if (e.message?.includes('UNIQUE'))
      return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// DELETE /api/auth/company-users/:id  — SuperAdmin only
// ─────────────────────────────────────────────────────────
router.delete('/company-users/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'superadmin')
    return res.status(403).json({ error: 'SuperAdmin only' });
  const user = await db.get(`SELECT * FROM company_users WHERE id=?`, [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (user.role === 'superadmin')
    return res.status(403).json({ error: 'Cannot delete SuperAdmin account' });
  await db.run(`DELETE FROM company_users WHERE id=?`, [req.params.id]);
  await db.run(
    `INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
    [uuid(), req.user.email, 'SuperAdmin', `Deleted ${user.role}: ${user.email}`, req.ip]
  ).catch(()=>{});
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────
// PATCH /api/auth/company-users/:id/password  — SuperAdmin only
// ─────────────────────────────────────────────────────────
router.patch('/company-users/:id/password', authMiddleware, async (req, res) => {
  if (req.user.role !== 'superadmin')
    return res.status(403).json({ error: 'SuperAdmin only' });
  const { password } = req.body;
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'Password must be 6+ characters' });
  const hash = bcrypt.hashSync(password, 10);
  await db.run(`UPDATE company_users SET password_hash=? WHERE id=?`, [hash, req.params.id]);
  res.json({ success: true });
});

export default router;
