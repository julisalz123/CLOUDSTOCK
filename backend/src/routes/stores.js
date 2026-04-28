const router = require('express').Router();
const pool = require('../models/db');
const auth = require('../middleware/auth');
const tnService = require('../services/tiendanube');
const mlService = require('../services/mercadolibre');

// ============================================================
// TIENDANUBE
// ============================================================

// Conectar Tiendanube manualmente con store_id + access_token
router.post('/tiendanube', auth, async (req, res) => {
  try {
    const { storeId, accessToken, storeName } = req.body;
    if (!storeId || !accessToken) return res.status(400).json({ error: 'Faltan datos de TN' });

    // Valida que los datos funcionan
    try {
      await tnService.getAllProducts(storeId, accessToken);
    } catch (err) {
      console.error('Error validando TN:', err.response?.data || err.message);
      return res.status(400).json({ error: 'No se pudo conectar a Tiendanube. Verificá el Store ID y Access Token.' });
    }

    await pool.query(
      `INSERT INTO stores (user_id, platform, store_name, store_id, access_token, is_source)
       VALUES ($1, 'tiendanube', $2, $3, $4, true)
       ON CONFLICT DO NOTHING`,
      [req.userId, storeName || 'Mi Tiendanube', storeId, accessToken]
    );

    // Configura webhooks en TN
    const publicUrl = process.env.PUBLIC_URL;
    if (publicUrl) {
      await tnService.setupWebhooks(storeId, accessToken, publicUrl);
    }

    res.json({ ok: true, message: 'Tiendanube conectada exitosamente' });
  } catch (err) {
    console.error('Error conectando TN:', err);
    res.status(500).json({ error: 'Error al conectar Tiendanube' });
  }
});

// ============================================================
// MERCADO LIBRE - OAuth
// ============================================================

// Paso 1: genera la URL de autorización
router.get('/mercadolibre/url', auth, (req, res) => {
  const redirectUri = `${process.env.PUBLIC_URL}/api/stores/mercadolibre/callback`;
  const url = mlService.getOAuthUrl(redirectUri);
  res.json({ url });
});

// Paso 2: callback OAuth (MELI redirige acá)
router.get('/mercadolibre/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const userId = state;

    if (!code) return res.status(400).send('Código de autorización requerido');

    const redirectUri = `${process.env.PUBLIC_URL}/api/stores/mercadolibre/callback`;
    const tokens = await mlService.exchangeCode(code, redirectUri);
    await pool.query(
      `INSERT INTO ml_tokens (user_id, access_token, refresh_token, expires_at, ml_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         ml_user_id = EXCLUDED.ml_user_id,
         updated_at = NOW()`,
      [
        userId,
        tokens.access_token,
        tokens.refresh_token,
        new Date(Date.now() + tokens.expires_in * 1000),
        String(tokens.user_id),
      ]
    );

    await pool.query(
      `INSERT INTO stores (user_id, platform, store_name, store_id, is_source)
       VALUES ($1, 'mercadolibre', 'Mercado Libre', $2, false)
       ON CONFLICT DO NOTHING`,
      [userId, String(tokens.user_id)]
    );

    // Registra webhook en MELI
    await mlService.registerWebhook(userId, `${process.env.PUBLIC_URL}/webhooks/mercadolibre`);

    // Redirige al frontend con éxito
    res.redirect(`${process.env.FRONTEND_URL || ''}/?ml=connected`);
  } catch (err) {
    console.error('Error en OAuth MELI:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL || ''}/?ml=error`);
  }
});

// FIX: Desconectar Mercado Libre
router.delete('/mercadolibre', auth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM ml_tokens WHERE user_id = $1`, [req.userId]);
    await pool.query(`DELETE FROM stores WHERE user_id = $1 AND platform = 'mercadolibre'`, [req.userId]);
    res.json({ ok: true, message: 'Mercado Libre desconectado exitosamente' });
  } catch (err) {
    console.error('Error desconectando MELI:', err);
    res.status(500).json({ error: 'Error al desconectar Mercado Libre' });
  }
});

// Estado de las conexiones del usuario
router.get('/status', auth, async (req, res) => {
  try {
    const { rows: stores } = await pool.query(
      'SELECT platform, store_name, created_at FROM stores WHERE user_id = $1',
      [req.userId]
    );
    const { rows: mlTokens } = await pool.query(
      'SELECT ml_user_id, expires_at FROM ml_tokens WHERE user_id = $1',
      [req.userId]
    );
    res.json({
      tiendanube: stores.find(s => s.platform === 'tiendanube') || null,
      mercadolibre: mlTokens[0] || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener estado de conexiones' });
  }
});

module.exports = router;
