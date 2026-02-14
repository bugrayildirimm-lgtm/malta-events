require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

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

  // "13 February 2026"
  let m = str.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m && monthToNum(m[2]) !== null) return new Date(+m[3], monthToNum(m[2]), +m[1]);

  // "2 Jul" (no year)
  m = str.match(/^(\d{1,2})\s+([A-Za-z]{3,})$/);
  if (m && monthToNum(m[2]) !== null) {
    const y = new Date().getFullYear();
    const d = new Date(y, monthToNum(m[2]), +m[1]);
    if (d < Date.now() - 60*86400000) d.setFullYear(y+1);
    return d;
  }

  // "24,25,26 Apr" → last day
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

// For ranges: use END date to decide past/future
function getEndDate(dateStr) {
  if (!dateStr || dateStr.includes('€') || dateStr.startsWith('Price')) return null;

  // "5 February 2026 - 1 March 2026"
  if (dateStr.includes(' - ')) {
    const parts = dateStr.split(' - ');
    return parseSingleDate(parts[1].trim()) || parseSingleDate(parts[0].trim());
  }

  // "Feb to May" or "14-Feb to 28-Mar"
  let mr = dateStr.match(/^(?:\d{1,2}[- ])?([A-Za-z]{3,})\s+to\s+(?:\d{1,2}[- ])?([A-Za-z]{3,})$/i);
  if (mr && monthToNum(mr[2]) !== null) {
    const y = new Date().getFullYear();
    const d = new Date(y, monthToNum(mr[2])+1, 0); // last day of end month
    if (d < Date.now() - 60*86400000) d.setFullYear(y+1);
    return d;
  }

  // "14-Feb to 28-Mar" with day numbers
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

// Check if a string looks like a date (not a real title)
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
  
  // Range: "5 February 2026 - 1 March 2026"
  if (dateStr.includes(' - ')) {
    const parts = dateStr.split(' - ');
    const s = extractDM(parts[0].trim());
    const e = extractDM(parts[1].trim());
    if (s && e) {
      if (s.month === e.month) return badge(s.month, `${s.day}-${e.day}`);
      return badge(`${s.month}→${e.month}`, `${s.day}→${e.day}`);
    }
  }

  // "14-Feb to 28-Mar" or "Feb to May"
  let mr = dateStr.match(/(?:(\d{1,2})[- ])?([A-Za-z]{3,})\s+to\s+(?:(\d{1,2})[- ])?([A-Za-z]{3,})/i);
  if (mr) {
    const m1 = (mr[2]||'').substring(0,3).toUpperCase();
    const m2 = (mr[4]||'').substring(0,3).toUpperCase();
    const d1 = mr[1] || '';
    const d2 = mr[3] || '';
    if (d1 && d2) return badge(`${m1}→${m2}`, `${d1}→${d2}`);
    return badge(`${m1}→${m2}`, 'Ongoing');
  }

  // "24,25,26 Apr"
  const multiDay = dateStr.match(/^([\d,\s]+)\s+([A-Za-z]{3,})$/);
  if (multiDay) {
    const days = multiDay[1].split(',').map(d=>d.trim()).filter(d=>d);
    const month = multiDay[2].substring(0,3).toUpperCase();
    return badge(month, days.length > 2 ? `${days[0]}-${days[days.length-1]}` : days.join(','));
  }

  // Single: "2 Jul" or "13 February 2026"
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
  return `<div class="date-badge"><div class="date-month">${top}</div><div class="date-day">${bottom}</div></div>`;
}


