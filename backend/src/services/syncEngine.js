/**
 * SYNC ENGINE — Lógica central de sincronización de stock
 * 
 * Regla fundamental:
 * - Tiendanube es SIEMPRE la fuente de verdad del stock
 * - MELI recibe el stock de TN, nunca al revés
 * - Si hay una venta en MELI → resta en TN → TN actualiza MELI
 * - Si hay un cambio manual en MELI → se IGNORA
 * - Si hay un cambio manual en TN (restock) → actualiza MELI
 *
 * IMPORTANTE: antes de calcular cualquier resta, siempre se consulta
 * el stock REAL de TN en vivo (nunca el "current_stock" cacheado en la DB),
 * para que ninguna caída de servidor, corrección manual o drift histórico
 * pueda generar cálculos incorrectos.
 */

const pool = require('../models/db');
const tnService = require('./tiendanube');
const mlService = require('./mercadolibre');

const pendingMLUpdates = new Set();

// Sincronización inicial: trae stock de TN y lo vuelca en MELI
async function initialSync(userId) {
  const { rows: mappings } = await pool.query(
    `SELECT * FROM product_mappings WHERE user_id = $1 AND is_active = true`,
    [userId]
  );

  const { rows: storeRows } = await pool.query(
    `SELECT * FROM stores WHERE user_id = $1 AND platform = 'tiendanube'`,
    [userId]
  );
  if (!storeRows[0]) throw new Error('No hay tienda TN configurada');
  const tnStore = storeRows[0];

  const results = { synced: 0, errors: [] };

  for (const mapping of mappings) {
    try {
      const tnStock = await tnService.getVariantStock(
        tnStore.store_id,
        tnStore.access_token,
        mapping.tn_product_id,
        mapping.tn_variant_id
      );

      let isFull = false;
      try {
        await mlService.updateStock(
          userId,
          mapping.ml_item_id,
          tnStock,
          mapping.ml_variation_id || null
        );
      } catch (err) {
        if (err.response?.status === 400) {
          isFull = true;
        } else {
          throw err;
        }
      }

      await pool.query(
        `UPDATE product_mappings 
         SET current_stock = $1, last_synced_at = NOW()
         WHERE id = $2`,
        [tnStock, mapping.id]
      );

      await logSync({
        userId,
        mappingId: mapping.id,
        eventType: isFull ? 'sync_skipped_full' : 'initial_sync',
        sourcePlatform: 'tiendanube',
        previousStock: null,
        newStock: tnStock,
        quantityChanged: null,
      });

      results.synced++;
    } catch (err) {
      console.error(`Error sincronizando mapping ${mapping.id}:`, err.message);
      results.errors.push({ mappingId: mapping.id, sku: mapping.sku, error: err.message });
    }
  }

  return results;
}

