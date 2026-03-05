// ═══════════════════════════════════════════════════════════
// FuelOS v3 — WebSocket Manager
// Manages real-time connections for live dispenser data push
// Uses native ws library (no socket.io dependency needed)
// ═══════════════════════════════════════════════════════════
const WebSocket = require('ws');
const jwt       = require('jsonwebtoken');

let wss = null;

// Map: pumpId → Set of WebSocket clients watching that pump
const pumpSubscribers = new Map();
// Map: ownerId → Set of WebSocket clients (owner sees all their pumps)
const ownerSubscribers = new Map();

/**
 * Attach WebSocket server to an existing HTTP server.
 * Call this once from server.js after app.listen().
 */
function attach(httpServer) {
  wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws._pumpId  = null;
    ws._ownerId = null;
    ws._role    = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);

        // ── AUTH handshake: client sends { type:'auth', token:'Bearer ...' }
        if (msg.type === 'auth') {
          const token = (msg.token || '').replace('Bearer ', '');
          try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            ws._ownerId = String(decoded.owner_id || decoded.id);
            ws._pumpId  = decoded.pump_id || null;
            ws._role    = decoded.role;

            // Subscribe to owner-level events
            if (!ownerSubscribers.has(ws._ownerId)) ownerSubscribers.set(ws._ownerId, new Set());
            ownerSubscribers.get(ws._ownerId).add(ws);

            // Subscribe to pump-level events if manager/operator
            if (ws._pumpId) {
              if (!pumpSubscribers.has(ws._pumpId)) pumpSubscribers.set(ws._pumpId, new Set());
              pumpSubscribers.get(ws._pumpId).add(ws);
            }

            ws.send(JSON.stringify({ type: 'auth_ok', role: ws._role, pumpId: ws._pumpId }));
            console.log(`[WS] Auth OK — role:${ws._role} owner:${ws._ownerId} pump:${ws._pumpId||'all'}`);
          } catch {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
            ws.close();
          }
          return;
        }

        // ── Ping/pong keepalive
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          return;
        }

      } catch (e) {
        console.warn('[WS] Bad message:', e.message);
      }
    });

    ws.on('close', () => {
      if (ws._ownerId) {
        ownerSubscribers.get(ws._ownerId)?.delete(ws);
      }
      if (ws._pumpId) {
        pumpSubscribers.get(ws._pumpId)?.delete(ws);
      }
    });

    ws.on('error', (e) => console.warn('[WS] Client error:', e.message));
  });

  console.log('[FuelOS] ✓ WebSocket server ready on /ws');
  return wss;
}

/**
 * Broadcast a message to all clients watching a specific pump.
 * Also sends to the pump's owner (who subscribes at owner level).
 */
function broadcastToPump(pumpId, ownerId, payload) {
  const message = JSON.stringify(payload);
  let sent = 0;

  // Send to pump-specific subscribers (managers/operators at this pump)
  pumpSubscribers.get(pumpId)?.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) { ws.send(message); sent++; }
  });

  // Send to owner subscribers
  ownerSubscribers.get(String(ownerId))?.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) { ws.send(message); sent++; }
  });

  return sent;
}

/**
 * Send to all clients of a specific owner (cross-pump broadcast).
 */
function broadcastToOwner(ownerId, payload) {
  const message = JSON.stringify(payload);
  let sent = 0;
  ownerSubscribers.get(String(ownerId))?.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) { ws.send(message); sent++; }
  });
  return sent;
}

/**
 * Get live connection stats (for health endpoint).
 */
function stats() {
  let total = 0;
  ownerSubscribers.forEach(set => { total += set.size; });
  return {
    totalClients: total,
    pumpRooms: pumpSubscribers.size,
    ownerRooms: ownerSubscribers.size,
  };
}

module.exports = { attach, broadcastToPump, broadcastToOwner, stats };