// =====================================================================
// CARD BUILDER
// =====================================================================
const createCard = (event, isPast) => {
    let source = 'Unknown';
    if (event.source_url.includes('showshappening')) source = 'ShowsHappening';
    else if (event.source_url.includes('visitmalta')) source = 'VisitMalta';

    // SAFETY: If title looks like a date, try to extract real title from URL
    let title = event.title || '';
    if (looksLikeDate(title) || title.startsWith('Price:') || title.includes('€')) {
      // Extract from URL slug as fallback
      const parts = event.source_url.split('/');
      const slug = parts[parts.length - 1] || parts[parts.length - 2] || '';
      if (slug && slug.length > 3) {
        title = decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
      }
      // If the old title was actually a date, use it as event_date
      if (looksLikeDate(event.title) && !event.event_date) {
        event.event_date = event.title;
      }
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

    // Show date range as text under title
    const hasRange = event.event_date && (event.event_date.includes(' - ') || /to/i.test(event.event_date));
    const dateInfo = hasRange ? `<div class="date-range-text">📅 ${event.event_date}</div>` : '';

    if (!desc) desc = 'Click details to see more about this event.';

    const loc = event.location && event.location !== 'Malta' ? event.location : '';
    const locHTML = loc ? `<div class="location">📍 ${loc}</div>` : '';

    const gray = isPast ? 'past-event' : '';
    const expired = isPast ? '<div class="expired-label">PAST EVENT</div>' : '';
    const hasImg = event.image_url && !event.image_url.includes('/api/v2/file/');

    return `
    <div class="card event-item ${gray}">
        <div class="card-media">
            ${dateHTML} ${expired}
            <div class="fallback" style="background: ${bgStyle}; position:absolute;top:0;left:0;z-index:1;">${firstLetter}</div>
            ${hasImg ? `<img src="${event.image_url}" class="card-img" style="position:relative;z-index:2;" onerror="this.style.display='none'">` : ''}
        </div>
        <div class="card-content">
            <div class="source-tag">${source}</div>
            <div class="title">${title}</div>
            ${locHTML}
            ${dateInfo}
            <div class="description">${desc}</div>
            <a href="${event.source_url}" target="_blank" class="btn">Details</a>
        </div>
    </div>`;
};


// =====================================================================
// MAIN ROUTE
// =====================================================================
app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events');
    const allEvents = result.rows;
    const today = new Date(); today.setHours(0,0,0,0);

    let upcoming = [], past = [];

    allEvents.forEach(event => {
        const endDate = getEndDate(event.event_date);
        const startDate = getStartDate(event.event_date);
        if (!endDate || endDate >= today) {
          // For sorting upcoming: use start date, but if start is in the past
          // (ongoing event), treat it as "happening now" (sort near top)
          let sortDate = startDate;
          if (startDate && startDate < today) {
            // Ongoing event — sort by today so it appears at the top
            sortDate = new Date(today);
          }
          upcoming.push({ ...event, _sort: sortDate });
        } else {
          past.push({ ...event, _sort: endDate });
        }
    });

    // Upcoming: soonest first, no-date events at the end
    upcoming.sort((a,b) => {
      if (!a._sort && !b._sort) return 0;
      if (!a._sort) return 1;  // no date → end
      if (!b._sort) return -1; // no date → end
      return a._sort - b._sort;
    });

    // Past: most recently ended first
    past.sort((a,b) => {
      if (!a._sort && !b._sort) return 0;
      if (!a._sort) return 1;
      if (!b._sort) return -1;
      return b._sort - a._sort;
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Malta Events | Discover</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
    input { width:100%; padding:20px 25px 20px 55px; border-radius:50px; border:none; background:rgba(255,255,255,0.98); font-family:inherit; font-size:1.1rem; box-sizing:border-box; transition:0.3s; }
    input:focus { outline:none; transform:scale(1.02); }
    .search-icon { position:absolute; left:25px; top:50%; transform:translateY(-50%); opacity:0.5; font-size:1.2rem; }

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
    .event-count { text-align:center; color:#94a3b8; font-size:0.9rem; margin-bottom:30px; }
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

  <div class="event-count">${upcoming.length} upcoming · ${past.length} past events</div>

  <div class="container" id="eventGrid">
    ${upcoming.map(e => createCard(e, false)).join('')}
    ${past.length > 0 ? `<div class="separator">Past Events Archive</div>${past.map(e => createCard(e, true)).join('')}` : ''}
  </div>

  <script>
    function filterEvents() {
      const q = document.getElementById('searchInput').value.toLowerCase();
      const cards = document.getElementsByClassName('event-item');
      for (let i = 0; i < cards.length; i++) {
        cards[i].classList.toggle('hidden', !cards[i].innerText.toLowerCase().includes(q));
      }
    }
  </script>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    res.status(500).send("Database error: " + err.message);
  }
});

// =====================================================================
// ADMIN PAGE - Manage event images
// =====================================================================
app.use(express.json());

// Simple auth - change this password!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'malta2026';

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
    .login-box button { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #FF385C; color: white; font-size: 1rem; font-weight: 700; cursor: pointer; font-family: inherit; }
    .login-box button:hover { background: #e11d48; }
    
    .admin-panel { display: none; }
    .admin-header { background: #1e293b; padding: 20px 30px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; position: sticky; top: 0; z-index: 100; }
    .admin-header h1 { font-size: 1.5rem; }
    .admin-header .stats { color: #94a3b8; font-size: 0.9rem; }
    .admin-header a { color: #FF385C; text-decoration: none; font-weight: 600; }
    
    .filters { background: #1e293b; padding: 15px 30px; display: flex; gap: 10px; align-items: center; border-bottom: 1px solid #334155; flex-wrap: wrap; }
    .filters input, .filters select { padding: 8px 14px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; font-family: inherit; font-size: 0.9rem; }
    .filters input { flex: 1; min-width: 200px; }
    .filter-btn { padding: 8px 16px; border-radius: 8px; border: 1px solid #334155; background: transparent; color: #94a3b8; cursor: pointer; font-family: inherit; font-size: 0.85rem; transition: 0.2s; }
    .filter-btn:hover, .filter-btn.active { background: #FF385C; color: white; border-color: #FF385C; }
    
    .events-grid { padding: 20px 30px; display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px; }
    
    .event-card { background: #1e293b; border-radius: 12px; overflow: hidden; border: 1px solid #334155; transition: 0.2s; }
    .event-card:hover { border-color: #475569; }
    .event-card.has-image { opacity: 0.6; }
    .event-card.has-image:hover { opacity: 1; }
    
    .event-preview { height: 140px; position: relative; background: #334155; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    .event-preview img { width: 100%; height: 100%; object-fit: cover; }
    .event-preview .no-img { color: #64748b; font-size: 0.85rem; }
    .event-preview .badge { position: absolute; top: 8px; right: 8px; padding: 3px 10px; border-radius: 20px; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; }
    .badge.missing { background: #ef4444; color: white; }
    .badge.has { background: #22c55e; color: white; }
    
    .event-info { padding: 15px; }
    .event-info .source { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-bottom: 5px; }
    .event-info .title { font-size: 1rem; font-weight: 700; margin-bottom: 5px; color: #f1f5f9; line-height: 1.3; }
    .event-info .date { font-size: 0.8rem; color: #94a3b8; margin-bottom: 10px; }
    
    .image-input { display: flex; gap: 8px; padding: 0 15px 15px; }
    .image-input input { flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; font-size: 0.85rem; font-family: inherit; }
    .image-input input:focus { outline: none; border-color: #FF385C; }
    .image-input button { padding: 8px 16px; border-radius: 8px; border: none; background: #FF385C; color: white; font-weight: 700; cursor: pointer; font-size: 0.85rem; font-family: inherit; white-space: nowrap; }
    .image-input button:hover { background: #e11d48; }
    .image-input button:disabled { background: #334155; cursor: not-allowed; }
    
    .image-actions { padding: 0 15px 15px; display: flex; gap: 8px; }
    .image-actions button { padding: 6px 12px; border-radius: 6px; border: 1px solid #334155; background: transparent; color: #94a3b8; cursor: pointer; font-size: 0.75rem; font-family: inherit; }
    .image-actions button:hover { background: #334155; color: white; }
    .image-actions .delete-btn:hover { background: #ef4444; border-color: #ef4444; color: white; }
    
    .toast { position: fixed; bottom: 30px; right: 30px; background: #22c55e; color: white; padding: 12px 24px; border-radius: 10px; font-weight: 600; display: none; z-index: 1000; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
    .toast.error { background: #ef4444; }
    .toast.show { display: block; animation: slideIn 0.3s ease; }
    @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    
    .count-bar { padding: 10px 30px; background: #1e293b; border-bottom: 1px solid #334155; font-size: 0.85rem; color: #94a3b8; }
    .count-bar span { color: #FF385C; font-weight: 700; }
  </style>
</head>
<body>
  <div class="login-screen" id="loginScreen">
    <div class="login-box">
      <h2>🔐 Admin Login</h2>
      <input type="password" id="passwordInput" placeholder="Enter admin password" onkeydown="if(event.key==='Enter')doLogin()">
      <button onclick="doLogin()">Login</button>
    </div>
  </div>

  <div class="admin-panel" id="adminPanel">
    <div class="admin-header">
      <div>
        <h1>🎛️ Event Image Manager</h1>
        <div class="stats" id="statsText">Loading...</div>
      </div>
      <a href="/">← Back to site</a>
    </div>
    
    <div class="filters">
      <input type="text" id="searchFilter" placeholder="🔍 Search events..." oninput="applyFilters()">
      <select id="sourceFilter" onchange="applyFilters()">
        <option value="all">All sources</option>
        <option value="showshappening">ShowsHappening</option>
        <option value="visitmalta">VisitMalta</option>
      </select>
      <button class="filter-btn active" onclick="setImageFilter('missing', this)">Missing images</button>
      <button class="filter-btn" onclick="setImageFilter('has', this)">Has images</button>
      <button class="filter-btn" onclick="setImageFilter('all', this)">All events</button>
    </div>
    
    <div class="count-bar" id="countBar">Loading events...</div>
    <div class="events-grid" id="eventsGrid"></div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    let allEvents = [];
    let imageFilter = 'missing';
    let authToken = '';

    function doLogin() {
      authToken = document.getElementById('passwordInput').value;
      fetch('/admin/api/events', { headers: { 'Authorization': authToken } })
        .then(r => { if (!r.ok) throw new Error('Wrong password'); return r.json(); })
        .then(data => {
          allEvents = data;
          document.getElementById('loginScreen').style.display = 'none';
          document.getElementById('adminPanel').style.display = 'block';
          updateStats();
          applyFilters();
        })
        .catch(() => showToast('Wrong password!', true));
    }

    function updateStats() {
      const missing = allEvents.filter(e => !hasValidImage(e)).length;
      const total = allEvents.length;
      document.getElementById('statsText').textContent = total + ' total events · ' + missing + ' missing images';
    }

    function hasValidImage(e) {
      return e.image_url && !e.image_url.includes('/api/v2/file/') && e.image_url.startsWith('http');
    }

    function setImageFilter(filter, btn) {
      imageFilter = filter;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilters();
    }

    function applyFilters() {
      const search = document.getElementById('searchFilter').value.toLowerCase();
      const source = document.getElementById('sourceFilter').value;
      
      let filtered = allEvents.filter(e => {
        if (search && !e.title.toLowerCase().includes(search) && !(e.event_date||'').toLowerCase().includes(search)) return false;
        if (source !== 'all' && !e.source_url.includes(source)) return false;
        if (imageFilter === 'missing' && hasValidImage(e)) return false;
        if (imageFilter === 'has' && !hasValidImage(e)) return false;
        return true;
      });

      document.getElementById('countBar').innerHTML = 'Showing <span>' + filtered.length + '</span> events';
      renderEvents(filtered);
    }

    function renderEvents(events) {
      const grid = document.getElementById('eventsGrid');
      grid.innerHTML = events.map(e => {
        const hasImg = hasValidImage(e);
        const source = e.source_url.includes('showshappening') ? 'ShowsHappening' : 
                       e.source_url.includes('visitmalta') ? 'VisitMalta' : 'Unknown';
        return '<div class="event-card ' + (hasImg ? 'has-image' : '') + '" data-id="' + e.id + '">' +
          '<div class="event-preview">' +
            (hasImg ? '<img src="' + e.image_url + '" onerror="this.parentElement.innerHTML=\\'<div class=no-img>Image broken</div>\\';">' : '<div class="no-img">No image</div>') +
            '<div class="badge ' + (hasImg ? 'has' : 'missing') + '">' + (hasImg ? '✓ Has image' : '✗ No image') + '</div>' +
          '</div>' +
          '<div class="event-info">' +
            '<div class="source">' + source + '</div>' +
            '<div class="title">' + e.title + '</div>' +
            '<div class="date">' + (e.event_date || 'No date') + ' · <a href="' + e.source_url + '" target="_blank" style="color:#FF385C;">View event ↗</a></div>' +
          '</div>' +
          '<div class="image-input">' +
            '<input type="text" id="img-' + e.id + '" placeholder="Paste image URL..." value="' + (hasImg ? e.image_url : '') + '">' +
            '<button onclick="saveImage(' + e.id + ')">Save</button>' +
          '</div>' +
          (hasImg ? '<div class="image-actions"><button class="delete-btn" onclick="removeImage(' + e.id + ')">Remove image</button></div>' : '') +
        '</div>';
      }).join('');
    }

    function saveImage(id) {
      const input = document.getElementById('img-' + id);
      const url = input.value.trim();
      if (!url) return showToast('Please paste an image URL first', true);
      if (!url.startsWith('http')) return showToast('URL must start with http', true);

      fetch('/admin/api/events/' + id + '/image', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': authToken },
        body: JSON.stringify({ image_url: url })
      })
      .then(r => { if (!r.ok) throw new Error('Failed'); return r.json(); })
      .then(() => {
        const evt = allEvents.find(e => e.id === id);
        if (evt) evt.image_url = url;
        updateStats();
        applyFilters();
        showToast('Image saved! ✓');
      })
      .catch(() => showToast('Failed to save', true));
    }

    function removeImage(id) {
      if (!confirm('Remove this image?')) return;
      fetch('/admin/api/events/' + id + '/image', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': authToken },
        body: JSON.stringify({ image_url: null })
      })
      .then(r => { if (!r.ok) throw new Error('Failed'); return r.json(); })
      .then(() => {
        const evt = allEvents.find(e => e.id === id);
        if (evt) evt.image_url = null;
        updateStats();
        applyFilters();
        showToast('Image removed');
      })
      .catch(() => showToast('Failed to remove', true));
    }

    function showToast(msg, isError) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => t.className = 'toast', 3000);
    }
  </script>
</body>
</html>`);
});

// Admin API - Get all events
app.get('/admin/api/events', (req, res) => {
  if (req.headers.authorization !== (process.env.ADMIN_PASSWORD || 'malta2026')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  pool.query('SELECT id, title, source_url, image_url, event_date, location, description FROM events ORDER BY title')
    .then(r => res.json(r.rows))
    .catch(e => res.status(500).json({ error: e.message }));
});

// Admin API - Update event image
app.put('/admin/api/events/:id/image', (req, res) => {
  if (req.headers.authorization !== (process.env.ADMIN_PASSWORD || 'malta2026')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { image_url } = req.body;
  pool.query('UPDATE events SET image_url = $1 WHERE id = $2', [image_url, req.params.id])
    .then(() => res.json({ success: true }))
    .catch(e => res.status(500).json({ error: e.message }));
});

app.listen(3000, () => console.log('Server running at http://localhost:3000'));
