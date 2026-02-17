// Normalizes all event categories to our standard set
// Run once: node normalize-categories.js

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

// Our standard categories
const STANDARD = [
  'Music & Concerts',
  'Theatre & Shows',
  'Dance',
  'Nightlife & Parties',
  'Festivals',
  'Arts & Culture',
  'Sports & Adventure',
  'Food & Drink',
  'Family',
  'Religious',
  'Conference',
  'Other'
];

// Map VisitMalta / other categories to our standard ones
const CATEGORY_MAP = {
  // VisitMalta categories (lowercase key -> standard value)
  'music': 'Music & Concerts',
  'concerts': 'Music & Concerts',
  'classical music': 'Music & Concerts',
  'pop/rock': 'Music & Concerts',
  'jazz': 'Music & Concerts',
  'opera': 'Music & Concerts',
  'live music': 'Music & Concerts',
  
  'theatre': 'Theatre & Shows',
  'theater': 'Theatre & Shows',
  'comedy': 'Theatre & Shows',
  'performing arts': 'Theatre & Shows',
  'shows': 'Theatre & Shows',
  'cabaret': 'Theatre & Shows',
  
  'dance': 'Dance',
  'ballet': 'Dance',
  
  'nightlife': 'Nightlife & Parties',
  'parties': 'Nightlife & Parties',
  'clubbing': 'Nightlife & Parties',
  'party': 'Nightlife & Parties',
  
  'festival': 'Festivals',
  'festivals': 'Festivals',
  'carnival': 'Festivals',
  'feast': 'Festivals',
  'festa': 'Festivals',
  
  'art': 'Arts & Culture',
  'arts': 'Arts & Culture',
  'exhibition': 'Arts & Culture',
  'exhibitions': 'Arts & Culture',
  'culture': 'Arts & Culture',
  'cultural': 'Arts & Culture',
  'heritage': 'Arts & Culture',
  'history': 'Arts & Culture',
  'museum': 'Arts & Culture',
  'visual arts': 'Arts & Culture',
  'film': 'Arts & Culture',
  'cinema': 'Arts & Culture',
  'literature': 'Arts & Culture',
  
  'sport': 'Sports & Adventure',
  'sports': 'Sports & Adventure',
  'outdoor': 'Sports & Adventure',
  'adventure': 'Sports & Adventure',
  'fitness': 'Sports & Adventure',
  'running': 'Sports & Adventure',
  'walking': 'Sports & Adventure',
  'hiking': 'Sports & Adventure',
  'climbing': 'Sports & Adventure',
  'kayaking': 'Sports & Adventure',
  'water sports': 'Sports & Adventure',
  
  'food': 'Food & Drink',
  'food & drink': 'Food & Drink',
  'food and drink': 'Food & Drink',
  'wine': 'Food & Drink',
  'gastronomy': 'Food & Drink',
  'culinary': 'Food & Drink',
  'market': 'Food & Drink',
  
  'family': 'Family',
  'kids': 'Family',
  'children': 'Family',
  'education': 'Family',
  
  'religious': 'Religious',
  'religion': 'Religious',
  'spiritual': 'Religious',
  'church': 'Religious',
  'holy week': 'Religious',
  
  'conference': 'Conference',
  'seminar': 'Conference',
  'workshop': 'Conference',
  'business': 'Conference',
  'networking': 'Conference',
  'charity': 'Conference',
  'community': 'Other',
  'wellness': 'Other',
  'health': 'Other',
  'nature': 'Other',
  'environment': 'Other',
  'sustainability': 'Other',
  'shopping': 'Other',
  'tour': 'Other',
  'tours': 'Other',
  'guided tour': 'Other',
};

async function run() {
  try {
    const result = await pool.query('SELECT id, title, category FROM events WHERE category IS NOT NULL');
    let updated = 0, already = 0, mapped = 0;

    for (const event of result.rows) {
      const cat = event.category.trim();
      
      // Already standard?
      if (STANDARD.includes(cat)) {
        already++;
        continue;
      }
      
      // Try to map
      const key = cat.toLowerCase();
      let newCat = CATEGORY_MAP[key];
      
      // Try partial match if exact match fails
      if (!newCat) {
        for (const [mapKey, mapVal] of Object.entries(CATEGORY_MAP)) {
          if (key.includes(mapKey) || mapKey.includes(key)) {
            newCat = mapVal;
            break;
          }
        }
      }
      
      if (!newCat) newCat = 'Other';
      
      console.log(`  "${cat}" → ${newCat} (${event.title})`);
      await pool.query('UPDATE events SET category = $1 WHERE id = $2', [newCat, event.id]);
      mapped++;
    }

    // Also auto-categorize events with NULL category based on title
    const uncategorized = await pool.query('SELECT id, title, description FROM events WHERE category IS NULL');
    const titleRules = [
      { category: 'Music & Concerts', keywords: ['concert','jazz','orchestra','choir','piano','opera','requiem','symphony','baroque','singing','music','band','dj','guitar','mozart','vocal','instrumental','rythms','rhythms','sip & listen','acoustic'] },
      { category: 'Theatre & Shows', keywords: ['theatre','theater','show','musical','grease','sunset boulevard','dinner show','comedy','stand up','drag','burlesque','variety','x factor','1984','cockadoodledoo'] },
      { category: 'Dance', keywords: ['dance','ballet','balletto','żfinmalta','żfindays','moveo'] },
      { category: 'Nightlife & Parties', keywords: ['party','nightlife','club','foam','bongo','bunkr','funkytown','rooftop','fiesta','karaoke','pub crawl','neolitika'] },
      { category: 'Festivals', keywords: ['festival','feast','festa','carnival','bloom','gaulitana'] },
      { category: 'Arts & Culture', keywords: ['art','exhibition','gallery','museum','contemporary','picasso','memorial','sculpture','painting','biennale','suspended','1732'] },
      { category: 'Sports & Adventure', keywords: ['sport','run','race','climbing','kayak','abseil','zipline','trek','via ferrata','swim','marathon','weightlifting','football','gozo run'] },
      { category: 'Food & Drink', keywords: ['food','wine','dinner','charcuterie','eat','artisan fair','market','eco market'] },
      { category: 'Family', keywords: ['family','kids','children','easter egg','esplora','magic','mystery','chamber of mysteries'] },
      { category: 'Religious', keywords: ['religious','church','holy week','procession','good friday','corpus christi','patron','in cristo'] },
      { category: 'Conference', keywords: ['conference','summit','seminar','workshop','sustainable','ageing','evidence'] },
    ];

    let autoCat = 0;
    for (const event of uncategorized.rows) {
      const text = ((event.title || '') + ' ' + (event.description || '')).toLowerCase();
      let matched = null;
      for (const rule of titleRules) {
        if (rule.keywords.some(kw => text.includes(kw))) {
          matched = rule.category;
          break;
        }
      }
      if (matched) {
        await pool.query('UPDATE events SET category = $1 WHERE id = $2', [matched, event.id]);
        autoCat++;
      }
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`Already standard: ${already}`);
    console.log(`Mapped to standard: ${mapped}`);
    console.log(`Auto-categorized from title: ${autoCat}`);
    console.log(`Total events: ${result.rows.length + uncategorized.rows.length}`);

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

run();
