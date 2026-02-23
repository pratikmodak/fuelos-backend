import { initDb } from '../db.js';
try { initDb(); console.log('✅ FuelOS database ready'); process.exit(0); }
catch(e) { console.error('❌', e.message); process.exit(1); }
