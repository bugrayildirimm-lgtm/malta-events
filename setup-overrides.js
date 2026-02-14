// Creates an image_overrides table that protects manually added images
// Run once: node setup-overrides.js

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    // This table stores manual overrides for images and categories
    // Keyed by source_url so they survive TRUNCATE + re-scrape
    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_overrides (
        id SERIAL PRIMARY KEY,
        source_url TEXT UNIQUE NOT NULL,
        image_url TEXT,
        category TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Created event_overrides table');

    // Copy any existing manual image URLs into overrides
    const result = await pool.query(`
      INSERT INTO event_overrides (source_url, image_url, category)
      SELECT source_url, image_url, category FROM events 
      WHERE image_url IS NOT NULL 
        AND image_url NOT LIKE '%/api/v2/file/%'
        AND image_url LIKE 'http%'
      ON CONFLICT (source_url) DO UPDATE SET 
        image_url = COALESCE(EXCLUDED.image_url, event_overrides.image_url),
        category = COALESCE(EXCLUDED.category, event_overrides.category)
    `);
    console.log('✓ Backed up ' + result.rowCount + ' image overrides');

    console.log('\nDone! Your manual images are now safe in event_overrides.');
    console.log('Even if you TRUNCATE events and re-scrape, the server will merge overrides back automatically.');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

run();
