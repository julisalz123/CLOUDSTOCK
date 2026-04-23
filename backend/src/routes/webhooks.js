const router = require('express').Router();
const crypto = require('crypto');
const pool = require('../models/db');
const syncEngine = require('../services/syncEngine');
const mlService = require('../services/mercadolibre');

// ============================================================
// WEBHOOK DE TIENDANUBE
// ============================================================
router.post('/tiendanube', async (req, res) => {
  // Responde rápido a TN (máximo 5 segundos)
  res.status(200).json({ ok: true });

  try {
    const event = req.body;
    if (!event) return;

    const storeId = String(req.headers['x-linkedstore'] || req.body.store_id || '');

    // Busca el usuario dueño de esta tienda
    const { rows: storeRows } = await pool.query(
      `SELECT user_id FROM stores WHERE store_id = $1 AND platform = 'tiendanube'`,
      [storeId]
    );
    if (!storeRows[0]) return;
    const userId = storeRows[0].user_id;

    const eventType = event.event;

    // Venta pagada en TN
    if (eventType === 'order/paid' || eventType === 'order/fulfilled') {
      const order = event.data || event;
      if (!order.products) return;

      const items = order.products.map(p => ({
        product_id: p.product_id,
        variant_id: p.variant_id,
        quantity: p.quantity,
      }));

      await syncEngine.handleTNSale(userId, String(order.id || ''), items);

      // Guarda la orden en nuestro sistema
      await pool.query(
        `INSERT INTO orders (user_id, platform, platform_order_id, status, customer_name, customer_email, total_amount, items, raw_data)
         VALUES ($1, 'tiendanube', $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [
          userId,
          String(order.id),
          order.status || 'paid',
          `${order.billing_name || ''} ${order.billing_last_name || ''}`.trim(),
          order.billing_email || '',
          order.price ? parseFloat(order.price) : null,
          JSON.stringify(items),
          JSON.stringify(order),
        ]
      );
    }

    // Cambio manual de stock en TN (restock u otro cambio)
    if (eventType === 'product/updated') {
      const product = event.data || event;
      if (!product.id || !product.variants) return;

      for (const variant of product.variants) {
        if (variant.stock !== undefined) {
          await syncEngine.handleTNStockUpdate(
            userId,
            String(product.id),
            String(variant.id),
            variant.stock
          );
        }
      }
    }

  } catch (err) {
    console.error('Error procesando webhook TN:', err);
  }
});

// ============================================================
// WEBHOOK DE MERCADO LIBRE
// ============================================================
router.post('/mercadolibre', async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const notification = req.body;
    if (!notification || notification.topic !== 'orders_v2') return;

    const resourceId = notification.resource?.split('/orders/')?.[1];
    if (!resourceId) return;

    // Identifica al usuario por el userId de MELI que viene en la notificación
    const mlUserId = String(notification.user_id || '');
    const { rows: tokenRows } = await pool.query(
      `SELECT user_id FROM ml_tokens WHERE ml_user_id = $1`,
      [mlUserId]
    );
    if (!tokenRows[0]) return;
    const userId = tokenRows[0].user_id;

    // Trae los detalles de la orden
    const order = await mlService.getOrder(userId, resourceId);
    if (!order || order.status !== 'paid') return;

    const items = (order.order_items || []).map(i => ({
      item_id: i.item?.id,
      variation_id: i.item?.variation_id || null,
      quantity: i.quantity,
    })).filter(i => i.item_id);

    if (items.length === 0) return;

    await syncEngine.handleMLSale(userId, String(order.id), items);

    // Guarda la orden
    await pool.query(
      `INSERT INTO orders (user_id, platform, platform_order_id, status, customer_name, customer_email, total_amount, items, raw_data)
       VALUES ($1, 'mercadolibre', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        userId,
        String(order.id),
        order.status,
        order.buyer ? `${order.buyer.first_name || ''} ${order.buyer.last_name || ''}`.trim() : '',
        order.buyer?.email || '',
        order.total_amount || null,
        JSON.stringify(items),
        JSON.stringify(order),
      ]
    );

  } catch (err) {
    console.error('Error procesando webhook MELI:', err);
  }
});

module.exports = router;
