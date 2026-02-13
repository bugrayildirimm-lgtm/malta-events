require('dotenv').config(); // Bunu en üste ekle
const { Pool } = require('pg');
const { chromium } = require('playwright');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD, // Şifreyi buradan çekecek
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});
// ... kodun geri kalanı aynı kalsın ...

// --- 1. SHOWSHAPPENING (DOKUNULMADI - AYNI KOD) ---
async function scrapeShowsHappening(browser) {
  const page = await browser.newPage();
  try {
    console.log("ShowsHappening taranıyor...");
    await page.goto('https://www.showshappening.com/', { waitUntil: 'networkidle' });
    
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
      return anchors.map(a => ({
        title: a.innerText.replace(/\n/g, ' ').trim(),
        url: a.href,
        image_url: a.querySelector('img') ? a.querySelector('img').src : null
      })).filter(item => 
        item.image_url && 
        item.title.length > 15 && 
        item.title.length < 150 &&
        !item.title.toLowerCase().includes('seller test') &&
        !item.title.toLowerCase().startsWith('entertainment')
      );
    });

    for (const event of events) {
      await pool.query(
        'INSERT INTO events (title, location, source_url, image_url) VALUES ($1, $2, $3, $4) ON CONFLICT (source_url) DO UPDATE SET image_url = EXCLUDED.image_url',
        [event.title.replace(/^Follow\s+/i, '').trim(), 'Malta', event.url, event.image_url]
      );
    }
    console.log(`ShowsHappening: ${events.length} etkinlik bulundu.`);
  } catch (err) { console.error("SH Hatası:", err.message); }
  finally { await page.close(); }
}

// --- 2. VISITMALTA (DOĞRUDAN API'DEN ÇEKİYOR - TARAYICI GEREKMİYOR) ---
async function scrapeVisitMalta() {
  try {
    console.log("VisitMalta taranıyor (API)...");

    // VisitMalta's frontend calls this API to load events — no browser needed!
    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://api.visitmaltaplus.com/api/v2/LoadAllEvents?&limit=500&version=947', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      throw new Error(`API yanıtı: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const rows = data.rows || {};
    const events = [];

    // Step 1: Collect all file target_ids that need resolution
    const fileIdsToResolve = new Set();

    for (const key of Object.keys(rows)) {
      const event = rows[key];
      const externalImg = event.field_external_image_url?.[0]?.value || null;
      if (!externalImg) {
        const imageTargetId = event.field_dtp_event_image?.[0]?.target_id || null;
        if (imageTargetId) fileIdsToResolve.add(imageTargetId);
      }
    }

    // Step 2: Try to resolve file IDs to real image URLs
    let fileIdToUrl = {};
    if (fileIdsToResolve.size > 0) {
      console.log(`  ${fileIdsToResolve.size} dosya ID'si çözülüyor...`);
      fileIdToUrl = await resolveFileIds(fetch, Array.from(fileIdsToResolve));
      console.log(`  ${Object.keys(fileIdToUrl).length} resim URL'si bulundu.`);
    }

    // Step 3: Build event objects
    for (const key of Object.keys(rows)) {
      const event = rows[key];

      // Title
      const title = event.title?.[0]?.value;
      if (!title || title.length < 3) continue;

      // Dates
      const startDate = event.start_date || null;
      const endDate = event.end_date || null;
      const dateText = startDate && endDate && startDate !== endDate
        ? `${startDate} - ${endDate}`
        : startDate || null;

      // URL
      const urlAlias = event.url_alias || event.path?.[0]?.alias?.replace(/^\//, '') || '';
      const sourceUrl = urlAlias
        ? `https://www.visitmalta.com/en/events-in-malta-and-gozo/event/${urlAlias}`
        : `https://www.visitmalta.com/en/events-in-malta-and-gozo/`;

      // Description (from body or summary)
      const bodyHtml = event.body?.[0]?.value || '';
      const summary = event.field_summary?.[0]?.value || '';
      const description = (summary || bodyHtml.replace(/<[^>]*>/g, '')).trim().substring(0, 500) || null;

      // Image — try external URL first, then resolved file ID
      const externalImg = event.field_external_image_url?.[0]?.value || null;
      const imageTargetId = event.field_dtp_event_image?.[0]?.target_id || null;
      const imageUrl = externalImg || fileIdToUrl[imageTargetId] || null;

      // Location
      const locationData = event.field_event_location?.[0];
      const location = locationData?.addr_autocomplete || locationData?.name || 'Malta';

      // Category
      const category = event.field_event_category?.[0]?.name || null;

      // Booking link
      const bookingLink = event.field_booking_link?.[0]?.value || null;

      // Website
      const website = event.field_event_website?.[0]?.value || null;

      events.push({
        title,
        date: dateText,
        start_date: startDate,
        end_date: endDate,
        url: sourceUrl,
        image_url: imageUrl,
        description,
        location,
        category,
        booking_link: bookingLink,
        website,
      });
    }

    const withImages = events.filter(e => e.image_url).length;
    console.log(`VisitMalta: ${events.length} etkinlik bulundu (${withImages} resimli). Kaydediliyor...`);

    // Save to database
    for (const event of events) {
      try {
        await pool.query(
          `INSERT INTO events (title, location, source_url, image_url, event_date, description) 
           VALUES ($1, $2, $3, $4, $5, $6) 
           ON CONFLICT (source_url) DO UPDATE SET 
             image_url = COALESCE(EXCLUDED.image_url, events.image_url),
             event_date = COALESCE(EXCLUDED.event_date, events.event_date),
             description = COALESCE(EXCLUDED.description, events.description)`,
          [
            event.title,
            event.location,
            event.url,
            event.image_url,
            event.date || null,
            event.description || null
          ]
        );
      } catch (dbErr) {
        // If table doesn't have event_date/description columns, fall back to basic insert
        if (dbErr.message.includes('column') && (dbErr.message.includes('event_date') || dbErr.message.includes('description'))) {
          await pool.query(
            'INSERT INTO events (title, location, source_url, image_url) VALUES ($1, $2, $3, $4) ON CONFLICT (source_url) DO NOTHING',
            [event.title, event.location, event.url, event.image_url]
          );
        } else {
          console.error(`  DB hatası (${event.title}):`, dbErr.message);
        }
      }
    }

    // Log sample events for verification
    if (events.length > 0) {
      const withImages = events.filter(e => e.image_url).length;
      const withoutImages = events.filter(e => !e.image_url).length;
      console.log(`\n  Resimli: ${withImages} | Resimsiz: ${withoutImages}`);
      console.log("\n  === ÖRNEK ETKİNLİKLER ===");
      events.slice(0, 5).forEach(e => {
        console.log(`  Başlık:  ${e.title}`);
        console.log(`  Tarih:   ${e.date || 'Bulunamadı'}`);
        console.log(`  Konum:   ${e.location}`);
        console.log(`  Resim:   ${e.image_url ? '✓' : '✗'}`);
        console.log(`  ---`);
      });
    }

  } catch (err) {
    console.error("VisitMalta Hatası:", err.message);
  }
}

// Try multiple Drupal file URL patterns to resolve image target IDs
async function resolveFileIds(fetch, fileIds) {
  const result = {};
  
  // Pattern 1: Try the custom API file endpoint
  const endpoints = [
    id => `https://api.visitmaltaplus.com/api/v2/file/${id}`,
    id => `https://api.visitmaltaplus.com/entity/file/${id}?_format=json`,
    id => `https://api.visitmaltaplus.com/file/${id}?_format=json`,
  ];

  // Test the first file ID with each endpoint pattern to find which one works
  const testId = fileIds[0];
  let workingEndpoint = null;

  for (const endpointFn of endpoints) {
    try {
      const url = endpointFn(testId);
      console.log(`  Endpoint deneniyor: ${url}`);
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        timeout: 10000,
      });

      if (res.ok) {
        const data = await res.json();
        // Look for a URL in the response
        const fileUrl = extractFileUrl(data);
        if (fileUrl) {
          console.log(`  ✓ Çalışan endpoint bulundu! Örnek URL: ${fileUrl}`);
          result[testId] = fileUrl;
          workingEndpoint = endpointFn;
          break;
        }
      }
    } catch (e) {
      // Try next endpoint
    }
  }

  // If we found a working endpoint, resolve all remaining IDs
  if (workingEndpoint) {
    const remaining = fileIds.filter(id => id !== testId);
    // Process in batches of 5 to be polite
    for (let i = 0; i < remaining.length; i += 5) {
      const batch = remaining.slice(i, i + 5);
      const promises = batch.map(async (id) => {
        try {
          const res = await fetch(workingEndpoint(id), {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json',
            },
            timeout: 10000,
          });
          if (res.ok) {
            const data = await res.json();
            const url = extractFileUrl(data);
            if (url) result[id] = url;
          }
        } catch (e) { /* skip */ }
      });
      await Promise.all(promises);
      // Small delay between batches
      if (i + 5 < remaining.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } else {
    console.log("  ✗ Dosya endpoint'i bulunamadı, sayfa resimlerine geçiliyor...");
  }

  return result;
}

