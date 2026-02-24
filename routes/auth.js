import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { signToken, authMiddleware } from '../middleware/auth.js';

const router = Router();

// ── Ensure company_users table exists on startup
await db.run(`CREATE TABLE IF NOT EXISTS company_users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status        TEXT DEFAULT 'Active',
  created_at    TEXT DEFAULT (datetime('now')),
  last_login    TEXT,
  totp_secret   TEXT,
  totp_pending  TEXT,
  totp_enabled  INTEGER DEFAULT 0,
  totp_backup_codes TEXT,
  _customised   INTEGER DEFAULT 0
)`);
// Add missing columns to existing tables (safe on re-deploy)
for (const col of ['totp_secret','totp_pending','totp_enabled','totp_backup_codes','_customised']) {
  await db.run(`ALTER TABLE company_users ADD COLUMN ${col} ${col==='totp_enabled'||col==='_customised'?'INTEGER DEFAULT 0':'TEXT'}`).catch(()=>{});
}

// ── Seed first SuperAdmin if none exists
// SuperAdmin is the TOP role — seeded once from env, never created via UI
// ── Fixed default SuperAdmin credentials (one-time seed)
// Email: superadmin@superadmin.com  |  Password: super2025
// Once you log in and update via My Account, the DB record is updated
// and these defaults are no longer used — the DB value takes over.
const SA_DEFAULT_EMAIL = 'superadmin@superadmin.com';
const SA_DEFAULT_PASS  = 'super2025';

// Always ensure superadmin exists with correct default credentials
// If a superadmin row exists with OLD email from previous deploy → update it
const saRow = await db.get(`SELECT * FROM company_users WHERE role='superadmin' LIMIT 1`);
if (!saRow) {
  // Fresh DB — insert default superadmin
  const hash = bcrypt.hashSync(SA_DEFAULT_PASS, 10);
  await db.run(
    `INSERT INTO company_users (id,email,name,role,password_hash) VALUES (?,?,?,?,?)`,
    [uuid(), SA_DEFAULT_EMAIL, 'Super Admin', 'superadmin', hash]
  );
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  FuelOS — SuperAdmin Account Created          ║');
  console.log('║  Email:    superadmin@superadmin.com          ║');
  console.log('║  Password: super2025                          ║');
  console.log('║  Login and change these from My Account tab   ║');
  console.log('╚══════════════════════════════════════════════╝\n');
} else if (saRow.email !== SA_DEFAULT_EMAIL && !saRow._customised) {
  // Old deploy had different default email — migrate to new default
  // Only do this if the user hasn't customised their credentials yet
  const hash = bcrypt.hashSync(SA_DEFAULT_PASS, 10);
  await db.run(
    `UPDATE company_users SET email=?, password_hash=?, name='Super Admin' WHERE id=?`,
    [SA_DEFAULT_EMAIL, hash, saRow.id]
  );
  console.log(`[Auth] Migrated superadmin email to ${SA_DEFAULT_EMAIL}`);
}

// ── DB-backed OTP store (survives server restarts/Render spin-down)
await db.run(`CREATE TABLE IF NOT EXISTS otp_store (
  email   TEXT NOT NULL,
  role    TEXT NOT NULL,
  otp     TEXT NOT NULL,
  expires INTEGER NOT NULL,
  PRIMARY KEY (email, role)
)`).catch(()=>{});
// Clean expired OTPs on startup
await db.run(`DELETE FROM otp_store WHERE expires < ?`, [Date.now()]).catch(()=>{});

const otpStore = {
  async set(email, data) {
    await db.run(
      `INSERT OR REPLACE INTO otp_store (email, role, otp, expires) VALUES (?,?,?,?)`,
      [email, data.role, data.otp, data.expires]
    );
  },
  async find(role, otp) {
    // Find matching non-expired entry
    const row = await db.get(
      `SELECT * FROM otp_store WHERE role=? AND otp=? AND expires > ?`,
      [role, otp, Date.now()]
    );
    return row ? row.email : null;
  },
  async delete(email) {
    await db.run(`DELETE FROM otp_store WHERE email=?`, [email]);
  }
};

