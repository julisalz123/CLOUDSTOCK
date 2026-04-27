require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
// ============================================================
// CORS
// ============================================================
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));

// ============================================================
// BODY PARSING
// Los webhooks necesitan el raw body para validar firmas
// ============================================================
app.use('/webhooks', express.raw({ type: '*/*' }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
    try { req.body = JSON.parse(req.body.toString()); } catch { req.body = {}; }
  }
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// RATE LIMITING
// ============================================================
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
});
app.use('/api', limiter);

// ============================================================
// RUTAS
// ============================================================
app.use('/api/auth', require('./routes/auth'));
app.use('/api/stores', require('./routes/stores'));
app.use('/api/products', require('./routes/products'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api', require('./routes/catalog'));
app.use('/webhooks', require('./routes/webhooks'));

// Health check para Railway
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ============================================================
// INICIO
// ============================================================
const PORT = process.env.PORT || 3001;

// Refresca el token de MELI cada 4 horas automáticamente
setInterval(async () => {
  try {
    const db = require('./models/db');
    const { refreshMLToken } = require('./services/mercadolibre');
    const { rows } = await db.query('SELECT user_id FROM ml_tokens');
    for (const row of rows) {
      await refreshMLToken(row.user_id);
      console.log(`Token MELI refrescado automáticamente para user ${row.user_id}`);
    }
  } catch (err) {
    console.error('Error en refresh automático de MELI:', err.message);
  }
}, 4 * 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SyncStock backend corriendo en puerto ${PORT}`);
  console.log(`📦 Entorno: ${process.env.NODE_ENV || 'development'}`);
});
