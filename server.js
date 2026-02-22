require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'malta2026';
function authCheck(req, res) {
  if (req.headers.authorization !== ADMIN_PASSWORD) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

// =====================================================================
// CLICK TRACKING TABLE (auto-create)
// =====================================================================
pool.query(`CREATE TABLE IF NOT EXISTS click_tracking (
  id SERIAL PRIMARY KEY,
  event_id INTEGER,
  event_title TEXT,
  source TEXT,
  clicked_at TIMESTAMP DEFAULT NOW(),
  user_agent TEXT,
  referrer TEXT
)`).catch(()=>{});

// Ensure columns exist
pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS category TEXT').catch(()=>{});
pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS source_name TEXT').catch(()=>{});
pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS recurring TEXT').catch(()=>{});
pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS slug TEXT').catch(()=>{});

pool.query(`CREATE TABLE IF NOT EXISTS email_subscribers (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  subscribed_at TIMESTAMP DEFAULT NOW(),
  source TEXT DEFAULT 'website'
)`).catch(()=>{});

// Generate URL-friendly slug from title
function generateSlug(title) {
  if (!title) return 'event-' + Date.now();
  return title.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z0-9\s-]/g, '') // remove special chars
    .replace(/\s+/g, '-') // spaces to hyphens
    .replace(/-+/g, '-') // collapse multiple hyphens
    .replace(/^-|-$/g, '') // trim hyphens
    .substring(0, 80) || 'event';
}

// =====================================================================
// MONTH HELPERS
// =====================================================================
const MONTHS = {
  'jan':0,'january':0,'feb':1,'february':1,'mar':2,'march':2,
  'apr':3,'april':3,'may':4,'jun':5,'june':5,
  'jul':6,'july':6,'aug':7,'august':7,'sep':8,'september':8,
  'oct':9,'october':9,'nov':10,'november':10,'dec':11,'december':11
};
function monthToNum(s) { return MONTHS[(s||'').toLowerCase()] ?? null; }

// =====================================================================
// DATE PARSING
// =====================================================================
function parseSingleDate(str) {
  if (!str) return null;
  str = str.trim();
  if (str.includes('€') || str.startsWith('Price')) return null;
  let m = str.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m && monthToNum(m[2]) !== null) return new Date(+m[3], monthToNum(m[2]), +m[1]);
  m = str.match(/^(\d{1,2})\s+([A-Za-z]{3,})$/);
  if (m && monthToNum(m[2]) !== null) {
    const y = new Date().getFullYear();
    const d = new Date(y, monthToNum(m[2]), +m[1]);
    if (d < Date.now() - 60*86400000) d.setFullYear(y+1);
    return d;
  }
  m = str.match(/^([\d,\s]+)\s+([A-Za-z]{3,})$/);
  if (m && monthToNum(m[2]) !== null) {
    const days = m[1].split(',').map(d=>+d.trim()).filter(d=>d);
    const y = new Date().getFullYear();
    const d = new Date(y, monthToNum(m[2]), days[days.length-1]);
    if (d < Date.now() - 60*86400000) d.setFullYear(y+1);
    return d;
  }
  return null;
}

function getEndDate(dateStr) {
  if (!dateStr || dateStr.includes('€') || dateStr.startsWith('Price')) return null;
  if (dateStr.includes(' - ')) {
    const parts = dateStr.split(' - ');
    return parseSingleDate(parts[1].trim()) || parseSingleDate(parts[0].trim());
  }
  let mr = dateStr.match(/^(?:\d{1,2}[- ])?([A-Za-z]{3,})\s+to\s+(?:\d{1,2}[- ])?([A-Za-z]{3,})$/i);
  if (mr && monthToNum(mr[2]) !== null) {
    const y = new Date().getFullYear();
    const d = new Date(y, monthToNum(mr[2])+1, 0);
    if (d < Date.now() - 60*86400000) d.setFullYear(y+1);
    return d;
  }
  mr = dateStr.match(/(\d{1,2})[- ]([A-Za-z]{3,})\s+to\s+(\d{1,2})[- ]([A-Za-z]{3,})/i);
  if (mr && monthToNum(mr[4]) !== null) {
    const y = new Date().getFullYear();
    const d = new Date(y, monthToNum(mr[4]), +mr[3]);
    if (d < Date.now() - 60*86400000) d.setFullYear(y+1);
    return d;
  }
  return parseSingleDate(dateStr);
}

function getStartDate(dateStr) {
  if (!dateStr || dateStr.includes('€') || dateStr.startsWith('Price')) return null;
  if (dateStr.includes(' - ')) return parseSingleDate(dateStr.split(' - ')[0].trim());
  let mr = dateStr.match(/^(?:(\d{1,2})[- ])?([A-Za-z]{3,})\s+to\s+/i);
  if (mr && monthToNum(mr[2]) !== null) {
    const y = new Date().getFullYear();
    return new Date(y, monthToNum(mr[2]), mr[1] ? +mr[1] : 1);
  }
  const multiDay = dateStr.match(/^([\d,\s]+)\s+([A-Za-z]{3,})$/);
  if (multiDay && monthToNum(multiDay[2]) !== null) {
    const day = +multiDay[1].split(',')[0].trim();
    const y = new Date().getFullYear();
    const d = new Date(y, monthToNum(multiDay[2]), day);
    if (d < Date.now() - 60*86400000) d.setFullYear(y+1);
    return d;
  }
  return parseSingleDate(dateStr);
}

function looksLikeDate(str) {
  if (!str) return false;
  const s = str.trim();
  if (/^\d{1,2}[,\d\s]*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(s)) return true;
  if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+to\s+/i.test(s)) return true;
  if (/^\d{1,2}[- ](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+to\s+/i.test(s)) return true;
  return false;
}

// =====================================================================
// DATE BADGE
// =====================================================================
function getDateBadge(dateStr) {
  if (!dateStr || dateStr.includes('€') || dateStr.startsWith('Price')) return '';
  if (dateStr.includes(' - ')) {
    const parts = dateStr.split(' - ');
    const s = extractDM(parts[0].trim());
    const e = extractDM(parts[1].trim());
    if (s && e) {
      if (s.month === e.month) return badge(s.month, s.day + '-' + e.day);
      return badge(s.month + '→' + e.month, s.day + '→' + e.day);
    }
  }
  let mr = dateStr.match(/(?:(\d{1,2})[- ])?([A-Za-z]{3,})\s+to\s+(?:(\d{1,2})[- ])?([A-Za-z]{3,})/i);
  if (mr) {
    const m1 = (mr[2]||'').substring(0,3).toUpperCase();
    const m2 = (mr[4]||'').substring(0,3).toUpperCase();
    if (mr[1] && mr[3]) return badge(m1 + '→' + m2, mr[1] + '→' + mr[3]);
    return badge(m1 + '→' + m2, 'Ongoing');
  }
  const multiDay = dateStr.match(/^([\d,\s]+)\s+([A-Za-z]{3,})$/);
  if (multiDay) {
    const days = multiDay[1].split(',').map(d=>d.trim()).filter(d=>d);
    const month = multiDay[2].substring(0,3).toUpperCase();
    return badge(month, days.length > 2 ? days[0] + '-' + days[days.length-1] : days.join(','));
  }
  const p = extractDM(dateStr);
  if (p) return badge(p.month, p.day);
  return '';
}
function extractDM(s) {
  const m = s.match(/(\d{1,2})\s+([A-Za-z]{3,})/);
  if (m) return { day: m[1], month: m[2].substring(0,3).toUpperCase() };
  return null;
}
function badge(top, bottom) {
  return '<div class="date-badge"><div class="date-month">' + top + '</div><div class="date-day">' + bottom + '</div></div>';
}

// =====================================================================
// CARD BUILDER
// =====================================================================
const createCard = (event, isPast) => {
    let source = event.source_name || 'Other';
    if (!event.source_name) {
      if (event.source_url && event.source_url.includes('showshappening')) source = 'ShowsHappening';
      else if (event.source_url && event.source_url.includes('visitmalta')) source = 'VisitMalta';
      else if (event.source_url && event.source_url.includes('eventbrite')) source = 'Eventbrite';
    }

    let title = event.title || '';
    if (looksLikeDate(title) || title.startsWith('Price:') || title.includes('€')) {
      const parts = (event.source_url||'').split('/');
      const slug = parts[parts.length - 1] || parts[parts.length - 2] || '';
      if (slug && slug.length > 3) {
        title = decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
      }
      if (looksLikeDate(event.title) && !event.event_date) event.event_date = event.title;
    }

    const firstLetter = title ? title.charAt(0).toUpperCase() : '?';
    const colors = [
      'linear-gradient(135deg, #FF9A9E 0%, #FECFEF 100%)',
      'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
      'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)',
      'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)'
    ];
    const bgStyle = colors[(firstLetter.charCodeAt(0)||0) % colors.length];
    const dateHTML = getDateBadge(event.event_date);
    let desc = event.description || '';
    if (!desc || desc === 'null') desc = '';
    const hasRange = event.event_date && (event.event_date.includes(' - ') || /to/i.test(event.event_date));
    const dateInfo = hasRange ? '<div class="date-range-text">📅 ' + event.event_date + '</div>' : '';
    const recurTag = event.recurring ? '<div class="recurring-tag">🔁 ' + event.recurring + '</div>' : '';
    if (!desc) desc = 'Click details to see more about this event.';
    const loc = event.location && event.location !== 'Malta' ? event.location : '';
    const locHTML = loc ? '<div class="location">📍 ' + loc + '</div>' : '';
    const gray = isPast ? 'past-event' : '';
    const expired = isPast ? '<div class="expired-label">PAST EVENT</div>' : '';
    const hasImg = event.image_url && !event.image_url.includes('/api/v2/file/');
    const sourceLower = source.toLowerCase().replace(/\s+/g, '');
    const safeTitle = (title||'').replace(/'/g, "\\'").replace(/"/g, '&quot;');

    const slug = event.slug || generateSlug(event.title);
    const startDate = getStartDate(event.event_date);
    const endDate = getEndDate(event.event_date);
    const startDateStr = startDate ? startDate.toISOString().split('T')[0] : '';
    const endDateStr = endDate ? endDate.toISOString().split('T')[0] : '';

    return `
    <div class="card event-item ${gray}" data-source="${sourceLower}" data-location="${(event.location||'malta').toLowerCase()}" data-category="${(event.category||'').toLowerCase()}" data-startdate="${startDateStr}" data-enddate="${endDateStr}" data-recurring="${event.recurring||''}">
        <a href="/event/${slug}" class="card-media-link">
        <div class="card-media">
            ${dateHTML} ${expired}
            <div class="fallback" style="background: ${bgStyle}; position:absolute;top:0;left:0;z-index:1;">${firstLetter}</div>
            ${hasImg ? '<img src="' + event.image_url + '" class="card-img" style="position:relative;z-index:2;" onerror="this.hidden=1">' : ''}
        </div>
        </a>
        <div class="card-content">
            <div class="source-tag">${source}</div>
            <div class="title">${title}</div>
            ${locHTML}
            ${dateInfo}
            ${recurTag}
            <div class="description">${desc}</div>
            <a href="/event/${slug}" class="btn">Details</a>
        </div>
    </div>`;
};


// =====================================================================
// SEO ROUTES
// =====================================================================
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /
Disallow: /admin
Sitemap: https://maltaeventguide.com/sitemap.xml`);
});