// ─────────────────────────────────────────────────────────
// POST /api/auth/login  — Owner / Manager / Operator
// ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password || !role)
      return res.status(400).json({ error: 'email, password and role required' });

    let user;
    if      (role === 'owner')    user = await db.get('SELECT * FROM owners    WHERE email=?', [email]);
    else if (role === 'manager')  user = await db.get('SELECT * FROM managers  WHERE email=?', [email]);
    else if (role === 'operator') user = await db.get('SELECT * FROM operators WHERE email=?', [email]);

    console.log(`[Login] role=${role} email=${email} found=${!!user} hash_prefix=${user?.password_hash?.slice(0,10)}`);

    if (!user) return res.status(401).json({ error: 'No account found with that email for role: ' + role });

    const isHashed = user.password_hash?.startsWith('$2b') || user.password_hash?.startsWith('$2a');
    let match = false;
    if (isHashed) {
      match = bcrypt.compareSync(password, user.password_hash);
    } else {
      // Plain text password (legacy seed data)
      match = user.password_hash === password;
    }

    console.log(`[Login] role=${role} email=${email} isHashed=${isHashed} match=${match}`);
    if (!match) {
      // If plain text in DB, auto-upgrade to bcrypt on next successful login attempt
      return res.status(401).json({ error: 'Password incorrect' });
    }

    // Auto-upgrade plain text passwords to bcrypt on successful login
    if (!isHashed) {
      const upgraded = bcrypt.hashSync(password, 10);
      const tbl = role === 'owner' ? 'owners' : role === 'manager' ? 'managers' : 'operators';
      await db.run(`UPDATE ${tbl} SET password_hash=? WHERE id=?`, [upgraded, user.id]).catch(()=>{});
      console.log(`[Login] Auto-upgraded password hash for ${email}`);
    }

    const table = role === 'owner' ? 'owners' : role === 'manager' ? 'managers' : 'operators';
    await db.run(`UPDATE ${table} SET last_login=datetime('now') WHERE id=?`, [user.id]).catch(()=>{});
    await db.run(
      `INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), email, role.charAt(0).toUpperCase()+role.slice(1), 'Login', req.ip]
    ).catch(()=>{});

    // Determine correct ownerId for the token
    let tokenOwnerId = user.owner_id || (role === 'owner' ? user.id : null);
    // For manager/operator: if owner_id not set, look up from pump
    if (!tokenOwnerId && (role === 'manager' || role === 'operator') && user.pump_id) {
      const pump = await db.get('SELECT owner_id FROM pumps WHERE id=?', [user.pump_id]).catch(()=>null);
      tokenOwnerId = pump?.owner_id;
    }
    if (!tokenOwnerId) tokenOwnerId = user.id; // last resort
    const token = signToken({ id: user.id, email: user.email, role, ownerId: tokenOwnerId, pumpId: user.pump_id });
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
    // Check if user has 2FA enabled — if yes, skip email OTP
    if (user.totp_enabled) {
      res.json({ success: true, two_fa: true });
      return;
    }

    await otpStore.set(email, { otp, role, expires: Date.now() + 30 * 60 * 1000 }); // 30min expiry
    console.log(`[OTP] ${role} / ${email} → ${otp}`);

    // Return OTP in response unless HIDE_OTP=true env var is set
    const hideOtp = process.env.HIDE_OTP === 'true';
    res.json({ success: true, two_fa: false, ...(!hideOtp ? { dev_otp: otp } : {}) });
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

    // Determine if this is a TOTP code (2FA) or email OTP
    // TOTP: user supplies email + 6-digit code from their app
    const { email: verifyEmail } = req.body;

    let user;
    let foundEmail;

    if (verifyEmail) {
      // 2FA path — verify TOTP against stored secret
      user = await db.get(
        `SELECT * FROM company_users WHERE email=? AND role=? AND status='Active'`,
        [verifyEmail, role]
      );
      if (!user) return res.status(401).json({ error: 'User not found' });

      if (user.totp_enabled) {
        const { authenticator } = await import('otplib');
        const validTotp = authenticator.check(otp, user.totp_secret);

        // Also allow backup codes
        let validBackup = false;
        if (!validTotp && user.totp_backup_codes) {
          const codes = JSON.parse(user.totp_backup_codes);
          const idx   = codes.indexOf(otp.toUpperCase());
          if (idx !== -1) {
            validBackup = true;
            codes.splice(idx, 1); // burn the used backup code
            await db.run(`UPDATE company_users SET totp_backup_codes=? WHERE id=?`,
              [JSON.stringify(codes), user.id]);
          }
        }
        if (!validTotp && !validBackup)
          return res.status(401).json({ error: 'Invalid authenticator code' });
        foundEmail = verifyEmail;
      } else {
        return res.status(400).json({ error: '2FA not enabled for this account' });
      }
    } else {
      // Email OTP path — look up from DB store
      foundEmail = await otpStore.find(role, otp);
      if (!foundEmail)
        return res.status(401).json({ error: 'Invalid or expired OTP. Request a new one.' });
      await otpStore.delete(foundEmail);

      user = await db.get(
        `SELECT * FROM company_users WHERE email=? AND role=?`,
        [foundEmail, role]
      );
    }
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

// Debug: show token contents + owner resolution
router.get('/me', async (req, res) => {
  try {
    const u = req.user;
    const ownerExists = u.ownerId ? await db.get('SELECT id,name,email FROM owners WHERE id=?', [u.ownerId]) : null;
    const pumpExists  = u.pumpId  ? await db.get('SELECT id,name,owner_id FROM pumps  WHERE id=?', [u.pumpId])  : null;
    res.json({
      token_contents: { id: u.id, email: u.email, role: u.role, ownerId: u.ownerId, pumpId: u.pumpId },
      owner_in_db: ownerExists,
      pump_in_db:  pumpExists,
      fk_will_work: !!ownerExists,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;

// ─────────────────────────────────────────────────────────
// GET /api/auth/debug-login  — TEMP: check what's in DB for an email
// Remove after debugging
// ─────────────────────────────────────────────────────────
router.get('/debug-login/:email', async (req, res) => {
  if (process.env.ALLOW_DEBUG !== 'true')
    return res.status(403).json({ error: 'Set ALLOW_DEBUG=true env var to enable' });
  try {
    const { email } = req.params;
    const { password } = req.query; // optional: pass ?password=xxx to test match
    const owner = await db.get('SELECT id,name,email,status,password_hash FROM owners WHERE email=?', [email]);
    const co    = await db.get('SELECT id,name,email,role,status,password_hash FROM company_users WHERE email=?', [email]);

    const fmt = (row) => {
      if (!row) return null;
      const isHashed = row.password_hash?.startsWith('$2b') || row.password_hash?.startsWith('$2a');
      const result = {
        id: row.id, name: row.name, email: row.email,
        status: row.status, role: row.role,
        hash_type: isHashed ? 'bcrypt' : 'plain_text',
        hash_prefix: row.password_hash?.slice(0, 15) + '...',
        hash_length: row.password_hash?.length,
      };
      if (password) {
        result.password_test = isHashed
          ? bcrypt.compareSync(password, row.password_hash)
          : row.password_hash === password;
      }
      return result;
    };

    const allOwners = await db.all('SELECT id,name,email,status FROM owners');
    res.json({
      searched_email: email,
      owner: fmt(owner),
      company_user: fmt(co),
      all_owners_in_db: allOwners.map(o => ({ id: o.id, name: o.name, email: o.email, status: o.status })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// GET /api/auth/reset-superadmin  — EMERGENCY: reset SA to defaults
// Only works if ALLOW_SA_RESET=true env var is set
// ─────────────────────────────────────────────────────────
router.get('/reset-superadmin', async (req, res) => {
  if (process.env.ALLOW_SA_RESET !== 'true')
    return res.status(403).json({ error: 'Set ALLOW_SA_RESET=true env var to enable this' });
  const hash = bcrypt.hashSync(SA_DEFAULT_PASS, 10);
  const saRow = await db.get(`SELECT id FROM company_users WHERE role='superadmin' LIMIT 1`);
  if (saRow) {
    await db.run(
      `UPDATE company_users SET email=?, password_hash=?, name='Super Admin', _customised=0 WHERE id=?`,
      [SA_DEFAULT_EMAIL, hash, saRow.id]
    );
  } else {
    await db.run(
      `INSERT INTO company_users (id,email,name,role,password_hash) VALUES (?,?,?,?,?)`,
      [uuid(), SA_DEFAULT_EMAIL, 'Super Admin', 'superadmin', hash]
    );
  }
  console.log('[Auth] SuperAdmin reset to defaults');
  res.json({ success: true, email: SA_DEFAULT_EMAIL, password: SA_DEFAULT_PASS });
});

// ─────────────────────────────────────────────────────────
// PATCH /api/auth/profile  — update own name/email
// ─────────────────────────────────────────────────────────
router.patch('/profile', authMiddleware, async (req, res) => {
  try {
    const { name, email } = req.body;
    const { id, role } = req.user;
    if (!['superadmin','admin','monitor','caller'].includes(role))
      return res.status(403).json({ error: 'Portal users only' });
    if (email) {
      const existing = await db.get(
        `SELECT id FROM company_users WHERE email=? AND id!=?`, [email, id]
      );
      if (existing) return res.status(409).json({ error: 'Email already in use' });
    }
    const updates = [];
    const params  = [];
    if (name)  { updates.push('name=?');  params.push(name);  }
    if (email) { updates.push('email=?'); params.push(email); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(id);
    updates.push('_customised=?');
    params.splice(params.length-1, 0, 1); // insert 1 before the id (last) param
    await db.run(`UPDATE company_users SET ${updates.join(',')} WHERE id=?`, params);
    const updated = await db.get(`SELECT id,email,name,role,status FROM company_users WHERE id=?`, [id]);
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), updated.email, role, 'Updated profile', req.ip]).catch(()=>{});
    // Return fresh token with new email
    const token = signToken({ id: updated.id, email: updated.email, role });
    res.json({ success: true, user: updated, token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/auth/password  — change own password
// ─────────────────────────────────────────────────────────
router.patch('/password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const { id, role } = req.user;
    if (!['superadmin','admin','monitor','caller'].includes(role))
      return res.status(403).json({ error: 'Portal users only' });
    if (!current_password || !new_password)
      return res.status(400).json({ error: 'current_password and new_password required' });
    if (new_password.length < 6)
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    const user = await db.get(`SELECT * FROM company_users WHERE id=?`, [id]);
    if (!bcrypt.compareSync(current_password, user.password_hash))
      return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = bcrypt.hashSync(new_password, 10);
    await db.run(`UPDATE company_users SET password_hash=? WHERE id=?`, [hash, id]);
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), user.email, role, 'Changed password', req.ip]).catch(()=>{});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// GET /api/auth/2fa/setup  — generate TOTP secret + QR code
// ─────────────────────────────────────────────────────────
router.get('/2fa/setup', authMiddleware, async (req, res) => {
  try {
    const { id, email, role } = req.user;
    if (!['superadmin','admin','monitor','caller'].includes(role))
      return res.status(403).json({ error: 'Portal users only' });

    const { authenticator } = await import('otplib');
    const QRCode = await import('qrcode');

    // Generate a new secret (don't save until verified)
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(email, 'FuelOS', secret);
    const qrDataUrl = await QRCode.default.toDataURL(otpauth);

    // Store pending secret temporarily (not active until confirmed)
    await db.run(
      `UPDATE company_users SET totp_pending=? WHERE id=?`, [secret, id]
    ).catch(async () => {
      // Column may not exist — add it
      await db.run(`ALTER TABLE company_users ADD COLUMN totp_pending TEXT`).catch(()=>{});
      await db.run(`ALTER TABLE company_users ADD COLUMN totp_secret TEXT`).catch(()=>{});
      await db.run(`ALTER TABLE company_users ADD COLUMN totp_enabled INTEGER DEFAULT 0`).catch(()=>{});
      await db.run(`ALTER TABLE company_users ADD COLUMN totp_backup_codes TEXT`).catch(()=>{});
      await db.run(`UPDATE company_users SET totp_pending=? WHERE id=?`, [secret, id]);
    });

    res.json({ secret, qr: qrDataUrl, otpauth });
  } catch (e) {
    console.error('[2FA Setup]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/2fa/enable  — confirm TOTP code → activate 2FA
// ─────────────────────────────────────────────────────────
router.post('/2fa/enable', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const { id, email, role } = req.user;
    if (!code) return res.status(400).json({ error: 'TOTP code required' });

    const { authenticator } = await import('otplib');
    const user = await db.get(`SELECT * FROM company_users WHERE id=?`, [id]);
    if (!user.totp_pending)
      return res.status(400).json({ error: 'No pending 2FA setup. Start setup first.' });

    const valid = authenticator.check(code, user.totp_pending);
    if (!valid) return res.status(401).json({ error: 'Invalid code — check your authenticator app' });

    // Generate 8 backup codes
    const backupCodes = Array.from({length:8}, () =>
      Math.random().toString(36).slice(2,8).toUpperCase()
    );

    await db.run(
      `UPDATE company_users SET totp_secret=?, totp_enabled=1, totp_pending=NULL, totp_backup_codes=? WHERE id=?`,
      [user.totp_pending, JSON.stringify(backupCodes), id]
    );
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), email, role, 'Enabled 2FA (TOTP)', req.ip]).catch(()=>{});

    res.json({ success: true, backup_codes: backupCodes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/2fa/disable  — turn off 2FA (requires password confirm)
// ─────────────────────────────────────────────────────────
router.post('/2fa/disable', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    const { id, email, role } = req.user;
    if (!password) return res.status(400).json({ error: 'Password required to disable 2FA' });
    const user = await db.get(`SELECT * FROM company_users WHERE id=?`, [id]);
    if (!bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Incorrect password' });
    await db.run(
      `UPDATE company_users SET totp_secret=NULL, totp_enabled=0, totp_pending=NULL, totp_backup_codes=NULL WHERE id=?`,
      [id]
    );
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), email, role, 'Disabled 2FA', req.ip]).catch(()=>{});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/2fa/regenerate-backup  — new backup codes
// ─────────────────────────────────────────────────────────
router.post('/2fa/regenerate-backup', authMiddleware, async (req, res) => {
  try {
    const { id, email, role } = req.user;
    const user = await db.get(`SELECT * FROM company_users WHERE id=?`, [id]);
    if (!user.totp_enabled) return res.status(400).json({ error: '2FA not enabled' });
    const backupCodes = Array.from({length:8}, () =>
      Math.random().toString(36).slice(2,8).toUpperCase()
    );
    await db.run(`UPDATE company_users SET totp_backup_codes=? WHERE id=?`,
      [JSON.stringify(backupCodes), id]);
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), email, role, 'Regenerated 2FA backup codes', req.ip]).catch(()=>{});
    res.json({ success: true, backup_codes: backupCodes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// GET /api/auth/2fa/status  — check if 2FA is enabled
// ─────────────────────────────────────────────────────────
router.get('/2fa/status', authMiddleware, async (req, res) => {
  try {
    const user = await db.get(
      `SELECT totp_enabled, totp_backup_codes FROM company_users WHERE id=?`,
      [req.user.id]
    );
    res.json({
      enabled: !!(user?.totp_enabled),
      backup_codes_count: user?.totp_backup_codes
        ? JSON.parse(user.totp_backup_codes).length : 0
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
