const router = require('express').Router();
const pool = require('../models/db');
const auth = require('../middleware/auth');

// Lista de órdenes del usuario (ambos canales)
router.get('/', auth, async (req, res) => {
  try {
    const { platform, limit = 50, offset = 0 } = req.query;
    let query = `SELECT * FROM orders WHERE user_id = $1`;
    const params = [req.userId];

    if (platform) {
      query += ` AND platform = $${params.length + 1}`;
      params.push(platform);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await pool.query(query, params);

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM orders WHERE user_id = $1 ${platform ? `AND platform = '${platform}'` : ''}`,
      [req.userId]
    );

    res.json({ orders: rows, total: parseInt(countRows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Error al traer órdenes' });
  }
});

// Detalle de una orden
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM orders WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Orden no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al traer la orden' });
  }
});

// Resumen de ventas (dashboard)
router.get('/stats/summary', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
        platform,
        COUNT(*) as total_orders,
        SUM(total_amount) as total_revenue,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as last_7_days
       FROM orders
       WHERE user_id = $1
       GROUP BY platform`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al calcular estadísticas' });
  }
});

module.exports = router;
