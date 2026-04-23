require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🗃️  Ejecutando migraciones...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS stores (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        platform VARCHAR(50) NOT NULL, -- 'tiendanube' | 'mercadolibre'
        store_name VARCHAR(255),
        store_id VARCHAR(255),
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at TIMESTAMP,
        is_source BOOLEAN DEFAULT false, -- TN es la fuente de verdad
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS product_mappings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        sku VARCHAR(255) NOT NULL,
        tn_product_id VARCHAR(255),
        tn_variant_id VARCHAR(255),
        ml_item_id VARCHAR(255),
        ml_variation_id VARCHAR(255),
        tn_product_name VARCHAR(500),
        ml_item_name VARCHAR(500),
        current_stock INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        last_synced_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, sku)
      );

      CREATE TABLE IF NOT EXISTS sync_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        mapping_id INTEGER REFERENCES product_mappings(id),
        event_type VARCHAR(100) NOT NULL,
        -- 'sale_tn', 'sale_ml', 'manual_update_tn', 'initial_sync', 'restock'
        source_platform VARCHAR(50),
        previous_stock INTEGER,
        new_stock INTEGER,
        quantity_changed INTEGER,
        order_id VARCHAR(255),
        details JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        platform VARCHAR(50) NOT NULL,
        platform_order_id VARCHAR(255),
        status VARCHAR(100),
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        total_amount DECIMAL(10,2),
        items JSONB,
        raw_data JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ml_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        access_token TEXT,
        refresh_token TEXT,
        expires_at TIMESTAMP,
        ml_user_id VARCHAR(255),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_mappings_sku ON product_mappings(user_id, sku);
      CREATE INDEX IF NOT EXISTS idx_mappings_tn ON product_mappings(tn_product_id);
      CREATE INDEX IF NOT EXISTS idx_mappings_ml ON product_mappings(ml_item_id);
      CREATE INDEX IF NOT EXISTS idx_logs_mapping ON sync_logs(mapping_id);
      CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
    `);

    console.log('✅ Migraciones completadas exitosamente');
  } catch (err) {
    console.error('❌ Error en migración:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
