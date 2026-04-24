/**
 * SYNC ENGINE — Lógica central de sincronización de stock
 * 
 * Regla fundamental:
 * - Tiendanube es SIEMPRE la fuente de verdad del stock
 * - MELI recibe el stock de TN, nunca al revés
 * - Si hay una venta en MELI → resta en TN → TN actualiza MELI
 * - Si hay un cambio manual en MELI → se IGNORA
 * - Si hay un cambio manual en TN (restock) → actualiza MELI
 */

const pool = require('../models/db');
const tnService = require('./tiendanube');
const mlService = require('./mercadolibre');

// Flag interno para evitar loops: cuando nosotros actualizamos MELI,
// ignoramos el webhook de cambio que MELI nos enviaría de vuelta
const pendingMLUpdates = new Set();

// Sincronización inicial: trae stock de TN y lo vuelca en MELI
// Borra el stock ficticio de MELI y pone el real de TN
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
      // 1. Lee el stock REAL de TN
      const tnStock = await tnService.getVariantStock(
        tnStore.store_id,
        tnStore.access_token,
        mapping.tn_product_id,
        mapping.tn_variant_id
      );

      // 2. Actualiza MELI con el stock de TN (borrando el ficticio)
      try {
  await mlService.updateStock(
    userId,
    mapping.ml_item_id,
    tnStock,
    mapping.ml_variation_id || null
  );
} catch (err) {
  if (err.response?.status === 400) {
    const errData = err.response?.data;
    // Si el ítem está cerrado, ignorar silenciosamente
    if (errData?.error === 'validation_error' && 
        errData?.message?.includes('closed')) {
      console.log(`Ítem MELI cerrado, ignorando: ${mapping.ml_item_id}`);
results.errors.push({ mappingId: mapping.id, sku: mapping.sku, error: 'item_closed' });
      return;
    }
    console.error('400 MELI:', JSON.stringify(errData));
    try {
      await mlService.updateStock(userId, mapping.ml_item_id, newStock, null);
    } catch (err2) {
      console.error('400 MELI fallback:', JSON.stringify(err2.response?.data));
      throw err2;
    }
  } else {
    throw err;
  }
}

      // 3. Actualiza nuestro registro interno
      await pool.query(
        `UPDATE product_mappings 
         SET current_stock = $1, last_synced_at = NOW()
         WHERE id = $2`,
        [tnStock, mapping.id]
      );

      // 4. Registra en el log
      await logSync({
        userId,
        mappingId: mapping.id,
        eventType: 'initial_sync',
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
// → busca si hay mapeo → resta en TN (ya lo hizo TN) → actualiza MELI
async function handleTNSale(userId, orderId, orderItems) {
  for (const item of orderItems) {
    try {
      // Busca el mapeo por product_id/variant_id de TN
      const { rows } = await pool.query(
        `SELECT * FROM product_mappings 
         WHERE user_id = $1 
         AND tn_product_id = $2 
         AND tn_variant_id = $3 
         AND is_active = true`,
        [userId, String(item.product_id), String(item.variant_id)]
      );
      if (!rows[0]) continue; // Este producto no está sincronizado

      const mapping = rows[0];
      const previousStock = mapping.current_stock;
      const newStock = Math.max(0, previousStock - item.quantity);

      // Marca el update como "nuestro" para ignorar el webhook de MELI
      const updateKey = `${mapping.ml_item_id}_${newStock}`;
      pendingMLUpdates.add(updateKey);
      setTimeout(() => pendingMLUpdates.delete(updateKey), 30000);

      // Actualiza MELI
      try {
  await mlService.updateStock(
    userId,
    mapping.ml_item_id,
    newStock,
    mapping.ml_variation_id || null
  );
} catch (err) {
  if (err.response?.status === 400) {
    const errData = err.response?.data;
    // Si el ítem está cerrado, ignorar silenciosamente
    if (errData?.error === 'validation_error' && 
        errData?.message?.includes('closed')) {
      console.log(`Ítem MELI cerrado, ignorando: ${mapping.ml_item_id}`);
      return;
    }
    console.error('400 MELI:', JSON.stringify(errData));
    try {
      await mlService.updateStock(userId, mapping.ml_item_id, newStock, null);
    } catch (err2) {
      console.error('400 MELI fallback:', JSON.stringify(err2.response?.data));
      throw err2;
    }
  } else {
    throw err;
  }
}

      // Actualiza nuestro registro
      await pool.query(
        `UPDATE product_mappings SET current_stock = $1, last_synced_at = NOW() WHERE id = $2`,
        [newStock, mapping.id]
      );

      await logSync({
        userId,
        mappingId: mapping.id,
        eventType: 'sale_tn',
        sourcePlatform: 'tiendanube',
        previousStock,
        newStock,
        quantityChanged: -item.quantity,
        orderId,
      });

    } catch (err) {
      console.error(`Error procesando venta TN para producto ${item.product_id}:`, err.message);
    }
  }
}

// Procesa una venta en MERCADO LIBRE
// → busca mapeo → resta en TN → MELI ya lo descontó solo → actualiza nuestro registro
async function handleMLSale(userId, orderId, mlItems) {
  const { rows: storeRows } = await pool.query(
    `SELECT * FROM stores WHERE user_id = $1 AND platform = 'tiendanube'`,
    [userId]
  );
  if (!storeRows[0]) return;
  const tnStore = storeRows[0];

  for (const item of mlItems) {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM product_mappings 
         WHERE user_id = $1 
         AND ml_item_id = $2 
         AND is_active = true`,
        [userId, String(item.item_id)]
      );
      if (!rows[0]) continue;

      const mapping = rows[0];
      const previousStock = mapping.current_stock;
      const newStock = Math.max(0, previousStock - item.quantity);

      // Resta en TN (el stock real)
      await tnService.updateVariantStock(
        tnStore.store_id,
        tnStore.access_token,
        mapping.tn_product_id,
        mapping.tn_variant_id,
        newStock
      );

      // Actualiza nuestro registro (MELI ya descontó por su cuenta)
      await pool.query(
        `UPDATE product_mappings SET current_stock = $1, last_synced_at = NOW() WHERE id = $2`,
        [newStock, mapping.id]
      );

      await logSync({
        userId,
        mappingId: mapping.id,
        eventType: 'sale_ml',
        sourcePlatform: 'mercadolibre',
        previousStock,
        newStock,
        quantityChanged: -item.quantity,
        orderId,
      });

    } catch (err) {
      console.error(`Error procesando venta ML para ítem ${item.item_id}:`, err.message);
    }
  }
}

// Procesa un cambio de stock en TN (restock manual o cambio de producto)
// → actualiza MELI con el nuevo valor de TN
async function handleTNStockUpdate(userId, productId, variantId, newStock) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM product_mappings 
       WHERE user_id = $1 AND tn_product_id = $2 AND tn_variant_id = $3 AND is_active = true`,
      [userId, String(productId), String(variantId)]
    );
    if (!rows[0]) return; // No está sincronizado

    const mapping = rows[0];
    const previousStock = mapping.current_stock;

    // Actualiza MELI con el nuevo stock de TN
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
    const errData = err.response?.data;
    // Si el ítem está cerrado, ignorar silenciosamente
    if (errData?.error === 'validation_error' && 
        errData?.message?.includes('closed')) {
      console.log(`Ítem MELI cerrado, ignorando: ${mapping.ml_item_id}`);
      return;
    }
    console.error('400 MELI:', JSON.stringify(errData));
    try {
      await mlService.updateStock(userId, mapping.ml_item_id, newStock, null);
    } catch (err2) {
      console.error('400 MELI fallback:', JSON.stringify(err2.response?.data));
      throw err2;
    }
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
      eventType: 'manual_update_tn',
      sourcePlatform: 'tiendanube',
      previousStock,
      newStock,
      quantityChanged: newStock - previousStock,
    });

  } catch (err) {
    console.error(`Error procesando update de TN para ${productId}/${variantId}:`, err.message);
  }
}

// Verifica si un update de MELI es nuestro (para evitar loops)
function isOurMLUpdate(itemId, stock) {
  return pendingMLUpdates.has(`${itemId}_${stock}`);
}

// Guarda un registro en sync_logs
async function logSync({ userId, mappingId, eventType, sourcePlatform, previousStock, newStock, quantityChanged, orderId, details }) {
  await pool.query(
    `INSERT INTO sync_logs 
     (user_id, mapping_id, event_type, source_platform, previous_stock, new_stock, quantity_changed, order_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [userId, mappingId, eventType, sourcePlatform, previousStock, newStock, quantityChanged, orderId || null, details ? JSON.stringify(details) : null]
  );
}

// Crea o actualiza un mapeo de producto por SKU
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
