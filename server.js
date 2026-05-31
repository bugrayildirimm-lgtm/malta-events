require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Core Node modules (hoisted to top to avoid TDZ when used by early middleware)
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static assets (CSS, images, etc.)
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'malta2026';

// Date utilities (extracted for maintainability)
const dates = require('./utils/dates');
const render = require('./utils/render');
const adminViews = require('./admin/views');
const createAdminApi = require('./admin/api');
function authCheck(req, res) {
  if (req.headers.authorization !== ADMIN_PASSWORD) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

// Mount extracted Admin API (all /admin/api/* routes now live in admin/api.js)
app.use('/admin/api', createAdminApi({
  pool,
  dates,
  ADMIN_PASSWORD,
  upload
}));

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
pool.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'live'").catch(()=>{});
pool.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT FALSE").catch(()=>{});

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
// STATIC ASSETS (logo routes + buffers)
// =====================================================================
let logoBuffer = null;
let logoFullBuffer = null;
try { logoBuffer = fs.readFileSync(path.join(__dirname, 'logo.png')); } catch(e) { console.log('logo.png not found, using text fallback'); }
try { logoFullBuffer = fs.readFileSync(path.join(__dirname, 'logo-full.png')); } catch(e) {}

app.get('/logo.png', (req, res) => {
  if (logoBuffer) {
    res.type('image/png').set('Cache-Control', 'public, max-age=604800').send(logoBuffer);
  } else {
    res.status(404).send('Not found');
  }
});

app.get('/logo-full.png', (req, res) => {
  if (logoFullBuffer) {
    res.type('image/png').set('Cache-Control', 'public, max-age=604800').send(logoFullBuffer);
  } else if (logoBuffer) {
    res.type('image/png').set('Cache-Control', 'public, max-age=604800').send(logoBuffer);
  } else {
    res.status(404).send('Not found');
  }
});

// =====================================================================
// SHARED UI HELPERS (reduces massive duplication across templates)
// =====================================================================

/**
 * Returns the Instagram / YouTube / TikTok social icon links.
 * Extracted to avoid duplicating the long SVG strings.
 */
function getSocialIconsHTML(variant = 'light') {
  const colors = variant === 'dark' 
    ? { base: '#94a3b8', hover: '#FF385C' } 
    : { base: 'rgba(255,255,255,0.7)', hover: 'white' };

  const commonStyle = `color:${colors.base};display:flex;align-items:center;transition:0.2s`;
  const onHover = `onmouseover="this.style.color='${colors.hover}'" onmouseout="this.style.color='${colors.base}'"`;

  return `
    <a href="https://www.instagram.com/maltaeventguide/" target="_blank" rel="noopener" style="${commonStyle}" ${onHover} title="Instagram">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
    </a>
    <a href="https://youtube.com/@maltaeventsguide" target="_blank" rel="noopener" style="${commonStyle}" ${onHover} title="YouTube">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
    </a>
    <a href="https://www.tiktok.com/@malta.events.guid" target="_blank" rel="noopener" style="${commonStyle}" ${onHover} title="TikTok">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.73a8.19 8.19 0 004.76 1.52V6.79a4.84 4.84 0 01-1-.1z"/></svg>
    </a>`;
}

/**
 * Renders the standard dark navigation bar used on subpages.
 * @param {Object} options
 * @param {boolean} [options.backLink=false]
 * @param {string} [options.backText='← All Events']
 * @param {number} [options.logoHeight=50]
 * @param {boolean} [options.showSocials=true]
 */
function getNavHTML(options = {}) {
  const {
    backLink = false,
    backText = '← All Events',
    logoHeight = 50,
    showSocials = true,
    darkNav = true   // default to dark gradient like homepage header for logo visibility on light pages
  } = options;

  const backHTML = backLink
    ? `<a href="/" class="back" style="color:#94a3b8;font-size:0.85rem;margin-left:auto;">${backText}</a>`
    : '';

  const navBg = darkNav 
    ? 'background:linear-gradient(135deg, #0f172a 0%, #1e3a5f 40%, #FF385C 100%);' 
    : 'background:rgba(255,255,255,0.96);backdrop-filter:blur(10px);box-shadow:0 1px 0 rgba(0,0,0,0.04);';

  const socialVariant = darkNav ? 'light' : 'dark';
  const socials = showSocials ? getSocialIconsHTML(socialVariant) : '';

  return `
  <div style="position:absolute;top:0;left:0;right:0;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;z-index:3;${navBg}">
    <a href="/" style="text-decoration:none">
      <img src="/logo.png" alt="Malta Event Guide" style="height:${logoHeight}px">
    </a>
    <div style="display:flex;align-items:center;gap:12px">
      ${socials}
      ${backHTML}
    </div>
  </div>`;
}

/**
 * Renders the standard site footer with links and social icons.
 * Used on homepage and all subpages for consistency.
 */
function getFooterHTML() {
  const year = new Date().getFullYear();
  return `
  <footer style="margin-top:60px;padding:40px 20px;background:#1e293b;color:#b0bec5;text-align:center;font-size:0.85rem;line-height:1.8">
    <div style="max-width:800px;margin:0 auto">
      <a href="/"><img src="/logo.png" alt="Malta Event Guide" style="height:60px;margin-bottom:10px"></a>
      <p>Your complete guide to events in Malta and Gozo. Discover concerts, festivals, theatre, nightlife, sports, arts and cultural events happening across the Maltese islands.</p>
      <div style="margin-top:20px;padding-top:15px;border-top:1px solid #334155;font-size:0.8rem;line-height:2.2">
        <a href="/music-events-malta" style="color:#94a3b8;margin:0 8px">Music Events</a> &middot;
        <a href="/nightlife-malta" style="color:#94a3b8;margin:0 8px">Nightlife</a> &middot;
        <a href="/festivals-malta" style="color:#94a3b8;margin:0 8px">Festivals</a> &middot;
        <a href="/theatre-shows-malta" style="color:#94a3b8;margin:0 8px">Theatre & Shows</a> &middot;
        <a href="/arts-culture-malta" style="color:#94a3b8;margin:0 8px">Arts & Culture</a> &middot;
        <a href="/sports-events-malta" style="color:#94a3b8;margin:0 8px">Sports</a> &middot;
        <a href="/food-drink-events-malta" style="color:#94a3b8;margin:0 8px">Food & Drink</a> &middot;
        <a href="/family-events-malta" style="color:#94a3b8;margin:0 8px">Family</a> &middot;
        <a href="/free-events-malta" style="color:#94a3b8;margin:0 8px">Free Events</a>
      </div>
      <p style="margin-top:15px;font-size:0.75rem;color:#64748b">&copy; ${year} maltaeventguide.com &middot; Events sourced from ShowsHappening, VisitMalta, Resident Advisor, EventWorks and local organizers</p>
      <div style="margin-top:18px;display:flex;justify-content:center;gap:16px">
        ${getSocialIconsHTML('dark')}
      </div>
      <p style="margin-top:15px;font-size:0.75rem;color:#64748b">Powered by <a href="https://bugrayildirim.me/" target="_blank" style="color:#94a3b8;text-decoration:underline">Bugra</a> &middot; <a href="mailto:hello@bugrayildirim.me" style="color:#94a3b8;text-decoration:underline">hello@bugrayildirim.me</a></p>
    </div>
  </footer>`;
}

// =====================================================================
// SEO ROUTES
// =====================================================================
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /
Disallow: /admin
Disallow: /*?month=
Disallow: /*?source=
Disallow: /*?category=
Disallow: /*?q=

Sitemap: https://maltaeventguide.com/sitemap.xml`);
});

app.get('/sitemap.xml', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  let eventUrls = '';
  try {
    const result = await pool.query("SELECT slug, event_date FROM events WHERE slug IS NOT NULL AND COALESCE(status,'live') = 'live'");
    eventUrls = result.rows
      .filter(r => r.slug && r.slug.length > 2)
      .map(r => `  <url>
    <loc>https://maltaeventguide.com/event/${r.slug}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`).join('\n');
  } catch(e) {}
  const catPages = ['music-events-malta','nightlife-malta','festivals-malta','theatre-shows-malta','arts-culture-malta','sports-events-malta','food-drink-events-malta','family-events-malta','free-events-malta'];
  const guidePageSlugs = ['guide/how-to-find-events-in-malta','guide/malta-nightlife-guide','guide/things-to-do-malta-tourists'];
  const catUrls = catPages.map(s => `  <url>
    <loc>https://maltaeventguide.com/${s}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>`).join('\n');
  const guideUrls = guidePageSlugs.map(s => `  <url>
    <loc>https://maltaeventguide.com/${s}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.85</priority>
  </url>`).join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://maltaeventguide.com/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
${catUrls}
${guideUrls}
${eventUrls}
</urlset>`);
});

// =====================================================================
// CATEGORY SEO LANDING PAGES
// =====================================================================
const categoryPages = {
  'music-events-malta': { cat: 'Music & Concerts', h1: 'Music Events in Malta', desc: 'Discover live music concerts, DJ sets, and musical performances happening across Malta and Gozo.' },
  'nightlife-malta': { cat: 'Nightlife & Parties', h1: 'Nightlife & Parties in Malta', desc: 'Find the best clubs, parties, DJ events and nightlife experiences in Malta. From Paceville to Valletta.' },
  'festivals-malta': { cat: 'Festivals', h1: 'Festivals in Malta', desc: 'Explore upcoming festivals in Malta and Gozo. Music festivals, cultural celebrations, food festivals and more.' },
  'theatre-shows-malta': { cat: 'Theatre & Shows', h1: 'Theatre & Shows in Malta', desc: 'Browse upcoming theatre performances, comedy shows, and live entertainment across Malta.' },
  'arts-culture-malta': { cat: 'Arts & Culture', h1: 'Arts & Culture Events in Malta', desc: 'Discover art exhibitions, cultural events, museum openings and heritage activities in Malta and Gozo.' },
  'sports-events-malta': { cat: 'Sports & Adventure', h1: 'Sports & Adventure Events in Malta', desc: 'Find sporting events, outdoor adventures, races and fitness activities happening in Malta.' },
  'food-drink-events-malta': { cat: 'Food & Drink', h1: 'Food & Drink Events in Malta', desc: 'Wine tastings, food festivals, restaurant events and culinary experiences across Malta and Gozo.' },
  'family-events-malta': { cat: 'Family', h1: 'Family Events in Malta', desc: 'Kid-friendly events, family outings, and activities for all ages in Malta and Gozo.' },
  'free-events-malta': { cat: '_free', h1: 'Free Events in Malta', desc: 'Discover free things to do in Malta and Gozo. Concerts, exhibitions, festivals and community events that cost nothing.' }
};

Object.entries(categoryPages).forEach(([slug, config]) => {
  app.get(`/${slug}`, async (req, res) => {
    try {
      let events;
      if (config.cat === '_free') {
        events = await pool.query("SELECT * FROM events WHERE (LOWER(description) LIKE '%free%' OR LOWER(title) LIKE '%free%') AND COALESCE(status,'live')='live' ORDER BY id DESC LIMIT 50");
      } else {
        events = await pool.query("SELECT * FROM events WHERE category = $1 AND COALESCE(status,'live')='live' ORDER BY id DESC LIMIT 50", [config.cat]);
      }
      const rows = events.rows;

      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- Google Analytics -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-YMT2MSCCRZ"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-YMT2MSCCRZ');</script>
  <title>${config.h1} 2026 | Malta Event Guide</title>
  <meta name="description" content="${config.desc} Updated daily on Malta Event Guide.">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://maltaeventguide.com/${slug}">
  <meta property="og:title" content="${config.h1} 2026">
  <meta property="og:description" content="${config.desc}">
  <meta property="og:url" content="https://maltaeventguide.com/${slug}">
  <meta property="og:type" content="website">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "${config.h1}",
    "description": "${config.desc}",
    "url": "https://maltaeventguide.com/${slug}",
    "isPartOf": { "@type": "WebSite", "name": "Malta Event Guide", "url": "https://maltaeventguide.com/" }
  }
  </script>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <style>
    /* Category page specific overrides. Most styles now in /styles.css */
    .hero { max-width:900px; margin:30px auto; padding:0 20px; }
    .hero h1 { font-size:2rem; margin:0 0 10px; }
    .hero p { color:#64748b; font-size:1rem; line-height:1.6; margin:0 0 25px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:18px; max-width:900px; margin:0 auto; padding:0 20px 50px; }
    .card { background:white; border-radius:16px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,0.06); transition:0.2s; }
    .card:hover { transform:translateY(-3px); box-shadow:0 8px 24px rgba(0,0,0,0.1); }
    .card-img { height:180px; background:#e2e8f0; background-size:cover; background-position:center; }
    .card-body { padding:14px; }
    .card-title { font-weight:700; font-size:0.95rem; margin:0 0 6px; }
    .card-meta { font-size:0.8rem; color:#64748b; }
    .internal-links { max-width:900px; margin:20px auto; padding:20px; background:white; border-radius:16px; font-size:0.9rem; line-height:1.8; }
    .internal-links a { margin-right:16px; }
  </style>
</head>
<body>
  ${getNavHTML({ backLink: true })}
  <div class="hero">
    <h1>${config.h1}</h1>
    <p>${config.desc} Browse ${rows.length}+ events below.</p>
  </div>
  <div class="grid">
    ${rows.map(e => {
      const eventSlug = e.slug || '';
      const img = e.image_url && !e.image_url.includes('/api/v2/file/') ? e.image_url : '';
      return `<a href="/event/${eventSlug}" style="text-decoration:none;color:inherit"><div class="card">
        <div class="card-img" style="${img ? `background-image:url('${img}')` : 'background:#1e293b'}"></div>
        <div class="card-body">
          <div class="card-title">${e.title || ''}</div>
          <div class="card-meta">${e.event_date || ''} · ${e.location || 'Malta'}</div>
        </div>
      </div></a>`;
    }).join('')}
  </div>
  <div class="internal-links">
    <strong>Explore more events:</strong><br>
    ${Object.entries(categoryPages).filter(([s]) => s !== slug).map(([s, c]) => `<a href="/${s}">${c.h1.replace(' in Malta','')}</a>`).join(' ')}
    <a href="/">All Events</a>
  </div>
  <footer style="margin-top:30px;padding:30px 20px;background:#1e293b;color:#94a3b8;text-align:center;font-size:0.8rem;line-height:1.8">
    <a href="/"><img src="/logo.png" alt="Malta Event Guide" style="height:50px;margin-bottom:8px"></a><br>
    Your complete guide to events in Malta & Gozo
    <div style="margin-top:12px;display:flex;justify-content:center;gap:16px">
      <a href="https://www.instagram.com/maltaeventguide/" target="_blank" rel="noopener" style="color:#94a3b8;transition:0.2s" onmouseover="this.style.color='#FF385C'" onmouseout="this.style.color='#94a3b8'" title="Instagram"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg></a>
      <a href="https://youtube.com/@maltaeventsguide" target="_blank" rel="noopener" style="color:#94a3b8;transition:0.2s" onmouseover="this.style.color='#FF0000'" onmouseout="this.style.color='#94a3b8'" title="YouTube"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
      <a href="https://www.tiktok.com/@malta.events.guid" target="_blank" rel="noopener" style="color:#94a3b8;transition:0.2s" onmouseover="this.style.color='#00f2ea'" onmouseout="this.style.color='#94a3b8'" title="TikTok"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.73a8.19 8.19 0 004.76 1.52V6.79a4.84 4.84 0 01-1-.1z"/></svg></a>
    </div>
    <div style="margin-top:10px">&copy; ${new Date().getFullYear()} maltaeventguide.com · Powered by <a href="https://bugrayildirim.me/" target="_blank" style="color:#94a3b8">Bugra</a></div>
  </footer>
</body>
</html>`);
    } catch(e) { res.redirect('/'); }
  });
});

// =====================================================================
// EDITORIAL GUIDE PAGES (SEO + LLM VISIBILITY)
// =====================================================================
const guidePages = {
  'guide/how-to-find-events-in-malta': {
    title: 'How to Find Events in Malta Easily — Complete Guide 2026',
    h1: 'How to Find Events in Malta Easily',
    desc: 'A practical guide to discovering concerts, festivals, nightlife and things to do across the Maltese islands. Tips for tourists and locals alike.',
    content: `
      <p>Malta has a packed events calendar all year round, but finding what is happening on any given week can be surprisingly difficult. Events are scattered across dozens of websites, Facebook groups, and Instagram pages with no single source covering everything. That is exactly why we built Malta Event Guide.</p>

      <h2>The Problem with Finding Events in Malta</h2>
      <p>If you search for events in Malta, you will find official tourism sites like VisitMalta that cover major festivals but miss smaller local gigs. You will find ticketing platforms like ShowsHappening and Eventbrite that only list events sold through their systems. And you will find social media pages that post flyers but have no searchable archive. The result is that most people in Malta rely on word of mouth or happen to see a poster on the street.</p>

      <h2>How Malta Event Guide Solves This</h2>
      <p><a href="/">Malta Event Guide</a> aggregates events from all major sources into one searchable listing. We pull from ShowsHappening, VisitMalta, Resident Advisor, EventWorks, and local organisers, then update daily. Every event includes the date, venue, category, and a direct link to the original source for tickets or details.</p>

      <h2>Tips for Finding Events as a Tourist</h2>
      <p>If you are visiting Malta, start by checking our homepage and filtering by date. The "This Weekend" quick filter is the fastest way to see what is coming up. For nightlife, head to our <a href="/nightlife-malta">Nightlife & Parties page</a>. For cultural activities during the day, check <a href="/arts-culture-malta">Arts & Culture</a> or <a href="/family-events-malta">Family Events</a>. Most events in Malta happen in Valletta, Paceville (St Julian's), Sliema, and Ta' Qali — all easily reachable by bus.</p>

      <h2>Tips for Locals</h2>
      <p>If you live in Malta and want to stay up to date, bookmark <a href="/">maltaeventguide.com</a> and check back regularly — we add new events every day. Sign up for our weekly email newsletter on the homepage (using the form at the bottom) to get curated event highlights delivered to your inbox every week.</p>

      <h2>Other Useful Resources</h2>
      <p>Besides Malta Event Guide, other useful sources include the "All the events in Malta" Facebook group, GuideMeMalta's events calendar, and individual venue pages on Instagram. For electronic music specifically, Resident Advisor covers Malta's club scene. For heritage and museum events, Heritage Malta publishes their own calendar. We aggregate from most of these sources so you do not have to check them all individually.</p>

      <h2>Free Events in Malta</h2>
      <p>Many events in Malta are completely free, including village festas, public holiday celebrations, Notte Bianca, and the Isle of MTV concert. Check our <a href="/free-events-malta">Free Events page</a> for a filtered view of everything that costs nothing.</p>
    `
  },
  'guide/malta-nightlife-guide': {
    title: 'Malta Nightlife Guide 2026 — Best Clubs, Bars & Party Areas',
    h1: 'Malta Nightlife Guide 2026',
    desc: 'Everything you need to know about nightlife in Malta. Best clubs in Paceville, rooftop bars in Valletta, boat parties, and tips for going out in Malta.',
    content: `
      <p>Malta punches well above its weight when it comes to nightlife. For a small island, it has an impressive density of clubs, bars, beach clubs, and seasonal festivals that attract both locals and international visitors. Here is your complete guide to going out in Malta in 2026.</p>

      <h2>Paceville — The Nightlife Centre</h2>
      <p>Paceville in St Julian's is the undisputed heart of Malta's nightlife. Within a few compact streets you will find dozens of bars and clubs open every night of the week. Entry is usually free or cheap, and drinks are affordable compared to most European cities. Popular venues include Havana, Hugo's, and the various bars along Dragonara Road. Paceville gets busy from around 11pm and goes until 4am or later on weekends.</p>

      <h2>Valletta — Boutique Bars & Rooftop Drinks</h2>
      <p>Valletta's nightlife scene is more refined. Strait Street (known historically as "The Gut") has been revitalised with cocktail bars, wine bars, and live music venues. For rooftop drinks with harbour views, Bridge Bar and Palazzo Consiglia are popular choices. Valletta tends to be busier on Thursday and Friday evenings.</p>

      <h2>Boat Parties & Beach Clubs</h2>
      <p>In summer (June to September), Malta's nightlife extends to the water. Pukka Up runs the biggest boat parties, and beach clubs like Cafe del Mar, Bora Bora, and MedAsia Playa host pool parties and DJ events during the day. These are a major draw for the summer tourist crowd.</p>

      <h2>Super Clubs & Festival Venues</h2>
      <p>Gianpula Village in Rabat is Malta's premier open-air club complex, hosting international DJs and multi-room events throughout summer. UNO Club on the same road is another major venue. For larger festivals, events are often held at MFCC Ta' Qali or the Granaries in Floriana.</p>

      <h2>Major Festivals Worth Planning Around</h2>
      <p>Malta's festival scene goes well beyond club nights. <a href="/event/earth-garden-festival-2026-3564">Earth Garden</a> (May) is the island's biggest alternative festival with five stages at Ta' Qali National Park — world music, techno, reggae, and psytrance across three days with 30,000 attendees. Bloom Festival brings international house and techno to outdoor venues. Glitch Festival and Lost & Found have made Malta a serious electronic music destination. The Isle of MTV (summer) is completely free, drawing tens of thousands to Floriana for global pop and dance acts. Check our <a href="/festivals-malta">Festivals page</a> for all upcoming dates.</p>

      <h2>Big Concerts in Malta 2026</h2>
      <p>Malta is attracting major international artists. <a href="/event/scorpions-live-in-concert-4792">Scorpions</a> are bringing their legendary rock show to the island. <a href="/event/pitbull-im-back-with-special-guest-lil-jon-2486">Pitbull with special guest Lil Jon</a> is performing as part of his "I'm Back" tour. Bonnie Tyler, Kim Wilde, James Morrison, and Gabriel Iglesias have also performed or are coming to Malta. Browse our <a href="/music-events-malta">Music Events page</a> for all upcoming concerts.</p>

      <h2>Summer Nightlife — Pool Parties, Boat Parties & Beach Clubs</h2>
      <p>From June to September, Malta's nightlife moves outdoors. Cafe del Mar, Bora Bora, and MedAsia Playa host pool parties and daytime DJ events. Boat parties run from Sliema and Bugibba with sunset cruises and live DJs. Gianpula Village and UNO in Rabat host open-air club nights with international headliners throughout summer.</p>

      <h2>Practical Tips</h2>
      <p>The legal drinking age in Malta is 17. Most clubs do not have a strict dress code, though some upscale venues prefer smart casual. Taxis from Paceville can be expensive late at night — the Bolt app usually offers better rates. Many clubs accept card payments but carrying some cash is useful for smaller bars and street food vendors.</p>

      <p>Browse all upcoming nightlife events on our <a href="/nightlife-malta">Nightlife & Parties page</a>, or check the <a href="/">homepage</a> and filter by category.</p>
    `
  },
  'guide/things-to-do-malta-tourists': {
    title: 'Things to Do in Malta for Tourists — Best Events & Activities 2026',
    h1: 'Things to Do in Malta for Tourists',
    desc: 'Planning a trip to Malta? Here are the best events, activities, and experiences for visitors. From historical sites and festivals to beach clubs and food tours.',
    content: `
      <p>Malta is one of the Mediterranean's most underrated destinations. With over 7,000 years of history, stunning coastline, a thriving food scene, and year-round sunshine, there is something for every type of traveller. Here are the best things to do during your visit.</p>

      <h2>Must-See Cultural Events</h2>
      <p>Malta's cultural calendar is rich. The Valletta Baroque Festival (January) brings world-class classical music to historic venues. Carnival (February) fills the streets of Valletta with colourful floats and masked parades. Holy Week (March/April) features solemn processions that are deeply atmospheric. In October, Notte Bianca opens Valletta's palaces, museums, and churches for free with live performances until late. Check our <a href="/arts-culture-malta">Arts & Culture page</a> for current listings.</p>

      <h2>Summer Festivals & Outdoor Events</h2>
      <p>If you visit between June and September, you will find Malta at its most vibrant. The Isle of MTV is a free open-air concert in Floriana featuring major international artists. <a href="/event/earth-garden-festival-2026-3564">Earth Garden</a> is Malta's largest alternative festival, held at Ta' Qali National Park with five stages covering world music, reggae, techno, and psytrance — attracting 30,000 people over three days. Bloom Festival brings house and techno to outdoor venues. Beach clubs like Cafe del Mar, Bora Bora, and MedAsia Playa host pool parties and DJ events every weekend. Boat parties run from Sliema with sunset cruises and live DJs. Village festas happen every weekend across different towns with fireworks, brass bands, and street food — completely free and unmissable.</p>

      <h2>Big Concerts in Malta 2026</h2>
      <p>Malta is becoming a serious stop for world-touring artists. <a href="/event/scorpions-live-in-concert-4792">Scorpions</a> are performing live in Malta. <a href="/event/pitbull-im-back-with-special-guest-lil-jon-2486">Pitbull with Lil Jon</a> is coming as part of his "I'm Back" world tour. Bonnie Tyler, Kim Wilde, James Morrison, and Gabriel Iglesias have also performed or are scheduled in Malta this year. Check our <a href="/music-events-malta">Music Events page</a> for the full concert calendar.</p>

      <h2>Food & Drink Experiences</h2>
      <p>Malta's food scene has exploded in recent years. Look out for food festivals, wine tastings at local vineyards (Marsovin and Meridiana are the main producers), and the annual Frawli Festival (Strawberry Festival) in Mgarr. For everyday eating, try pastizzi (flaky pastries with ricotta or pea filling) from any village bakery — they cost less than a euro. Browse our <a href="/food-drink-events-malta">Food & Drink Events page</a> for upcoming tastings and festivals.</p>

      <h2>Adventure & Outdoors</h2>
      <p>Malta's coastline is spectacular for diving, snorkelling, and coastal walks. The Blue Grotto, Comino's Blue Lagoon, and Gozo's inland sea are must-visits. For organised adventure events like trail runs, regattas, and cycling tours, check our <a href="/sports-events-malta">Sports & Adventure page</a>.</p>

      <h2>Family-Friendly Activities</h2>
      <p>Travelling with kids? Malta has plenty of family events including puppet shows, heritage open days, and outdoor markets. The Esplora Interactive Science Centre in Kalkara is excellent for children. Popeye Village in Mellieha (the original film set) is a fun day out. See our <a href="/family-events-malta">Family Events page</a> for what is coming up.</p>

      <h2>How to Stay Updated</h2>
      <p>The easiest way to find events during your stay is to bookmark <a href="/">Malta Event Guide</a> and check the "This Week" or "This Weekend" filters. We update daily with events from across the island.</p>
    `
  }
};

Object.entries(guidePages).forEach(([slug, config]) => {
  app.get('/' + slug, (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=7200');
    const otherGuides = Object.entries(guidePages).filter(([s]) => s !== slug).map(([s, c]) => '<a href="/' + s + '"><div class="rg-title">' + c.h1 + '</div><div class="rg-desc">' + c.desc.substring(0, 80) + '...</div></a>').join('');
    res.send(`<!DOCTYPE html>
<html lang="en-MT">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-YMT2MSCCRZ"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-YMT2MSCCRZ');</script>
  <title>${config.title}</title>
  <meta name="description" content="${config.desc}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://maltaeventguide.com/${slug}">
  <meta property="og:title" content="${config.title}">
  <meta property="og:description" content="${config.desc}">
  <meta property="og:url" content="https://maltaeventguide.com/${slug}">
  <meta property="og:type" content="article">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "${config.h1}",
    "description": "${config.desc}",
    "url": "https://maltaeventguide.com/${slug}",
    "publisher": { "@type": "Organization", "name": "Malta Event Guide", "url": "https://maltaeventguide.com", "logo": { "@type": "ImageObject", "url": "https://maltaeventguide.com/logo.png" } },
    "datePublished": "2026-03-01",
    "dateModified": "2026-03-07",
    "author": { "@type": "Organization", "name": "Malta Event Guide" }
  }
  </script>
  <link rel="preload" href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap" rel="stylesheet"></noscript>
  <style>
    /* Guide page specific styles. Common styles in /styles.css */
    article { max-width:740px; margin:40px auto; padding:0 24px 60px; }
    article h1 { font-size:2.2rem; font-weight:900; line-height:1.2; margin:0 0 12px; }
    article .byline { color:#64748b; font-size:0.9rem; margin-bottom:30px; }
    article h2 { font-size:1.25rem; font-weight:700; margin:35px 0 12px; color:#0f172a; }
    article p { font-size:1rem; line-height:1.8; color:#334155; margin:0 0 18px; }
    article a { text-decoration:underline; text-underline-offset:3px; }

  </style>
</head>
<body>
  ${getNavHTML({ backLink: true, backText: '&larr; All Events' })}
  <article>
    <h1>${config.h1}</h1>
    <div class="byline">Updated March 2026 &middot; Malta Event Guide</div>
    ${config.content}
    <div class="guide-cta">
      <h3>Browse Events Now</h3>
      <p>See what is happening in Malta this week</p>
      <a href="/">Explore Events &rarr;</a>
    </div>
    <h2>More Guides</h2>
    <div class="related-guides">
      ${otherGuides}
    </div>
  </article>
  <footer>
    <a href="/"><img src="/logo.png" alt="Malta Event Guide" style="height:40px;margin-bottom:6px"></a><br>
    Your complete guide to events in Malta &amp; Gozo<br>
    <a href="/music-events-malta">Music</a> &middot; <a href="/nightlife-malta">Nightlife</a> &middot; <a href="/festivals-malta">Festivals</a> &middot; <a href="/theatre-shows-malta">Theatre</a> &middot; <a href="/arts-culture-malta">Arts</a> &middot; <a href="/sports-events-malta">Sports</a> &middot; <a href="/food-drink-events-malta">Food</a> &middot; <a href="/family-events-malta">Family</a> &middot; <a href="/free-events-malta">Free</a>
    <div style="margin-top:8px">&copy; ${new Date().getFullYear()} maltaeventguide.com</div>
  </footer>
</body>
</html>`);
  });
});

// =====================================================================
// MAIN ROUTE (PUBLIC SITE)
// =====================================================================
app.get('/', async (req, res) => {
  try {
    // Cache for 5 minutes - gives Google stable content
    res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
    
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

    const result = await pool.query("SELECT * FROM events WHERE COALESCE(status, 'live') = 'live'");
    const allEvents = result.rows;
    
    // Clean up location data
    allEvents.forEach(event => {
      if (event.location) {
        event.location = event.location
          .replace(/\s*View map\s*/gi, '')
          .replace(/,\s*Malta\s*$/i, '')
          .replace(/,\s*Malta,\s*/i, ', ')
          .replace(/\s+/g, ' ')
          .trim();
        if (event.location.toLowerCase() === 'malta' || event.location.length < 3) {
          event.location = 'Malta';
        }
      }
    });
    
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
        if (!event.event_date && dates.looksLikeDate(event.title)) event.event_date = event.title;
    });

    allEvents.forEach(event => {
        // Normalize source_name to prevent duplicates (trim and title case)
        if (event.source_name) {
          event.source_name = event.source_name.trim().replace(/\s+/g, ' ');
        }
        // Consolidate source names into clean groups
        let srcName = event.source_name
          || (event.source_url && event.source_url.includes('showshappening') ? 'ShowsHappening' : null)
          || (event.source_url && event.source_url.includes('visitmalta') ? 'VisitMalta' : null)
          || (event.source_url && event.source_url.includes('ra.co') ? 'Resident Advisor' : null)
          || (event.source_url && event.source_url.includes('eventworks') ? 'EventWorks' : null)
          || (event.source_url && event.source_url.includes('biljett') ? 'Biljett.mt' : null)
          || (event.source_url && event.source_url.includes('eventbrite') ? 'Eventbrite' : null);
        // Consolidate ShowsHappening sub-sources
        if (srcName && (srcName.includes('ShowsHappening') || srcName.includes('Show Happening'))) srcName = 'ShowsHappening';
        if (srcName && srcName.includes('Community Events')) srcName = 'Community Events Malta';
        if (srcName) {
          event.source_name = srcName; // normalize
          sources.add(srcName);
        }
        if (event.location && event.location !== 'Malta') locations.add(event.location);
        if (event.category) categories.add(event.category);

        const endDate = dates.getEndDate(event.event_date);
        const startDate = dates.getStartDate(event.event_date);
        const nextDate = dates.getNextDate(event.event_date);
        
        // Recurring events with no parseable date are always "upcoming" and sort to today
        const isRecurring = !!(event.recurring && event.recurring.trim());
        
        if (isRecurring && !startDate && !endDate) {
          // Recurring with no date — push it a bit further down so single-date events surface higher
          const recurringSort = new Date(today);
          recurringSort.setDate(recurringSort.getDate() + 3);
          upcoming.push({ ...event, _sort: recurringSort, _isRecurring: true });
        } else if (!endDate || endDate >= today) {
          let sortDate = nextDate || startDate;
          if (sortDate && sortDate < today) sortDate = new Date(today);
          // Recurring events that have a date range: give them a small penalty so they don't dominate the top
          if (isRecurring && !sortDate) {
            sortDate = new Date(today);
            sortDate.setDate(sortDate.getDate() + 3);
          }
          upcoming.push({ ...event, _sort: sortDate, _isRecurring: isRecurring });
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
<html lang="en-MT">
<head>
  <meta charset="UTF-8">
  <!-- Google Analytics -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-YMT2MSCCRZ"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-YMT2MSCCRZ');</script>
  <title>Malta Events 2026 | What's On This Summer — Concerts, Festivals, Nightlife & Pool Parties</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="/styles.css">
  <meta name="description" content="Find the best Malta events this summer 2026. Browse concerts, boat parties, pool parties, beach clubs, festivals, nightlife and things to do across Malta and Gozo. Updated daily with 500+ events.">
  <meta name="keywords" content="Malta events, things to do in Malta, Malta summer events, what's on Malta, Malta concerts, Malta festivals, Malta nightlife, Malta pool parties, Malta boat parties, Malta beach clubs, Gozo events, Malta 2026, events in Valletta, Paceville nightlife, Malta festas, isle of MTV Malta">
  <meta name="author" content="Malta Event Guide">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://maltaeventguide.com/">

  <!-- Open Graph (Facebook, WhatsApp, LinkedIn) -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="Malta Events 2026 | What's On This Summer — Concerts, Festivals, Nightlife">
  <meta property="og:description" content="Find the best events in Malta this summer. Concerts, boat parties, pool parties, beach clubs, festivals and nightlife across Malta and Gozo. Updated daily.">
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
        "startDate": "${e._sort.toISOString().split('T')[0]}"` : `,
        "startDate": "${new Date().toISOString().split('T')[0]}"`}${e.description ? `,
        "description": ${JSON.stringify(e.description.substring(0, 200))}` : ''}${e.image_url ? `,
        "image": ${JSON.stringify(e.image_url)}` : ''}${e.source_url && !e.source_url.startsWith('manual') ? `,
        "url": ${JSON.stringify(e.source_url)}` : ''}
      }
    }`).join(',')}]
  }
  </script>

  <link rel="preload" href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap" rel="stylesheet"></noscript>
  <style>
    /* Homepage-specific styles only. Common styles are in /styles.css */
    header { 
      position: relative; 
      background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 40%, #FF385C 100%); 
      background-size: cover; 
      background-position: center; 
      color: white; 
      text-align: center; 
      padding: 6rem 1rem 8rem; 
      margin-bottom: 80px; 
    }
    .header-overlay { position: absolute; top:0;left:0;right:0;bottom:0; background: radial-gradient(ellipse at 30% 50%, rgba(255,56,92,0.15) 0%, transparent 60%); z-index:1; }
    .header-content { position: relative; z-index:2; max-width: 800px; margin: 0 auto; }
    h1 { margin:0; font-size:3.5rem; font-weight:900; letter-spacing:-1px; text-shadow: 0 4px 10px rgba(0,0,0,0.3); }
    .subtitle { color: rgba(255,255,255,0.9); margin-top:10px; font-size:1.2rem; font-weight:300; }
    
    .search-box-wrapper { position:absolute; bottom:-35px; left:0;right:0; padding:0 20px; z-index:10; }
    .search-box { max-width:600px; margin:0 auto; position:relative; box-shadow:0 20px 40px rgba(0,0,0,0.2); }
    .search-box input { width:100%; padding:20px 25px 20px 55px; border-radius:50px; border:none; background:rgba(255,255,255,0.98); font-family:inherit; font-size:1.1rem; box-sizing:border-box; transition:0.3s; }
    .search-box input:focus { outline:none; transform:scale(1.02); }
    .search-icon { position:absolute; left:25px; top:50%; transform:translateY(-50%); opacity:0.5; font-size:1.2rem; }

    .container { max-width:1200px; margin:0 auto; padding:0 20px; display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:30px; }
    

    
    /* Photo link - clickable on all devices */
    .card-media-link { display:contents; text-decoration:none; cursor:pointer; }
  </style>
</head>
<body>
  <header>
    <div class="header-overlay"></div>
    <div style="position:absolute;top:0;left:0;right:0;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;z-index:3">
      <a href="/" style="text-decoration:none">
        <img src="/logo.png" alt="Malta Event Guide" style="height:50px">
      </a>
      <div style="display:flex;align-items:center;gap:12px">
        <a href="https://www.instagram.com/maltaeventguide/" target="_blank" rel="noopener" style="color:rgba(255,255,255,0.7);display:flex;align-items:center;transition:0.2s" onmouseover="this.style.color='white'" onmouseout="this.style.color='rgba(255,255,255,0.7)'" title="Instagram"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg></a>
        <a href="https://youtube.com/@maltaeventsguide" target="_blank" rel="noopener" style="color:rgba(255,255,255,0.7);display:flex;align-items:center;transition:0.2s" onmouseover="this.style.color='white'" onmouseout="this.style.color='rgba(255,255,255,0.7)'" title="YouTube"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
        <a href="https://www.tiktok.com/@malta.events.guid" target="_blank" rel="noopener" style="color:rgba(255,255,255,0.7);display:flex;align-items:center;transition:0.2s" onmouseover="this.style.color='white'" onmouseout="this.style.color='rgba(255,255,255,0.7)'" title="TikTok"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.73a8.19 8.19 0 004.76 1.52V6.79a4.84 4.84 0 01-1-.1z"/></svg></a>
      </div>
    </div>
    <div class="header-content">
      <h1>Malta Events Guide</h1>
      <div class="subtitle">Discover ${upcoming.length} events across Malta & Gozo</div>
    </div>
    <div class="search-box-wrapper">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" id="searchInput" placeholder="Search for concerts, festivals, nightlife..." onkeyup="filterEvents()">
      </div>
    </div>
  </header>

  <main>
  <div class="quick-filters">
    <button class="qf-btn" onclick="quickFilter('today',this)">🔥 Today</button>
    <button class="qf-btn" onclick="quickFilter('tomorrow',this)">📅 Tomorrow</button>
    <button class="qf-btn" onclick="quickFilter('weekend',this)">🎉 This Weekend</button>
    <button class="qf-btn" onclick="quickFilter('week',this)">📆 This Week</button>
    <button class="qf-btn" onclick="quickFilter('all',this)">All</button>
  </div>
  <div class="filter-bar">
    <select id="sourceSelect" onchange="filterEvents()" aria-label="Filter by source">
      <option value="">All Sources</option>
      ${sourceOptions}
    </select>
    <select id="categorySelect" onchange="filterEvents()" aria-label="Filter by event type">
      <option value="">All Types</option>
      ${categoryOptions}
    </select>
    <select id="monthSelect" onchange="filterEvents()" aria-label="Filter by month">
      <option value="">All Months</option>
      ${monthOptions}
    </select>
    <select id="showSelect" onchange="filterEvents()" aria-label="Filter upcoming or past events">
      <option value="upcoming">Upcoming Only</option>
      <option value="all">All Events</option>
      <option value="past">Past Only</option>
    </select>
    <button class="reset-btn" onclick="resetFilters()">Reset Filters</button>
    <span class="filter-count" id="filterCount">${upcoming.length} events</span>
  </div>

  ${render.renderFeaturedEvents(allEvents, generateSlug)}

  <div class="container" id="eventGrid">
    ${upcoming.map(e => render.createCard(e, false)).join('')}
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

      const countEl = document.getElementById('filterCount');
      if (visible === 0) {
        countEl.textContent = 'No events match your filters';
        countEl.style.color = '#ef4444';
      } else {
        countEl.textContent = visible + ' events shown';
        countEl.style.color = '';
      }
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
          match = inRange(todayStr) || recurMatch(today);
          // Extra safety for recurring
          if (!match && recur) {
            match = recurMatch(today);
          }
        } else if(mode==='tomorrow'){
          match = inRange(tomorrowStr) || recurMatch(tomorrow);
          // Extra safety: always check recurring for tomorrow as well
          if (!match && recur) {
            match = recurMatch(tomorrow);
          }
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
      const countEl = document.getElementById('filterCount');
      if (visible === 0) {
        countEl.textContent = 'No events match your filters';
        countEl.style.color = '#ef4444';
      } else {
        countEl.textContent = visible + ' events shown';
        countEl.style.color = '';
      }
    }
  </script>

  ${render.renderNewsletterBox()}

  <section style="max-width:900px;margin:60px auto 0;padding:0 20px;color:#334155;font-size:0.95rem;line-height:1.8">
    <h2 style="font-size:1.5rem;font-weight:800;color:#0f172a;margin:0 0 15px">Malta Events Summer 2026 — Your Complete Guide</h2>
    <p>Malta Event Guide is the most comprehensive events listing for the Maltese islands, with over 500 events updated daily. Whether you are a local looking for something to do this weekend or a tourist planning your summer holiday, we cover everything happening across Malta and Gozo — from live concerts and boat parties to village festas, pool parties, and nightlife in Paceville.</p>
    <p>We aggregate events from ShowsHappening, VisitMalta, Resident Advisor, EventWorks and local organisers so you never miss what is on. Every event includes the date, venue, category, and a direct link to buy tickets.</p>

    <h3 style="font-size:1.15rem;font-weight:700;color:#0f172a;margin:30px 0 10px">What Types of Events Can You Find?</h3>
    <p>Our guide covers <a href="/music-events-malta" style="color:#FF385C;text-decoration:underline">live music and concerts</a>, <a href="/nightlife-malta" style="color:#FF385C;text-decoration:underline">nightlife and club events</a>, <a href="/festivals-malta" style="color:#FF385C;text-decoration:underline">festivals</a>, <a href="/theatre-shows-malta" style="color:#FF385C;text-decoration:underline">theatre and shows</a>, <a href="/arts-culture-malta" style="color:#FF385C;text-decoration:underline">arts and culture</a>, <a href="/sports-events-malta" style="color:#FF385C;text-decoration:underline">sports and adventure</a>, <a href="/food-drink-events-malta" style="color:#FF385C;text-decoration:underline">food and drink experiences</a>, <a href="/family-events-malta" style="color:#FF385C;text-decoration:underline">family-friendly activities</a>, and <a href="/free-events-malta" style="color:#FF385C;text-decoration:underline">free events</a>. Use the filters above to narrow by category, date, or source.</p>

    <h3 style="font-size:1.15rem;font-weight:700;color:#0f172a;margin:30px 0 10px">Summer 2026 Highlights</h3>
    <p>Summer is the biggest season for events in Malta. Beach clubs like Cafe del Mar, Bora Bora and MedAsia Playa host pool parties and DJ events every weekend from June to September. Boat parties run regularly from Sliema and Bugibba, offering sunset cruises with live DJs. The Isle of MTV in Floriana is Malta's biggest free concert with international headliners. Village festas happen every weekend across different towns — expect fireworks, brass bands, and traditional street food. Gianpula Village and UNO in Rabat host open-air club nights with international DJs throughout the season.</p>

    <h3 style="font-size:1.15rem;font-weight:700;color:#0f172a;margin:30px 0 10px">Big Concerts Coming to Malta</h3>
    <p>Malta is attracting major international artists this summer. <a href="/event/scorpions-live-in-concert-4792" style="color:#FF385C;text-decoration:underline">Scorpions</a> are bringing their legendary rock show to the island. <a href="/event/pitbull-im-back-with-special-guest-lil-jon-2486" style="color:#FF385C;text-decoration:underline">Pitbull with special guest Lil Jon</a> is performing as part of his worldwide "I'm Back" tour. Bonnie Tyler, Kim Wilde, James Morrison, and Gabriel Iglesias have also performed or are scheduled in Malta this year — check our <a href="/music-events-malta" style="color:#FF385C;text-decoration:underline">Music Events page</a> for the full concert calendar and tickets.</p>

    <h3 style="font-size:1.15rem;font-weight:700;color:#0f172a;margin:30px 0 10px">Festivals in Malta 2026</h3>
    <p><a href="/event/earth-garden-festival-2026-3564" style="color:#FF385C;text-decoration:underline">Earth Garden Festival</a> at Ta' Qali National Park is Malta's largest alternative festival — five stages, 30,000 attendees, three days of world music, techno, reggae and psytrance. Bloom Festival brings international house and techno DJs to open-air venues. Glitch Festival, Lost & Found, and Annie Mac's festival have all made Malta a serious destination for electronic music. Browse our <a href="/festivals-malta" style="color:#FF385C;text-decoration:underline">Festivals page</a> for all upcoming dates.</p>

    <h3 style="font-size:1.15rem;font-weight:700;color:#0f172a;margin:30px 0 10px">Nightlife in Malta</h3>
    <p>Paceville in St Julian's is the heart of Malta's nightlife with dozens of bars and clubs open every night. Valletta's Strait Street offers cocktail bars and live music in a more refined setting. For the latest club nights, DJ events and party listings, check our <a href="/nightlife-malta" style="color:#FF385C;text-decoration:underline">Nightlife page</a> or read our <a href="/guide/malta-nightlife-guide" style="color:#FF385C;text-decoration:underline">Malta Nightlife Guide</a>.</p>

    <h3 style="font-size:1.15rem;font-weight:700;color:#0f172a;margin:30px 0 10px">How to Use Malta Event Guide</h3>
    <p>Search by keyword, filter by date or category, or browse our curated pages. Each event links directly to its official source for tickets. We also feature handpicked events at the top of the page. Use the newsletter signup form on this page to get the best events delivered to your inbox every Sunday. Bookmark us and check back regularly — new events are added every day.</p>

    <h3 style="font-size:1.15rem;font-weight:700;color:#0f172a;margin:30px 0 10px">Guides for Visitors and Locals</h3>
    <p>Planning your trip? Read our guides: <a href="/guide/how-to-find-events-in-malta" style="color:#FF385C;text-decoration:underline">How to Find Events in Malta Easily</a>, <a href="/guide/malta-nightlife-guide" style="color:#FF385C;text-decoration:underline">Malta Nightlife Guide 2026</a>, and <a href="/guide/things-to-do-malta-tourists" style="color:#FF385C;text-decoration:underline">Things to Do in Malta for Tourists</a>.</p>
  </section>

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

  </main>
  ${getFooterHTML()}
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Malta Event Guide",
    "url": "https://maltaeventguide.com",
    "description": "Your complete guide to events in Malta and Gozo",
    "logo": "https://maltaeventguide.com/logo.png",
    "sameAs": ["https://www.instagram.com/maltaeventguide/", "https://youtube.com/@maltaeventsguide", "https://www.tiktok.com/@malta.events.guid"],
    "areaServed": {
      "@type": "Country",
      "name": "Malta"
    }
  }
  </script>

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
    res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
    const slug = req.params.slug;
    const result = await pool.query('SELECT * FROM events WHERE slug = $1', [slug]);
    if (!result.rows.length) return res.status(410).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="robots" content="noindex">
<title>Event No Longer Available | Malta Event Guide</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;700&display=swap" rel="stylesheet">
<style>body{font-family:'Outfit',sans-serif;background:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}
.box{max-width:480px}.box h1{font-size:1.5rem;color:#1e293b;margin:0 0 10px}.box p{color:#64748b;line-height:1.6;margin:0 0 20px}
.box a{display:inline-block;background:#FF385C;color:white;padding:12px 28px;border-radius:12px;text-decoration:none;font-weight:700}</style>
</head><body><div class="box"><div style="font-size:3rem;margin-bottom:15px">📅</div>
<h1>This event is no longer available</h1>
<p>It may have ended or been removed. Browse our latest listings to find something new.</p>
<a href="/">Browse Events →</a></div></body></html>`);
    
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
    const startDate = dates.getStartDate(event.event_date);
    const endDate = dates.getEndDate(event.event_date);
    const startDateStr = startDate ? startDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const endDateStr = endDate ? endDate.toISOString().split('T')[0] : startDateStr;
    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "Event",
      "name": title,
      "description": event.description || desc,
      "startDate": startDateStr,
      "endDate": endDateStr,
      "eventStatus": "https://schema.org/EventScheduled",
      "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
      "location": {
        "@type": "Place",
        "name": loc,
        "address": { "@type": "PostalAddress", "addressCountry": "MT", "addressLocality": loc }
      },
      "organizer": {
        "@type": "Organization",
        "name": event.source_name || "Malta Event Guide",
        "url": "https://maltaeventguide.com"
      },
      "performer": {
        "@type": "PerformingGroup",
        "name": event.source_name || title
      }
    };
    // Extract price from description if available
    const descText = event.description || '';
    const priceMatch = descText.match(/(?:price|entry|ticket|cost|fee|admission)[:\s]*(?:€|EUR|eur)\s*(\d+(?:[.,]\d{2})?)/i)
      || descText.match(/(?:price|entry|ticket|cost|fee|admission)[:\s]*(\d+(?:[.,]\d{2})?)\s*(?:€|EUR|eur)/i)
      || descText.match(/(\d+(?:[.,]\d{2})?)\s*(?:€|EUR)\b/i)
      || descText.match(/(?:€|EUR)\s*(\d+(?:[.,]\d{2})?)/i);
    const priceVal = priceMatch ? priceMatch[1].replace(',', '.') : null;
    const isFree = /\bfree\b|\bfree entry\b|\bno charge\b|\bfree admission\b/i.test(descText);
    
    if (isFree || priceVal === '0') {
      jsonLd.offers = {
        "@type": "Offer",
        "url": externalUrl || ("https://maltaeventguide.com/event/" + slug),
        "price": "0",
        "priceCurrency": "EUR",
        "validFrom": startDateStr,
        "availability": "https://schema.org/InStock"
      };
    } else if (priceVal && parseFloat(priceVal) > 0) {
      jsonLd.offers = {
        "@type": "Offer",
        "url": externalUrl || ("https://maltaeventguide.com/event/" + slug),
        "price": priceVal,
        "priceCurrency": "EUR",
        "validFrom": startDateStr,
        "availability": "https://schema.org/InStock"
      };
    } else {
      // No price info — don't guess, just provide URL and availability
      jsonLd.offers = {
        "@type": "Offer",
        "url": externalUrl || ("https://maltaeventguide.com/event/" + slug),
        "validFrom": startDateStr,
        "availability": "https://schema.org/InStock"
      };
    }
    if (hasImg) jsonLd.image = img;

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
  <link rel="stylesheet" href="/styles.css">
  <style>
    /* Event-specific styles. Common rules moved to /styles.css */
    .wrapper { max-width:960px; margin:30px auto; padding:0 20px 40px; }

    .event-layout { display:grid; grid-template-columns:420px 1fr; gap:0; background:white; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); align-items:start; }

    .event-img { overflow:hidden; background:#f1f5f9; min-height:350px; }
    .event-img img { width:100%; min-height:350px; object-fit:cover; display:block; }
    .event-img .fallback { height:100%;min-height:350px;display:flex;align-items:center;justify-content:center;color:white;font-size:6rem;font-weight:800;background:#1e293b; }

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
    .desc p { margin:0 0 14px; }
    .desc p:last-child { margin-bottom:0; }
    .video-embed { position:relative; padding-bottom:56.25%; height:0; margin:18px 0; border-radius:12px; overflow:hidden; background:#000; }
    .video-embed iframe { position:absolute; top:0; left:0; width:100%; height:100%; border:0; }
    .ig-embed { margin:18px 0; border-radius:12px; overflow:hidden; max-width:400px; }
    .ig-embed iframe { width:100%; border:0; border-radius:12px; height:720px; }

    .cta { display:block; width:100%; padding:16px; background:#0f172a; color:white; text-align:center; border-radius:12px; font-weight:800; font-size:1.05rem; transition:0.3s; box-sizing:border-box; }
    .cta:hover { background:var(--primary); transform:translateY(-2px); box-shadow:0 8px 25px rgba(255,56,92,0.3); }

    .share-row { display:flex; gap:8px; margin-top:12px; }
    .share-btn { 
      flex:1; 
      padding:11px 12px; 
      border-radius:10px; 
      text-align:center; 
      font-size:0.82rem; 
      font-weight:600; 
      color:#1e293b; 
      background:#f1f5f9; 
      border:1px solid #e2e8f0;
      cursor:pointer; 
      transition:all 0.2s; 
    }
    .share-btn:hover { 
      background:#e2e8f0; 
      border-color:#cbd5e1; 
      transform: translateY(-1px);
    }
    .share-whatsapp { background:#dcfce7; border-color:#86efac; color:#166534; }
    .share-facebook { background:#dbeafe; border-color:#93c5fd; color:#1e40af; }
    .share-copy { background:#f1f5f9; }
    .share-calendar { background:#f1f5f9; }

    /* Make top nav more visible on event pages */
    body > div[style*="position:absolute;top:0;left:0;right:0;padding:18px"] {
      background: rgba(255,255,255,0.95);
      backdrop-filter: blur(8px);
    }



    .footer { margin-top:40px;padding:30px 20px;background:#1e293b;color:#94a3b8;text-align:center;font-size:0.8rem;line-height:1.8; }
    .footer a { color:#94a3b8; }

    @media (max-width:750px) {
      .event-layout { grid-template-columns:1fr; }
      .event-img { min-height:auto; }
      .event-img img { min-height:auto; object-fit:contain; max-height:450px; background:#f1f5f9; }
      .event-details { padding:24px; }
      h1 { font-size:1.4rem; }
      .wrapper { margin-top:15px; }
      .share-row { flex-wrap:wrap; }
      .share-btn { min-width:calc(50% - 6px); }
    }
  </style>
</head>
<body>
  ${getNavHTML({ backLink: true })}

  <div class="wrapper">
    <div class="event-layout">
      <div class="event-img">
        ${hasImg ? '<img src="' + img + '" alt="' + title.replace(/"/g, '&quot;') + ' event in ' + loc.replace(/"/g, '&quot;') + ', Malta" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' : ''}
        <div class="fallback" style="background:${bgStyle};${hasImg ? 'display:none;' : ''}">${firstLetter}</div>
      </div>
      <div class="event-details">
        <div class="source-badge">${source}</div>
        <h1>${title}</h1>
        <div class="info-grid">
          ${dateStr ? '<div class="info-row"><div class="info-icon date">📅</div><div><div class="info-label">' + dateStr + '</div></div></div>' : ''}
          <div class="info-row"><div class="info-icon loc">📍</div><div><div class="info-label"><a href="https://www.google.com/maps/search/${encodeURIComponent(loc + ', Malta')}" target="_blank" rel="noopener" style="color:#1e293b;text-decoration:underline;text-decoration-color:#cbd5e1;text-underline-offset:3px">${loc}</a></div></div></div>
          ${event.category ? '<div class="info-row"><div class="info-icon cat">' + (catEmojis[event.category]||'📌') + '</div><div><div class="info-label">' + event.category + '</div></div></div>' : ''}
          ${event.recurring ? '<div class="info-row"><div class="info-icon recur">🔁</div><div><div class="info-label">' + event.recurring + '</div></div></div>' : ''}
        </div>
        ${event.description ? '<div class="desc">' + event.description
          // Convert YouTube links to embeds (watch, youtu.be, shorts, embed)
          .replace(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})(?:[^\s]*)/g, '</p><div class="video-embed"><iframe src="https://www.youtube.com/embed/$1?rel=0" allowfullscreen loading="lazy"></iframe></div><p>')
          // Convert Vimeo links to embeds (vimeo.com/ID, vimeo.com/manage/videos/ID, vimeo.com/channels/xxx/ID, player.vimeo.com/video/ID)
          .replace(/(?:https?:\/\/)?(?:www\.)?(?:player\.)?vimeo\.com\/(?:manage\/videos\/|channels\/[\w]+\/|video\/)?(\d{6,})(?:[^\s]*)/g, '</p><div class="video-embed"><iframe src="https://player.vimeo.com/video/$1" allowfullscreen loading="lazy"></iframe></div><p>')
          // Convert Instagram reel/post/p links to embeds
          .replace(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|p|tv)\/([\w-]+)(?:[^\s]*)/g, '</p><div class="ig-embed" data-url="https://www.instagram.com/p/$1/embed"></div><p>')
          // Convert plain URLs to clickable links (skip already converted ones)
          .replace(/(?<!src="|href="|"|data-url=")(https?:\/\/[^\s<"]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:#FF385C;word-break:break-all">$1</a>')
          // Paragraphs and line breaks
          .replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>').replace(/$/, '</p>')
          // Clean up empty paragraphs
          .replace(/<p>\s*<\/p>/g, '')
          + '</div>' : ''}
        ${externalUrl ? '<a href="' + externalUrl + '" target="_blank" class="cta" onclick="fetch(\'/api/track\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({event_id:' + event.id + ',event_title:\'' + title.replace(/'/g, "\\'") + '\',source:\'' + source + '\'})})">View Event / Get Tickets →</a>' : '<a href="/" class="cta">← Browse More Events</a>'}
        <div class="share-row">
          <div class="share-btn share-calendar" onclick="addToCalendar()">Add to Calendar</div>
          <div class="share-btn share-whatsapp" onclick="window.open('https://wa.me/?text='+encodeURIComponent('${title.replace(/'/g, "\\'")} - https://maltaeventguide.com/event/${slug}'))">WhatsApp</div>
          <div class="share-btn share-facebook" onclick="window.open('https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent('https://maltaeventguide.com/event/${slug}'))">Facebook</div>
          <div class="share-btn share-copy" onclick="navigator.clipboard.writeText('https://maltaeventguide.com/event/${slug}');this.textContent='Copied!'">Copy Link</div>
        </div>
        <script>
        function addToCalendar(){
          var title=${JSON.stringify(title)};
          var loc=${JSON.stringify(loc)};
          var desc=${JSON.stringify((event.description||'').substring(0,300).replace(/\n/g,' '))}+'\\n\\nhttps://maltaeventguide.com/event/${slug}';
          var startDate=${startDate ? JSON.stringify(startDate.toISOString().split('T')[0].replace(/-/g,'')) : '"'+ new Date().toISOString().split('T')[0].replace(/-/g,'') +'"'};
          var endDate=${endDate ? JSON.stringify(endDate.toISOString().split('T')[0].replace(/-/g,'')) : 'startDate'};
          // Make end date the next day if same as start (all-day event)
          if(endDate===startDate){
            var d=new Date(startDate.substring(0,4)+'-'+startDate.substring(4,6)+'-'+startDate.substring(6,8));
            d.setDate(d.getDate()+1);
            endDate=d.toISOString().split('T')[0].replace(/-/g,'');
          }
          var ics=[
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Malta Event Guide//EN',
            'BEGIN:VEVENT',
            'DTSTART;VALUE=DATE:'+startDate,
            'DTEND;VALUE=DATE:'+endDate,
            'SUMMARY:'+title.replace(/[,;]/g,' '),
            'LOCATION:'+loc.replace(/[,;]/g,' ')+', Malta',
            'DESCRIPTION:'+desc.replace(/[,;\\n]/g,' ').substring(0,200),
            'URL:https://maltaeventguide.com/event/${slug}',
            'END:VEVENT',
            'END:VCALENDAR'
          ].join('\\r\\n');
          var blob=new Blob([ics],{type:'text/calendar;charset=utf-8'});
          var link=document.createElement('a');
          link.href=URL.createObjectURL(blob);
          link.download=title.replace(/[^a-zA-Z0-9]/g,'-').substring(0,40)+'.ics';
          link.click();
        }
        // Load Instagram embeds
        document.querySelectorAll('.ig-embed').forEach(function(el){
          var url=el.getAttribute('data-url');
          if(url){
            var iframe=document.createElement('iframe');
            iframe.src=url;
            iframe.setAttribute('allowfullscreen','true');
            iframe.setAttribute('loading','lazy');
            iframe.setAttribute('scrolling','no');
            el.appendChild(iframe);
          }
        });
        </script>
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

  ${getFooterHTML()}

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
    // Normalize source name
    let src = (source || '').trim();
    const srcLower = src.toLowerCase();
    if (srcLower.startsWith('showshappening')) src = 'ShowsHappening';
    else if (srcLower.startsWith('eventworks')) src = 'EventWorks';
    else if (srcLower.startsWith('visitmalta')) src = 'VisitMalta';
    else if (srcLower.startsWith('resident advisor')) src = 'Resident Advisor';
    else if (srcLower.startsWith('community events')) src = 'Community Events Malta';
    await pool.query(
      'INSERT INTO click_tracking (event_id, event_title, source, user_agent, referrer) VALUES ($1, $2, $3, $4, $5)',
      [event_id, event_title, src, req.headers['user-agent']||'', req.headers['referer']||'']
    );
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

// Email subscribe (public) — also syncs to Brevo
const BREVO_SMTP_KEY = process.env.BREVO_SMTP_KEY || '';
const BREVO_SENDER = process.env.BREVO_SENDER || 'hello@maltaeventguide.com';

app.post('/api/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@') || !email.includes('.')) return res.status(400).json({ error: 'Invalid email' });
    const cleanEmail = email.toLowerCase().trim();
    await pool.query(
      'INSERT INTO email_subscribers (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
      [cleanEmail]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to subscribe' }); }
});

// Unsubscribe endpoint
app.get('/unsubscribe', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (email) {
    try { await pool.query('DELETE FROM email_subscribers WHERE email = $1', [email]); } catch(e) {}
  }
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Unsubscribed</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;700&display=swap" rel="stylesheet">
  <style>body{font-family:'Outfit',sans-serif;background:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}
  .box{max-width:480px}.box h1{font-size:1.5rem;color:#1e293b}.box p{color:#64748b}
  .box a{color:#FF385C;text-decoration:underline}</style></head>
  <body><div class="box"><h1>You've been unsubscribed</h1><p>You won't receive any more emails from Malta Event Guide.</p><p><a href="/">Back to Events</a></p></div></body></html>`);
});

// All /admin/api/* routes have been moved to admin/api.js
// (see createAdminApi factory + router definitions)

// =====================================================================
// ADMIN PAGE (HTML shell served from admin/views.js)
// =====================================================================
app.get('/admin', (req, res) => {
  res.send(adminViews.getAdminHTML());
});

// Serve the concatenated admin JS bundle (core + all tabs + main)
// This was previously inline in the monolith and got lost during the admin/ extraction.
app.get('/admin/js', (req, res) => {
  res.type('application/javascript').send(adminViews.getAdminJS());
});



      





// All remaining /admin/api/* routes have been extracted to admin/api.js
// (Old inline definitions removed for structure)
// AUTO-CLEANUP: Delete past events daily
// =====================================================================
async function cleanupPastEvents() {
  try {
    const result = await pool.query("SELECT id, title, event_date, recurring FROM events WHERE COALESCE(status, 'live') = 'live'");
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    // Give 1 day grace period after event ends
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const toDelete = [];
    
    for (const event of result.rows) {
      // Skip recurring events — they repeat
      if (event.recurring) continue;
      // Skip events with no parseable date
      const endDate = dates.getEndDate(event.event_date);
      const startDate = dates.getStartDate(event.event_date);
      const eventEnd = endDate || startDate;
      if (!eventEnd) continue;
      // If event ended before cutoff, mark for deletion
      if (eventEnd < cutoff) {
        toDelete.push(event.id);
      }
    }
    
    if (toDelete.length > 0) {
      await pool.query('DELETE FROM events WHERE id = ANY($1)', [toDelete]);
      console.log(`[Cleanup] Deleted ${toDelete.length} past events`);
    } else {
      console.log('[Cleanup] No past events to delete');
    }
  } catch (e) {
    console.log('[Cleanup] Error:', e.message);
  }
}

// Run on server start (after 30 seconds) and then every 24 hours
setTimeout(cleanupPastEvents, 30000);
setInterval(cleanupPastEvents, 24 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
