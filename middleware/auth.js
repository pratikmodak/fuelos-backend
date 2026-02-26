// middleware/auth.js — JWT verification middleware
const jwt = require('jsonwebtoken');

// Verify owner/manager/operator token
const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Verify admin/superadmin/monitor/caller token
const requireAdmin = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (!['superadmin','admin','monitor','caller'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Require superadmin role specifically
const requireSuperAdmin = (req, res, next) => {
  requireAdmin(req, res, () => {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'SuperAdmin access required' });
    }
    next();
  });
};

// Require owner role
const requireOwner = (req, res, next) => {
  requireAuth(req, res, () => {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Owner access required' });
    }
    next();
  });
};

// Allow either owner or admin token (for shared routes)
const requireAuthOrAdmin = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    // Try owner JWT first
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    try {
      // Try admin JWT
      req.user = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  }
};

module.exports = { requireAuth, requireAdmin, requireSuperAdmin, requireOwner, requireAuthOrAdmin };
