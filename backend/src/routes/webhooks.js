const router = require('express').Router();
const pool = require('../models/db');
const syncEngine = require('../services/syncEngine');
const mlService = require('../services/mercadolibre');

// ============================================================
// WEBHOOK DE TIENDANUBE
// ============================================================
router.post('/tiendanube', async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const event = req.body;
    if (!event) return;

    console.log('Webhook TN body:', JSON.stringify(req.body));
    const storeId = String(
      req.headers['x-linkedstore'] ||
      req.headers['x-store-id'] ||
      req.body.store_id ||
      req.body.store?.id ||
      ''
    );
    console.log('Store ID detectado:', storeId);

    const { rows: storeRows } = await pool.query(
      `SELECT user_id FROM stores WHERE store_id = $1 AND platform = 'tiendanube'`,
      [storeId]
    );
    if (!storeRows[0]) return;
    const userId = storeRows[0].user_id;

    const eventType = event.event;

    if (eventType === 'order/paid' || eventType === 'order/fulfilled' || eventType === 'order/created') {
      let order = event.data || event;

      if (!order.products || order.products.length === 0) {
        try {
          const { rows: tnStoreRows } = await pool.query(
            `SELECT * FROM stores WHERE user_id = $1 AND platform = 'tiendanube'`,
            [userId]
          );
          if (!tnStoreRows[0]) return;
          const axios = require('axios');
          const { data: fullOrder } = await axios.get(
            `https://api.tiendanube.com/v1/${tnStoreRows[0].store_id}/orders/${order.id}`,
            {
              headers: {
                'Authentication': `bearer ${tnStoreRows[0].access_token}`,
                'User-Agent': 'SyncStock/1.0',
              }
            }
          );
          order = fullOrder;
          console.log('Orden TN productos:', JSON.stringify(order?.products).substring(0, 500));
        } catch (err) {
          console.error('Error trayendo orden TN:', err.message);
          return;
        }
      }

      if (!order.products || order.products.length === 0) return;

      const { rows: existingTNOrder } = await pool.query(
        `SELECT id FROM orders WHERE platform_order_id = $1 AND platform = 'tiendanube'`,
        [String(order.id)]
      );
      if (existingTNOrder[0]) {
        console.log('Orden TN ya procesada, ignorando:', order.id);
        return;
      }

      const items = order.products.map(p => ({
        product_id: p.product_id,
        variant_id: p.variant_id,
        quantity: parseInt(p.quantity),
        sku: p.sku || null,
        product_name: p.name_without_variants || p.name || null,
        variant_values: p.variant_values || [],
        unit_price: p.price || null,
        image: p.image?.src || null,
      }));

      await syncEngine.handleTNSale(userId, String(order.id || ''), items);

      try {
        await pool.query(
          `INSERT INTO orders (user_id, platform, platform_order_id, status, customer_name, customer_email, total_amount, items, raw_data)
           VALUES ($1, 'tiendanube', $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (platform, platform_order_id)
           DO UPDATE SET status = EXCLUDED.status, items = EXCLUDED.items, raw_data = EXCLUDED.raw_data`,
          [
            userId,
            String(order.id),
            order.status || 'open',
            `${order.billing_name || ''} ${order.billing_last_name || ''}`.trim(),
            order.billing_email || '',
            order.price ? parseFloat(order.price) : null,
            JSON.stringify(items),
            JSON.stringify(order),
          ]
        );
      } catch (dbErr) {
        console.error('Error guardando orden TN en DB:', dbErr.message);
      }
    }

    if (eventType === 'product/updated') {
      const product = event.data || event;
      const productId = product.id || event.id;
      if (!productId) return;

      const { rows: storeRows2 } = await pool.query(
        `SELECT * FROM stores WHERE user_id = $1 AND platform = 'tiendanube'`,
        [userId]
      );
      if (!storeRows2[0]) return;

      try {
        const tnService = require('../services/tiendanube');
        const fullProduct = await tnService.getProduct(
          storeRows2[0].store_id,
          storeRows2[0].access_token,
          String(productId)
        );
        if (!fullProduct?.variants) return;

        for (const variant of fullProduct.variants) {
          if (variant.stock !== undefined && variant.stock !== null) {
            console.log(`Actualizando variante ${variant.id} stock: ${variant.stock}`);
            await syncEngine.handleTNStockUpdate(
              userId,
              String(productId),
              String(variant.id),
              variant.stock
            );
          }
        }
      } catch (err) {
        console.error('Error trayendo producto TN en webhook:', err.message);
      }
    }

    if (eventType === 'order/cancelled') {
      const order = event.data || event;
      await pool.query(
        `UPDATE orders SET status = 'cancelled' WHERE platform_order_id = $1 AND platform = 'tiendanube'`,
        [String(order.id)]
      );
      console.log('Orden TN cancelada:', order.id);
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

    const mlUserId = String(notification.user_id || '');
    const { rows: tokenRows } = await pool.query(
      `SELECT user_id FROM ml_tokens WHERE ml_user_id = $1`,
      [mlUserId]
    );
    if (!tokenRows[0]) return;
    const userId = tokenRows[0].user_id;

    // FIX: si el refresh token es null, no explotar sino loguear y salir limpio
    let order;
    try {
      order = await mlService.getOrder(userId, resourceId);
    } catch (err) {
      if (err.message === 'REAUTH_NEEDED') {
        console.error(`Token MELI invalido para userId ${userId}. El usuario debe reconectar su cuenta de MercadoLibre.`);
        return;
      }
      throw err;
    }

    if (!order) return;

    if (order.status === 'cancelled') {
      const { rows: cancelledOrder } = await pool.query(
        `SELECT id, items FROM orders WHERE platform_order_id = $1 AND platform = 'mercadolibre'`,
        [String(order.id)]
      );
      if (!cancelledOrder[0]) return;

      const { rows: tnRows } = await pool.query(
        `SELECT * FROM stores WHERE user_id = $1 AND platform = 'tiendanube'`, [userId]
      );
      if (!tnRows[0]) return;

      const tnService = require('../services/tiendanube');
      const items = JSON.parse(cancelledOrder[0].items || '[]');
      for (const item of items) {
        try {
          const { rows: mappings } = await pool.query(
            `SELECT * FROM product_mappings WHERE user_id = $1 AND ml_item_id = $2 AND is_active = true`,
            [userId, String(item.item_id)]
          );
          if (!mappings[0]) continue;
          const mapping = mappings[0];
          const newStock = (mapping.current_stock || 0) + item.quantity;
          await tnService.updateVariantStock(
            tnRows[0].store_id, tnRows[0].access_token,
            mapping.tn_product_id, mapping.tn_variant_id, newStock
          );
          await pool.query(
            `UPDATE product_mappings SET current_stock = $1, last_synced_at = NOW() WHERE id = $2`,
            [newStock, mapping.id]
          );
          await pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [cancelledOrder[0].id]);
          console.log(`Cancelacion MELI: +${item.quantity} en TN para ${mapping.sku}`);
        } catch (err) {
          console.error('Error cancelacion MELI:', err.message);
        }
      }
      return;
    }

    const { rows: existingMLOrder } = await pool.query(
      `SELECT id FROM orders WHERE platform_order_id = $1 AND platform = 'mercadolibre'`,
      [String(order.id)]
    );
    if (existingMLOrder[0]) {
      console.log('Orden MELI ya procesada, ignorando:', order.id);
      return;
    }

    if (order.status !== 'paid') return;

    const items = (order.order_items || []).map(i => ({
  item_id: i.item?.id,
  variation_id: i.item?.variation_id || null,
  quantity: i.quantity,
  product_name: i.item?.title || null,
  unit_price: i.unit_price || null,
  sku: i.item?.seller_custom_field || null,
})).filter(i => i.item_id);

    if (items.length === 0) return;

    await syncEngine.handleMLSale(userId, String(order.id), items);

    await pool.query(
      `INSERT INTO orders (user_id, platform, platform_order_id, status, customer_name, customer_email, total_amount, items, raw_data)
       VALUES ($1, 'mercadolibre', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (platform, platform_order_id) DO NOTHING`,
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
