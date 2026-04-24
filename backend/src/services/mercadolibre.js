const axios = require('axios');
const pool = require('../models/db');

const ML_BASE = 'https://api.mercadolibre.com';

// Refresca el access token de MELI automáticamente
async function refreshMLToken(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM ml_tokens WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]) throw new Error('No hay tokens de MELI para este usuario');

  const { data } = await axios.post(`${ML_BASE}/oauth/token`, {
    grant_type: 'refresh_token',
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    refresh_token: rows[0].refresh_token,
  });

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await pool.query(
    `UPDATE ml_tokens 
     SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW()
     WHERE user_id=$4`,
    [data.access_token, data.refresh_token, expiresAt, userId]
  );
  return data.access_token;
}

// Obtiene un token válido, refrescando si es necesario
async function getValidToken(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM ml_tokens WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]) throw new Error('No hay tokens de MELI configurados');

  const isExpired = new Date(rows[0].expires_at) < new Date(Date.now() + 5 * 60 * 1000);
  if (isExpired) {
    return await refreshMLToken(userId);
  }
  return rows[0].access_token;
}

function mlClient(accessToken) {
  return axios.create({
    baseURL: ML_BASE,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
}

// Obtiene datos de un ítem de MELI
async function getItem(userId, itemId) {
  const token = await getValidToken(userId);
  const client = mlClient(token);
  const { data } = await client.get(`/items/${itemId}`);
  return data;
}

// Actualiza el stock de un ítem/variación en MELI
// Esta es la función clave: sobreescribe el stock con el valor de TN
async function updateStock(userId, itemId, newStock, variationId = null) {
  const token = await getValidToken(userId);
  const client = mlClient(token);

  let payload;
  if (variationId) {
    // Producto con variaciones (talle, color, etc.)
    payload = {
      variations: [{ id: variationId, available_quantity: newStock }],
    };
  } else {
    payload = { available_quantity: newStock };
  }

  const { data } = await client.put(`/items/${itemId}`, payload);
  return data;
}

// Obtiene el stock actual de un ítem en MELI
async function getItemStock(userId, itemId, variationId = null) {
  const item = await getItem(userId, itemId);
  if (variationId) {
    const variation = item.variations?.find(v => String(v.id) === String(variationId));
    return variation?.available_quantity ?? 0;
  }
  return item.available_quantity ?? 0;
}

// Lista los ítems del vendedor en MELI
async function getSellerItems(userId) {
  const token = await getValidToken(userId);
  const { rows } = await pool.query(
    'SELECT ml_user_id FROM ml_tokens WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]?.ml_user_id) throw new Error('No se encontró el user_id de MELI');

  const client = mlClient(token);
  const items = [];
  let offset = 0;
  let total = 1;

  while (offset < total) {
    const { data } = await client.get(`/users/${rows[0].ml_user_id}/items/search`, {
      params: { limit: 50, offset },
    });
    total = data.paging?.total || 0;
    if (!data.results || data.results.length === 0) break;

    // Trae detalles de hasta 20 ítems a la vez (límite de la API)
    const chunks = [];
    for (let i = 0; i < data.results.length; i += 20) {
      chunks.push(data.results.slice(i, i + 20));
    }
    for (const chunk of chunks) {
      const ids = chunk.join(',');
      const { data: details } = await client.get(`/items?ids=${ids}&attributes=id,title,seller_custom_field,available_quantity,variations`);
      for (const item of details) {
        if (item.code === 200 && item.body) {
          // SKU: primero seller_custom_field, si no busca en variaciones
          let sku = item.body.seller_custom_field || null;
          if (!sku && item.body.variations?.length > 0) {
            sku = item.body.variations[0].seller_custom_field || null;
          }
          items.push({
            id: item.body.id,
            title: item.body.title,
            sku: sku,
            stock: item.body.available_quantity,
            variations: item.body.variations?.map(v => ({
              ...v,
              sku: v.seller_custom_field || null,
            })),
          });
        }
      }
    }
    offset += data.results.length;
  }
  return items;
}

// Registra webhook en MELI para recibir notificaciones de ventas
async function registerWebhook(userId, callbackUrl) {
  const token = await getValidToken(userId);
  const client = mlClient(token);
  try {
    const { data } = await client.post('/applications/notification_url', {
      notification_url: callbackUrl,
      topics: ['orders_v2', 'items'],
    });
    return data;
  } catch (err) {
    console.log('Webhook MELI (puede ya existir):', err.response?.data || err.message);
    return null;
  }
}

// Obtiene detalles de una orden de MELI
async function getOrder(userId, orderId) {
  const token = await getValidToken(userId);
  const client = mlClient(token);
  const { data } = await client.get(`/orders/${orderId}`);
  return data;
}

// Genera la URL de OAuth para autenticar con MELI
function getOAuthUrl(redirectUri) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ML_CLIENT_ID,
    redirect_uri: redirectUri,
  });
  return `https://auth.mercadolibre.com.ar/authorization?${params}`;
}

// Intercambia el código de OAuth por tokens
async function exchangeCode(code, redirectUri) {
  const { data } = await axios.post(`${ML_BASE}/oauth/token`, {
    grant_type: 'authorization_code',
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });
  return data;
}

module.exports = {
  getValidToken,
  getItem,
  updateStock,
  getItemStock,
  getSellerItems,
  registerWebhook,
  getOrder,
  getOAuthUrl,
  exchangeCode,
};
