const express = require('express');
const cors    = require('cors');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');

const app     = express();
const PORT    = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json());
// Serve dashboard files from project root (index.html, style.css, script.js)
app.use(express.static(__dirname));

// ── Data Store ────────────────────────────────
const MAX_HISTORY = 200;
let store = {
  latest:  null,
  history: [],
  devices: {}
};

// ── Watering Config (editable from dashboard) ─
let config = {
  openThreshold:   40,
  wateringMinutes: 3
};

// ── Persistence (file-based, no extra deps) ───
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const saved = JSON.parse(raw);
      if (saved.store)  store  = { ...store,  ...saved.store  };
      if (saved.config) config = { ...config, ...saved.config };
      console.log(`[PERSIST] Loaded ${store.history.length} readings | config ${JSON.stringify(config)}`);
    }
  } catch (err) {
    console.warn('[PERSIST] Could not load state, starting fresh:', err.message);
  }
}

// Debounced write to avoid hammering the disk on every reading.
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ store, config }, null, 2));
    } catch (err) {
      console.warn('[PERSIST] Save failed:', err.message);
    }
  }, 1000);
}

// Load saved state before serving requests.
loadState();

// ── SSE Clients ───────────────────────────────
let clients = [];
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(c => { try { c.write(msg); return true; } catch { return false; } });
}

// ── Soil Moisture Level ───────────────────────
function soilLevel(moisture) {
  if (moisture < 20)                         return { label: 'Very Dry',    color: '#ff4757', icon: '🏜️'  };
  if (moisture >= 20 && moisture < 40)       return { label: 'Dry',         color: '#ff6b35', icon: '☀️'  };
  if (moisture >= 40 && moisture < 60)       return { label: 'Good',        color: '#2ed573', icon: '✅'  };
  if (moisture >= 60 && moisture < 80)       return { label: 'Moist',       color: '#00d2ff', icon: '💧'  };
  return                                            { label: 'Saturated',   color: '#7b2ff7', icon: '🌊' };
}

// ── GET /api/config ───────────────────────────
app.get('/api/config', (req, res) => {
  res.json(config);
});

// ── POST /api/config — Dashboard updates ──────
app.post('/api/config', (req, res) => {
  const { openThreshold, wateringMinutes } = req.body;

  if (openThreshold !== undefined)   config.openThreshold   = Math.max(5, Math.min(95, parseInt(openThreshold)));
  if (wateringMinutes !== undefined) config.wateringMinutes = Math.max(1, Math.min(60, parseInt(wateringMinutes)));

  console.log(`[CONFIG] Open <${config.openThreshold}% | Water ${config.wateringMinutes} min`);

  saveState();
  broadcast({ type: 'config', data: config });
  res.json({ ok: true, config });
});

// ── POST /api/sensor — receive from ESP32 ─────
app.post('/api/sensor', (req, res) => {
  const {
    raw, moisture, valve, device, threshold, wateringMinutes: wm,
    humidity, temperature, heatIndex
  } = req.body;

  if (moisture === undefined && humidity === undefined) {
    return res.status(400).json({ error: 'Missing moisture or humidity' });
  }

  const id      = device || 'ESP32';
  const ts      = new Date().toISOString();
  const level   = moisture !== undefined ? soilLevel(parseFloat(moisture)) : null;
  const reading = {
    device:      id,
    raw:         raw         !== undefined ? parseInt(raw)                  : null,
    moisture:    moisture    !== undefined ? parseFloat(moisture).toFixed(1) : null,
    valve:       valve       || 'CLOSE',
    level,
    // Optional DHT (air) readings — present when an ESP32_DHT device reports.
    humidity:    humidity    !== undefined ? parseFloat(humidity).toFixed(1)    : null,
    temperature: temperature !== undefined ? parseFloat(temperature).toFixed(1) : null,
    heatIndex:   heatIndex   !== undefined ? parseFloat(heatIndex).toFixed(1)   : null,
    config:      { ...config },
    timestamp:   ts
  };

  store.latest = reading;
  store.history.unshift(reading);
  if (store.history.length > MAX_HISTORY) store.history.pop();

  if (!store.devices[id]) store.devices[id] = { count: 0 };
  store.devices[id].count++;
  store.devices[id].lastSeen = ts;
  store.devices[id].latest   = reading;

  const mPart = reading.moisture !== null ? `Moisture: ${reading.moisture}% | Raw: ${raw} | ` : '';
  const dhtPart = reading.humidity !== null ? `H: ${reading.humidity}% T: ${reading.temperature}°C | ` : '';
  console.log(`[${ts}] ${id} — ${mPart}${dhtPart}Valve: ${valve}${level ? ' | ' + level.label : ''}`);

  saveState();
  broadcast({ type: 'reading', data: reading });
  res.json({ ok: true, reading, config });
});

// ── GET /api/data ─────────────────────────────
app.get('/api/data', (req, res) => res.json({ ...store, config }));

// ── SSE stream ────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',                'text/event-stream');
  res.setHeader('Cache-Control',               'no-cache');
  res.setHeader('Connection',                  'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'init', data: { ...store, config } })}\n\n`);
  clients.push(res);

  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
  req.on('close', () => { clearInterval(hb); clients = clients.filter(c => c !== res); });
});

// ── Local IP ──────────────────────────────────
function localIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces)
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}

app.listen(PORT, '0.0.0.0', () => {
  const ip = localIP();
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   🌱 Smart Sprinkler — Moisture Server 🌱       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Dashboard : http://localhost:${PORT}                ║`);
  console.log(`║  Network   : http://${ip}:${PORT}             ║`);
  console.log(`║  ESP32 URL : POST /api/sensor                   ║`);
  console.log(`║  Config    : GET  /api/config                   ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`👉 ESP32 serverUrl = "http://${ip}:${PORT}/api/sensor"`);
  console.log(`📋 Config: Open <${config.openThreshold}% | Water ${config.wateringMinutes} min`);
  console.log(`💾 State persisted to ${path.basename(DATA_FILE)}`);
  console.log('');
});
