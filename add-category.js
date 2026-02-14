// Run once to add the category column
// Usage: node add-category.js

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
    // Add category column
    await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS category TEXT');
    console.log('✓ Added category column');

    // Auto-categorize existing events based on title keywords
    const rules = [
      { category: 'Music & Concerts', keywords: ['concert','jazz','orchestra','choir','piano','opera','requiem','symphony','baroque','singing','music','band','dj','abba','boney','guitar','fauré','bruckner','madrigal','vocal','instrumental','mozart','rythms','rhythms'] },
      { category: 'Theatre & Shows', keywords: ['theatre','theater','show','musical','grease','sunset boulevard','dinner show','comedy','stand up','drag','burlesque','variety','x factor','live shows'] },
      { category: 'Dance', keywords: ['dance','ballet','balletto','żfinmalta','żfindays'] },
      { category: 'Nightlife & Parties', keywords: ['party','nightlife','club','foam','carnival','bongo','bunkr','funkytown','rooftop','fiesta','karaoke','pub crawl','after party'] },
      { category: 'Festivals', keywords: ['festival','feast','festa','carnival','bloom','gaulitana'] },
      { category: 'Arts & Culture', keywords: ['art','exhibition','gallery','museum','contemporary','picasso','memorial','sculpture','painting','biennale'] },
      { category: 'Sports & Adventure', keywords: ['sport','run','race','climbing','kayak','abseil','zipline','trek','via ferrata','swim','marathon','weightlifting','football','gozo run'] },
      { category: 'Food & Drink', keywords: ['food','wine','dinner','charcuterie','eat','artisan fair','market'] },
      { category: 'Family', keywords: ['family','kids','children','easter egg','esplora','magic','mystery'] },
      { category: 'Religious', keywords: ['religious','church','holy week','procession','good friday','corpus christi','patron'] },
      { category: 'Conference', keywords: ['conference','summit','seminar','workshop','sustainable','ageing','dementia','evidence'] },
    ];

    const result = await pool.query('SELECT id, title, description FROM events WHERE category IS NULL');
    let updated = 0;

    for (const event of result.rows) {
      const text = ((event.title || '') + ' ' + (event.description || '')).toLowerCase();
      let matched = null;

      for (const rule of rules) {
        if (rule.keywords.some(kw => text.includes(kw))) {
          matched = rule.category;
          break;
        }
      }

      if (matched) {
        await pool.query('UPDATE events SET category = $1 WHERE id = $2', [matched, event.id]);
        updated++;
      }
    }

    console.log(`✓ Auto-categorized ${updated} out of ${result.rows.length} uncategorized events`);
    console.log('\nRemaining uncategorized events:');
    const remaining = await pool.query("SELECT title FROM events WHERE category IS NULL ORDER BY title");
    remaining.rows.forEach(r => console.log('  - ' + r.title));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

run();