// Extract file URL from a Drupal file entity response
function extractFileUrl(data) {
  if (!data) return null;
  
  // Try various Drupal response formats
  if (typeof data === 'string' && data.startsWith('http')) return data;
  if (data.url) return data.url;
  if (data.uri?.[0]?.url) return data.uri[0].url;
  if (data.uri?.[0]?.value) {
    const uri = data.uri[0].value;
    // Convert Drupal internal URI (public://...) to full URL
    if (uri.startsWith('public://')) {
      return `https://api.visitmaltaplus.com/sites/default/files/${uri.replace('public://', '')}`;
    }
    return uri;
  }
  if (data.attributes?.uri?.url) return data.attributes.uri.url;
  if (data.field_media_image?.uri) return data.field_media_image.uri;
  
  return null;
}

// Get Open Graph image from an event page as fallback
async function getOgImage(fetch, url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 15000,
    });
    if (!res.ok) return null;
    const html = await res.text();
    
    // Look for og:image meta tag
    const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    if (ogMatch) return ogMatch[1];
    
    // Look for twitter:image
    const twMatch = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
    if (twMatch) return twMatch[1];
    
    return null;
  } catch (e) {
    return null;
  }
}

// --- ÇALIŞTIR ---
async function run() {
  console.log("=== Event Scraper Başlatılıyor ===\n");
  
  const browser = await chromium.launch({ 
    headless: false
  });
  
  try {
    await scrapeShowsHappening(browser);
    console.log("\n---\n");
    await scrapeVisitMalta(); // No browser needed — uses API directly
  } finally {
    await browser.close();
    await pool.end();
    console.log("\n=== Bitti ===");
  }
}

run();
