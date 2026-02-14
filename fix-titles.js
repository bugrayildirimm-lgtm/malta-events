// Run once to fix events where the title is actually a date
// This moves the date to event_date and extracts the real title from the URL
// Usage: node fix-titles.js

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

function looksLikeDate(str) {
  if (!str) return false;
  const s = str.trim();
  if (/^\d{1,2}[,\d\s]*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(s)) return true;
  if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+to\s+/i.test(s)) return true;
  if (/^\d{1,2}[- ](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+to\s+/i.test(s)) return true;
  return false;
}

function titleFromUrl(url) {
  const parts = url.split('/');
  const slug = parts[parts.length - 1] || parts[parts.length - 2] || '';
  if (slug && slug.length > 3 && !slug.includes('?')) {
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  }
  return null;
}

async function fix() {
  try {
    const result = await pool.query("SELECT id, title, event_date, source_url FROM events WHERE source_url LIKE '%showshappening%'");
    let fixed = 0;

    for (const row of result.rows) {
      if (looksLikeDate(row.title)) {
        const newTitle = titleFromUrl(row.source_url);
        const newDate = row.event_date || row.title; // keep existing date if present

        if (newTitle) {
          await pool.query('UPDATE events SET title = $1, event_date = $2 WHERE id = $3', [newTitle, newDate, row.id]);
          console.log(`FIXED: "${row.title}" → title: "${newTitle}", date: "${newDate}"`);
          fixed++;
        } else {
          // At least move the date
          await pool.query('UPDATE events SET event_date = $1 WHERE id = $2', [row.title, row.id]);
          console.log(`DATE MOVED: "${row.title}" → event_date (no URL title found)`);
          fixed++;
        }
      }
    }

    // Also remove the homepage entry if it exists
    const junk = await pool.query("DELETE FROM events WHERE title LIKE '%Www.Showshappening%' OR title LIKE '%showshappening.com%' RETURNING title");
    junk.rows.forEach(r => console.log(`REMOVED JUNK: "${r.title}"`));

    console.log(`\nDone! Fixed ${fixed} events, removed ${junk.rowCount} junk entries.`);
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

fix();
