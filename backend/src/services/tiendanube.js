const axios = require('axios');

const TN_BASE = 'https://api.tiendanube.com/v1';

function tnClient(storeId, accessToken) {
  return axios.create({
    baseURL: `${TN_BASE}/${storeId}`,
    headers: {
      'Authentication': `bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'SyncStock/1.0 (soporte@syncstock.app)',
    },
  });
}

// Trae todos los productos de TN (paginado)
async function getAllProducts(storeId, accessToken) {
  const client = tnClient(storeId, accessToken);
  const products = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { data } = await client.get('/products', {
      params: { page, per_page: 200, fields: 'id,name,variants,sku' },
    });
    if (!data || data.length === 0) {
      hasMore = false;
    } else {
      products.push(...data);
      page++;
      if (data.length < 200) hasMore = false;
    }
  }
  return products;
}

// Trae un producto por ID
async function getProduct(storeId, accessToken, productId) {
  const client = tnClient(storeId, accessToken);
  const { data } = await client.get(`/products/${productId}`);
  return data;
}

// Obtiene el stock de una variante específica
async function getVariantStock(storeId, accessToken, productId, variantId) {
  const client = tnClient(storeId, accessToken);
  const { data } = await client.get(`/products/${productId}/variants/${variantId}`);
  return data.stock;
}

// Actualiza el stock de una variante en TN
// IMPORTANTE: solo se llama cuando hay venta en MELI
async function updateVariantStock(storeId, accessToken, productId, variantId, newStock) {
  const client = tnClient(storeId, accessToken);
  const { data } = await client.put(`/products/${productId}/variants/${variantId}`, {
    stock: newStock,
  });
  return data;
}

// Registra webhook en TN para recibir eventos
async function registerWebhook(storeId, accessToken, event, callbackUrl) {
  const client = tnClient(storeId, accessToken);
  try {
    const { data } = await client.post('/webhooks', {
      event,
      url: callbackUrl,
    });
    return data;
  } catch (err) {
    // Si ya existe, no es error crítico
    if (err.response?.status === 422) {
      console.log(`Webhook ${event} ya existe en TN`);
      return null;
    }
    throw err;
  }
}

// Registra todos los webhooks necesarios
async function setupWebhooks(storeId, accessToken, publicUrl) {
  const events = [
    'order/paid',
    'order/fulfilled',
    'product/updated',
  ];
  const results = [];
  for (const event of events) {
    const result = await registerWebhook(
      storeId, accessToken, event,
      `${publicUrl}/webhooks/tiendanube`
    );
    results.push({ event, result });
  }
  return results;
}

// Parsea los productos de TN en formato normalizado con variantes y SKUs
function parseProducts(tnProducts) {
  const items = [];
  for (const product of tnProducts) {
    if (!product.variants || product.variants.length === 0) continue;
    for (const variant of product.variants) {
      items.push({
        productId: String(product.id),
        variantId: String(variant.id),
        productName: product.name?.es || product.name?.pt || Object.values(product.name || {})[0] || 'Sin nombre',
        sku: variant.sku || null,
        stock: variant.stock,
        price: variant.price,
        values: variant.values || [],
      });
    }
  }
  return items;
}

module.exports = {
  getAllProducts,
  getProduct,
  getVariantStock,
  updateVariantStock,
  registerWebhook,
  setupWebhooks,
  parseProducts,
};
