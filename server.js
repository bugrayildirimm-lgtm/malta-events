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
    let source = 'Manual';
    if (event.source_url && event.source_url.includes('showshappening')) source = 'ShowsHappening';
    else if (event.source_url && event.source_url.includes('visitmalta')) source = 'VisitMalta';

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
    if (!desc) desc = 'Click details to see more about this event.';
    const loc = event.location && event.location !== 'Malta' ? event.location : '';
    const locHTML = loc ? '<div class="location">📍 ' + loc + '</div>' : '';
    const gray = isPast ? 'past-event' : '';
    const expired = isPast ? '<div class="expired-label">PAST EVENT</div>' : '';
    const hasImg = event.image_url && !event.image_url.includes('/api/v2/file/');
    const sourceLower = source.toLowerCase().replace(/\s+/g, '');
    const safeTitle = (title||'').replace(/'/g, "\\'").replace(/"/g, '&quot;');

    return `
    <div class="card event-item ${gray}" data-source="${sourceLower}" data-location="${(event.location||'malta').toLowerCase()}" data-category="${(event.category||'').toLowerCase()}">
        <div class="card-media">
            ${dateHTML} ${expired}
            <div class="fallback" style="background: ${bgStyle}; position:absolute;top:0;left:0;z-index:1;">${firstLetter}</div>
            ${hasImg ? '<img src="' + event.image_url + '" class="card-img" style="position:relative;z-index:2;" onerror="this.hidden=1">' : ''}
        </div>
        <div class="card-content">
            <div class="source-tag">${source}</div>
            <div class="title">${title}</div>
            ${locHTML}
            ${dateInfo}
            <div class="description">${desc}</div>
            <a href="${event.source_url || '#'}" target="_blank" class="btn" onclick="trackClick(${event.id},'${safeTitle}','${source}')">Details</a>
        </div>
    </div>`;
};


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

    // Collect unique sources and locations for filters
    const sources = new Set();
    const locations = new Set();
    const categories = new Set();

    let upcoming = [], past = [];

    allEvents.forEach(event => {
        if (!event.event_date && looksLikeDate(event.title)) event.event_date = event.title;
    });

    allEvents.forEach(event => {
        // Collect filter data
        if (event.source_url && event.source_url.includes('showshappening')) sources.add('ShowsHappening');
        else if (event.source_url && event.source_url.includes('visitmalta')) sources.add('VisitMalta');
        else sources.add('Manual');
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
      if (!a._sort && !b._sort) return 0;
      if (!a._sort) return 1;
      if (!b._sort) return -1;
      return a._sort - b._sort;
    });
    past.sort((a,b) => {
      if (!a._sort && !b._sort) return 0;
      if (!a._sort) return 1;
      if (!b._sort) return -1;
      return b._sort - a._sort;
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
    const categoryOptions = Array.from(categories).sort().map(c => '<option value="' + c.toLowerCase() + '">' + c + '</option>').join('');

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
    .search-box input { width:100%; padding:20px 25px 20px 55px; border-radius:50px; border:none; background:rgba(255,255,255,0.98); font-family:inherit; font-size:1.1rem; box-sizing:border-box; transition:0.3s; }
    .search-box input:focus { outline:none; transform:scale(1.02); }
    .search-icon { position:absolute; left:25px; top:50%; transform:translateY(-50%); opacity:0.5; font-size:1.2rem; }

    .filter-bar { max-width:1200px; margin:0 auto 25px; padding:0 20px; display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .filter-bar select { padding:10px 16px; border-radius:25px; border:1px solid #e2e8f0; background:white; font-family:inherit; font-size:0.9rem; color:#1e293b; cursor:pointer; appearance:none; -webkit-appearance:none; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2364748b' d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right 12px center; padding-right:35px; }
    .filter-bar select:focus { outline:none; border-color:var(--primary); }
    .filter-bar .reset-btn { padding:10px 18px; border-radius:25px; border:1px solid #e2e8f0; background:white; font-family:inherit; font-size:0.85rem; color:#64748b; cursor:pointer; transition:0.2s; }
    .filter-bar .reset-btn:hover { background:#f1f5f9; color:var(--primary); border-color:var(--primary); }
    .filter-bar .filter-count { font-size:0.85rem; color:#94a3b8; }

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
  </script>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    res.status(500).send("Database error: " + err.message);
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

    <!-- ADD EVENT TAB -->
    <div id="addTab" style="display:none">
      <div class="add-form">
        <h3>➕ Add New Event</h3>
        <div class="form-group"><label>Event Title <span class="req">*</span></label><input type="text" id="ae_title" placeholder="e.g. Jazz Night at Valletta"></div>
        <div class="form-group"><label>Event Date <span class="req">*</span></label><input type="text" id="ae_date" placeholder="e.g. 14 Feb or 20,21 Mar or Feb to May"><div class="hint">Use formats: 14 Feb · 20,21 Feb · Feb to May · 14 Feb to 28 Mar</div></div>
        <div class="form-group"><label>Location <span class="req">*</span></label><input type="text" id="ae_loc" placeholder="e.g. Mediterranean Conference Centre, Valletta"></div>
        <div class="form-group"><label>Category <span class="req">*</span></label><select id="ae_cat" style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;font-family:inherit;font-size:0.9rem"><option value="">Select category...</option><option value="Music & Concerts">🎵 Music & Concerts</option><option value="Theatre & Shows">🎭 Theatre & Shows</option><option value="Dance">💃 Dance</option><option value="Nightlife & Parties">🎉 Nightlife & Parties</option><option value="Festivals">🎪 Festivals</option><option value="Arts & Culture">🎨 Arts & Culture</option><option value="Sports & Adventure">🏃 Sports & Adventure</option><option value="Food & Drink">🍷 Food & Drink</option><option value="Family">👨‍👩‍👧 Family</option><option value="Religious">⛪ Religious</option><option value="Conference">📋 Conference</option><option value="Other">📌 Other</option></select></div>
        <div class="form-group"><label>Image URL</label><input type="text" id="ae_img" placeholder="https://..."><div class="hint">Paste a direct link to the event image (right-click image → Copy image address)</div></div>
        <div class="form-group"><label>Event/Ticket URL</label><input type="text" id="ae_url" placeholder="https://... link to event page or ticket sales"></div>
        <div class="form-group"><label>Description</label><textarea id="ae_desc" placeholder="Brief description of the event..."></textarea></div>
        <button class="form-btn" onclick="addEvent()">Add Event</button>
      </div>
    </div>

    <!-- ANALYTICS TAB -->
    <div id="analyticsTab" style="display:none">
      <div class="analytics">
        <h3>📊 Click Analytics</h3>
        <div class="stat-cards" id="statCards">Loading...</div>
        <h3 style="margin-top:20px">Top Clicked Events</h3>
        <table class="click-table" id="clickTable"><thead><tr><th>Event</th><th>Source</th><th>Clicks</th></tr></thead><tbody id="clickBody"><tr><td colspan="3" style="color:#64748b">Loading...</td></tr></tbody></table>
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
  ['imagesTab','datesTab','categoriesTab','addTab','analyticsTab'].forEach(function(id){document.getElementById(id).style.display='none'});
  var map={images:'imagesTab',dates:'datesTab',categories:'categoriesTab',add:'addTab',analytics:'analyticsTab'};
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
    return '<div class="ec'+(h?' dim':'')+'"><div class="ep">'+(h?'<img src="'+esc(e.image_url)+'" onerror="this.hidden=1">':'<div class="ni">No image<\\/div>')+'<div class="bdg '+(h?'ok':'miss')+'">'+(h?'\\u2713':'\\u2717')+'<\\/div><\\/div><div class="ei"><div class="src">'+s+'<\\/div><div class="ttl">'+esc(e.title)+'<\\/div><div class="mt">'+esc(e.event_date||'No date')+' \\u00b7 <a href="'+esc(e.source_url)+'" target="_blank">View \\u2197<\\/a><\\/div><\\/div><div class="fr"><input id="img-'+e.id+'" placeholder="Paste image URL..." value="'+esc(h?e.image_url:'')+'"><button onclick="si('+e.id+')">Save<\\/button><\\/div>'+(h?'<div class="fa"><button class="del" onclick="rmi('+e.id+')">Remove<\\/button><\\/div>':'')+'<\\/div>';
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
    return '<div class="ec'+(hd?' dim':'')+'"><div class="ep">'+(h?'<img src="'+esc(e.image_url)+'" onerror="this.hidden=1">':'<div class="ni">No img<\\/div>')+'<div class="bdg '+(hd?'ok':'warn')+'">'+(hd?'\\u2713 '+esc(e.event_date):'\\u2717 No date')+'<\\/div><\\/div><div class="ei"><div class="src">'+s+'<\\/div><div class="ttl">'+esc(e.title)+'<\\/div><div class="mt"><a href="'+esc(e.source_url||'#')+'" target="_blank">View event \\u2197<\\/a><\\/div><\\/div><div class="fr"><input id="dt-'+e.id+'" placeholder="e.g. 14 Feb or 20,21 Mar" value="'+esc(e.event_date||'')+'"><button onclick="sd('+e.id+')">Save<\\/button><\\/div><div class="dh"><div class="dh-t">Quick formats:<\\/div><div class="dc"><span class="chip" onclick="sdv('+e.id+',\\x2714 Feb\\x27)">14 Feb<\\/span><span class="chip" onclick="sdv('+e.id+',\\x2720,21 Mar\\x27)">20,21 Mar<\\/span><span class="chip" onclick="sdv('+e.id+',\\x27Feb to May\\x27)">Feb to May<\\/span><span class="chip" onclick="sdv('+e.id+',\\x2714 Feb to 28 Mar\\x27)">14 Feb to 28 Mar<\\/span><\\/div><\\/div>'+(hd?'<div class="fa"><button class="del" onclick="rmd('+e.id+')">Clear<\\/button><\\/div>':'')+'<\\/div>';
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
    return '<div class="ec'+(e.category?' dim':'')+'"><div class="ep">'+(h?'<img src="'+esc(e.image_url)+'" onerror="this.hidden=1">':'<div class="ni">No img<\\/div>')+'<div class="bdg '+(e.category?'ok':'warn')+'">'+(e.category||'No category')+'<\\/div><\\/div><div class="ei"><div class="src">'+s+'<\\/div><div class="ttl">'+esc(e.title)+'<\\/div><div class="mt">'+esc(e.event_date||'No date')+'<\\/div><\\/div><div class="fr"><select id="cat-'+e.id+'" style="flex:1;padding:8px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;font-family:inherit;font-size:0.8rem">'+selCats+'<\\/select><button onclick="sc('+e.id+')">Save<\\/button><\\/div><\\/div>';
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
  var url=document.getElementById('ae_url').value.trim()||null;
  var desc=document.getElementById('ae_desc').value.trim()||null;
  if(!title)return toast('Title is required',1);
  if(!date)return toast('Date is required',1);
  if(!loc)return toast('Location is required',1);
  if(!cat)return toast('Category is required',1);
  api('POST','/admin/api/events',{title:title,event_date:date,location:loc,category:cat,image_url:img,source_url:url,description:desc},function(d){
    E.push(d.event);us();toast('Event added! \\u2713');
    ['ae_title','ae_date','ae_loc','ae_img','ae_url','ae_desc'].forEach(function(id){document.getElementById(id).value=''});
    document.getElementById('ae_cat').value='';
  });
}
function loadAnalytics(){
  fetch('/admin/api/analytics',{headers:{Authorization:auth}})
    .then(function(r){return r.json()})
    .then(function(d){
      document.getElementById('statCards').innerHTML=
        '<div class="sc"><div class="num">'+d.total_clicks+'<\\/div><div class="lbl">Total Clicks<\\/div><\\/div>'+
        '<div class="sc"><div class="num">'+d.today_clicks+'<\\/div><div class="lbl">Today<\\/div><\\/div>'+
        '<div class="sc"><div class="num">'+d.week_clicks+'<\\/div><div class="lbl">This Week<\\/div><\\/div>'+
        '<div class="sc"><div class="num">'+d.unique_events+'<\\/div><div class="lbl">Unique Events<\\/div><\\/div>';
      document.getElementById('clickBody').innerHTML=d.top_events.map(function(e){
        return '<tr><td>'+e.event_title+'<\\/td><td>'+e.source+'<\\/td><td><strong>'+e.clicks+'<\\/strong><\\/td><\\/tr>';
      }).join('')||'<tr><td colspan="3" style="color:#64748b">No clicks yet<\\/td><\\/tr>';
    }).catch(function(){});
}
function getSource(e){
  if(!e.source_url)return 'manual';
  if(e.source_url.indexOf('showshappening')>-1)return 'showshappening';
  if(e.source_url.indexOf('visitmalta')>-1)return 'visitmalta';
  return 'manual';
}
function getSrc(e){var s=getSource(e);return s==='showshappening'?'ShowsHappening':s==='visitmalta'?'VisitMalta':'Manual'}
function ue(id,f,v){var e=E.find(function(x){return x.id===id});if(e)e[f]=v;us();if(tab==='images')af1();else if(tab==='dates')af2();else if(tab==='categories')af3()}
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
      result = await pool.query('SELECT id, title, source_url, image_url, event_date, location, description, category FROM events ORDER BY title');
    } catch (e) {
      // category column might not exist yet
      result = await pool.query('SELECT id, title, source_url, image_url, event_date, location, description FROM events ORDER BY title');
      result.rows = result.rows.map(r => ({ ...r, category: null }));
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
    const { title, event_date, location, image_url, source_url, description, category } = req.body;
    if (!title || !event_date || !location) return res.status(400).json({ error: 'Title, date, and location are required' });
    let result;
    try {
      result = await pool.query(
        'INSERT INTO events (title, event_date, location, image_url, source_url, description, category) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [title, event_date, location || 'Malta', image_url || null, source_url || 'manual://added', description || null, category || null]
      );
    } catch (e) {
      // category column might not exist
      result = await pool.query(
        'INSERT INTO events (title, event_date, location, image_url, source_url, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [title, event_date, location || 'Malta', image_url || null, source_url || 'manual://added', description || null]
      );
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
    const unique = await pool.query('SELECT COUNT(DISTINCT event_id) as c FROM click_tracking');
    const top = await pool.query('SELECT event_title, source, COUNT(*) as clicks FROM click_tracking GROUP BY event_title, source ORDER BY clicks DESC LIMIT 20');
    res.json({
      total_clicks: total.rows[0].c,
      today_clicks: today.rows[0].c,
      week_clicks: week.rows[0].c,
      unique_events: unique.rows[0].c,
      top_events: top.rows
    });
  } catch (e) { res.json({ total_clicks: 0, today_clicks: 0, week_clicks: 0, unique_events: 0, top_events: [] }); }
});

app.listen(3000, () => console.log('Server running at http://localhost:3000'));
