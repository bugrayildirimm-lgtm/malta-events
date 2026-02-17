require('dotenv').config();
const { Pool } = require('pg');
const { chromium } = require('playwright');

// Note: VisitMalta now uses direct API calls (no browser needed)
// Only ShowsHappening still needs the browser

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

// --- 1. SHOWSHAPPENING ---
async function scrapeShowsHappening(browser) {
  const page = await browser.newPage();
  try {
    console.log("ShowsHappening scraping...");
    await page.goto('https://www.showshappening.com/', { waitUntil: 'networkidle', timeout: 60000 });
    
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let totalHeight = 0;
        let distance = 100;
        let timer = setInterval(() => {
          let scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if(totalHeight >= scrollHeight) { clearInterval(timer); resolve(); }
        }, 100);
      });
    });

    const events = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      return anchors.map(a => {
        // Split text into lines using actual newlines
        const rawText = a.innerText || '';
        const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        let date = null;
        let title = null;
        let price = null;
        
        const datePattern = /^(\d{1,2}[\s,]+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i;
        const dateRangePattern = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+to\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i;
        // NEW: handle "14-Feb to 28-Mar" style dates
        const dashDateRange = /^\d{1,2}[- ](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+to\s+\d{1,2}[- ](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i;
        
        for (const line of lines) {
          if (line.toLowerCase() === 'follow') continue;
          
          // Detect price
          if (line.includes('€') || line.toLowerCase() === 'free') {
            price = line;
            continue;
          }
          
          // Detect date
          if (datePattern.test(line) || dateRangePattern.test(line) || dashDateRange.test(line)) {
            date = line;
            continue;
          }
          
          // Everything else is a potential title
          if (!title && line.length > 3 && line.length < 200) {
            title = line;
          }
        }
        
        // FALLBACK: If no title found from text, extract from URL slug
        // e.g. "/ad-events-ltd/Carmen-by-Balletto-di-Milano" → "Carmen by Balletto di Milano"
        if (!title && a.href) {
          const urlParts = a.href.split('/');
          const slug = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2] || '';
          if (slug && slug.length > 3 && !slug.includes('?') && !slug.includes('category')) {
            title = decodeURIComponent(slug)
              .replace(/[-_]+/g, ' ')
              .replace(/\b\w/g, c => c.toUpperCase())
              .trim();
          }
        }
        
        return {
          title: title,
          url: a.href,
          image_url: a.querySelector('img') ? a.querySelector('img').src : null,
          date: date,
          price: price,
        };
      }).filter(item => 
        item.image_url && 
        item.title &&
        item.title.length > 3 && 
        item.title.length < 200 &&
        !item.title.toLowerCase().includes('seller test') &&
        !item.title.toLowerCase().startsWith('entertainment') &&
        !item.title.toLowerCase().startsWith('showshappening') &&
        // Filter out non-event links
        !item.url.includes('apple.com') &&
        !item.url.includes('apps.apple') &&
        !item.url.includes('play.google') &&
        !item.url.includes('Account/Login') &&
        !item.url.includes('showsmanager.com') &&
        !item.url.includes('/search?') &&
        !item.url.includes('/whatshappening') &&
        !item.url.endsWith('showshappening.com/') &&
        // Must be an event page URL (contains organizer/event-slug pattern)
        item.url.includes('showshappening.com/') &&
        item.url.split('showshappening.com/')[1]?.includes('/')
      );
    });

    // Deduplicate by URL
    const seen = new Set();
    const unique = events.filter(e => {
      if (seen.has(e.url)) return false;
      seen.add(e.url);
      return true;
    });

    for (const event of unique) {
      try {
        await pool.query(
          `INSERT INTO events (title, location, source_url, image_url, event_date, description) 
           VALUES ($1, $2, $3, $4, $5, $6) 
           ON CONFLICT (source_url) DO UPDATE SET 
             title = EXCLUDED.title,
             image_url = EXCLUDED.image_url,
             event_date = COALESCE(EXCLUDED.event_date, events.event_date),
             description = COALESCE(EXCLUDED.description, events.description)`,
          [
            event.title,
            'Malta',
            event.url,
            event.image_url,
            event.date || null,
            event.price ? `Price: ${event.price}` : null
          ]
        );
      } catch (dbErr) {
        if (dbErr.message.includes('column')) {
          await pool.query(
            'INSERT INTO events (title, location, source_url, image_url) VALUES ($1, $2, $3, $4) ON CONFLICT (source_url) DO UPDATE SET image_url = EXCLUDED.image_url',
            [event.title, 'Malta', event.url, event.image_url]
          );
        }
      }
    }

    const withDates = unique.filter(e => e.date).length;
    const withPrices = unique.filter(e => e.price).length;
    console.log(`ShowsHappening: ${unique.length} events (${withDates} with dates, ${withPrices} with prices).`);
    
    if (unique.length > 0) {
      console.log("\n  === SAMPLE EVENTS ===");
      unique.slice(0, 5).forEach(e => {
        console.log(`  Title: ${e.title}`);
        console.log(`  Date:  ${e.date || 'N/A'}`);
        console.log(`  Price: ${e.price || 'N/A'}`);
        console.log(`  URL:   ${e.url}`);
        console.log(`  ---`);
      });
    }
  } catch (err) { console.error("SH Error:", err.message); }
  finally { await page.close(); }
}

