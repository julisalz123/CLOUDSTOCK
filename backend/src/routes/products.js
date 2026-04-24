const router = require('express').Router();
const pool = require('../models/db');
const auth = require('../middleware/auth');
const tnService = require('../services/tiendanube');
const mlService = require('../services/mercadolibre');
const syncEngine = require('../services/syncEngine');

// Trae todos los productos de Tiendanube
router.get('/tiendanube', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM stores WHERE user_id = $1 AND platform = 'tiendanube'`,
      [req.userId]
    );
    if (!rows[0]) return res.status(400).json({ error: 'Tiendanube no conectada' });

    const products = await tnService.getAllProducts(rows[0].store_id, rows[0].access_token);
    const parsed = tnService.parseProducts(products);
    res.json(parsed);
  } catch (err) {
    console.error('Error trayendo productos TN:', err);
    res.status(500).json({ error: 'Error al traer productos de Tiendanube' });
  }
});

// Trae todos los ítems de Mercado Libre
router.get('/mercadolibre', auth, async (req, res) => {
  try {
    const items = await mlService.getSellerItems(req.userId);
    res.json(items);
  } catch (err) {
    console.error('Error trayendo ítems MELI:', err);
    res.status(500).json({ error: 'Error al traer productos de Mercado Libre' });
  }
});

// Auto-mapeo por SKU — sugiere matches sin guardar nada
router.get('/automatch', auth, async (req, res) => {
  try {
    const { rows: storeRows } = await pool.query(
      `SELECT * FROM stores WHERE user_id = $1 AND platform = 'tiendanube'`,
      [req.userId]
    );
    if (!storeRows[0]) return res.status(400).json({ error: 'Tiendanube no conectada' });

    const [tnProducts, mlItems] = await Promise.all([
      tnService.getAllProducts(storeRows[0].store_id, storeRows[0].access_token).then(p => tnService.parseProducts(p)),
      mlService.getSellerItems(req.userId),
    ]);

    const { rows: existingMappings } = await pool.query(
      `SELECT sku FROM product_mappings WHERE user_id = $1 AND is_active = true`,
      [req.userId]
    );
    const existingSkus = new Set(existingMappings.map(m => m.sku));

    const mlBySku = {};
    for (const item of mlItems) {
      if (item.sku) {
        const skuKey = item.sku.trim().toLowerCase();
        if (!mlBySku[skuKey]) mlBySku[skuKey] = [];
        mlBySku[skuKey].push(item);
      }
    }

    const matches = [];
    for (const tnProduct of tnProducts) {
      if (!tnProduct.sku) continue;
      const skuKey = tnProduct.sku.trim().toLowerCase();
      if (existingSkus.has(tnProduct.sku)) continue;
      const mlMatches = mlBySku[skuKey];
      if (!mlMatches) continue;

      for (const mlItem of mlMatches) {
        matches.push({
          sku: tnProduct.sku,
          tn: {
            productId: tnProduct.productId,
            variantId: tnProduct.variantId,
            productName: tnProduct.productName,
            stock: tnProduct.stock,
            values: tnProduct.values,
          },
          ml: {
            itemId: mlItem.id,
            title: mlItem.title,
            stock: mlItem.stock,
            variations: mlItem.variations,
          },
          confidence: 'exact',
        });
      }
    }

    res.json({ matches, total: matches.length });
  } catch (err) {
    console.error('Error en automatch:', err);
    res.status(500).json({ error: 'Error al buscar matches automáticos' });
  }
});

// Lista los mapeos activos del usuario
router.get('/mappings', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pm.*, 
        (SELECT COUNT(*) FROM sync_logs sl WHERE sl.mapping_id = pm.id) as sync_count
       FROM product_mappings pm 
       WHERE pm.user_id = $1 
       ORDER BY pm.created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al traer mapeos' });
  }
});

// Crea un mapeo SKU
router.post('/mappings', auth, async (req, res) => {
  try {
    const {
      sku,
      tnProductId, tnVariantId, tnProductName,
      mlItemId, mlVariationId, mlItemName,
    } = req.body;

    if (!sku || !tnProductId || !tnVariantId || !mlItemId) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const mapping = await syncEngine.createMapping(req.userId, {
      sku, tnProductId, tnVariantId, tnProductName,
      mlItemId, mlVariationId, mlItemName,
    });

    res.status(201).json(mapping);
  } catch (err) {
    console.error('Error creando mapeo:', err);
    res.status(500).json({ error: 'Error al crear el mapeo' });
  }
});

// Elimina/desactiva un mapeo
router.delete('/mappings/:id', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE product_mappings SET is_active = false WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar mapeo' });
  }
});

// Sincronización inicial
router.post('/sync/initial', auth, async (req, res) => {
  try {
    const results = await syncEngine.initialSync(req.userId);
    res.json(results);
  } catch (err) {
    console.error('Error en sync inicial:', err);
    res.status(500).json({ error: err.message });
  }
});

// Sync manual de un producto
router.post('/sync/:mappingId', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM product_mappings WHERE id = $1 AND user_id = $2`,
      [req.params.mappingId, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Mapeo no encontrado' });

    const mapping = rows[0];
    const { rows: storeRows } = await pool.query(
      `SELECT * FROM stores WHERE user_id = $1 AND platform = 'tiendanube'`,
      [req.userId]
    );

    const tnStock = await tnService.getVariantStock(
      storeRows[0].store_id, storeRows[0].access_token,
      mapping.tn_product_id, mapping.tn_variant_id
    );

    await mlService.updateStock(req.userId, mapping.ml_item_id, tnStock, mapping.ml_variation_id);
    await pool.query(
      `UPDATE product_mappings SET current_stock = $1, last_synced_at = NOW() WHERE id = $2`,
      [tnStock, mapping.id]
    );

    res.json({ ok: true, stock: tnStock });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Historial de sync
router.get('/mappings/:id/logs', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sl.* FROM sync_logs sl
       JOIN product_mappings pm ON pm.id = sl.mapping_id
       WHERE sl.mapping_id = $1 AND pm.user_id = $2
       ORDER BY sl.created_at DESC LIMIT 50`,
      [req.params.id, req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al traer logs' });
  }
});

module.exports = router;