// Procesa una venta en TIENDANUBE
// → TN ya restó su propio stock (es la fuente de verdad) → leemos ese valor real y lo empujamos a MELI
async function handleTNSale(userId, orderId, orderItems) {
  const { rows: storeRows } = await pool.query(
    `SELECT * FROM stores WHERE user_id = $1 AND platform = 'tiendanube'`,
    [userId]
  );
  if (!storeRows[0]) return;
  const tnStore = storeRows[0];

  for (const item of orderItems) {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM product_mappings 
         WHERE user_id = $1 
         AND tn_product_id = $2 
         AND tn_variant_id = $3 
         AND is_active = true`,
        [userId, String(item.product_id), String(item.variant_id)]
      );
      if (!rows[0]) continue;

      const mapping = rows[0];
      const previousStock = mapping.current_stock;

      // Leemos el stock REAL y actual de TN (TN ya aplicó la venta, es la verdad)
      const tnStock = await tnService.getVariantStock(
        tnStore.store_id, tnStore.access_token,
        mapping.tn_product_id, mapping.tn_variant_id
      );

      const updateKey = `${mapping.ml_item_id}_${tnStock}`;
      pendingMLUpdates.add(updateKey);
      setTimeout(() => pendingMLUpdates.delete(updateKey), 30000);

      let isFull = false;
      try {
        await mlService.updateStock(
          userId,
          mapping.ml_item_id,
          tnStock,
          mapping.ml_variation_id || null
        );
      } catch (err) {
        if (err.response?.status === 400) {
          isFull = true;
        } else {
          throw err;
        }
      }

      await pool.query(
        `UPDATE product_mappings SET current_stock = $1, last_synced_at = NOW() WHERE id = $2`,
        [tnStock, mapping.id]
      );

      await logSync({
        userId,
        mappingId: mapping.id,
        eventType: isFull ? 'sync_skipped_full' : 'sale_tn',
        sourcePlatform: 'tiendanube',
        previousStock,
        newStock: tnStock,
        quantityChanged: tnStock - previousStock,
        orderId,
      });

    } catch (err) {
      console.error(`Error procesando venta TN para producto ${item.product_id}:`, err.message);
    }
  }
}

// Procesa una venta en MERCADO LIBRE
// → SIEMPRE lee el stock real y actual de TN antes de restar (nunca confía en el cache)
async function handleMLSale(userId, orderId, mlItems, isFulfillment = false) {
  const { rows: storeRows } = await pool.query(
    `SELECT * FROM stores WHERE user_id = $1 AND platform = 'tiendanube'`,
    [userId]
  );
  if (!storeRows[0]) {
    throw new Error('No hay tienda TN configurada para este usuario');
  }
  const tnStore = storeRows[0];
  const errors = [];

  for (const item of mlItems) {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM product_mappings 
         WHERE user_id = $1 AND ml_item_id = $2 AND is_active = true`,
        [userId, String(item.item_id)]
      );
      if (!rows[0]) {
        console.error(`ALERTA: no se encontró mapeo para ml_item_id=${item.item_id} (orden ${orderId}). Venta NO reflejada en TN.`);
        errors.push({ item_id: item.item_id, error: 'mapeo no encontrado' });
        continue;
      }

      const mapping = rows[0];

      if (isFulfillment) {
        await logSync({
          userId, mappingId: mapping.id, eventType: 'sale_ml_full_skipped',
          sourcePlatform: 'mercadolibre', previousStock: mapping.current_stock,
          newStock: mapping.current_stock, quantityChanged: 0, orderId,
          details: { note: 'Venta Full, no se descuenta TN', quantity: item.quantity },
        });
        continue;
      }

      // CLAVE: leemos el stock REAL de TN ahora mismo, no el cacheado en nuestra DB.
      // Esto evita que cualquier drift (caídas de servidor, correcciones manuales, etc.)
      // genere cálculos incorrectos.
      const realTnStock = await tnService.getVariantStock(
        tnStore.store_id, tnStore.access_token,
        mapping.tn_product_id, mapping.tn_variant_id
      );

      const newStock = Math.max(0, realTnStock - item.quantity);

      // CANDADO: una venta jamás debe dejar el stock igual o mayor al real actual
      if (newStock >= realTnStock && realTnStock > 0) {
        console.error(`BLOQUEADO: venta ML orden ${orderId} intentó dejar stock >= real (mapping ${mapping.id}, real=${realTnStock}, calc=${newStock})`);
        await logSync({
          userId, mappingId: mapping.id, eventType: 'sale_ml_blocked_suspicious',
          sourcePlatform: 'mercadolibre', previousStock: realTnStock, newStock: realTnStock,
          quantityChanged: 0, orderId,
          details: { note: 'Bloqueado: el cálculo no representaba una baja de stock', quantity: item.quantity },
        });
        continue;
      }

      await tnService.updateVariantStock(
        tnStore.store_id, tnStore.access_token,
        mapping.tn_product_id, mapping.tn_variant_id, newStock
      );

      await pool.query(
        `UPDATE product_mappings SET current_stock = $1, last_synced_at = NOW() WHERE id = $2`,
        [newStock, mapping.id]
      );

      await logSync({
        userId, mappingId: mapping.id, eventType: 'sale_ml', sourcePlatform: 'mercadolibre',
        previousStock: realTnStock, newStock, quantityChanged: -item.quantity, orderId,
      });

    } catch (err) {
      console.error(`Error procesando venta ML para ítem ${item.item_id} (orden ${orderId}):`, err.message);
      errors.push({ item_id: item.item_id, error: err.message });
    }
  }

  if (errors.length > 0) {
    throw new Error(`Fallaron ${errors.length} ítem(s) de la orden ${orderId}: ${JSON.stringify(errors)}`);
  }
}

