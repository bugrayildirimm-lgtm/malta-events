// Run this ONCE to add the new columns to your events table
// Usage: node add-columns.js

require('dotenv').config(); // En üste bunu ekle
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD, // Şifreyi gizli dosyadan çek
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});
// ...gerisi aynı kalsın...

async function addColumns() {
  try {
    // Add event_date column (stores the date as text since formats may vary)
    await pool.query(`
      ALTER TABLE events ADD COLUMN IF NOT EXISTS event_date TEXT;
    `);
    console.log("✓ event_date column added (or already exists)");

    // Add description column
    await pool.query(`
      ALTER TABLE events ADD COLUMN IF NOT EXISTS description TEXT;
    `);
    console.log("✓ description column added (or already exists)");

    console.log("\nDone! You can now run: npm start");
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

addColumns();