app.get('/sitemap.xml', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  let eventUrls = '';
  try {
    const result = await pool.query('SELECT slug FROM events WHERE slug IS NOT NULL');
    eventUrls = result.rows.map(r => `  <url>
    <loc>https://maltaeventguide.com/event/${r.slug}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`).join('\n');
  } catch(e) {}
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://maltaeventguide.com/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
${eventUrls}
</urlset>`);
});

// =====================================================================
// MAIN ROUTE (PUBLIC SITE)
// =====================================================================
app.get('/', async (req, res) => {
  try {
    // Merge event_overrides (manual images/categories) back into events
    // This is what makes manual edits survive TRUNCATE + re-scrape
    try {
      await pool.query(`
        UPDATE events e SET 
          image_url = COALESCE(o.image_url, e.image_url),
          category = COALESCE(o.category, e.category)
        FROM event_overrides o WHERE e.source_url = o.source_url
      `);
    } catch(e) { /* table may not exist yet, that's ok */ }

    const result = await pool.query('SELECT * FROM events');
    const allEvents = result.rows;
    const today = new Date(); today.setHours(0,0,0,0);

    // Auto-generate slugs for events without them
    const usedSlugs = new Set(allEvents.filter(e => e.slug).map(e => e.slug));
    for (const event of allEvents) {
      if (!event.slug) {
        let slug = generateSlug(event.title);
        let suffix = 2;
        let candidate = slug;
        while (usedSlugs.has(candidate)) { candidate = slug + '-' + suffix; suffix++; }
        event.slug = candidate;
        usedSlugs.add(candidate);
        pool.query('UPDATE events SET slug = $1 WHERE id = $2', [candidate, event.id]).catch(()=>{});
      }
    }

    // Collect unique sources and locations for filters
    const sources = new Set();
    const locations = new Set();
    const categories = new Set();

    let upcoming = [], past = [];

    allEvents.forEach(event => {
        if (!event.event_date && looksLikeDate(event.title)) event.event_date = event.title;
    });

    allEvents.forEach(event => {
        // Normalize source_name to prevent duplicates (trim and title case)
        if (event.source_name) {
          event.source_name = event.source_name.trim().replace(/\s+/g, ' ');
        }
        // Collect filter data
        const srcName = event.source_name
          || (event.source_url && event.source_url.includes('showshappening') ? 'ShowsHappening' : null)
          || (event.source_url && event.source_url.includes('visitmalta') ? 'VisitMalta' : null)
          || (event.source_url && event.source_url.includes('eventbrite') ? 'Eventbrite' : null);
        if (srcName) {
          // Deduplicate by comparing lowercase
          const existing = Array.from(sources).find(s => s.toLowerCase() === srcName.toLowerCase());
          if (!existing) sources.add(srcName);
          else event.source_name = existing; // normalize to the first version seen
        }
        if (event.location && event.location !== 'Malta') locations.add(event.location);
        if (event.category) categories.add(event.category);

        const endDate = getEndDate(event.event_date);
        const startDate = getStartDate(event.event_date);
        if (!endDate || endDate >= today) {
          let sortDate = startDate;
          if (startDate && startDate < today) sortDate = new Date(today);
          upcoming.push({ ...event, _sort: sortDate });
        } else {
          past.push({ ...event, _sort: endDate });
        }
    });

    upcoming.sort((a,b) => {
      if (!a._sort && !b._sort) return (a.title||'').localeCompare(b.title||'');
      if (!a._sort) return 1;
      if (!b._sort) return -1;
      const diff = a._sort - b._sort;
      if (diff !== 0) return diff;
      return (a.title||'').localeCompare(b.title||'');
    });
    past.sort((a,b) => {
      if (!a._sort && !b._sort) return (a.title||'').localeCompare(b.title||'');
      if (!a._sort) return 1;
      if (!b._sort) return -1;
      const diff = b._sort - a._sort;
      if (diff !== 0) return diff;
      return (a.title||'').localeCompare(b.title||'');
    });

    // Build month filter options from upcoming events
    const monthSet = new Set();
    upcoming.forEach(e => {
      if (e._sort) {
        const m = e._sort.toLocaleString('en', { month: 'short' }).toUpperCase();
        monthSet.add(m);
      }
    });
    const monthOptions = Array.from(monthSet).map(m => '<option value="' + m.toLowerCase() + '">' + m + '</option>').join('');

    const sourceOptions = Array.from(sources).map(s => '<option value="' + s.toLowerCase().replace(/\s+/g,'') + '">' + s + '</option>').join('');
    const standardCategories = ['Music & Concerts','Theatre & Shows','Dance','Nightlife & Parties','Festivals','Arts & Culture','Sports & Adventure','Food & Drink','Family','Religious','Conference','Other'];
    const categoryOptions = standardCategories.filter(c => categories.has(c)).map(c => '<option value="' + c.toLowerCase() + '">' + c + '</option>').join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!-- Google Analytics -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-YMT2MSCCRZ"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-YMT2MSCCRZ');</script>
  <title>Malta Events 2026 | Concerts, Festivals, Nightlife & Things to Do in Malta</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Discover the best events happening in Malta and Gozo. Browse concerts, festivals, theatre shows, nightlife parties, sports, food events and cultural activities across the Maltese islands. Updated daily.">
  <meta name="keywords" content="Malta events, things to do in Malta, Malta concerts, Malta festivals, Malta nightlife, Gozo events, what's on Malta, Malta 2026, Malta carnival, Malta theatre, events in Valletta, Malta parties, Malta sports">
  <meta name="author" content="Malta Event Guide">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://maltaeventguide.com/">

  <!-- Open Graph (Facebook, WhatsApp, LinkedIn) -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="Malta Event Guide | Concerts, Festivals, Nightlife & Things to Do in Malta & Gozo">
  <meta property="og:description" content="Your complete guide to what's on in Malta. Discover concerts, festivals, theatre, nightlife, sports and cultural events happening across the Maltese islands. Updated daily with the latest listings.">
  <meta property="og:url" content="https://maltaeventguide.com/">
  <meta property="og:site_name" content="Malta Event Guide">
  <meta property="og:locale" content="en_MT">
  <meta property="og:image" content="https://images.pexels.com/photos/34699762/pexels-photo-34699762.jpeg?auto=compress&cs=tinysrgb&w=1200&h=630">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Malta Event Guide | Concerts, Festivals, Nightlife & Things to Do in Malta & Gozo">
  <meta name="twitter:description" content="Your complete guide to what's on in Malta. Discover concerts, festivals, theatre, nightlife, sports and cultural events. Updated daily with the latest listings.">
  <meta name="twitter:image" content="https://images.pexels.com/photos/34699762/pexels-photo-34699762.jpeg?auto=compress&cs=tinysrgb&w=1200&h=630">

  <!-- JSON-LD Structured Data -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "Malta Event Guide",
    "url": "https://maltaeventguide.com/",
    "description": "Discover the best events in Malta and Gozo. Concerts, festivals, theatre, nightlife, sports and cultural events.",
    "potentialAction": {
      "@type": "SearchAction",
      "target": "https://maltaeventguide.com/?q={search_term_string}",
      "query-input": "required name=search_term_string"
    }
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "Upcoming Events in Malta",
    "numberOfItems": ${upcoming.length},
    "itemListElement": [${upcoming.slice(0, 20).map((e, i) => `{
      "@type": "ListItem",
      "position": ${i + 1},
      "item": {
        "@type": "Event",
        "name": ${JSON.stringify(e.title || '')},
        "location": {
          "@type": "Place",
          "name": ${JSON.stringify(e.location || 'Malta')},
          "address": { "@type": "PostalAddress", "addressCountry": "MT" }
        }${e._sort ? `,
        "startDate": "${e._sort.toISOString().split('T')[0]}"` : ''}${e.description ? `,
        "description": ${JSON.stringify(e.description.substring(0, 200))}` : ''}${e.image_url ? `,
        "image": ${JSON.stringify(e.image_url)}` : ''}${e.source_url && !e.source_url.startsWith('manual') ? `,
        "url": ${JSON.stringify(e.source_url)}` : ''}
      }
    }`).join(',')}]
  }
  </script>

  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap" rel="stylesheet">
  <style>
    :root { --bg: #f8fafc; --card-bg: #fff; --text: #1e293b; --primary: #FF385C; }
    body { font-family: 'Outfit', sans-serif; background: var(--bg); margin: 0; color: var(--text); padding-bottom: 50px; }
    
    header { position: relative; background-image: url('https://images.pexels.com/photos/34699762/pexels-photo-34699762.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1'); background-size: cover; background-position: center; color: white; text-align: center; padding: 6rem 1rem 8rem; margin-bottom: 80px; }
    .header-overlay { position: absolute; top:0;left:0;right:0;bottom:0; background: rgba(15,23,42,0.75); z-index:1; }
    .header-content { position: relative; z-index:2; max-width: 800px; margin: 0 auto; }
    h1 { margin:0; font-size:3.5rem; font-weight:900; letter-spacing:-1px; text-shadow: 0 4px 10px rgba(0,0,0,0.3); }
    .subtitle { color: rgba(255,255,255,0.9); margin-top:10px; font-size:1.2rem; font-weight:300; }
    
    .search-box-wrapper { position:absolute; bottom:-35px; left:0;right:0; padding:0 20px; z-index:10; }
    .search-box { max-width:600px; margin:0 auto; position:relative; box-shadow:0 20px 40px rgba(0,0,0,0.2); }
    .search-box input { width:100%; padding:20px 25px 20px 55px; border-radius:50px; border:none; background:rgba(255,255,255,0.98); font-family:inherit; font-size:1.1rem; box-sizing:border-box; transition:0.3s; }
    .search-box input:focus { outline:none; transform:scale(1.02); }
    .search-icon { position:absolute; left:25px; top:50%; transform:translateY(-50%); opacity:0.5; font-size:1.2rem; }

    .filter-bar { max-width:1200px; margin:0 auto 25px; padding:0 20px; display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .filter-bar select { padding:10px 16px; border-radius:25px; border:1px solid #e2e8f0; background:white; font-family:inherit; font-size:0.9rem; color:#1e293b; cursor:pointer; appearance:none; -webkit-appearance:none; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2364748b' d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right 12px center; padding-right:35px; }
    .filter-bar select:focus { outline:none; border-color:var(--primary); }
    .filter-bar .reset-btn { padding:10px 18px; border-radius:25px; border:1px solid #e2e8f0; background:white; font-family:inherit; font-size:0.85rem; color:#64748b; cursor:pointer; transition:0.2s; }
    .filter-bar .reset-btn:hover { background:#f1f5f9; color:var(--primary); border-color:var(--primary); }
    .filter-bar .filter-count { font-size:0.85rem; color:#94a3b8; }
    .quick-filters { max-width:1200px; margin:0 auto 15px; padding:0 20px; display:flex; gap:8px; flex-wrap:wrap; }
    .qf-btn { padding:8px 18px; border-radius:25px; border:2px solid #e2e8f0; background:white; font-family:inherit; font-size:0.85rem; font-weight:600; color:#475569; cursor:pointer; transition:0.2s; }
    .qf-btn:hover { border-color:var(--primary); color:var(--primary); }
    .qf-btn.active { background:var(--primary); color:white; border-color:var(--primary); }

    .container { max-width:1200px; margin:0 auto; padding:0 20px; display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:30px; }
    
    .card { background:var(--card-bg); border-radius:16px; overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.05); transition:transform 0.2s,box-shadow 0.2s; display:flex; flex-direction:column; border:1px solid #e2e8f0; }
    .card:hover { transform:translateY(-5px); box-shadow:0 20px 30px rgba(0,0,0,0.1); border-color:transparent; }
    
    .card-media { height:200px; position:relative; background:#eee; overflow:hidden; }
    .card-img { width:100%; height:100%; object-fit:cover; transition:0.5s; }
    .card:hover .card-img { transform:scale(1.05); }
    
    .past-event { filter:grayscale(100%); opacity:0.6; }
    .past-event:hover { filter:grayscale(0%); opacity:1; }
    .expired-label { position:absolute; top:50%;left:50%; transform:translate(-50%,-50%); background:rgba(0,0,0,0.8); color:white; padding:5px 15px; font-weight:800; text-transform:uppercase; border-radius:4px; z-index:20; letter-spacing:1px; font-size:0.9rem; border:1px solid white; }

    .separator { grid-column:1/-1; display:flex; align-items:center; justify-content:center; margin:50px 0 30px; color:#94a3b8; font-weight:800; letter-spacing:2px; text-transform:uppercase; font-size:0.9rem; }
    .separator::before,.separator::after { content:""; flex:1; border-bottom:2px solid #e2e8f0; margin:0 20px; }

    .date-badge { position:absolute; top:12px;left:12px; background:rgba(255,255,255,0.95); border-radius:8px; text-align:center; box-shadow:0 4px 10px rgba(0,0,0,0.15); z-index:10; backdrop-filter:blur(4px); display:flex; flex-direction:column; overflow:hidden; min-width:50px; }
    .date-month { background:var(--primary); color:white; font-size:0.6rem; font-weight:700; padding:3px 8px; text-transform:uppercase; letter-spacing:0.5px; white-space:nowrap; }
    .date-day { color:#333; font-size:0.95rem; font-weight:800; padding:2px 8px 4px; white-space:nowrap; }

    .fallback { width:100%;height:100%; display:flex;align-items:center;justify-content:center; color:white; font-size:4rem; font-weight:800; text-shadow:0 2px 10px rgba(0,0,0,0.2); }
    
    .card-content { padding:1.5rem; flex-grow:1; display:flex; flex-direction:column; }
    .source-tag { font-size:0.7rem; text-transform:uppercase; letter-spacing:1px; color:#64748b; margin-bottom:8px; font-weight:700; }
    .title { font-size:1.25rem; font-weight:800; margin-bottom:0.75rem; line-height:1.3; color:#0f172a; }
    .location { font-size:0.85rem; color:#64748b; margin-bottom:0.5rem; }
    .date-range-text { font-size:0.8rem; color:#0f172a; margin-bottom:0.5rem; font-weight:500; }
    .description { font-size:0.9rem; color:#475569; margin-bottom:1.5rem; line-height:1.6; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
    .btn { margin-top:auto; display:block; width:100%; padding:15px; background:#0f172a; color:white; text-align:center; text-decoration:none; border-radius:12px; font-weight:700; font-size:1rem; transition:0.3s; box-shadow:0 4px 12px rgba(15,23,42,0.15); }
    .btn:hover { background:var(--primary); box-shadow:0 8px 20px rgba(255,56,92,0.3); transform:translateY(-2px); }
    .hidden { display:none; }
    .event-count { text-align:center; color:#94a3b8; font-size:0.9rem; margin-bottom:20px; }

    /* Photo link - clickable on all devices, links to event page */
    .card-media-link { display:contents; text-decoration:none; cursor:pointer; }
    .recurring-tag { display:inline-block; background:#dbeafe; color:#1d4ed8; font-size:0.75rem; font-weight:600; padding:3px 10px; border-radius:20px; margin-bottom:8px; }
  </style>
</head>
<body>
  <header>
    <div class="header-overlay"></div>
    <div class="header-content">
      <h1>Malta Events Guide</h1>
      <div class="subtitle">Discover ${upcoming.length + past.length} events across Malta & Gozo</div>
    </div>
    <div class="search-box-wrapper">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" id="searchInput" placeholder="Search for concerts, festivals, nightlife..." onkeyup="filterEvents()">
      </div>
    </div>
  </header>

  <div class="quick-filters">
    <button class="qf-btn" onclick="quickFilter('today',this)">🔥 Today</button>
    <button class="qf-btn" onclick="quickFilter('tomorrow',this)">📅 Tomorrow</button>
    <button class="qf-btn" onclick="quickFilter('weekend',this)">🎉 This Weekend</button>
    <button class="qf-btn" onclick="quickFilter('week',this)">📆 This Week</button>
    <button class="qf-btn" onclick="quickFilter('all',this)">All</button>
  </div>
  <div class="filter-bar">
    <select id="sourceSelect" onchange="filterEvents()">
      <option value="">All Sources</option>
      ${sourceOptions}
    </select>
    <select id="categorySelect" onchange="filterEvents()">
      <option value="">All Types</option>
      ${categoryOptions}
    </select>
    <select id="monthSelect" onchange="filterEvents()">
      <option value="">All Months</option>
      ${monthOptions}
    </select>
    <select id="showSelect" onchange="filterEvents()">
      <option value="upcoming">Upcoming Only</option>
      <option value="all">All Events</option>
      <option value="past">Past Only</option>
    </select>
    <button class="reset-btn" onclick="resetFilters()">Reset Filters</button>
    <span class="filter-count" id="filterCount">${upcoming.length} upcoming · ${past.length} past</span>
  </div>

  <div class="container" id="eventGrid">
    ${upcoming.map(e => createCard(e, false)).join('')}
    ${past.length > 0 ? '<div class="separator event-item" data-source="" data-location="">Past Events Archive</div>' + past.map(e => createCard(e, true)).join('') : ''}
  </div>

  <script>
    function trackClick(eventId, title, source) {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: eventId, event_title: title, source: source })
      }).catch(function(){});
    }

    function filterEvents() {
      var q = document.getElementById('searchInput').value.toLowerCase();
      var src = document.getElementById('sourceSelect').value.toLowerCase();
      var cat = document.getElementById('categorySelect').value.toLowerCase();
      var month = document.getElementById('monthSelect').value.toLowerCase();
      var show = document.getElementById('showSelect').value;
      var cards = document.getElementsByClassName('event-item');
      var visible = 0;

      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var isSeparator = card.classList.contains('separator');
        
        if (isSeparator) {
          card.classList.toggle('hidden', show === 'upcoming');
          continue;
        }

        var isPast = card.classList.contains('past-event');
        var matchShow = show === 'all' || (show === 'upcoming' && !isPast) || (show === 'past' && isPast);
        var matchText = !q || card.innerText.toLowerCase().indexOf(q) !== -1;
        var matchSource = !src || (card.getAttribute('data-source') || '').indexOf(src) !== -1;
        var matchCat = !cat || (card.getAttribute('data-category') || '').indexOf(cat) !== -1;
        
        var matchMonth = true;
        if (month) {
          var dateText = (card.getAttribute('data-date') || card.innerText).toLowerCase();
          matchMonth = dateText.indexOf(month) !== -1;
        }

        var show_ = matchShow && matchText && matchSource && matchCat && matchMonth;
        card.classList.toggle('hidden', !show_);
        if (show_ && !isPast) visible++;
      }

      document.getElementById('filterCount').textContent = visible + ' events shown';
    }

    function resetFilters() {
      document.getElementById('searchInput').value = '';
      document.getElementById('sourceSelect').value = '';
      document.getElementById('categorySelect').value = '';
      document.getElementById('monthSelect').value = '';
      document.getElementById('showSelect').value = 'upcoming';
      filterEvents();
    }
    function quickFilter(mode, btn) {
      document.querySelectorAll('.qf-btn').forEach(function(b){ b.classList.remove('active') });
      if(mode!=='all') btn.classList.add('active');
      document.getElementById('showSelect').value = 'all';
      document.getElementById('sourceSelect').value = '';
      document.getElementById('categorySelect').value = '';
      document.getElementById('monthSelect').value = '';
      document.getElementById('searchInput').value = '';
      
      if(mode==='all'){ filterEvents(); return; }
      
      var today = new Date(); today.setHours(0,0,0,0);
      var todayStr = today.toISOString().split('T')[0];
      var tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
      var tomorrowStr = tomorrow.toISOString().split('T')[0];
      
      var weekendDates = [];
      for(var i=0;i<7;i++){
        var dd = new Date(today); dd.setDate(dd.getDate()+i);
        var wd = dd.getDay();
        if(wd===5||wd===6||wd===0) weekendDates.push(dd.toISOString().split('T')[0]);
      }
      var weekDates = [];
      for(var i=0;i<7;i++){
        var dd = new Date(today); dd.setDate(dd.getDate()+i);
        weekDates.push(dd.toISOString().split('T')[0]);
      }
      var dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      
      var cards = document.querySelectorAll('.event-item');
      var visible = 0;
      cards.forEach(function(card){
        if(card.classList.contains('separator')){ card.classList.add('hidden'); return; }
        if(card.classList.contains('past-event')){ card.classList.add('hidden'); return; }
        var sd = card.getAttribute('data-startdate')||'';
        var ed = card.getAttribute('data-enddate')||'';
        var recur = (card.getAttribute('data-recurring')||'').toLowerCase();
        var match = false;
        
        // Is this a date range (ongoing) event?
        var isRange = sd && ed && sd!==ed;
        
        // Helper: exact date match (single-day event)
        function exactMatch(targetStr){
          return sd===targetStr;
        }
        
        // Helper: check if a target date falls within start-end range
        function inRange(targetStr){
          if(sd===targetStr) return true;
          if(isRange) return targetStr >= sd && targetStr <= ed;
          return false;
        }
        
        // Helper: check recurring match for a given date
        function recurMatch(dateObj){
          if(!recur) return false;
          var dn = dateObj.getDay();
          if(recur.indexOf(dayNames[dn])!==-1) return true;
          if(recur==='every weekday'&&dn>=1&&dn<=5) return true;
          if(recur==='every weekend'&&(dn===0||dn===6)) return true;
          if(recur==='weekly'||recur==='monthly') return true;
          return false;
        }
        
        if(mode==='today'){
          // Single-day: exact match. Range: only if has recurring tag matching today
          match = exactMatch(todayStr) || recurMatch(today);
          if(!match && isRange && recur && inRange(todayStr)) match = recurMatch(today);
        } else if(mode==='tomorrow'){
          match = exactMatch(tomorrowStr) || recurMatch(tomorrow);
          if(!match && isRange && recur && inRange(tomorrowStr)) match = recurMatch(tomorrow);
        } else if(mode==='weekend'){
          // Weekend: show range events too (likely happening at some point)
          for(var w=0;w<weekendDates.length;w++){
            if(inRange(weekendDates[w])){ match=true; break; }
          }
          if(!match) match = recur.indexOf('friday')!==-1||recur.indexOf('saturday')!==-1||recur.indexOf('sunday')!==-1||recur==='every weekend';
        } else if(mode==='week'){
          // This week: show range events too
          for(var w=0;w<weekDates.length;w++){
            if(inRange(weekDates[w])){ match=true; break; }
          }
          if(!match&&recur) match = true;
        }
        
        card.classList.toggle('hidden', !match);
        if(match) visible++;
      });
      document.getElementById('filterCount').textContent = visible + ' events shown';
    }
  </script>

  <div style="max-width:600px;margin:50px auto 0;padding:0 20px">
    <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);border-radius:20px;padding:35px;text-align:center;color:white">
      <div style="font-size:2rem;margin-bottom:5px">📬</div>
      <h2 style="margin:0 0 8px;font-size:1.3rem;font-weight:800">Never Miss an Event in Malta</h2>
      <p style="color:#94a3b8;font-size:0.9rem;margin:0 0 20px">Get weekly updates on the best events, festivals & things to do in Malta and Gozo.</p>
      <div style="display:flex;gap:8px;max-width:420px;margin:0 auto;flex-wrap:wrap" id="emailForm">
        <input type="email" id="subEmail" placeholder="Your email address" style="flex:1;min-width:200px;padding:12px 16px;border-radius:12px;border:2px solid #334155;background:#1e293b;color:white;font-family:inherit;font-size:0.9rem;outline:none" onfocus="this.style.borderColor='#FF385C'" onblur="this.style.borderColor='#334155'">
        <button onclick="subscribeEmail()" style="padding:12px 24px;border-radius:12px;border:none;background:#FF385C;color:white;font-family:inherit;font-weight:700;font-size:0.9rem;cursor:pointer;white-space:nowrap;transition:0.2s;flex-shrink:0" onmouseover="this.style.background='#e11d48'" onmouseout="this.style.background='#FF385C'">Subscribe</button>
      </div>
      <div id="subMsg" style="margin-top:10px;font-size:0.85rem;display:none"></div>
      <p style="color:#475569;font-size:0.7rem;margin:15px 0 0">No spam, unsubscribe anytime. We respect your privacy.</p>
    </div>
  </div>

  <script>
    function subscribeEmail(){
      var email=document.getElementById('subEmail').value.trim();
      var msg=document.getElementById('subMsg');
      if(!email||email.indexOf('@')===-1){msg.style.display='block';msg.style.color='#f87171';msg.textContent='Please enter a valid email';return}
      fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email})})
        .then(function(r){return r.json()})
        .then(function(d){
          msg.style.display='block';
          if(d.ok){msg.style.color='#4ade80';msg.textContent='You\\'re subscribed! 🎉';document.getElementById('subEmail').value=''}
          else{msg.style.color='#f87171';msg.textContent='Something went wrong, try again'}
        }).catch(function(){msg.style.display='block';msg.style.color='#f87171';msg.textContent='Something went wrong, try again'});
    }
    document.getElementById('subEmail').addEventListener('keypress',function(e){if(e.key==='Enter')subscribeEmail()});
  </script>

  <footer style="margin-top:60px;padding:40px 20px;background:#1e293b;color:#94a3b8;text-align:center;font-size:0.85rem;line-height:1.8">
    <div style="max-width:800px;margin:0 auto">
      <h2 style="color:white;font-size:1.2rem;margin:0 0 10px">Malta Event Guide</h2>
      <p>Your complete guide to events in Malta and Gozo. Discover concerts, festivals, theatre, nightlife, sports, arts and cultural events happening across the Maltese islands.</p>
      <p style="margin-top:15px;font-size:0.75rem;color:#64748b">&copy; ${new Date().getFullYear()} maltaeventguide.com &middot; Events sourced from ShowsHappening, VisitMalta and local organizers</p>
      <p style="margin-top:8px;font-size:0.75rem;color:#64748b">Powered by <a href="https://bugrayildirim.me/" target="_blank" style="color:#94a3b8;text-decoration:underline">Bugra</a> &middot; <a href="mailto:hello@bugrayildirim.me" style="color:#94a3b8;text-decoration:underline">hello@bugrayildirim.me</a></p>
    </div>
  </footer>

  <div id="scrollTop" onclick="window.scrollTo({top:0,behavior:'smooth'})" style="position:fixed;bottom:30px;right:30px;width:48px;height:48px;background:#0f172a;color:white;border-radius:50%;display:none;align-items:center;justify-content:center;cursor:pointer;font-size:1.3rem;box-shadow:0 4px 15px rgba(0,0,0,0.3);z-index:999;transition:opacity 0.3s,transform 0.3s" onmouseover="this.style.background='#FF385C'" onmouseout="this.style.background='#0f172a'">↑</div>
  <script>
    window.addEventListener('scroll',function(){
      var btn=document.getElementById('scrollTop');
      if(window.scrollY>600){btn.style.display='flex'}else{btn.style.display='none'}
    });
  </script>

  <div id="cookieBanner" style="display:none;position:fixed;bottom:0;left:0;right:0;background:#0f172a;color:#e2e8f0;padding:16px 24px;z-index:9999;box-shadow:0 -4px 20px rgba(0,0,0,0.3)">
    <div style="max-width:1000px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap">
      <p style="margin:0;font-size:0.85rem;line-height:1.5;flex:1;min-width:250px">🍪 We use cookies to improve your experience. By continuing to browse, you agree to our use of cookies.</p>
      <div style="display:flex;gap:10px">
        <button onclick="acceptCookies()" style="padding:10px 24px;border-radius:10px;border:none;background:#FF385C;color:white;font-family:inherit;font-weight:700;font-size:0.85rem;cursor:pointer;transition:0.2s" onmouseover="this.style.background='#e11d48'" onmouseout="this.style.background='#FF385C'">Accept</button>
        <button onclick="acceptCookies()" style="padding:10px 16px;border-radius:10px;border:1px solid #475569;background:transparent;color:#94a3b8;font-family:inherit;font-size:0.85rem;cursor:pointer">Dismiss</button>
      </div>
    </div>
  </div>
  <script>
    function acceptCookies(){document.getElementById('cookieBanner').style.display='none';try{localStorage.setItem('cookiesAccepted','1')}catch(e){}}
    try{if(!localStorage.getItem('cookiesAccepted')){document.getElementById('cookieBanner').style.display='block'}}catch(e){}
  </script>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    res.status(500).send("Database error: " + err.message);
  }
});


// =====================================================================
// INDIVIDUAL EVENT PAGE (SEO - one page per event)
// =====================================================================
app.get('/event/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const result = await pool.query('SELECT * FROM events WHERE slug = $1', [slug]);
    if (!result.rows.length) return res.redirect('/');
    
    const event = result.rows[0];
    const title = event.title || 'Event';
    const desc = (event.description || 'Discover this event in Malta.').substring(0, 160);
    const loc = event.location || 'Malta';
    const dateStr = event.recurring ? (event.event_date || '') + ' · ' + event.recurring : (event.event_date || '');
    const img = event.image_url || '';
    const hasImg = img && !img.includes('/api/v2/file/');
    
    let source = event.source_name || 'Other';
    if (!event.source_name) {
      if (event.source_url && event.source_url.includes('showshappening')) source = 'ShowsHappening';
      else if (event.source_url && event.source_url.includes('visitmalta')) source = 'VisitMalta';
      else if (event.source_url && event.source_url.includes('eventbrite')) source = 'Eventbrite';
    }

    // Clean external URL (remove #manual- fragment)
    let externalUrl = (event.source_url || '').split('#manual-')[0];
    if (!externalUrl || externalUrl === 'manual://added') externalUrl = null;

    // Get related events (same category, different event)
    let related = [];
    try {
      if (event.category) {
        const rel = await pool.query(
          'SELECT id, title, slug, image_url, event_date, location, category FROM events WHERE category = $1 AND id != $2 AND slug IS NOT NULL ORDER BY RANDOM() LIMIT 6',
          [event.category, event.id]
        );
        related = rel.rows;
      }
    } catch(e) {}

    // Structured data for this specific event
    const startDate = getStartDate(event.event_date);
    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "Event",
      "name": title,
      "description": event.description || desc,
      "location": {
        "@type": "Place",
        "name": loc,
        "address": { "@type": "PostalAddress", "addressCountry": "MT", "addressLocality": loc }
      }
    };
    if (startDate) jsonLd.startDate = startDate.toISOString().split('T')[0];
    if (hasImg) jsonLd.image = img;
    if (externalUrl) jsonLd.url = externalUrl;
    if (event.category) jsonLd.eventAttendanceMode = "https://schema.org/OfflineEventAttendanceMode";

    const firstLetter = title.charAt(0).toUpperCase();
    const colors = [
      'linear-gradient(135deg, #FF9A9E 0%, #FECFEF 100%)',
      'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
      'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)',
      'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)'
    ];
    const bgStyle = colors[(firstLetter.charCodeAt(0)||0) % colors.length];
    const catEmojis = {'Music & Concerts':'🎵','Theatre & Shows':'🎭','Dance':'💃','Nightlife & Parties':'🎉','Festivals':'🎪','Arts & Culture':'🎨','Sports & Adventure':'🏃','Food & Drink':'🍷','Family':'👨‍👩‍👧','Religious':'⛪','Conference':'📋','Other':'📌'};

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!-- Google Analytics -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-YMT2MSCCRZ"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-YMT2MSCCRZ');</script>
  <title>${title} — ${loc} | Malta Event Guide</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${desc.replace(/"/g, '&quot;')} — ${dateStr} at ${loc}. Find event details on Malta Event Guide.">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://maltaeventguide.com/event/${slug}">

  <meta property="og:type" content="event">
  <meta property="og:title" content="${title} — ${loc}">
  <meta property="og:description" content="${desc.replace(/"/g, '&quot;')} — ${dateStr}">
  <meta property="og:url" content="https://maltaeventguide.com/event/${slug}">
  <meta property="og:site_name" content="Malta Event Guide">
  ${hasImg ? '<meta property="og:image" content="' + img + '">' : ''}

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title} — ${loc}">
  <meta name="twitter:description" content="${desc.replace(/"/g, '&quot;')}">
  ${hasImg ? '<meta name="twitter:image" content="' + img + '">' : ''}

  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>

  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap" rel="stylesheet">
  <style>
    :root { --bg: #f8fafc; --text: #1e293b; --primary: #FF385C; }
    body { font-family:'Outfit',sans-serif; background:var(--bg); margin:0; color:var(--text); }
    a { color:var(--primary); text-decoration:none; }

    .nav { background:#0f172a; padding:15px 24px; display:flex; align-items:center; gap:15px; }
    .nav a { color:white; font-weight:700; font-size:1.1rem; }
    .nav .back { color:#94a3b8; font-size:0.85rem; margin-left:auto; }

    .wrapper { max-width:960px; margin:30px auto; padding:0 20px 40px; }

    .event-layout { display:grid; grid-template-columns:360px 1fr; gap:0; background:white; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }

    .event-img { position:relative; background:#f1f5f9; overflow:hidden; min-height:400px; }
    .event-img img { width:100%; height:100%; object-fit:cover; position:absolute; top:0; left:0; }
    .event-img .fallback { width:100%;height:100%;min-height:400px;display:flex;align-items:center;justify-content:center;color:white;font-size:6rem;font-weight:800;background:#1e293b;position:absolute;top:0;left:0; }

    .event-details { padding:32px; display:flex; flex-direction:column; }

    .source-badge { display:inline-block; background:#f1f5f9; color:#64748b; padding:4px 12px; border-radius:20px; font-size:0.7rem; font-weight:600; text-transform:uppercase; margin-bottom:10px; width:fit-content; }
    h1 { font-size:1.8rem; font-weight:900; margin:0 0 16px; line-height:1.25; }

    .info-grid { display:flex; flex-direction:column; gap:12px; margin-bottom:18px; }
    .info-row { display:flex; align-items:center; gap:10px; font-size:0.92rem; color:#475569; }
    .info-icon { width:36px; height:36px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:1.1rem; flex-shrink:0; }
    .info-icon.date { background:#fef3c7; }
    .info-icon.loc { background:#dbeafe; }
    .info-icon.cat { background:#ede9fe; }
    .info-icon.recur { background:#dcfce7; }
    .info-label { font-weight:600; color:var(--text); }

    .desc { color:#475569; line-height:1.8; font-size:0.95rem; margin:15px 0; flex-grow:1; }

    .cta { display:block; width:100%; padding:16px; background:#0f172a; color:white; text-align:center; border-radius:12px; font-weight:800; font-size:1.05rem; transition:0.3s; box-sizing:border-box; }
    .cta:hover { background:var(--primary); transform:translateY(-2px); box-shadow:0 8px 25px rgba(255,56,92,0.3); }

    .share-row { display:flex; gap:8px; margin-top:12px; }
    .share-btn { flex:1; padding:10px; border-radius:10px; text-align:center; font-size:0.8rem; font-weight:600; color:white; cursor:pointer; transition:opacity 0.2s; }
    .share-btn:hover { opacity:0.85; }
    .share-whatsapp { background:#25D366; }
    .share-facebook { background:#1877F2; }
    .share-copy { background:#64748b; }

    .related { max-width:960px; margin:40px auto; padding:0 20px; }
    .related h2 { font-size:1.2rem; margin-bottom:15px; }
    .related-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:15px; }
    .rel-card { background:white; border-radius:12px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.06); transition:transform 0.2s; text-decoration:none; color:var(--text); }
    .rel-card:hover { transform:translateY(-3px); box-shadow:0 8px 20px rgba(0,0,0,0.1); }
    .rel-img { height:110px; background:#eee; overflow:hidden; }
    .rel-img img { width:100%; height:100%; object-fit:cover; }
    .rel-info { padding:10px; }
    .rel-info .ttl { font-weight:700; font-size:0.82rem; margin-bottom:3px; display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden; }
    .rel-info .dt { color:#94a3b8; font-size:0.72rem; }

    .footer { margin-top:40px;padding:30px 20px;background:#1e293b;color:#94a3b8;text-align:center;font-size:0.8rem;line-height:1.8; }
    .footer a { color:#94a3b8; }

    @media (max-width:750px) {
      .event-layout { grid-template-columns:1fr; }
      .event-img { min-height:280px; max-height:350px; }
      .event-img img { object-fit:cover; }
      .event-details { padding:24px; }
      h1 { font-size:1.4rem; }
      .wrapper { margin-top:15px; }
    }
  </style>
</head>
<body>
  <nav class="nav">
    <a href="/">Malta Events Guide</a>
    <a href="/" class="back">← All Events</a>
  </nav>

  <div class="wrapper">
    <div class="event-layout">
      <div class="event-img">
        ${hasImg ? '<img src="' + img + '" alt="' + title.replace(/"/g, '&quot;') + '" onerror="this.style.display=\'none\'">' : ''}
        <div class="fallback" style="background:${bgStyle};${hasImg ? 'z-index:-1;' : ''}">${firstLetter}</div>
      </div>
      <div class="event-details">
        <div class="source-badge">${source}</div>
        <h1>${title}</h1>
        <div class="info-grid">
          ${dateStr ? '<div class="info-row"><div class="info-icon date">📅</div><div><div class="info-label">' + dateStr + '</div></div></div>' : ''}
          <div class="info-row"><div class="info-icon loc">📍</div><div><div class="info-label">${loc}</div></div></div>
          ${event.category ? '<div class="info-row"><div class="info-icon cat">' + (catEmojis[event.category]||'📌') + '</div><div><div class="info-label">' + event.category + '</div></div></div>' : ''}
          ${event.recurring ? '<div class="info-row"><div class="info-icon recur">🔁</div><div><div class="info-label">' + event.recurring + '</div></div></div>' : ''}
        </div>
        ${event.description ? '<div class="desc">' + event.description + '</div>' : ''}
        ${externalUrl ? '<a href="' + externalUrl + '" target="_blank" class="cta" onclick="fetch(\'/api/track\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({event_id:' + event.id + ',event_title:\'' + title.replace(/'/g, "\\'") + '\',source:\'' + source + '\'})})">View Event / Get Tickets →</a>' : '<a href="/" class="cta">← Browse More Events</a>'}
        <div class="share-row">
          <div class="share-btn share-whatsapp" onclick="window.open('https://wa.me/?text='+encodeURIComponent('${title.replace(/'/g, "\\'")} - https://maltaeventguide.com/event/${slug}'))">WhatsApp</div>
          <div class="share-btn share-facebook" onclick="window.open('https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent('https://maltaeventguide.com/event/${slug}'))">Facebook</div>
          <div class="share-btn share-copy" onclick="navigator.clipboard.writeText('https://maltaeventguide.com/event/${slug}');this.textContent='Copied!'">Copy Link</div>
        </div>
      </div>
    </div>
  </div>

  ${related.length > 0 ? `
  <div class="related">
    <h2>You might also like</h2>
    <div class="related-grid">
      ${related.map(r => {
        const rImg = r.image_url && !r.image_url.includes('/api/v2/file/') ? r.image_url : '';
        const rLetter = (r.title||'E').charAt(0).toUpperCase();
        const rBg = colors[(rLetter.charCodeAt(0)||0) % colors.length];
        return `<a href="/event/${r.slug}" class="rel-card">
          <div class="rel-img">${rImg ? '<img src="' + rImg + '" onerror="this.hidden=1">' : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:' + rBg + ';color:white;font-size:2rem;font-weight:800">' + rLetter + '</div>'}</div>
          <div class="rel-info"><div class="ttl">${r.title}</div><div class="dt">${r.event_date || ''} · ${r.location || 'Malta'}</div></div>
        </a>`;
      }).join('')}
    </div>
  </div>` : ''}

  <div style="max-width:600px;margin:40px auto 0;padding:0 20px">
    <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);border-radius:20px;padding:35px;text-align:center;color:white">
      <div style="font-size:2rem;margin-bottom:5px">📬</div>
      <h2 style="margin:0 0 8px;font-size:1.3rem;font-weight:800">Never Miss an Event in Malta</h2>
      <p style="color:#94a3b8;font-size:0.9rem;margin:0 0 20px">Get weekly updates on the best events, festivals & things to do in Malta and Gozo.</p>
      <div style="display:flex;gap:8px;max-width:420px;margin:0 auto;flex-wrap:wrap">
        <input type="email" id="subEmail" placeholder="Your email address" style="flex:1;min-width:200px;padding:12px 16px;border-radius:12px;border:2px solid #334155;background:#1e293b;color:white;font-family:inherit;font-size:0.9rem;outline:none" onfocus="this.style.borderColor='#FF385C'" onblur="this.style.borderColor='#334155'">
        <button onclick="subscribeEmail()" style="padding:12px 24px;border-radius:12px;border:none;background:#FF385C;color:white;font-family:inherit;font-weight:700;font-size:0.9rem;cursor:pointer;white-space:nowrap;transition:0.2s;flex-shrink:0" onmouseover="this.style.background='#e11d48'" onmouseout="this.style.background='#FF385C'">Subscribe</button>
      </div>
      <div id="subMsg" style="margin-top:10px;font-size:0.85rem;display:none"></div>
      <p style="color:#475569;font-size:0.7rem;margin:15px 0 0">No spam, unsubscribe anytime. We respect your privacy.</p>
    </div>
  </div>
  <script>
    function subscribeEmail(){
      var email=document.getElementById('subEmail').value.trim();
      var msg=document.getElementById('subMsg');
      if(!email||email.indexOf('@')===-1){msg.style.display='block';msg.style.color='#f87171';msg.textContent='Please enter a valid email';return}
      fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email})})
        .then(function(r){return r.json()})
        .then(function(d){
          msg.style.display='block';
          if(d.ok){msg.style.color='#4ade80';msg.textContent='You\\'re subscribed! 🎉';document.getElementById('subEmail').value=''}
          else{msg.style.color='#f87171';msg.textContent='Something went wrong, try again'}
        }).catch(function(){msg.style.display='block';msg.style.color='#f87171';msg.textContent='Something went wrong, try again'});
    }
    document.getElementById('subEmail').addEventListener('keypress',function(e){if(e.key==='Enter')subscribeEmail()});
  </script>

  <div class="footer">
    <a href="/">Malta Event Guide</a> — Your complete guide to events in Malta & Gozo<br>
    &copy; ${new Date().getFullYear()} maltaeventguide.com · Powered by <a href="https://bugrayildirim.me/" target="_blank">Bugra</a> · <a href="mailto:hello@bugrayildirim.me">hello@bugrayildirim.me</a>
  </div>

  <div id="cookieBanner" style="display:none;position:fixed;bottom:0;left:0;right:0;background:#0f172a;color:#e2e8f0;padding:16px 24px;z-index:9999;box-shadow:0 -4px 20px rgba(0,0,0,0.3)">
    <div style="max-width:1000px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap">
      <p style="margin:0;font-size:0.85rem;line-height:1.5;flex:1;min-width:250px">🍪 We use cookies to improve your experience. By continuing to browse, you agree to our use of cookies.</p>
      <div style="display:flex;gap:10px">
        <button onclick="acceptCookies()" style="padding:10px 24px;border-radius:10px;border:none;background:#FF385C;color:white;font-family:inherit;font-weight:700;font-size:0.85rem;cursor:pointer;transition:0.2s" onmouseover="this.style.background='#e11d48'" onmouseout="this.style.background='#FF385C'">Accept</button>
        <button onclick="acceptCookies()" style="padding:10px 16px;border-radius:10px;border:1px solid #475569;background:transparent;color:#94a3b8;font-family:inherit;font-size:0.85rem;cursor:pointer">Dismiss</button>
      </div>
    </div>
  </div>
  <script>
    function acceptCookies(){document.getElementById('cookieBanner').style.display='none';try{localStorage.setItem('cookiesAccepted','1')}catch(e){}}
    try{if(!localStorage.getItem('cookiesAccepted')){document.getElementById('cookieBanner').style.display='block'}}catch(e){}
  </script>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    console.error('Event page error:', err);
    res.redirect('/');
  }
});


// =====================================================================
// CLICK TRACKING API (public, no auth needed)
// =====================================================================
app.post('/api/track', async (req, res) => {
  try {
    const { event_id, event_title, source } = req.body;
    await pool.query(
      'INSERT INTO click_tracking (event_id, event_title, source, user_agent, referrer) VALUES ($1, $2, $3, $4, $5)',
      [event_id, event_title, source, req.headers['user-agent']||'', req.headers['referer']||'']
    );
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

// Email subscribe (public)
app.post('/api/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@') || !email.includes('.')) return res.status(400).json({ error: 'Invalid email' });
    await pool.query(
      'INSERT INTO email_subscribers (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
      [email.toLowerCase().trim()]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to subscribe' }); }
});


// =====================================================================
// ADMIN PAGE
// =====================================================================
app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Admin - Malta Events</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Outfit', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    .login-screen { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-box { background: #1e293b; padding: 40px; border-radius: 16px; width: 350px; text-align: center; }
    .login-box h2 { margin-bottom: 20px; font-size: 1.5rem; }
    .login-box input { width: 100%; padding: 12px 16px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; font-size: 1rem; margin-bottom: 15px; font-family: inherit; }
    .login-box button, .form-btn { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #FF385C; color: white; font-size: 1rem; font-weight: 700; cursor: pointer; font-family: inherit; }
    .login-box button:hover, .form-btn:hover { background: #e11d48; }
    .admin-panel { display: none; }
    .admin-header { background: #1e293b; padding: 20px 30px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; position: sticky; top: 0; z-index: 100; }
    .admin-header h1 { font-size: 1.5rem; }
    .admin-header .stats { color: #94a3b8; font-size: 0.9rem; }
    .admin-header a { color: #FF385C; text-decoration: none; font-weight: 600; }
    .tabs { display: flex; background: #1e293b; border-bottom: 1px solid #334155; padding: 0 30px; overflow-x: auto; }
    .tab { padding: 14px 20px; cursor: pointer; color: #64748b; font-weight: 600; font-size: 0.9rem; border-bottom: 3px solid transparent; transition: 0.2s; white-space: nowrap; }
    .tab:hover { color: #e2e8f0; }
    .tab.active { color: #FF385C; border-bottom-color: #FF385C; }
    .tab .tc { background: #334155; color: #94a3b8; padding: 2px 8px; border-radius: 10px; font-size: 0.7rem; margin-left: 5px; }
    .tab.active .tc { background: #FF385C; color: white; }
    .filters { background: #1e293b; padding: 15px 30px; display: flex; gap: 10px; align-items: center; border-bottom: 1px solid #334155; flex-wrap: wrap; }
    .filters input, .filters select { padding: 8px 14px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; font-family: inherit; font-size: 0.9rem; }
    .filters input { flex: 1; min-width: 200px; }
    .fb { padding: 8px 16px; border-radius: 8px; border: 1px solid #334155; background: transparent; color: #94a3b8; cursor: pointer; font-family: inherit; font-size: 0.8rem; transition: 0.2s; }
    .fb:hover, .fb.active { background: #FF385C; color: white; border-color: #FF385C; }
    .events-grid { padding: 20px 30px; display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 20px; }
    .ec { background: #1e293b; border-radius: 12px; overflow: hidden; border: 1px solid #334155; transition: 0.2s; }
    .ec:hover { border-color: #475569; }
    .ec.dim { opacity: 0.5; } .ec.dim:hover { opacity: 1; }
    .ep { height: 130px; position: relative; background: #334155; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    .ep img { width: 100%; height: 100%; object-fit: cover; }
    .ep .ni { color: #64748b; font-size: 0.85rem; }
    .ep .bdg { position: absolute; top: 8px; right: 8px; padding: 3px 10px; border-radius: 20px; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; }
    .bdg.miss { background: #ef4444; color: white; }
    .bdg.ok { background: #22c55e; color: white; }
    .bdg.warn { background: #f59e0b; color: #0f172a; }
    .ei { padding: 12px 15px; }
    .ei .src { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-bottom: 4px; }
    .ei .ttl { font-size: 0.95rem; font-weight: 700; margin-bottom: 4px; color: #f1f5f9; line-height: 1.3; }
    .ei .mt { font-size: 0.75rem; color: #94a3b8; margin-bottom: 8px; }
    .ei .mt a { color: #FF385C; }
    .fr { display: flex; gap: 8px; padding: 0 15px 10px; }
    .fr input { flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; font-size: 0.8rem; font-family: inherit; }
    .fr input:focus { outline: none; border-color: #FF385C; }
    .fr button { padding: 8px 14px; border-radius: 8px; border: none; background: #FF385C; color: white; font-weight: 700; cursor: pointer; font-size: 0.8rem; font-family: inherit; white-space: nowrap; }
    .fr button:hover { background: #e11d48; }
    .fa { padding: 0 15px 12px; display: flex; gap: 6px; flex-wrap: wrap; }
    .fa button { padding: 4px 10px; border-radius: 6px; border: 1px solid #334155; background: transparent; color: #94a3b8; cursor: pointer; font-size: 0.7rem; font-family: inherit; }
    .fa button:hover { background: #334155; color: white; }
    .fa .del:hover { background: #ef4444; border-color: #ef4444; color: white; }
    .dh { padding: 0 15px 10px; }
    .dh-t { font-size: 0.7rem; color: #64748b; margin-bottom: 4px; }
    .dc { display: flex; gap: 4px; flex-wrap: wrap; }
    .chip { padding: 2px 7px; border-radius: 4px; font-size: 0.65rem; background: #0f172a; border: 1px solid #334155; color: #94a3b8; cursor: pointer; }
    .chip:hover { border-color: #FF385C; color: #FF385C; }
    .toast { position: fixed; bottom: 30px; right: 30px; background: #22c55e; color: white; padding: 12px 24px; border-radius: 10px; font-weight: 600; display: none; z-index: 1000; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
    .toast.err { background: #ef4444; }
    .toast.show { display: block; animation: si 0.3s ease; }
    @keyframes si { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .cb { padding: 10px 30px; background: #1e293b; border-bottom: 1px solid #334155; font-size: 0.85rem; color: #94a3b8; }
    .cb span { color: #FF385C; font-weight: 700; }
    .fg { background: #1e293b; padding: 15px 30px; border-bottom: 1px solid #334155; display: none; }
    .fg h3 { font-size: 0.85rem; color: #e2e8f0; margin-bottom: 8px; }
    .ft { width: 100%; font-size: 0.75rem; }
    .ft td { padding: 4px 12px 4px 0; color: #94a3b8; border-bottom: 1px solid #1e293b; }
    .ft td:first-child { color: #22c55e; font-family: monospace; font-weight: 600; white-space: nowrap; }
    .fgt { color: #FF385C; cursor: pointer; font-size: 0.8rem; font-weight: 600; padding: 8px 30px; background: #1e293b; border-bottom: 1px solid #334155; }
    .fgt:hover { text-decoration: underline; }
    /* Add Event Form */
    .add-form { padding: 30px; max-width: 600px; }
    .add-form h3 { font-size: 1.2rem; margin-bottom: 20px; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; font-size: 0.8rem; color: #94a3b8; margin-bottom: 5px; font-weight: 600; }
    .form-group label .req { color: #FF385C; }
    .form-group input, .form-group textarea { width: 100%; padding: 10px 14px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; font-family: inherit; font-size: 0.9rem; }
    .form-group input:focus, .form-group textarea:focus { outline: none; border-color: #FF385C; }
    .form-group textarea { resize: vertical; min-height: 80px; }
    .form-group .hint { font-size: 0.7rem; color: #475569; margin-top: 4px; }
    .form-btn { margin-top: 10px; }
    /* Analytics */
    .analytics { padding: 30px; }
    .analytics h3 { font-size: 1.2rem; margin-bottom: 20px; }
    .stat-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .sc { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; text-align: center; }
    .sc .num { font-size: 2rem; font-weight: 900; color: #FF385C; }
    .sc .lbl { font-size: 0.8rem; color: #94a3b8; margin-top: 5px; }
    .click-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    .click-table th { text-align: left; padding: 10px; border-bottom: 2px solid #334155; color: #94a3b8; font-weight: 600; }
    .click-table td { padding: 10px; border-bottom: 1px solid #1e293b; color: #e2e8f0; }
  </style>
</head>
<body>
  <div class="login-screen" id="LS">
    <div class="login-box">
      <h2>🔐 Admin Login</h2>
      <input type="password" id="pw" placeholder="Enter admin password" onkeydown="if(event.key==='Enter')doLogin()">
      <button onclick="doLogin()">Login</button>
    </div>
  </div>
  <div class="admin-panel" id="AP">
    <div class="admin-header">
      <div><h1>🎛️ Event Manager</h1><div class="stats" id="st">Loading...</div></div>
      <a href="/">← Back to site</a>
    </div>
    <div class="tabs">
      <div class="tab active" onclick="switchTab('images',this)">🖼️ Images <span class="tc" id="ic">0</span></div>
      <div class="tab" onclick="switchTab('dates',this)">📅 Dates <span class="tc" id="dc">0</span></div>
      <div class="tab" onclick="switchTab('categories',this)">🏷️ Categories <span class="tc" id="cc">0</span></div>
      <div class="tab" onclick="switchTab('manage',this)">📋 Manage</div>
      <div class="tab" onclick="switchTab('add',this)">➕ Add Event</div>
      <div class="tab" onclick="switchTab('analytics',this)">📊 Analytics</div>
    </div>

    <!-- IMAGES TAB -->
    <div id="imagesTab">
      <div class="filters">
        <input type="text" id="sf1" placeholder="🔍 Search..." oninput="af1()">
        <select id="ss1" onchange="af1()"><option value="all">All sources</option><option value="showshappening">ShowsHappening</option><option value="visitmalta">VisitMalta</option><option value="manual">Manual</option></select>
        <button class="fb active" onclick="ssf('missing',this)">Missing</button>
        <button class="fb" onclick="ssf('has',this)">Has images</button>
        <button class="fb" onclick="ssf('all',this)">All</button>
      </div>
      <div class="cb" id="cb1">Loading...</div>
      <div class="events-grid" id="eg1"></div>
    </div>

    <!-- DATES TAB -->
    <div id="datesTab" style="display:none">
      <div class="fgt" onclick="document.getElementById('fgd').style.display=document.getElementById('fgd').style.display==='none'?'':'none'">📖 Date format guide</div>
      <div class="fg" id="fgd">
        <h3>Supported formats</h3>
        <table class="ft">
          <tr><td>14 Feb</td><td>Single date</td></tr>
          <tr><td>20,21 Feb</td><td>Multiple days same month</td></tr>
          <tr><td>13,14,15 Mar</td><td>Multi-day event</td></tr>
          <tr><td>14 Feb to 28 Mar</td><td>Date range (different months)</td></tr>
          <tr><td>Feb to May</td><td>Month range (ongoing)</td></tr>
          <tr><td>14-Feb to 28-Mar</td><td>Dash style range</td></tr>
          <tr><td>5 February 2026 - 1 March 2026</td><td>Full date range</td></tr>
        </table>
      </div>
      <div class="filters">
        <input type="text" id="sf2" placeholder="🔍 Search..." oninput="af2()">
        <select id="ss2" onchange="af2()"><option value="all">All sources</option><option value="showshappening">ShowsHappening</option><option value="visitmalta">VisitMalta</option><option value="manual">Manual</option></select>
        <button class="fb active" onclick="sdf('missing',this)">Missing</button>
        <button class="fb" onclick="sdf('has',this)">Has dates</button>
        <button class="fb" onclick="sdf('all',this)">All</button>
      </div>
      <div class="cb" id="cb2">Loading...</div>
      <div class="events-grid" id="eg2"></div>
    </div>

    <!-- CATEGORIES TAB -->
    <div id="categoriesTab" style="display:none">
      <div class="filters">
        <input type="text" id="sf3" placeholder="🔍 Search..." oninput="af3()">
        <button class="fb active" onclick="scf('missing',this)">Uncategorized</button>
        <button class="fb" onclick="scf('has',this)">Has category</button>
        <button class="fb" onclick="scf('all',this)">All</button>
      </div>
      <div class="cb" id="cb3">Loading...</div>
      <div class="events-grid" id="eg3"></div>
    </div>

    <!-- MANAGE TAB -->
    <div id="manageTab" style="display:none">
      <!-- Source Stats -->
      <div id="sourceStats" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px"></div>
      
      <!-- Duplicate Warning -->
      <div id="dupWarn" style="display:none;background:#422006;border:1px solid #92400e;border-radius:12px;padding:15px;margin-bottom:20px">
        <h4 style="color:#fbbf24;margin:0 0 10px">⚠️ Possible Duplicates</h4>
        <div id="dupList"></div>
      </div>

      <!-- Filters and Bulk Actions -->
      <div class="filters">
        <input type="text" id="sf4" placeholder="🔍 Search events..." oninput="af4()">
        <select id="ss4" onchange="af4()" style="padding:8px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;font-family:inherit">
          <option value="all">All Sources</option>
        </select>
        <button class="fb" onclick="selectAll4()" id="selBtn4">Select All</button>
        <button class="fb" onclick="bulkDel()" style="background:#7f1d1d;color:#fca5a5">🗑️ Delete Selected</button>
      </div>
      <div class="cb" id="cb4">Loading...</div>
      <div class="events-grid" id="eg4"></div>

      <!-- Edit Modal -->
      <div id="editModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:1000;overflow-y:auto;padding:20px">
        <div style="max-width:600px;margin:40px auto;background:#1e293b;border-radius:16px;padding:24px">
          <h3 style="color:white;margin:0 0 20px">✏️ Edit Event</h3>
          <input type="hidden" id="ed_id">
          <div class="form-group"><label>Title</label><input type="text" id="ed_title"></div>
          <div class="form-group"><label>Date</label><input type="text" id="ed_date" placeholder="e.g. 14 Feb or 20,21 Mar"></div>
          <div class="form-group"><label>Recurring</label><select id="ed_recur" style="width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;font-family:inherit"><option value="">Not recurring</option><option value="Every Monday">Every Monday</option><option value="Every Tuesday">Every Tuesday</option><option value="Every Wednesday">Every Wednesday</option><option value="Every Thursday">Every Thursday</option><option value="Every Friday">Every Friday</option><option value="Every Saturday">Every Saturday</option><option value="Every Sunday">Every Sunday</option><option value="Every Weekday">Every Weekday</option><option value="Every Weekend">Every Weekend</option><option value="Weekly">Weekly</option><option value="Monthly">Monthly</option></select></div>
          <div class="form-group"><label>Location</label><input type="text" id="ed_loc"></div>
          <div class="form-group"><label>Source</label><input type="text" id="ed_source" placeholder="e.g. ShowsHappening, VisitMalta..."></div>
          <div class="form-group"><label>Category</label><select id="ed_cat" style="width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;font-family:inherit"><option value="">Select...</option><option value="Music & Concerts">🎵 Music & Concerts</option><option value="Theatre & Shows">🎭 Theatre & Shows</option><option value="Dance">💃 Dance</option><option value="Nightlife & Parties">🎉 Nightlife & Parties</option><option value="Festivals">🎪 Festivals</option><option value="Arts & Culture">🎨 Arts & Culture</option><option value="Sports & Adventure">🏃 Sports & Adventure</option><option value="Food & Drink">🍷 Food & Drink</option><option value="Family">👨‍👩‍👧 Family</option><option value="Religious">⛪ Religious</option><option value="Conference">📋 Conference</option><option value="Other">📌 Other</option></select></div>
          <div class="form-group"><label>Image URL</label><input type="text" id="ed_img"></div>
          <div class="form-group"><label>Event URL</label><input type="text" id="ed_url"></div>
          <div class="form-group"><label>Description</label><textarea id="ed_desc" rows="3"></textarea></div>
          <div style="display:flex;gap:10px;margin-top:15px">
            <button onclick="saveEdit()" style="flex:1;padding:12px;background:#22c55e;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:700;font-family:inherit">Save Changes</button>
            <button onclick="closeEdit()" style="flex:1;padding:12px;background:#334155;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:700;font-family:inherit">Cancel</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ADD EVENT TAB -->
    <div id="addTab" style="display:none">
      <div class="add-form">
        <h3>➕ Add New Event</h3>
        <div class="form-group"><label>Event Title <span class="req">*</span></label><input type="text" id="ae_title" placeholder="e.g. Jazz Night at Valletta"></div>
        <div class="form-group"><label>Event Date <span class="req">*</span></label><input type="text" id="ae_date" placeholder="e.g. 14 Feb or 20,21 Mar or Feb to May"><div class="hint">Use formats: 14 Feb · 20,21 Feb · Feb to May · 14 Feb to 28 Mar</div></div>
        <div class="form-group"><label>Recurring</label><select id="ae_recur" style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;font-family:inherit;font-size:0.9rem"><option value="">Not recurring (one-time event)</option><option value="Every Monday">Every Monday</option><option value="Every Tuesday">Every Tuesday</option><option value="Every Wednesday">Every Wednesday</option><option value="Every Thursday">Every Thursday</option><option value="Every Friday">Every Friday</option><option value="Every Saturday">Every Saturday</option><option value="Every Sunday">Every Sunday</option><option value="Every Weekday">Every Weekday (Mon-Fri)</option><option value="Every Weekend">Every Weekend (Sat-Sun)</option><option value="Weekly">Weekly</option><option value="Monthly">Monthly</option></select><div class="hint">If this event repeats, select how often</div></div>
        <div class="form-group"><label>Location <span class="req">*</span></label><input type="text" id="ae_loc" placeholder="e.g. Mediterranean Conference Centre, Valletta"></div>
        <div class="form-group"><label>Category <span class="req">*</span></label><select id="ae_cat" style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;font-family:inherit;font-size:0.9rem"><option value="">Select category...</option><option value="Music & Concerts">🎵 Music & Concerts</option><option value="Theatre & Shows">🎭 Theatre & Shows</option><option value="Dance">💃 Dance</option><option value="Nightlife & Parties">🎉 Nightlife & Parties</option><option value="Festivals">🎪 Festivals</option><option value="Arts & Culture">🎨 Arts & Culture</option><option value="Sports & Adventure">🏃 Sports & Adventure</option><option value="Food & Drink">🍷 Food & Drink</option><option value="Family">👨‍👩‍👧 Family</option><option value="Religious">⛪ Religious</option><option value="Conference">📋 Conference</option><option value="Other">📌 Other</option></select></div>
        <div class="form-group"><label>Image URL</label><input type="text" id="ae_img" placeholder="https://..."><div class="hint">Paste a direct link to the event image (right-click image → Copy image address)</div></div>
        <div class="form-group"><label>Source <span class="req">*</span></label><input type="text" id="ae_source" placeholder="e.g. ShowsHappening, VisitMalta, Eventbrite, DJ Malta Events..."><div class="hint">Where did you find this event? This appears as the source tag on the site</div></div>
        <div class="form-group"><label>Event/Ticket URL <span class="req">*</span></label><input type="text" id="ae_url" placeholder="https://... link to event page or ticket sales"><div class="hint">The link users will go to when they click Details</div></div>
        <div class="form-group"><label>Description</label><textarea id="ae_desc" placeholder="Brief description of the event..."></textarea></div>
        <button class="form-btn" onclick="addEvent()">Add Event</button>
      </div>
    </div>

    <!-- ANALYTICS TAB -->
    <div id="analyticsTab" style="display:none">
      <div class="analytics">
        <h3>📊 Click Analytics</h3>
        <div class="stat-cards" id="statCards">Loading...</div>
        
        <div style="margin-top:25px">
          <div onclick="toggleSection('clickSection')" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;background:#1e293b;padding:12px 18px;border-radius:10px;margin-bottom:2px">
            <h3 style="margin:0;font-size:1rem">🔗 Top Clicked Events</h3>
            <span id="clickArrow" style="color:#64748b;font-size:1.2rem">▼</span>
          </div>
          <div id="clickSection" style="background:#1e293b;border-radius:0 0 10px 10px;padding:15px;margin-bottom:20px">
            <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
              <input type="text" id="clickSearch" placeholder="Search events..." oninput="filterClicks()" style="flex:1;min-width:150px;padding:8px 12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;font-family:inherit;font-size:0.85rem">
              <select id="clickSource" onchange="filterClicks()" style="padding:8px 12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;font-family:inherit;font-size:0.85rem">
                <option value="">All Sources</option>
              </select>
              <select id="clickPeriod" onchange="filterClicks()" style="padding:8px 12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;font-family:inherit;font-size:0.85rem">
                <option value="all">All Time</option>
                <option value="today">Today</option>
                <option value="week">This Week</option>
                <option value="month">This Month</option>
              </select>
            </div>
            <div style="font-size:0.75rem;color:#64748b;margin-bottom:8px" id="clickFilterCount"></div>
            <table class="click-table" id="clickTable"><thead><tr><th>Event</th><th>Source</th><th>Clicks</th></tr></thead><tbody id="clickBody"><tr><td colspan="3" style="color:#64748b">Loading...</td></tr></tbody></table>
          </div>
        </div>

        <div>
          <div onclick="toggleSection('subSection')" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;background:#1e293b;padding:12px 18px;border-radius:10px;margin-bottom:2px">
            <h3 style="margin:0;font-size:1rem">📬 Email Subscribers (<span id="subCount">0</span>)</h3>
            <span id="subArrow" style="color:#64748b;font-size:1.2rem">▼</span>
          </div>
          <div id="subSection" style="background:#1e293b;border-radius:0 0 10px 10px;padding:15px;max-height:400px;overflow-y:auto">
            <div id="subList" style="font-size:0.85rem;color:#94a3b8">Loading...</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script src="/admin/js"></script>
</body>
</html>`);
});