// Procesa un cambio de stock en TN (restock manual o cambio de producto)
async function handleTNStockUpdate(userId, productId, variantId, newStock) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM product_mappings 
       WHERE user_id = $1 AND tn_product_id = $2 AND tn_variant_id = $3 AND is_active = true`,
      [userId, String(productId), String(variantId)]
    );
    if (!rows[0]) return;

    const mapping = rows[0];
    const previousStock = mapping.current_stock;

    if (newStock === previousStock) return;

    let isFull = false;
    const updateKey = `${mapping.ml_item_id}_${newStock}`;
    pendingMLUpdates.add(updateKey);
    setTimeout(() => pendingMLUpdates.delete(updateKey), 30000);

    try {
      await mlService.updateStock(
        userId,
        mapping.ml_item_id,
        newStock,
        mapping.ml_variation_id || null
      );
    } catch (err) {
      if (err.response?.status === 400) {
        isFull = true;
      } else {
        throw err;
      }
    }

    await pool.query(
      `UPDATE product_mappings SET current_stock = $1, last_synced_at = NOW() WHERE id = $2`,
      [newStock, mapping.id]
    );

    await logSync({
      userId,
      mappingId: mapping.id,
      eventType: isFull ? 'sync_skipped_full' : 'manual_update_tn',
      sourcePlatform: 'tiendanube',
      previousStock,
      newStock,
      quantityChanged: newStock - previousStock,
      details: isFull ? { note: 'Item en logística FULL: no se pisó MELI, solo se actualizó el registro interno' } : undefined,
    });

  } catch (err) {
    console.error(`Error procesando update de TN para ${productId}/${variantId}:`, err.message);
  }
}

function isOurMLUpdate(itemId, stock) {
  return pendingMLUpdates.has(`${itemId}_${stock}`);
}

async function logSync({ userId, mappingId, eventType, sourcePlatform, previousStock, newStock, quantityChanged, orderId, details }) {
  await pool.query(
    `INSERT INTO sync_logs 
     (user_id, mapping_id, event_type, source_platform, previous_stock, new_stock, quantity_changed, order_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [userId, mappingId, eventType, sourcePlatform, previousStock, newStock, quantityChanged, orderId || null, details ? JSON.stringify(details) : null]
  );
}

async function createMapping(userId, { sku, tnProductId, tnVariantId, mlItemId, mlVariationId, tnProductName, mlItemName }) {
  const { rows } = await pool.query(
    `INSERT INTO product_mappings 
     (user_id, sku, tn_product_id, tn_variant_id, ml_item_id, ml_variation_id, tn_product_name, ml_item_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, sku) DO UPDATE SET
       tn_product_id = EXCLUDED.tn_product_id,
       tn_variant_id = EXCLUDED.tn_variant_id,
       ml_item_id = EXCLUDED.ml_item_id,
       ml_variation_id = EXCLUDED.ml_variation_id,
       tn_product_name = EXCLUDED.tn_product_name,
       ml_item_name = EXCLUDED.ml_item_name,
       is_active = true
     RETURNING *`,
    [userId, sku, tnProductId, tnVariantId, mlItemId, mlVariationId || null, tnProductName, mlItemName]
  );
  return rows[0];
}

module.exports = {
  initialSync,
  handleTNSale,
  handleMLSale,
  handleTNStockUpdate,
  isOurMLUpdate,
  createMapping,
  logSync,
};
