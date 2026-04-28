const axios = require('axios');
const pool = require('../models/db');

const ML_BASE = 'https://api.mercadolibre.com';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Refresca el access token de MELI automáticamente
async function refreshMLToken(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM ml_tokens WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]) throw new Error('No hay tokens de MELI para este usuario');

  // FIX: validar que el refresh token existe antes de usarlo
  if (!rows[0].refresh_token || rows[0].refresh_token === 'null') {
    throw new Error('REAUTH_NEEDED');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('client_id', process.env.ML_CLIENT_ID);
  params.append('client_secret', process.env.ML_CLIENT_SECRET);
  params.append('refresh_token', rows[0].refresh_token);

  const { data } = await axios.post(`${ML_BASE}/oauth/token`, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    }
  });

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await pool.query(
    `UPDATE ml_tokens 
     SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW()
     WHERE user_id=$4`,
    [data.access_token, data.refresh_token, expiresAt, userId]
  );
  console.log('Token MELI refrescado exitosamente');
  return data.access_token;
}

// Obtiene un token valido, refrescando si es necesario
async function getValidToken(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM ml_tokens WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]) throw new Error('No hay tokens de MELI configurados');

  // FIX: expires_at viene como timestamp con timezone desde la DB.
  // Comparamos correctamente: si ya paso o vence en menos de 5 min, refrescamos.
  const expiresAt = rows[0].expires_at ? new Date(rows[0].expires_at) : null;
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  const needsRefresh = !expiresAt || expiresAt < fiveMinutesFromNow;

  if (needsRefresh) {
    console.log('Token MELI proximo a vencer o vencido, refrescando...');
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

// Obtiene datos de un item de MELI
async function getItem(userId, itemId) {
  const token = await getValidToken(userId);
  const client = mlClient(token);
  const { data } = await client.get(`/items/${itemId}`);
  return data;
}

// Actualiza el stock de un item/variacion en MELI
async function updateStock(userId, itemId, newStock, variationId = null) {
  const token = await getValidToken(userId);
  const client = mlClient(token);

  let payload;
  if (variationId) {
    payload = {
      variations: [{ id: variationId, available_quantity: newStock }],
    };
  } else {
    payload = { available_quantity: newStock };
  }

  const { data } = await client.put(`/items/${itemId}`, payload);
  return data;
}

// Obtiene el stock actual de un item en MELI
async function getItemStock(userId, itemId, variationId = null) {
  const item = await getItem(userId, itemId);
  if (variationId) {
    const variation = item.variations?.find(v => String(v.id) === String(variationId));
    return variation?.available_quantity ?? 0;
  }
  return item.available_quantity ?? 0;
}

// Lista los items del vendedor en MELI
async function getSellerItems(userId) {
  const token = await getValidToken(userId);
  const { rows } = await pool.query(
    'SELECT ml_user_id FROM ml_tokens WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]?.ml_user_id) throw new Error('No se encontro el user_id de MELI');

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

    const chunks = [];
    for (let i = 0; i < data.results.length; i += 20) {
      chunks.push(data.results.slice(i, i + 20));
    }
    for (const chunk of chunks) {
      await sleep(500);
      const ids = chunk.join(',');
      const { data: details } = await client.get(`/items?ids=${ids}&attributes=id,title,seller_custom_field,available_quantity,variations`);
      for (const item of details) {
        if (item.code === 200 && item.body) {
          let sku = item.body.seller_custom_field || null;
          let variations = [];

          if (item.body.variations?.length > 0) {
            try {
              const { data: fullItem } = await client.get(
                `/items/${item.body.id}?attributes=variations`
              );
              variations = (fullItem.variations || []).map(v => {
                const varSku = v.seller_custom_field ||
                  v.attributes?.find(a => a.id === 'SELLER_SKU')?.value_name ||
                  null;
                if (!sku && varSku) sku = varSku;
                return {
                  id: v.id,
                  available_quantity: v.available_quantity,
                  seller_custom_field: varSku,
                  sku: varSku,
                  attribute_combinations: v.attribute_combinations,
                };
              });
            } catch (e) {
              console.log('Error trayendo variaciones de', item.body.id, e.message);
            }
          }

          if (!sku) {
            try {
              const { data: fullItem } = await client.get(
                `/items/${item.body.id}?attributes=attributes`
              );
              sku = fullItem.attributes?.find(a => a.id === 'SELLER_SKU')?.value_name || null;
            } catch (e) {}
          }

          items.push({
            id: item.body.id,
            title: item.body.title,
            sku,
            stock: item.body.available_quantity,
            variations,
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
  return `https://auth.mercadolibre.com.ar/authorization?${params}&scope=read_orders%20write_orders%20read_listings%20write_listings%20offline_access`;
}

// Intercambia el codigo de OAuth por tokens
async function exchangeCode(code, redirectUri) {
  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('client_id', process.env.ML_CLIENT_ID);
  params.append('client_secret', process.env.ML_CLIENT_SECRET);
  params.append('code', code);
  params.append('redirect_uri', redirectUri);

  const { data } = await axios.post(`${ML_BASE}/oauth/token`, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    }
  });
  return data;
}

module.exports = {
  refreshMLToken,
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