// Admin JS - served as separate file to avoid template escaping issues
app.get('/admin/js', (req, res) => {
  res.type('application/javascript').send(`
var E=[],tab='images',sf1v='missing',sf2v='missing',auth='';
function esc(s){if(!s)return'';var d=document.createElement('div');d.textContent=s;return d.innerHTML}
function doLogin(){
  auth=document.getElementById('pw').value;
  fetch('/admin/api/events',{headers:{Authorization:auth}})
    .then(function(r){if(!r.ok)throw new Error('auth');return r.json()})
    .then(function(d){
      E=d;
      document.getElementById('LS').style.display='none';
      document.getElementById('AP').style.display='block';
      try{us()}catch(e){console.error('us',e)}
      try{af1()}catch(e){console.error('af1',e)}
      try{af2()}catch(e){console.error('af2',e)}
      try{af3()}catch(e){console.error('af3',e)}
      try{af4()}catch(e){console.error('af4',e)}
      try{loadAnalytics()}catch(e){console.error('analytics',e)}
    })
    .catch(function(e){
      if(e&&e.message==='auth')toast('Wrong password!',1);
      else{console.error('Login:',e);toast('Error: '+e,1)}
    });
}
function us(){
  var mi=E.filter(function(e){return!vi(e)}).length;
  var md=E.filter(function(e){return!e.event_date}).length;
  var mc=E.filter(function(e){return!e.category}).length;
  document.getElementById('st').textContent=E.length+' events \\u00b7 '+mi+' missing images \\u00b7 '+md+' missing dates \\u00b7 '+mc+' uncategorized';
  document.getElementById('ic').textContent=mi;
  document.getElementById('dc').textContent=md;
  document.getElementById('cc').textContent=mc;
}
function vi(e){return e.image_url&&e.image_url.indexOf('/api/v2/file/')<0&&e.image_url.indexOf('http')===0}
function switchTab(t,el){
  tab=t;
  document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active')});
  el.classList.add('active');
  ['imagesTab','datesTab','categoriesTab','manageTab','addTab','analyticsTab'].forEach(function(id){document.getElementById(id).style.display='none'});
  var map={images:'imagesTab',dates:'datesTab',categories:'categoriesTab',manage:'manageTab',add:'addTab',analytics:'analyticsTab'};
  document.getElementById(map[t]).style.display='';
  if(t==='analytics')loadAnalytics();
}
function ssf(f,b){sf1v=f;document.querySelectorAll('#imagesTab .fb').forEach(function(x){x.classList.remove('active')});b.classList.add('active');af1()}
function af1(){
  var q=document.getElementById('sf1').value.toLowerCase(),s=document.getElementById('ss1').value;
  var f=E.filter(function(e){
    if(q&&e.title.toLowerCase().indexOf(q)<0)return 0;
    if(s!=='all'&&getSource(e)!==s)return 0;
    if(sf1v==='missing'&&vi(e))return 0;
    if(sf1v==='has'&&!vi(e))return 0;
    return 1;
  });
  document.getElementById('cb1').innerHTML='Showing <span>'+f.length+'<\\/span>';
  ri(f);
}
function ri(evts){
  document.getElementById('eg1').innerHTML=evts.map(function(e){
    var h=vi(e),s=getSrc(e);
    return '<div class="ec'+(h?' dim':'')+'"><div class="ep">'+(h?'<img src="'+esc(e.image_url)+'" onerror="this.hidden=1">':'<div class="ni">No image<\\/div>')+'<div class="bdg '+(h?'ok':'miss')+'">'+(h?'\\u2713':'\\u2717')+'<\\/div><\\/div><div class="ei"><div class="src">'+s+'<\\/div><div class="ttl">'+esc(e.title)+'<\\/div><div class="mt">'+esc(e.event_date||'No date')+' \\u00b7 <a href="'+esc(e.source_url)+'" target="_blank">View \\u2197<\\/a><\\/div><\\/div><div class="fr"><input id="img-'+e.id+'" placeholder="Paste image URL..." value="'+esc(h?e.image_url:'')+'"><button onclick="si('+e.id+')">Save<\\/button><\\/div>'+'<div class="fa">'+(h?'<button class="del" onclick="rmi('+e.id+')">Remove img<\\/button>':'')+'<button class="del" onclick="delEvt('+e.id+')">❌ Delete event<\\/button><\\/div><\\/div>';
  }).join('');
}
function si(id){
  var u=document.getElementById('img-'+id).value.trim();
  if(!u||u.indexOf('http')!==0)return toast('Enter a valid URL',1);
  api('PUT','/admin/api/events/'+id+'/image',{image_url:u},function(){ue(id,'image_url',u);toast('Saved \\u2713')});
}
function rmi(id){if(!confirm('Remove?'))return;api('PUT','/admin/api/events/'+id+'/image',{image_url:null},function(){ue(id,'image_url',null);toast('Removed')})}
function sdf(f,b){sf2v=f;document.querySelectorAll('#datesTab .fb').forEach(function(x){x.classList.remove('active')});b.classList.add('active');af2()}
function af2(){
  var q=document.getElementById('sf2').value.toLowerCase(),s=document.getElementById('ss2').value;
  var f=E.filter(function(e){
    if(q&&e.title.toLowerCase().indexOf(q)<0)return 0;
    if(s!=='all'&&getSource(e)!==s)return 0;
    if(sf2v==='missing'&&e.event_date)return 0;
    if(sf2v==='has'&&!e.event_date)return 0;
    return 1;
  });
  document.getElementById('cb2').innerHTML='Showing <span>'+f.length+'<\\/span>';
  rd(f);
}
function rd(evts){
  document.getElementById('eg2').innerHTML=evts.map(function(e){
    var hd=!!e.event_date,h=vi(e),s=getSrc(e);
    return '<div class="ec'+(hd?' dim':'')+'"><div class="ep">'+(h?'<img src="'+esc(e.image_url)+'" onerror="this.hidden=1">':'<div class="ni">No img<\\/div>')+'<div class="bdg '+(hd?'ok':'warn')+'">'+(hd?'\\u2713 '+esc(e.event_date):'\\u2717 No date')+'<\\/div><\\/div><div class="ei"><div class="src">'+s+'<\\/div><div class="ttl">'+esc(e.title)+'<\\/div><div class="mt"><a href="'+esc(e.source_url||'#')+'" target="_blank">View event \\u2197<\\/a><\\/div><\\/div><div class="fr"><input id="dt-'+e.id+'" placeholder="e.g. 14 Feb or 20,21 Mar" value="'+esc(e.event_date||'')+'"><button onclick="sd('+e.id+')">Save<\\/button><\\/div><div class="dh"><div class="dh-t">Quick formats:<\\/div><div class="dc"><span class="chip" onclick="sdv('+e.id+',\\x2714 Feb\\x27)">14 Feb<\\/span><span class="chip" onclick="sdv('+e.id+',\\x2720,21 Mar\\x27)">20,21 Mar<\\/span><span class="chip" onclick="sdv('+e.id+',\\x27Feb to May\\x27)">Feb to May<\\/span><span class="chip" onclick="sdv('+e.id+',\\x2714 Feb to 28 Mar\\x27)">14 Feb to 28 Mar<\\/span><\\/div><\\/div>'+'<div class="fa">'+(hd?'<button class="del" onclick="rmd('+e.id+')">Clear date<\\/button>':'')+'<button class="del" onclick="delEvt('+e.id+')">❌ Delete event<\\/button><\\/div><\\/div>';
  }).join('');
}
function sdv(id,v){document.getElementById('dt-'+id).value=v;document.getElementById('dt-'+id).focus()}
function sd(id){
  var v=document.getElementById('dt-'+id).value.trim();
  if(!v)return toast('Enter a date',1);
  api('PUT','/admin/api/events/'+id+'/date',{event_date:v},function(d){
    if(d.warning)toast('Saved but: '+d.warning,1);else toast('Date saved \\u2713');
    ue(id,'event_date',v);
  });
}
function rmd(id){if(!confirm('Clear?'))return;api('PUT','/admin/api/events/'+id+'/date',{event_date:null},function(){ue(id,'event_date',null);toast('Cleared')})}
var sf3v='missing';
function scf(f,b){sf3v=f;document.querySelectorAll('#categoriesTab .fb').forEach(function(x){x.classList.remove('active')});b.classList.add('active');af3()}
function af3(){
  var q=document.getElementById('sf3').value.toLowerCase();
  var f=E.filter(function(e){
    if(q&&e.title.toLowerCase().indexOf(q)<0)return 0;
    if(sf3v==='missing'&&e.category)return 0;
    if(sf3v==='has'&&!e.category)return 0;
    return 1;
  });
  document.getElementById('cb3').innerHTML='Showing <span>'+f.length+'<\\/span>';
  rc(f);
}
function rc(evts){
  var cats='<option value="">Select...<\\/option><option value="Music & Concerts">\\ud83c\\udfb5 Music & Concerts<\\/option><option value="Theatre & Shows">\\ud83c\\udfad Theatre & Shows<\\/option><option value="Dance">\\ud83d\\udc83 Dance<\\/option><option value="Nightlife & Parties">\\ud83c\\udf89 Nightlife & Parties<\\/option><option value="Festivals">\\ud83c\\udfaa Festivals<\\/option><option value="Arts & Culture">\\ud83c\\udfa8 Arts & Culture<\\/option><option value="Sports & Adventure">\\ud83c\\udfc3 Sports & Adventure<\\/option><option value="Food & Drink">\\ud83c\\udf77 Food & Drink<\\/option><option value="Family">\\ud83d\\udc68\\u200d\\ud83d\\udc69\\u200d\\ud83d\\udc67 Family<\\/option><option value="Religious">\\u26ea Religious<\\/option><option value="Conference">\\ud83d\\udccb Conference<\\/option><option value="Other">\\ud83d\\udccc Other<\\/option>';
  document.getElementById('eg3').innerHTML=evts.map(function(e){
    var h=vi(e),s=getSrc(e);
    var selCats=cats.replace('value="'+(e.category||'')+'"','value="'+(e.category||'')+'" selected');
    return '<div class="ec'+(e.category?' dim':'')+'"><div class="ep">'+(h?'<img src="'+esc(e.image_url)+'" onerror="this.hidden=1">':'<div class="ni">No img<\\/div>')+'<div class="bdg '+(e.category?'ok':'warn')+'">'+(e.category||'No category')+'<\\/div><\\/div><div class="ei"><div class="src">'+s+'<\\/div><div class="ttl">'+esc(e.title)+'<\\/div><div class="mt">'+esc(e.event_date||'No date')+'<\\/div><\\/div><div class="fr"><select id="cat-'+e.id+'" style="flex:1;padding:8px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;font-family:inherit;font-size:0.8rem">'+selCats+'<\\/select><button onclick="sc('+e.id+')">Save<\\/button><\\/div><div class="fa"><button class="del" onclick="delEvt('+e.id+')">❌ Delete event<\\/button><\\/div><\\/div>';
  }).join('');
}
function sc(id){
  var v=document.getElementById('cat-'+id).value;
  if(!v)return toast('Select a category',1);
  api('PUT','/admin/api/events/'+id+'/category',{category:v},function(){ue(id,'category',v);toast('Category saved \\u2713')});
}
function addEvent(){
  var title=document.getElementById('ae_title').value.trim();
  var date=document.getElementById('ae_date').value.trim();
  var loc=document.getElementById('ae_loc').value.trim();
  var cat=document.getElementById('ae_cat').value;
  var img=document.getElementById('ae_img').value.trim()||null;
  if(img&&img.indexOf('http')!==0)img='https://'+img;
  var src=document.getElementById('ae_source').value;
  var url=document.getElementById('ae_url').value.trim()||null;
  if(url&&url.indexOf('http')!==0)url='https://'+url;
  if(!src)return toast('Source is required',1);
  if(!url)return toast('Event URL is required',1);
  var recur=document.getElementById('ae_recur').value||null;
  var desc=document.getElementById('ae_desc').value.trim()||null;
  if(!title)return toast('Title is required',1);
  if(!date)return toast('Date is required',1);
  if(!loc)return toast('Location is required',1);
  if(!cat)return toast('Category is required',1);
  var sourceUrl=url||'manual://added';
  api('POST','/admin/api/events',{title:title,event_date:date,location:loc,category:cat,image_url:img,source_url:sourceUrl,description:desc,source_name:src,recurring:recur},function(d){
    E.push(d.event);us();toast('Event added! \\u2713');
    ['ae_title','ae_date','ae_loc','ae_img','ae_url','ae_desc'].forEach(function(id){document.getElementById(id).value=''});
    document.getElementById('ae_cat').value='';
    document.getElementById('ae_source').value='';
    document.getElementById('ae_recur').value='';
  });
}
var allClicks=[];
function toggleSection(id){
  var el=document.getElementById(id);
  var arrow=document.getElementById(id.replace('Section','Arrow'));
  if(el.style.display==='none'){el.style.display='block';if(arrow)arrow.textContent='▼'}
  else{el.style.display='none';if(arrow)arrow.textContent='▶'}
}
function filterClicks(){
  var q=(document.getElementById('clickSearch').value||'').toLowerCase();
  var src=document.getElementById('clickSource').value;
  var period=document.getElementById('clickPeriod').value;
  var now=new Date();
  var filtered=allClicks.filter(function(e){
    if(q&&(e.event_title||'').toLowerCase().indexOf(q)<0)return false;
    if(src&&e.source!==src)return false;
    if(period!=='all'&&e.last_click){
      var d=new Date(e.last_click);
      var diffDays=(now-d)/(1000*60*60*24);
      if(period==='today'&&diffDays>1)return false;
      if(period==='week'&&diffDays>7)return false;
      if(period==='month'&&diffDays>30)return false;
    }
    return true;
  });
  var totalFiltered=0;
  var html=filtered.map(function(e){
    totalFiltered+=parseInt(e.clicks);
    return '<tr><td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(e.event_title)+'<\\/td><td>'+esc(e.source)+'<\\/td><td><strong>'+e.clicks+'<\\/strong><\\/td><\\/tr>';
  }).join('');
  document.getElementById('clickBody').innerHTML=html||'<tr><td colspan="3" style="color:#64748b">No matching clicks<\\/td><\\/tr>';
  document.getElementById('clickFilterCount').textContent=filtered.length+' events · '+totalFiltered+' total clicks';
}
function loadAnalytics(){
  fetch('/admin/api/analytics',{headers:{Authorization:auth}})
    .then(function(r){return r.json()})
    .then(function(d){
      document.getElementById('statCards').innerHTML=
        '<div class="sc"><div class="num">'+d.total_clicks+'<\\/div><div class="lbl">Total Clicks<\\/div><\\/div>'+
        '<div class="sc"><div class="num">'+d.today_clicks+'<\\/div><div class="lbl">Today<\\/div><\\/div>'+
        '<div class="sc"><div class="num">'+d.week_clicks+'<\\/div><div class="lbl">This Week<\\/div><\\/div>'+
        '<div class="sc"><div class="num">'+d.month_clicks+'<\\/div><div class="lbl">This Month<\\/div><\\/div>'+
        '<div class="sc"><div class="num">'+d.unique_events+'<\\/div><div class="lbl">Unique Events<\\/div><\\/div>';
      allClicks=d.top_events||[];
      // Build source filter dropdown
      var sources={};
      allClicks.forEach(function(e){if(e.source)sources[e.source]=(sources[e.source]||0)+parseInt(e.clicks)});
      var srcSelect=document.getElementById('clickSource');
      srcSelect.innerHTML='<option value="">All Sources</option>';
      Object.keys(sources).sort().forEach(function(s){
        srcSelect.innerHTML+='<option value="'+s+'">'+s+' ('+sources[s]+')</option>';
      });
      filterClicks();
    }).catch(function(){});
  fetch('/admin/api/subscribers',{headers:{Authorization:auth}})
    .then(function(r){return r.json()})
    .then(function(subs){
      document.getElementById('subCount').textContent=subs.length;
      if(subs.length===0){document.getElementById('subList').innerHTML='<div style="color:#64748b">No subscribers yet</div>';return}
      document.getElementById('subList').innerHTML=subs.map(function(s){
        var d=new Date(s.subscribed_at);
        return '<div style="padding:6px 0;border-bottom:1px solid #334155;display:flex;justify-content:space-between"><span>'+s.email+'</span><span style="color:#64748b;font-size:0.75rem">'+d.toLocaleDateString()+'</span></div>';
      }).join('');
    }).catch(function(){});
}
// MANAGE TAB
var sel4={};
function af4(){
  var q=document.getElementById('sf4').value.toLowerCase();
  var s=document.getElementById('ss4').value;
  var f=E.filter(function(e){
    if(q&&e.title.toLowerCase().indexOf(q)<0)return 0;
    if(s!=='all'&&getSource(e)!==s&&(e.source_name||'').toLowerCase()!==s.toLowerCase())return 0;
    return 1;
  });
  document.getElementById('cb4').innerHTML='Showing <span>'+f.length+'<\/span> of '+E.length+' events';
  rm(f);
  buildSourceStats();
  detectDuplicates();
  buildSourceFilter4();
}
function buildSourceFilter4(){
  var ss=document.getElementById('ss4');
  var cur=ss.value;
  var srcs={};
  E.forEach(function(e){
    var s=e.source_name||getSrc(e);
    var k=s.toLowerCase();
    if(!srcs[k])srcs[k]={name:s,count:0};
    srcs[k].count++;
  });
  var html='<option value="all">All Sources<\/option>';
  Object.keys(srcs).sort().forEach(function(k){
    html+='<option value="'+k+'">'+srcs[k].name+' ('+srcs[k].count+')<\/option>';
  });
  ss.innerHTML=html;
  ss.value=cur;
}
function buildSourceStats(){
  var srcs={};
  var canonical={};
  E.forEach(function(e){
    var s=(e.source_name||getSrc(e)).trim().replace(/\s+/g,' ');
    var key=s.toLowerCase();
    if(!canonical[key])canonical[key]=s;
    s=canonical[key];
    if(!srcs[s])srcs[s]=0;
    srcs[s]++;
  });
  var html='';
  Object.keys(srcs).sort().forEach(function(s){
    html+='<div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:12px 18px;text-align:center;min-width:120px"><div style="font-size:1.5rem;font-weight:800;color:white">'+srcs[s]+'<\/div><div style="font-size:0.75rem;color:#94a3b8;margin-top:2px">'+s+'<\/div><\/div>';
  });
  html+='<div style="background:#0f172a;border:1px solid #22c55e;border-radius:10px;padding:12px 18px;text-align:center;min-width:120px"><div style="font-size:1.5rem;font-weight:800;color:#22c55e">'+E.length+'<\/div><div style="font-size:0.75rem;color:#94a3b8;margin-top:2px">Total<\/div><\/div>';
  document.getElementById('sourceStats').innerHTML=html;
}
function detectDuplicates(){
  var titles={};
  E.forEach(function(e){
    var k=(e.title||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    if(k.length<5)return;
    if(!titles[k])titles[k]=[];
    titles[k].push(e);
  });
  var dups=[];
  Object.keys(titles).forEach(function(k){
    if(titles[k].length>1)dups.push(titles[k]);
  });
  var warn=document.getElementById('dupWarn');
  if(dups.length===0){warn.style.display='none';return}
  warn.style.display='block';
  var html='';
  dups.forEach(function(group){
    html+='<div style="margin-bottom:10px;padding:8px;background:#1c1917;border-radius:8px">';
    html+='<div style="color:#fbbf24;font-weight:700;margin-bottom:5px">\u26a0 "'+esc(group[0].title)+'" appears '+group.length+' times<\/div>';
    group.forEach(function(e){
      html+='<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;color:#d6d3d1"><span>ID: '+e.id+' \u00b7 '+getSrc(e)+' \u00b7 '+(e.event_date||'no date')+'<\/span><button onclick="delEvt('+e.id+')" style="background:#7f1d1d;color:#fca5a5;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.75rem">Delete<\/button><\/div>';
    });
    html+='<\/div>';
  });
  document.getElementById('dupList').innerHTML=html;
}
function rm(evts){
  document.getElementById('eg4').innerHTML=evts.map(function(e){
    var h=vi(e),s=e.source_name||getSrc(e);
    var checked=sel4[e.id]?' checked':'';
    return '<div class="ec" style="position:relative"><div style="position:absolute;top:8px;left:8px;z-index:5"><input type="checkbox" id="chk-'+e.id+'" onchange="togSel('+e.id+')"'+checked+' style="width:18px;height:18px;cursor:pointer"><\/div><div class="ep">'+(h?'<img src="'+esc(e.image_url)+'" onerror="this.hidden=1">':'<div class="ni">No img<\/div>')+'<\/div><div class="ei"><div class="src">'+esc(s)+'<\/div><div class="ttl">'+esc(e.title)+'<\/div><div class="mt">'+esc(e.event_date||'No date')+' \u00b7 '+esc(e.location||'Malta')+'<\/div><div class="mt">'+(e.category?esc(e.category):'<span style="color:#f87171">No category<\/span>')+'<\/div><\/div><div class="fr" style="gap:6px"><button onclick="openEdit('+e.id+')" style="flex:1">\u270f\ufe0f Edit<\/button><button class="del" onclick="delEvt('+e.id+')" style="flex:1">\u274c Delete<\/button><\/div><\/div>';
  }).join('');
}
function togSel(id){sel4[id]=document.getElementById('chk-'+id).checked;if(!sel4[id])delete sel4[id]}
function selectAll4(){
  var boxes=document.querySelectorAll('#eg4 input[type=checkbox]');
  var allSel=Object.keys(sel4).length===boxes.length;
  boxes.forEach(function(b){
    var id=parseInt(b.id.replace('chk-',''));
    b.checked=!allSel;
    if(!allSel)sel4[id]=true;else delete sel4[id];
  });
}
function bulkDel(){
  var ids=Object.keys(sel4);
  if(ids.length===0)return toast('No events selected',1);
  if(!confirm('Delete '+ids.length+' events permanently?'))return;
  var done=0;
  ids.forEach(function(id){
    api('DELETE','/admin/api/events/'+id,{},function(){
      done++;
      E=E.filter(function(x){return x.id!==parseInt(id)});
      delete sel4[id];
      if(done===ids.length){us();af4();toast(done+' events deleted');}
    });
  });
}
function openEdit(id){
  var e=E.find(function(x){return x.id===id});
  if(!e)return;
  document.getElementById('ed_id').value=id;
  document.getElementById('ed_title').value=e.title||'';
  document.getElementById('ed_date').value=e.event_date||'';
  document.getElementById('ed_loc').value=e.location||'';
  document.getElementById('ed_source').value=e.source_name||getSrc(e);
  document.getElementById('ed_cat').value=e.category||'';
  document.getElementById('ed_img').value=e.image_url||'';
  document.getElementById('ed_url').value=e.source_url||'';
  document.getElementById('ed_desc').value=e.description||'';
  document.getElementById('ed_recur').value=e.recurring||'';
  document.getElementById('editModal').style.display='block';
}
function closeEdit(){document.getElementById('editModal').style.display='none'}
function saveEdit(){
  var id=parseInt(document.getElementById('ed_id').value);
  var imgVal=document.getElementById('ed_img').value.trim()||null;
  var urlVal=document.getElementById('ed_url').value.trim()||null;
  if(imgVal&&imgVal.indexOf('http')!==0)imgVal='https://'+imgVal;
  if(urlVal&&urlVal.indexOf('http')!==0)urlVal='https://'+urlVal;
  var data={
    title:document.getElementById('ed_title').value.trim(),
    event_date:document.getElementById('ed_date').value.trim()||null,
    location:document.getElementById('ed_loc').value.trim()||'Malta',
    source_name:document.getElementById('ed_source').value.trim()||null,
    category:document.getElementById('ed_cat').value||null,
    image_url:imgVal,
    source_url:urlVal,
    description:document.getElementById('ed_desc').value.trim()||null,
    recurring:document.getElementById('ed_recur').value||null
  };
  if(!data.title)return toast('Title required',1);
  api('PUT','/admin/api/events/'+id,data,function(){
    var e=E.find(function(x){return x.id===id});
    if(e)Object.assign(e,data);
    closeEdit();us();af4();toast('Event updated \u2713');
  });
}
function delEvt(id){
  if(!confirm('Delete this event permanently?'))return;
  api('DELETE','/admin/api/events/'+id,{},function(){
    E=E.filter(function(x){return x.id!==id});
    us();
    if(tab==='images')af1();else if(tab==='dates')af2();else if(tab==='categories')af3();else if(tab==='manage')af4();
    toast('Event deleted');
  });
}
function getSource(e){
  if(!e.source_url)return 'manual';
  if(e.source_url.indexOf('showshappening')>-1)return 'showshappening';
  if(e.source_url.indexOf('visitmalta')>-1)return 'visitmalta';
  return 'manual';
}
function getSrc(e){if(e.source_name)return e.source_name;var s=getSource(e);return s==='showshappening'?'ShowsHappening':s==='visitmalta'?'VisitMalta':'Other'}
function ue(id,f,v){var e=E.find(function(x){return x.id===id});if(e)e[f]=v;us();if(tab==='images')af1();else if(tab==='dates')af2();else if(tab==='categories')af3();else if(tab==='manage')af4()}
function api(method,url,body,cb){
  fetch(url,{method:method,headers:{'Content-Type':'application/json',Authorization:auth},body:JSON.stringify(body)})
    .then(function(r){if(!r.ok)throw 0;return r.json()}).then(cb).catch(function(){toast('Failed',1)});
}
function toast(m,e){var t=document.getElementById('toast');t.textContent=m;t.className='toast show'+(e?' err':'');setTimeout(function(){t.className='toast'},3000)}
`);
});


