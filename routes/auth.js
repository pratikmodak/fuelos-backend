// routes/auth.js — Authentication for all roles
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');

// ── Helper: generate 6-digit OTP
const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));

// ── Helper: send OTP via email (or just log in dev)
const sendOtp = async (email, otp) => {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    await transporter.sendMail({
      from: `FuelOS <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'FuelOS Admin OTP',
      html: `<p>Your FuelOS admin OTP is: <strong style="font-size:24px;letter-spacing:4px">${otp}</strong></p><p>Valid for 10 minutes.</p>`,
    });
  } else {
    // Dev mode: log to console (visible in Render logs)
    console.log(`[FuelOS OTP] ${email}: ${otp}`);
  }
};

// ════════════════════════════════════════════════
// POST /api/auth/login — Owner / Manager / Operator
// ════════════════════════════════════════════════
router.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password || !role) return res.status(400).json({ error: 'email, password, role required' });

    let user, tableName;

    if (role === 'owner') {
      const r = await db.query('SELECT * FROM owners WHERE LOWER(email)=LOWER($1)', [email]);
      user = r.rows[0];
      tableName = 'owners';
    } else if (role === 'manager') {
      const r = await db.query('SELECT * FROM managers WHERE LOWER(email)=LOWER($1)', [email]);
      user = r.rows[0];
      tableName = 'managers';
    } else if (role === 'operator') {
      const r = await db.query('SELECT * FROM operators WHERE LOWER(email)=LOWER($1)', [email]);
      user = r.rows[0];
      tableName = 'operators';
    } else {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (!user) return res.status(401).json({ error: 'No account found for this email and role' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid password' });

    if (user.status === 'Suspended') return res.status(403).json({ error: 'Account suspended' });

    const payload = {
      id: user.id,
      email: user.email,
      role,
      owner_id: role === 'owner' ? user.id : user.owner_id,
      pump_id: user.pump_id || null,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

    const userData = {
      id:          String(user.id),
      owner_id:    String(role === 'owner' ? user.id : user.owner_id),
      email:       user.email,
      name:        user.name,
      phone:       user.phone,
      role,
      pump_id:     user.pump_id || null,
      pumpId:      user.pump_id || null,
      plan:        user.plan || 'Starter',
      billing:     user.billing || 'monthly',
      status:      user.status || 'Active',
      shift:       user.shift,
      end_date:    user.end_date,
      whatsapp:    user.whatsapp,
      whatsapp_num: user.whatsapp_num,
      business_name: user.business_name,
      gst:         user.gst,
      pan:         user.pan,
      address:     user.address,
    };

    res.json({ token, role, user: userData });
  } catch (e) {
    console.error('[auth/login]', e);
    res.status(500).json({ error: 'Login failed: ' + e.message });
  }
});

// ════════════════════════════════════════════════
// POST /api/auth/admin-login — Step 1: Check creds, send OTP
// ════════════════════════════════════════════════
router.post('/admin-login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    let user;

    if (role === 'superadmin') {
      // Check against env vars for superadmin
      const saEmail = process.env.SUPERADMIN_EMAIL || 'superadmin@fuelos.in';
      const saPass  = process.env.SUPERADMIN_PASSWORD;
      if (email.toLowerCase() !== saEmail.toLowerCase()) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const valid = saPass ? password === saPass : false;
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

      // Check if superadmin exists in DB, create if not
      let saRow = (await db.query("SELECT * FROM company_users WHERE role='superadmin' LIMIT 1")).rows[0];
      if (!saRow) {
        const hash = await bcrypt.hash(saPass || 'changeme', 10);
        const r = await db.query(
          `INSERT INTO company_users (email,name,role,password) VALUES ($1,$2,'superadmin',$3) RETURNING *`,
          [saEmail, 'Super Admin', hash]
        );
        saRow = r.rows[0];
      }
      user = saRow;
    } else {
      const r = await db.query(
        'SELECT * FROM company_users WHERE LOWER(email)=LOWER($1) AND role=$2',
        [email, role]
      );
      user = r.rows[0];
      if (!user) return res.status(401).json({ error: 'No account found for this role' });
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    }

    // If 2FA enabled, skip OTP
    if (user.two_fa_enabled) {
      // Store temp session
      await db.query(
        `UPDATE company_users SET otp_expires=$1 WHERE id=$2`,
        [new Date(Date.now() + 10 * 60 * 1000), user.id]
      );
      return res.json({ two_fa: true, user_id: user.id, role });
    }

    // Generate and send OTP
    const otp = genOtp();
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await db.query(
      `UPDATE company_users SET otp_code=$1, otp_expires=$2 WHERE id=$3`,
      [otp, expires, user.id]
    );

    await sendOtp(user.email, otp);

    res.json({
      message: 'OTP sent',
      role,
      // Return OTP in dev mode only
      dev_otp: process.env.NODE_ENV !== 'production' ? otp : undefined,
    });
  } catch (e) {
    console.error('[auth/admin-login]', e);
    res.status(500).json({ error: 'Login failed: ' + e.message });
  }
});

// ════════════════════════════════════════════════
// POST /api/auth/admin-verify — Step 2: Verify OTP or 2FA code
// ════════════════════════════════════════════════
router.post('/admin-verify', async (req, res) => {
  try {
    const { otp, role } = req.body;
    if (!otp) return res.status(400).json({ error: 'OTP required' });

    // Find user by pending OTP or 2FA
    let user;

    if (role === 'superadmin') {
      const r = await db.query("SELECT * FROM company_users WHERE role='superadmin' LIMIT 1");
      user = r.rows[0];
    } else {
      // Find by role and valid OTP
      const r = await db.query(
        `SELECT * FROM company_users WHERE role=$1 AND otp_expires > NOW() LIMIT 1`,
        [role]
      );
      user = r.rows[0];
    }

    if (!user) return res.status(401).json({ error: 'No pending verification for this role' });

    let valid = false;

    if (user.two_fa_enabled && user.two_fa_secret) {
      // Verify TOTP code
      valid = speakeasy.totp.verify({
        secret: user.two_fa_secret,
        encoding: 'base32',
        token: otp,
        window: 1,
      });
    } else {
      // Verify OTP
      if (user.otp_expires && new Date(user.otp_expires) < new Date()) {
        return res.status(401).json({ error: 'OTP expired' });
      }
      valid = user.otp_code === otp;
    }

    if (!valid) return res.status(401).json({ error: 'Invalid code' });

    // Clear OTP
    await db.query(
      `UPDATE company_users SET otp_code=NULL, otp_expires=NULL, last_login=NOW() WHERE id=$1`,
      [user.id]
    );

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      token,
      role: user.role,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (e) {
    console.error('[auth/admin-verify]', e);
    res.status(500).json({ error: 'Verification failed: ' + e.message });
  }
});

// ════════════════════════════════════════════════
// GET /api/auth/me — Current user info
// ════════════════════════════════════════════════
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { id, role } = req.user;
    let user;
    if (role === 'owner') {
      const r = await db.query('SELECT * FROM owners WHERE id=$1', [id]);
      user = r.rows[0];
    } else if (role === 'manager') {
      const r = await db.query('SELECT * FROM managers WHERE id=$1', [id]);
      user = r.rows[0];
    } else if (role === 'operator') {
      const r = await db.query('SELECT * FROM operators WHERE id=$1', [id]);
      user = r.rows[0];
    }
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ ...user, role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// PATCH /api/auth/profile — Update profile
// ════════════════════════════════════════════════
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { name, phone, business_name, gst, pan, address } = req.body;
    const { id, role } = req.user;
    const table = role === 'owner' ? 'owners' : role === 'manager' ? 'managers' : 'operators';
    await db.query(
      `UPDATE ${table} SET name=COALESCE($1,name), phone=COALESCE($2,phone), updated_at=NOW() WHERE id=$3`,
      [name, phone, id]
    );
    if (role === 'owner') {
      await db.query(
        `UPDATE owners SET business_name=COALESCE($1,business_name), gst=COALESCE($2,gst), pan=COALESCE($3,pan), address=COALESCE($4,address) WHERE id=$5`,
        [business_name, gst, pan, address, id]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// PATCH /api/auth/password — Change password
// ════════════════════════════════════════════════
router.patch('/password', requireAuth, async (req, res) => {
  try {
    const { current, newPassword } = req.body;
    const { id, role } = req.user;
    const table = role === 'owner' ? 'owners' : role === 'manager' ? 'managers' : 'operators';
    const r = await db.query(`SELECT password FROM ${table} WHERE id=$1`, [id]);
    const valid = await bcrypt.compare(current, r.rows[0]?.password || '');
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query(`UPDATE ${table} SET password=$1, updated_at=NOW() WHERE id=$2`, [hash, id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// 2FA ROUTES (admin only)
// ════════════════════════════════════════════════
router.get('/2fa/status', requireAdmin, async (req, res) => {
  try {
    const r = await db.query('SELECT two_fa_enabled, backup_codes FROM company_users WHERE id=$1', [req.user.id]);
    const u = r.rows[0];
    res.json({ enabled: u?.two_fa_enabled || false, backup_codes_count: (u?.backup_codes || []).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/2fa/setup', requireAdmin, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({ name: `FuelOS (${req.user.email})`, length: 20 });
    const qr = await QRCode.toDataURL(secret.otpauth_url);
    // Store temp secret (not enabled yet)
    await db.query('UPDATE company_users SET two_fa_secret=$1 WHERE id=$2', [secret.base32, req.user.id]);
    res.json({ qr, secret: secret.base32 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/2fa/enable', requireAdmin, async (req, res) => {
  try {
    const { code } = req.body;
    const r = await db.query('SELECT two_fa_secret FROM company_users WHERE id=$1', [req.user.id]);
    const valid = speakeasy.totp.verify({ secret: r.rows[0].two_fa_secret, encoding: 'base32', token: code, window: 1 });
    if (!valid) return res.status(400).json({ error: 'Invalid code' });
    const backupCodes = Array.from({ length: 10 }, () => uuidv4().replace(/-/g, '').slice(0, 8));
    const hashed = await Promise.all(backupCodes.map(c => bcrypt.hash(c, 8)));
    await db.query('UPDATE company_users SET two_fa_enabled=TRUE, backup_codes=$1 WHERE id=$2', [hashed, req.user.id]);
    res.json({ ok: true, backup_codes: backupCodes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/2fa/disable', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    const r = await db.query('SELECT password FROM company_users WHERE id=$1', [req.user.id]);
    const valid = await bcrypt.compare(password, r.rows[0].password);
    if (!valid) return res.status(401).json({ error: 'Invalid password' });
    await db.query('UPDATE company_users SET two_fa_enabled=FALSE, two_fa_secret=NULL, backup_codes=NULL WHERE id=$1', [req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
// COMPANY USERS (SuperAdmin manages Admin/Monitor/Caller)
// ════════════════════════════════════════════════
router.get('/company-users', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, email, name, role, last_login, created_at, two_fa_enabled FROM company_users WHERE role != 'superadmin' ORDER BY created_at DESC`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/company-users', requireSuperAdmin, async (req, res) => {
  try {
    const { email, name, role, password } = req.body;
    if (!['admin','monitor','caller'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const hash = await bcrypt.hash(password, 10);
    const r = await db.query(
      `INSERT INTO company_users (email,name,role,password) VALUES ($1,$2,$3,$4) RETURNING id,email,name,role`,
      [email, name, role, hash]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/company-users/:id', requireSuperAdmin, async (req, res) => {
  try {
    await db.query("DELETE FROM company_users WHERE id=$1 AND role!='superadmin'", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/company-users/:id/password', requireSuperAdmin, async (req, res) => {
  try {
    const hash = await bcrypt.hash(req.body.password, 10);
    await db.query('UPDATE company_users SET password=$1 WHERE id=$2', [hash, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