// --- 2. VISITMALTA (DIRECT API - NO BROWSER NEEDED) ---
async function scrapeVisitMalta() {
  try {
    console.log("VisitMalta scraping (API)...");

    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://api.visitmaltaplus.com/api/v2/LoadAllEvents?&limit=500&version=947', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      throw new Error(`API response: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const rows = data.rows || {};
    const events = [];

    for (const key of Object.keys(rows)) {
      const event = rows[key];

      const title = event.title?.[0]?.value;
      if (!title || title.length < 3) continue;

      const startDate = event.start_date || null;
      const endDate = event.end_date || null;
      const dateText = startDate && endDate && startDate !== endDate
        ? `${startDate} - ${endDate}`
        : startDate || null;

      const urlAlias = event.url_alias || event.path?.[0]?.alias?.replace(/^\//, '') || '';
      const sourceUrl = urlAlias
        ? `https://www.visitmalta.com/en/events-in-malta-and-gozo/event/${urlAlias}`
        : `https://www.visitmalta.com/en/events-in-malta-and-gozo/`;

      const bodyHtml = event.body?.[0]?.value || '';
      const summary = event.field_summary?.[0]?.value || '';
      const description = (summary || bodyHtml.replace(/<[^>]*>/g, '')).trim().substring(0, 500) || null;

      const externalImg = event.field_external_image_url?.[0]?.value || null;
      // Build image URL from media_id - check all possible image fields
      const mediaId = (event.field_image || [])[0]?.target_id 
        || (event.field_header_image || [])[0]?.target_id 
        || (event.field_dtp_event_image || [])[0]?.target_id 
        || (event.field_app_featured_image || [])[0]?.target_id 
        || event.field_external_image_url?.[0]?.target_id
        || null;
      const imageUrl = (externalImg && externalImg.startsWith('http'))
        ? externalImg
        : mediaId
          ? `https://api.visitmaltaplus.com/api/v2/images/1?media_id=${mediaId}&height=400`
          : null;

      const locationData = event.field_event_location?.[0];
      const location = locationData?.addr_autocomplete || locationData?.name || 'Malta';

      const rawCategory = event.field_event_category?.[0]?.name || null;
      // Map VisitMalta categories to our standard set
      const catMap = {
        'music': 'Music & Concerts', 'concerts': 'Music & Concerts', 'classical music': 'Music & Concerts',
        'pop/rock': 'Music & Concerts', 'jazz': 'Music & Concerts', 'opera': 'Music & Concerts',
        'theatre': 'Theatre & Shows', 'comedy': 'Theatre & Shows', 'performing arts': 'Theatre & Shows',
        'dance': 'Dance', 'ballet': 'Dance',
        'nightlife': 'Nightlife & Parties', 'parties': 'Nightlife & Parties',
        'festival': 'Festivals', 'festivals': 'Festivals', 'carnival': 'Festivals', 'feast': 'Festivals',
        'art': 'Arts & Culture', 'exhibition': 'Arts & Culture', 'exhibitions': 'Arts & Culture',
        'culture': 'Arts & Culture', 'heritage': 'Arts & Culture', 'film': 'Arts & Culture', 'visual arts': 'Arts & Culture',
        'sport': 'Sports & Adventure', 'sports': 'Sports & Adventure', 'outdoor': 'Sports & Adventure',
        'food': 'Food & Drink', 'food & drink': 'Food & Drink', 'wine': 'Food & Drink', 'gastronomy': 'Food & Drink',
        'family': 'Family', 'kids': 'Family', 'children': 'Family',
        'religious': 'Religious', 'religion': 'Religious',
        'conference': 'Conference', 'seminar': 'Conference', 'workshop': 'Conference',
      };
      let category = null;
      if (rawCategory) {
        const key = rawCategory.toLowerCase().trim();
        category = catMap[key];
        if (!category) {
          for (const [k, v] of Object.entries(catMap)) {
            if (key.includes(k)) { category = v; break; }
          }
        }
        if (!category) category = 'Other';
      }
      const bookingLink = event.field_booking_link?.[0]?.value || null;
      const website = event.field_event_website?.[0]?.value || null;

      events.push({
        title, date: dateText, url: sourceUrl, image_url: imageUrl,
        description, location, category, booking_link: bookingLink, website,
      });
    }

    console.log(`VisitMalta: ${events.length} events found. Saving...`);

    for (const event of events) {
      try {
        await pool.query(
          `INSERT INTO events (title, location, source_url, image_url, event_date, description, category) 
           VALUES ($1, $2, $3, $4, $5, $6, $7) 
           ON CONFLICT (source_url) DO UPDATE SET 
             title = EXCLUDED.title,
             image_url = COALESCE(EXCLUDED.image_url, events.image_url),
             event_date = COALESCE(EXCLUDED.event_date, events.event_date),
             description = COALESCE(EXCLUDED.description, events.description),
             category = COALESCE(EXCLUDED.category, events.category)`,
          [event.title, event.location, event.url, event.image_url, event.date || null, event.description || null, event.category || null]
        );
      } catch (dbErr) {
        if (dbErr.message.includes('column') && (dbErr.message.includes('event_date') || dbErr.message.includes('description'))) {
          await pool.query(
            'INSERT INTO events (title, location, source_url, image_url) VALUES ($1, $2, $3, $4) ON CONFLICT (source_url) DO NOTHING',
            [event.title, event.location, event.url, event.image_url]
          );
        } else {
          console.error(`  DB error (${event.title}):`, dbErr.message);
        }
      }
    }

    if (events.length > 0) {
      console.log("\n  === SAMPLE EVENTS ===");
      events.slice(0, 5).forEach(e => {
        console.log(`  Title:    ${e.title}`);
        console.log(`  Date:     ${e.date || 'N/A'}`);
        console.log(`  Location: ${e.location}`);
        console.log(`  Image:    ${e.image_url ? 'YES' : 'NO'}`);
        console.log(`  ---`);
      });
    }

  } catch (err) {
    console.error("VisitMalta Error:", err.message);
  }
}

// --- RUN ---
async function run() {
  console.log("=== Event Scraper Starting ===\n");
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox']
  });
  
  try {
    await scrapeShowsHappening(browser);
    console.log("\n---\n");
    await scrapeVisitMalta();
  } finally {
    await browser.close();
    await pool.end();
    console.log("\n=== Done ===");
  }
}

run();