// =====================================================================
// ADMIN API ROUTES
// =====================================================================

// Get all events
app.get('/admin/api/events', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    // Try with category column first, fallback without it
    let result;
    try {
      result = await pool.query('SELECT id, title, source_url, image_url, event_date, location, description, category, source_name, recurring FROM events ORDER BY title');
    } catch (e) {
      // columns might not exist yet
      try {
        result = await pool.query('SELECT id, title, source_url, image_url, event_date, location, description, category, source_name FROM events ORDER BY title');
        result.rows = result.rows.map(r => ({ ...r, recurring: null }));
      } catch (e2) {
        result = await pool.query('SELECT id, title, source_url, image_url, event_date, location, description FROM events ORDER BY title');
        result.rows = result.rows.map(r => ({ ...r, category: null, source_name: null, recurring: null }));
      }
    }
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update event image (also saves to overrides for protection)
app.put('/admin/api/events/:id/image', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    await pool.query('UPDATE events SET image_url = $1 WHERE id = $2', [req.body.image_url, req.params.id]);
    // Save to overrides so it survives truncate
    const evt = await pool.query('SELECT source_url FROM events WHERE id = $1', [req.params.id]);
    if (evt.rows[0]) {
      await pool.query(
        'INSERT INTO event_overrides (source_url, image_url) VALUES ($1, $2) ON CONFLICT (source_url) DO UPDATE SET image_url = $2',
        [evt.rows[0].source_url, req.body.image_url]
      ).catch(()=>{});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update event category (also saves to overrides)
app.put('/admin/api/events/:id/category', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    await pool.query('UPDATE events SET category = $1 WHERE id = $2', [req.body.category, req.params.id]);
    const evt = await pool.query('SELECT source_url FROM events WHERE id = $1', [req.params.id]);
    if (evt.rows[0]) {
      await pool.query(
        'INSERT INTO event_overrides (source_url, category) VALUES ($1, $2) ON CONFLICT (source_url) DO UPDATE SET category = $2',
        [evt.rows[0].source_url, req.body.category]
      ).catch(()=>{});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete event
app.delete('/admin/api/events/:id', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update full event (edit)
app.put('/admin/api/events/:id', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const { title, event_date, location, source_name, category, description, recurring } = req.body;
    let { image_url, source_url } = req.body;
    // Auto-fix URLs missing protocol
    if (source_url && !source_url.startsWith('http') && !source_url.startsWith('manual:')) source_url = 'https://' + source_url;
    if (image_url && !image_url.startsWith('http')) image_url = 'https://' + image_url;
    await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS source_name TEXT').catch(()=>{});
    await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS recurring TEXT').catch(()=>{});
    await pool.query(
      `UPDATE events SET title=$1, event_date=$2, location=$3, source_name=$4, category=$5, image_url=$6, source_url=$7, description=$8, recurring=$9, slug=$10 WHERE id=$11`,
      [title, event_date, location, source_name, category, image_url, source_url, description, recurring || null, generateSlug(title) + '-' + req.params.id, req.params.id]
    );
    // Also update overrides
    const evt = await pool.query('SELECT source_url FROM events WHERE id = $1', [req.params.id]);
    if (evt.rows[0]) {
      await pool.query(
        'INSERT INTO event_overrides (source_url, image_url, category) VALUES ($1, $2, $3) ON CONFLICT (source_url) DO UPDATE SET image_url=COALESCE($2,event_overrides.image_url), category=COALESCE($3,event_overrides.category)',
        [evt.rows[0].source_url, image_url, category]
      ).catch(()=>{});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update event date
app.put('/admin/api/events/:id/date', (req, res) => {
  if (!authCheck(req, res)) return;
  const { event_date } = req.body;
  let warning = null;
  if (event_date) {
    const valid = /^(\d{1,2}[,\d\s]*\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(event_date) ||
                  /^\d{1,2}\s+\w+\s+\d{4}\s*-\s*\d{1,2}\s+\w+\s+\d{4}$/.test(event_date);
    if (!valid) warning = 'Format may not sort correctly';
  }
  pool.query('UPDATE events SET event_date = $1 WHERE id = $2', [event_date, req.params.id])
    .then(() => res.json({ success: true, warning }))
    .catch(e => res.status(500).json({ error: e.message }));
});

// Add new event (manual)
app.post('/admin/api/events', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const { title, event_date, location, description, category, source_name, recurring } = req.body;
    let { image_url, source_url } = req.body;
    if (!title || !event_date || !location) return res.status(400).json({ error: 'Title, date, and location are required' });
    
    // Auto-fix URLs missing protocol
    if (source_url && !source_url.startsWith('http') && !source_url.startsWith('manual:')) source_url = 'https://' + source_url;
    if (image_url && !image_url.startsWith('http')) image_url = 'https://' + image_url;
    
    // Ensure unique source_url (database has UNIQUE constraint for scraper dedup)
    if (source_url) source_url = source_url.split('#manual-')[0] + '#manual-' + Date.now();
    
    // Ensure source_name column exists
    await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS source_name TEXT').catch((e)=>{console.log('ALTER skip:', e.message)});
    
    let result;
    try {
      result = await pool.query(
        'INSERT INTO events (title, event_date, location, image_url, source_url, description, category, source_name, recurring, slug) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [title, event_date, location || 'Malta', image_url || null, source_url || 'manual://added', description || null, category || null, source_name || null, recurring || null, generateSlug(title) + '-' + Date.now().toString(36)]
      );
    } catch (e1) {
      console.log('Insert with recurring failed:', e1.message);
      try {
        result = await pool.query(
          'INSERT INTO events (title, event_date, location, image_url, source_url, description, category, source_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [title, event_date, location || 'Malta', image_url || null, source_url || 'manual://added', description || null, category || null, source_name || null]
        );
      } catch (e2) {
        console.log('Insert fallback failed:', e2.message);
        result = await pool.query(
          'INSERT INTO events (title, event_date, location, image_url, source_url, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
          [title, event_date, location || 'Malta', image_url || null, source_url || 'manual://added', description || null]
        );
      }
    }
    res.json({ success: true, event: result.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Analytics
app.get('/admin/api/analytics', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const total = await pool.query('SELECT COUNT(*) as c FROM click_tracking');
    const today = await pool.query("SELECT COUNT(*) as c FROM click_tracking WHERE clicked_at >= CURRENT_DATE");
    const week = await pool.query("SELECT COUNT(*) as c FROM click_tracking WHERE clicked_at >= CURRENT_DATE - INTERVAL '7 days'");
    const month = await pool.query("SELECT COUNT(*) as c FROM click_tracking WHERE clicked_at >= CURRENT_DATE - INTERVAL '30 days'");
    const unique = await pool.query('SELECT COUNT(DISTINCT event_id) as c FROM click_tracking');
    const top = await pool.query('SELECT event_title, source, COUNT(*) as clicks, MAX(clicked_at) as last_click FROM click_tracking GROUP BY event_title, source ORDER BY clicks DESC LIMIT 100');
    // Per-source totals
    const sourceTotals = await pool.query('SELECT source, COUNT(*) as clicks FROM click_tracking GROUP BY source ORDER BY clicks DESC');
    res.json({
      total_clicks: total.rows[0].c,
      today_clicks: today.rows[0].c,
      week_clicks: week.rows[0].c,
      month_clicks: month.rows[0].c,
      unique_events: unique.rows[0].c,
      top_events: top.rows,
      source_totals: sourceTotals.rows
    });
  } catch (e) { res.json({ total_clicks: 0, today_clicks: 0, week_clicks: 0, month_clicks: 0, unique_events: 0, top_events: [], source_totals: [] }); }
});

app.get('/admin/api/subscribers', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const result = await pool.query('SELECT email, subscribed_at FROM email_subscribers ORDER BY subscribed_at DESC');
    res.json(result.rows);
  } catch (e) { res.json([]); }
});

app.listen(3000, () => console.log('Server running at http://localhost:3000'));
