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

// --- 1. SHOWSHAPPENING (DEEP SCRAPE - visits each event page) ---
async function scrapeShowsHappening(browser) {
  const page = await browser.newPage();
  try {
    console.log("ShowsHappening scraping (deep mode)...");
    await page.goto('https://www.showshappening.com/', { waitUntil: 'networkidle', timeout: 60000 });
    
    // Scroll to load all events
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

    // Step 1: Collect all event URLs and basic info from homepage
    const eventLinks = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      return anchors.map(a => {
        const rawText = a.innerText || '';
        const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        let date = null;
        let title = null;
        let price = null;
        
        const datePattern = /^(\d{1,2}[\s,]+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i;
        const dateRangePattern = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+to\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i;
        const dashDateRange = /^\d{1,2}[- ](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+to\s+\d{1,2}[- ](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i;
        
        for (const line of lines) {
          if (line.toLowerCase() === 'follow') continue;
          if (line.includes('€') || line.toLowerCase() === 'free') { price = line; continue; }
          if (datePattern.test(line) || dateRangePattern.test(line) || dashDateRange.test(line)) { date = line; continue; }
          if (!title && line.length > 3 && line.length < 200) title = line;
        }
        
        if (!title && a.href) {
          const urlParts = a.href.split('/');
          const slug = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2] || '';
          if (slug && slug.length > 3 && !slug.includes('?') && !slug.includes('category')) {
            title = decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
          }
        }
        
        return {
          title,
          url: a.href,
          image_url: (() => {
            const img = a.querySelector('img');
            if (!img) return null;
            const src = img.src || '';
            // Skip ShowsHappening branded images
            if (src.includes('Online-tickets') || src.includes('online-tickets') || src.includes('showshappening.com/images')) return null;
            return src;
          })(),
          date,
          price,
        };
      }).filter(item => 
        item.image_url && item.title && item.title.length > 3 && item.title.length < 200 &&
        !item.title.toLowerCase().includes('seller test') &&
        !item.title.toLowerCase().startsWith('entertainment') &&
        !item.title.toLowerCase().startsWith('showshappening') &&
        !item.url.includes('apple.com') && !item.url.includes('apps.apple') &&
        !item.url.includes('play.google') && !item.url.includes('Account/Login') &&
        !item.url.includes('showsmanager.com') && !item.url.includes('/search?') &&
        !item.url.includes('/whatshappening') && !item.url.endsWith('showshappening.com/') &&
        item.url.includes('showshappening.com/') &&
        item.url.split('showshappening.com/')[1]?.includes('/')
      );
    });

    // Deduplicate by URL
    const seen = new Set();
    const unique = eventLinks.filter(e => {
      if (seen.has(e.url)) return false;
      seen.add(e.url);
      return true;
    });

    console.log(`  Found ${unique.length} unique events on homepage. Now visiting each page for details...`);

    // Step 2: Visit each event page for rich details
    const detailPage = await browser.newPage();
    let enriched = 0;
    
    for (let i = 0; i < unique.length; i++) {
      const event = unique[i];
      try {
        await detailPage.goto(event.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await detailPage.waitForTimeout(1500);
        
        const details = await detailPage.evaluate(() => {
          const getText = (sel) => {
            const el = document.querySelector(sel);
            return el ? el.innerText.trim() : '';
          };
          const getAll = (sel) => Array.from(document.querySelectorAll(sel)).map(el => el.innerText.trim()).filter(t => t.length > 0);
          
          // Get all text content from the page
          const bodyText = document.body.innerText || '';
          
          // --- DESCRIPTION ---
          // Look for the main event description (usually in a specific container)
          let description = '';
          // Try common description selectors
          const descSelectors = [
            '[class*="description"]', '[class*="Description"]',
            '[class*="event-info"]', '[class*="eventInfo"]',
            '[class*="about"]', '[class*="details"]',
            '.show-more-content', '[class*="content-body"]'
          ];
          for (const sel of descSelectors) {
            const el = document.querySelector(sel);
            if (el && el.innerText.trim().length > 30) {
              description = el.innerText.trim();
              break;
            }
          }
          // Fallback: find paragraphs with substantial text
          if (!description) {
            const paras = Array.from(document.querySelectorAll('p, [class*="text"]'));
            const longParas = paras.filter(p => p.innerText.trim().length > 50 && p.innerText.trim().length < 2000);
            if (longParas.length > 0) {
              description = longParas.map(p => p.innerText.trim()).join('\n\n');
            }
          }
          // Clean: remove T&Cs boilerplate
          if (description) {
            const tcStart = description.indexOf('Organiser/Promoter/Venue');
            if (tcStart > 100) description = description.substring(0, tcStart).trim();
            const tcStart2 = description.indexOf('ShowsHappening Terms');
            if (tcStart2 > 100) description = description.substring(0, tcStart2).trim();
            const tcStart3 = description.indexOf('The booking fee is not');
            if (tcStart3 > 100) description = description.substring(0, tcStart3).trim();
            // Limit to 1000 chars
            if (description.length > 1000) description = description.substring(0, 1000) + '...';
          }
          
          // --- VENUE / LOCATION ---
          let location = '';
          // Look for "Where" section or venue name
          const whereMatch = bodyText.match(/Where\s*\n\s*(.+)/i);
          if (whereMatch) location = whereMatch[1].trim();
          // Try venue-specific selectors
          if (!location) {
            const venueSelectors = ['[class*="venue"]', '[class*="Venue"]', '[class*="location"]', '[class*="Location"]', '[class*="where"]'];
            for (const sel of venueSelectors) {
              const el = document.querySelector(sel);
              if (el && el.innerText.trim().length > 2 && el.innerText.trim().length < 100) {
                location = el.innerText.trim();
                break;
              }
            }
          }
          // Try finding text with "View map" nearby
          if (!location) {
            const mapLinks = Array.from(document.querySelectorAll('a'));
            const mapLink = mapLinks.find(a => a.innerText.includes('View map'));
            if (mapLink && mapLink.parentElement) {
              const parentText = mapLink.parentElement.innerText.replace('View map', '').trim();
              if (parentText.length > 2 && parentText.length < 150) location = parentText;
            }
          }
          
          // --- DATE (more precise from event page) ---
          let dateDetail = '';
          // Look for "When" section
          const whenMatch = bodyText.match(/When\s*\n\s*(.+)/i);
          if (whenMatch) dateDetail = whenMatch[1].trim();
          // Try date-specific selectors
          if (!dateDetail) {
            const dateSelectors = ['[class*="date"]', '[class*="Date"]', '[class*="when"]', '[class*="When"]', 'time'];
            for (const sel of dateSelectors) {
              const el = document.querySelector(sel);
              if (el && el.innerText.trim().length > 3 && el.innerText.trim().length < 100) {
                dateDetail = el.innerText.trim();
                break;
              }
            }
          }
          
          // --- PRICE ---
          let price = '';
          const priceMatches = bodyText.match(/€[\d.,]+/g);
          if (priceMatches) {
            const prices = [...new Set(priceMatches)];
            if (prices.length === 1) price = prices[0];
            else if (prices.length > 1) price = 'From ' + prices.sort((a, b) => parseFloat(a.replace('€','')) - parseFloat(b.replace('€','')))[0];
          }
          if (!price && bodyText.toLowerCase().includes('free')) price = 'Free';
          
          // --- ORGANIZER ---
          let organizer = '';
          // Usually in the URL: showshappening.com/ORGANIZER/event-name
          const urlParts = window.location.pathname.split('/').filter(p => p);
          if (urlParts.length >= 2) {
            organizer = decodeURIComponent(urlParts[0]).replace(/[-_]+/g, ' ');
          }
          
          // --- IMAGE (higher quality from event page) ---
          let image = '';
          const imgs = Array.from(document.querySelectorAll('img'));
          
          // Priority 1: Blob storage flyer images (actual event posters uploaded by organizers)
          const flyerImg = imgs.find(img => img.src && img.src.includes('blob.core.windows.net') && img.src.includes('flyer'));
          if (flyerImg) {
            image = flyerImg.src;
          }
          
          // Priority 2: Any blob storage image from ShowsHappening (event content, not branding)
          if (!image) {
            const blobImg = imgs.find(img => img.src && img.src.includes('blob.core.windows.net') && !img.src.includes('logo') && !img.src.includes('icon'));
            if (blobImg) image = blobImg.src;
          }
          
          // Priority 3: Large content images (not branding, not tiny icons)
          if (!image) {
            const contentImg = imgs.find(img => {
              const src = img.src || '';
              if (!src || !src.startsWith('http')) return false;
              if (src.includes('logo') || src.includes('icon') || src.includes('avatar')) return false;
              if (src.includes('showshappening.com') || src.includes('ShowsHappening')) return false;
              if (src.includes('Online-tickets') || src.includes('online-tickets')) return false;
              if (src.includes('favicon') || src.includes('spinner') || src.includes('loading')) return false;
              // Check natural dimensions if available, or accept if src looks like content
              const w = img.naturalWidth || img.width || 0;
              if (w > 0 && w < 100) return false;
              return true;
            });
            if (contentImg) image = contentImg.src;
          }
          
          // Priority 4: og:image only if not ShowsHappening branded
          if (!image) {
            const ogImage = document.querySelector('meta[property="og:image"]');
            if (ogImage) {
              const ogSrc = ogImage.getAttribute('content') || '';
              if (ogSrc && !ogSrc.includes('showshappening') && !ogSrc.includes('ShowsHappening') && !ogSrc.includes('Online-tickets') && !ogSrc.includes('online-tickets')) {
                image = ogSrc;
              }
            }
          }
          
          return { description, location, dateDetail, price, organizer, image };
        });
        
        // Merge details into event
        if (details.location && details.location.length > 2) {
          // Clean up ShowsHappening location format
          let loc = details.location;
          loc = loc.replace(/\s*View map\s*/gi, '').trim();
          loc = loc.replace(/,\s*Malta\s*$/i, '').trim();
          loc = loc.replace(/,\s*Malta,\s*/i, ', ').trim();
          loc = loc.replace(/\s+/g, ' ');
          if (loc.length > 2 && loc.toLowerCase() !== 'malta') event.location = loc;
        }
        if (details.description) event.description = details.description;
        if (details.dateDetail && !event.date) event.date = details.dateDetail;
        if (details.price && !event.price) event.price = details.price;
        if (details.organizer) event.organizer = details.organizer;
        if (details.image && details.image.startsWith('http')) event.image_url = details.image;
        
        enriched++;
        if (i % 10 === 0) console.log(`  Progress: ${i+1}/${unique.length} pages visited...`);
        
      } catch (detailErr) {
        // Skip if page fails - keep homepage data
        console.log(`  Skipped ${event.title}: ${detailErr.message}`);
      }
    }
    
    await detailPage.close();
    console.log(`  Enriched ${enriched}/${unique.length} events with page details.`);

    // Step 3: Save to database (with duplicate title detection)
    for (const event of unique) {
      try {
        // Final safety: strip branded ShowsHappening images before saving
        if (event.image_url) {
          const imgLower = event.image_url.toLowerCase();
          if (imgLower.includes('online-tickets') || imgLower.includes('online_tickets') || 
              (imgLower.includes('showshappening.com/images') && !imgLower.includes('blob.core.windows.net'))) {
            console.log(`  [Image] Stripped branded image for "${event.title}"`);
            event.image_url = null;
          }
        }
        
        // Build description with price info
        let desc = event.description || '';
        if (event.price && !desc.includes(event.price)) {
          desc = desc ? `Price: ${event.price}\n\n${desc}` : `Price: ${event.price}`;
        }
        
        // Check if an event with same/similar title already exists (from any source)
        const titleNorm = (event.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const existing = await pool.query(
          `SELECT id, title, source_url, image_url, description, location, event_date FROM events 
           WHERE LOWER(regexp_replace(title, '[^a-zA-Z0-9]', '', 'g')) = $1 
           AND COALESCE(status,'live') = 'live'`,
          [titleNorm]
        );
        
        if (existing.rows.length > 0 && !existing.rows.some(r => r.source_url === event.url)) {
          // Event already exists from another source — enrich existing, don't create duplicate
          const ex = existing.rows[0];
          const updates = [];
          const vals = [];
          let paramIdx = 1;
          
          // Only update fields that are empty/missing on the existing event
          if ((!ex.image_url || ex.image_url.includes('showshappening')) && event.image_url) {
            updates.push(`image_url = $${paramIdx++}`); vals.push(event.image_url);
          }
          if ((!ex.description || ex.description.length < 20) && desc && desc.length > 20) {
            updates.push(`description = $${paramIdx++}`); vals.push(desc);
          }
          if ((!ex.location || ex.location === 'Malta') && event.location && event.location !== 'Malta') {
            updates.push(`location = $${paramIdx++}`); vals.push(event.location);
          }
          if (!ex.event_date && event.date) {
            updates.push(`event_date = $${paramIdx++}`); vals.push(event.date);
          }
          
          if (updates.length > 0) {
            vals.push(ex.id);
            await pool.query(`UPDATE events SET ${updates.join(', ')} WHERE id = $${paramIdx}`, vals);
            console.log(`  [Dedup] Enriched existing "${ex.title}" (ID:${ex.id}) — skipped duplicate from ShowsHappening`);
          } else {
            console.log(`  [Dedup] Skipped "${event.title}" — already exists (ID:${ex.id})`);
          }
          continue; // Don't insert new row
        }
        
        await pool.query(
          `INSERT INTO events (title, location, source_url, image_url, event_date, description, source_name) 
           VALUES ($1, $2, $3, $4, $5, $6, $7) 
           ON CONFLICT (source_url) DO UPDATE SET 
             title = EXCLUDED.title,
             image_url = COALESCE(NULLIF(EXCLUDED.image_url, ''), events.image_url),
             event_date = COALESCE(EXCLUDED.event_date, events.event_date),
             description = CASE WHEN LENGTH(EXCLUDED.description) > LENGTH(COALESCE(events.description, '')) THEN EXCLUDED.description ELSE events.description END,
             location = CASE WHEN EXCLUDED.location != 'Malta' THEN EXCLUDED.location ELSE events.location END,
             source_name = COALESCE(EXCLUDED.source_name, events.source_name)`,
          [
            event.title,
            event.location || 'Malta',
            event.url,
            event.image_url,
            event.date || null,
            desc || null,
            event.organizer ? `ShowsHappening · ${event.organizer}` : 'ShowsHappening'
          ]
        );
      } catch (dbErr) {
        console.log(`  DB error for ${event.title}: ${dbErr.message}`);
      }
    }

    const withDesc = unique.filter(e => e.description).length;
    const withLoc = unique.filter(e => e.location && e.location !== 'Malta').length;
    const withDates = unique.filter(e => e.date).length;
    const withPrices = unique.filter(e => e.price).length;
    console.log(`ShowsHappening: ${unique.length} events (${withDesc} with descriptions, ${withLoc} with venues, ${withDates} with dates, ${withPrices} with prices).`);
    
    if (unique.length > 0) {
      console.log("\n  === SAMPLE EVENTS ===");
      unique.slice(0, 5).forEach(e => {
        console.log(`  Title: ${e.title}`);
        console.log(`  Date:  ${e.date || 'N/A'}`);
        console.log(`  Venue: ${e.location || 'N/A'}`);
        console.log(`  Price: ${e.price || 'N/A'}`);
        console.log(`  Desc:  ${(e.description || 'N/A').substring(0, 100)}...`);
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
        // Duplicate check by normalized title
        const titleNorm = (event.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (titleNorm.length > 3) {
          const existing = await pool.query(
            `SELECT id, title, source_url, image_url, description, location, event_date, category FROM events 
             WHERE LOWER(regexp_replace(title, '[^a-zA-Z0-9]', '', 'g')) = $1 
             AND COALESCE(status,'live') = 'live' AND source_url != $2`,
            [titleNorm, event.url]
          );
          if (existing.rows.length > 0) {
            const ex = existing.rows[0];
            const updates = []; const vals = []; let p = 1;
            if (!ex.image_url && event.image_url) { updates.push(`image_url = $${p++}`); vals.push(event.image_url); }
            if ((!ex.description || ex.description.length < 20) && event.description && event.description.length > 20) { updates.push(`description = $${p++}`); vals.push(event.description); }
            if ((!ex.location || ex.location === 'Malta') && event.location && event.location !== 'Malta') { updates.push(`location = $${p++}`); vals.push(event.location); }
            if (!ex.event_date && event.date) { updates.push(`event_date = $${p++}`); vals.push(event.date); }
            if (!ex.category && event.category) { updates.push(`category = $${p++}`); vals.push(event.category); }
            if (updates.length > 0) { vals.push(ex.id); await pool.query(`UPDATE events SET ${updates.join(', ')} WHERE id = $${p}`, vals); }
            console.log(`  [Dedup] Skipped VisitMalta "${event.title}" — exists as ID:${ex.id}`);
            continue;
          }
        }

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

// --- 3. RESIDENT ADVISOR (RA.co) ---
async function scrapeResidentAdvisor() {
  try {
    console.log("Resident Advisor scraping...");
    
    const fetch = (await import('node-fetch')).default;
    
    const today = new Date();
    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + 60);
    
    // Try multiple possible Malta area IDs
    const areaIds = [164];
    let listings = [];
    let totalResults = 0;
    let workingAreaId = null;

    for (const areaId of areaIds) {
      console.log(`  Trying area ID ${areaId}...`);
      
      const query = {
        query: `query GET_DEFAULT_EVENTS_LISTING($filters: FilterInputDtoInput, $pageSize: Int, $page: Int) {
          eventListings(filters: $filters, pageSize: $pageSize, page: $page) {
            data {
              id
              listingDate
              event {
                id
                title
                date
                startTime
                endTime
                contentUrl
                images {
                  filename
                }
                flyerFront
                venue {
                  name
                  area {
                    name
                    country {
                      name
                    }
                  }
                }
                artists {
                  name
                }
                pick {
                  blurb
                }
              }
            }
            totalResults
          }
        }`,
        variables: {
          filters: {
            areas: { eq: areaId },
            listingDate: {
              gte: today.toISOString().split('T')[0],
              lte: futureDate.toISOString().split('T')[0]
            }
          },
          pageSize: 50,
          page: 1
        }
      };

      try {
        const response = await fetch('https://ra.co/graphql', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Referer': 'https://ra.co/events/mt/all',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          body: JSON.stringify(query)
        });

        const data = await response.json();
        
        if (data.data && data.data.eventListings && data.data.eventListings.data) {
          const results = data.data.eventListings.data;
          const total = data.data.eventListings.totalResults || 0;
          
          // Check if any event mentions Malta in the venue area
          const hasMalta = results.some(l => {
            const area = l.event?.venue?.area?.name || '';
            const country = l.event?.venue?.area?.country?.name || '';
            return area.toLowerCase().includes('malta') || country.toLowerCase().includes('malta');
          });
          
          console.log(`    Found ${results.length} events (total: ${total})${hasMalta ? ' ✓ Malta confirmed' : ''}`);
          
          if (results.length > 0 && results.length > listings.length) {
            listings = results;
            totalResults = total;
            workingAreaId = areaId;
            if (hasMalta) break; // Perfect match, stop trying
          }
        } else {
          console.log(`    No results or unexpected response`);
          if (data.errors) console.log(`    Errors: ${JSON.stringify(data.errors).substring(0, 200)}`);
        }
      } catch (fetchErr) {
        console.log(`    Fetch error: ${fetchErr.message}`);
      }
    }

    if (listings.length === 0) {
      console.log("  RA: No events found for any Malta area ID. You may need to find the correct ID.");
      console.log("  Tip: Open ra.co/events/mt/all in browser, check Network tab for GraphQL requests to find the area ID.");
      return;
    }

    console.log(`\n  RA: Using area ID ${workingAreaId} — ${listings.length} events (total: ${totalResults})`);

    let saved = 0;
    for (const listing of listings) {
      const event = listing.event;
      if (!event || !event.title) continue;

      const title = event.title;
      const venue = event.venue?.name || 'Malta';
      const area = event.venue?.area?.name || '';
      const country = event.venue?.area?.country?.name || '';
      // "All" is not a useful area name - use country or just "Malta"
      const locationArea = (area && area.toLowerCase() !== 'all') ? area : (country || 'Malta');
      const location = `${venue}, ${locationArea}`;
      
      const sourceUrl = event.contentUrl 
        ? `https://ra.co${event.contentUrl}` 
        : `https://ra.co/events/${event.id}`;
      
      let imageUrl = null;
      if (event.images && event.images.length > 0 && event.images[0].filename) {
        const fn = event.images[0].filename;
        // RA image URLs can be: full URL, just filename, or path
        if (fn.startsWith('http')) {
          imageUrl = fn;
        } else if (fn.startsWith('/')) {
          imageUrl = `https://images.ra.co${fn}`;
        } else {
          // Try with query params for proper sizing
          imageUrl = `https://images.ra.co/${fn}?width=640`;
        }
      }
      // Also try flyerFront if images array is empty
      if (!imageUrl && event.flyerFront) {
        imageUrl = event.flyerFront;
      }

      const eventDate = listing.listingDate || event.date || null;
      let dateText = null;
      if (eventDate) {
        try {
          const d = new Date(eventDate);
          const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          dateText = `${d.getDate()} ${months[d.getMonth()]}`;
        } catch(e) {}
      }

      let description = '';
      if (event.artists && event.artists.length > 0) {
        const artistNames = event.artists.map(a => a.name).filter(Boolean);
        if (artistNames.length > 0) {
          description = 'Lineup: ' + artistNames.join(', ');
        }
      }
      if (event.pick && event.pick.blurb) {
        description = event.pick.blurb + (description ? '\n' + description : '');
      }

      try {
        // Duplicate check
        const titleNorm = (title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (titleNorm.length > 3) {
          const existing = await pool.query(
            `SELECT id, title, source_url, image_url, description, location, event_date FROM events 
             WHERE LOWER(regexp_replace(title, '[^a-zA-Z0-9]', '', 'g')) = $1 
             AND COALESCE(status,'live') = 'live' AND source_url != $2`,
            [titleNorm, sourceUrl]
          );
          if (existing.rows.length > 0) {
            const ex = existing.rows[0];
            const updates = []; const vals = []; let p = 1;
            if (!ex.image_url && imageUrl) { updates.push(`image_url = $${p++}`); vals.push(imageUrl); }
            if ((!ex.description || ex.description.length < 20) && description && description.length > 20) { updates.push(`description = $${p++}`); vals.push(description); }
            if ((!ex.location || ex.location === 'Malta') && location && location !== 'Malta') { updates.push(`location = $${p++}`); vals.push(location); }
            if (!ex.event_date && dateText) { updates.push(`event_date = $${p++}`); vals.push(dateText); }
            if (updates.length > 0) { vals.push(ex.id); await pool.query(`UPDATE events SET ${updates.join(', ')} WHERE id = $${p}`, vals); }
            console.log(`  [Dedup] Skipped RA "${title}" — exists as ID:${ex.id}`);
            continue;
          }
        }

        await pool.query(
          `INSERT INTO events (title, location, source_url, image_url, event_date, description, category, source_name) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
           ON CONFLICT (source_url) DO UPDATE SET 
             title = EXCLUDED.title,
             image_url = COALESCE(EXCLUDED.image_url, events.image_url),
             event_date = COALESCE(EXCLUDED.event_date, events.event_date),
             description = COALESCE(EXCLUDED.description, events.description),
             category = COALESCE(EXCLUDED.category, events.category)`,
          [title, location, sourceUrl, imageUrl, dateText, description || null, 'Nightlife & Parties', 'Resident Advisor']
        );
        saved++;
      } catch (dbErr) {
        if (dbErr.message.includes('column')) {
          try {
            await pool.query(
              'INSERT INTO events (title, location, source_url, image_url) VALUES ($1, $2, $3, $4) ON CONFLICT (source_url) DO NOTHING',
              [title, location, sourceUrl, imageUrl]
            );
            saved++;
          } catch(e) {}
        } else {
          console.error(`  DB error (${title}):`, dbErr.message);
        }
      }
    }

    console.log(`  RA: ${saved} events saved/updated`);

    if (listings.length > 0) {
      console.log("\n  === RA SAMPLE EVENTS ===");
      listings.slice(0, 5).forEach(l => {
        const e = l.event;
        console.log(`  Title:    ${e.title}`);
        console.log(`  Venue:    ${e.venue?.name || 'N/A'}, ${e.venue?.area?.country?.name || 'N/A'}`);
        console.log(`  Date:     ${l.listingDate || 'N/A'}`);
        console.log(`  Artists:  ${(e.artists||[]).map(a=>a.name).join(', ') || 'N/A'}`);
        console.log(`  Images:   ${JSON.stringify(e.images || [])}`);
        console.log(`  Flyer:    ${e.flyerFront || 'N/A'}`);
        console.log(`  URL:      https://ra.co${e.contentUrl || '/events/' + e.id}`);
        console.log(`  ---`);
      });
    }

  } catch (err) {
    console.error("Resident Advisor Error:", err.message);
  }
}

// --- 4. EVENTWORKS.MT ---
async function scrapeEventWorks() {
  try {
    console.log("EventWorks scraping...");
    
    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://eventworks.mt/all-events/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      console.error(`  EventWorks: HTTP ${response.status}`);
      return;
    }
    
    const html = await response.text();
    console.log(`  EventWorks: Page loaded (${html.length} chars)`);
    
    const events = [];
    
    // Split by event blocks: each starts with <div class="search-event-holder
    const blocks = html.split(/search-event-holder/);
    
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      
      // Extract href
      const hrefMatch = block.match(/<a\s+href=["']([^"']+)["']/);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];
      
      // Skip external/non-event links
      if (href.startsWith('http') || href.startsWith('#') || href.length < 3) continue;
      
      // Extract image URL from background-image or --bg-image
      let imageUrl = null;
      const imgMatch = block.match(/url\(['"]?(https:\/\/s3[^'")\s]+)['"]?\)/);
      if (imgMatch) imageUrl = imgMatch[1];
      
      // Extract month and day
      const monthMatch = block.match(/<span\s+class=["']month["']>\s*(.*?)\s*<\/span>/);
      const dayMatch = block.match(/<span\s+class=["']day["']>\s*(.*?)\s*<\/span>/);
      if (!monthMatch || !dayMatch) continue;
      const dateText = `${dayMatch[1]} ${monthMatch[1]}`;
      
      // Extract title
      const titleMatch = block.match(/<div\s+class=["']event-title["']>\s*(.*?)\s*<\/div>/);
      if (!titleMatch) continue;
      const title = titleMatch[1].trim();
      
      // Extract location
      const locMatch = block.match(/<div\s+class=["']event-location["']>\s*(.*?)\s*<\/div>/);
      const location = locMatch ? locMatch[1].trim() : 'Malta';
      
      // Extract price
      const priceMatch = block.match(/<div\s+class=["']event-price-range["']>\s*(.*?)\s*<\/div>/);
      const price = priceMatch ? priceMatch[1].trim() : '';
      
      // Skip non-Malta events
      const locLower = location.toLowerCase();
      if (locLower.includes('bournemouth') || locLower.includes('amsterdam') || locLower.includes('london') || locLower.includes('manchester')) {
        console.log(`  Skipping non-Malta: ${title}`);
        continue;
      }
      
      const sourceUrl = `https://eventworks.mt${href}`;
      
      if (events.some(e => e.url === sourceUrl)) continue;
      
      events.push({
        title,
        date: dateText,
        location,
        url: sourceUrl,
        image_url: imageUrl,
        description: (price && price !== 'From €N/A') ? price : null
      });
    }
    
    console.log(`  EventWorks: ${events.length} Malta events found. Saving...`);
    
    let saved = 0;
    for (const event of events) {
      try {
        // Duplicate check
        const titleNorm = (event.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (titleNorm.length > 3) {
          const existing = await pool.query(
            `SELECT id, title, source_url, image_url, description, location, event_date FROM events 
             WHERE LOWER(regexp_replace(title, '[^a-zA-Z0-9]', '', 'g')) = $1 
             AND COALESCE(status,'live') = 'live' AND source_url != $2`,
            [titleNorm, event.url]
          );
          if (existing.rows.length > 0) {
            const ex = existing.rows[0];
            const updates = []; const vals = []; let p = 1;
            if (!ex.image_url && event.image_url) { updates.push(`image_url = $${p++}`); vals.push(event.image_url); }
            if ((!ex.description || ex.description.length < 20) && event.description && event.description.length > 20) { updates.push(`description = $${p++}`); vals.push(event.description); }
            if ((!ex.location || ex.location === 'Malta') && event.location && event.location !== 'Malta') { updates.push(`location = $${p++}`); vals.push(event.location); }
            if (!ex.event_date && event.date) { updates.push(`event_date = $${p++}`); vals.push(event.date); }
            if (updates.length > 0) { vals.push(ex.id); await pool.query(`UPDATE events SET ${updates.join(', ')} WHERE id = $${p}`, vals); }
            console.log(`  [Dedup] Skipped EventWorks "${event.title}" — exists as ID:${ex.id}`);
            continue;
          }
        }

        await pool.query(
          `INSERT INTO events (title, location, source_url, image_url, event_date, description, category, source_name) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
           ON CONFLICT (source_url) DO UPDATE SET 
             title = EXCLUDED.title,
             image_url = COALESCE(EXCLUDED.image_url, events.image_url),
             event_date = COALESCE(EXCLUDED.event_date, events.event_date),
             description = COALESCE(EXCLUDED.description, events.description)`,
          [event.title, event.location, event.url, event.image_url, event.date, event.description, 'Nightlife & Parties', 'EventWorks']
        );
        saved++;
      } catch (dbErr) {
        if (dbErr.message.includes('column')) {
          try {
            await pool.query(
              'INSERT INTO events (title, location, source_url, image_url) VALUES ($1, $2, $3, $4) ON CONFLICT (source_url) DO NOTHING',
              [event.title, event.location, event.url, event.image_url]
            );
            saved++;
          } catch(e) {}
        } else {
          console.error(`  DB error (${event.title}):`, dbErr.message);
        }
      }
    }
    
    console.log(`  EventWorks: ${saved} events saved/updated`);
    
    if (events.length > 0) {
      console.log("\n  === EVENTWORKS SAMPLE EVENTS ===");
      events.slice(0, 5).forEach(e => {
        console.log(`  Title:    ${e.title}`);
        console.log(`  Date:     ${e.date}`);
        console.log(`  Venue:    ${e.location}`);
        console.log(`  Image:    ${e.image_url ? 'YES' : 'NO'}`);
        console.log(`  URL:      ${e.url}`);
        console.log(`  ---`);
      });
    }
    
  } catch (err) {
    console.error("EventWorks Error:", err.message);
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
    console.log("\n---\n");
    await scrapeResidentAdvisor();
    console.log("\n---\n");
    await scrapeEventWorks();
  } finally {
    await browser.close();
    await pool.end();
    console.log("\n=== Done ===");
  }
}

run();
