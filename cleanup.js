// Run once to clean junk entries from the database
// Usage: node cleanup.js

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

async function cleanup() {
  try {
    // Remove App Store, Google Play, login pages, and other non-event entries
    const result = await pool.query(`
      DELETE FROM events WHERE 
        source_url LIKE '%apple.com%' OR
        source_url LIKE '%play.google%' OR
        source_url LIKE '%Account/Login%' OR
        source_url LIKE '%showsmanager.com%' OR
        source_url LIKE '%/search?%' OR
        title LIKE 'Id%' OR
        title LIKE '%Download%App%'
    `);
    console.log(`Cleaned up ${result.rowCount} junk entries.`);
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

cleanup();
