require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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
  
  // Strip day names: "Saturday, 21 February 2026" -> "21 February 2026"
  str = str.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[,.\s]*/i, '');
  // Strip time: "21 Feb 2026 at 20:30" or "21 Feb 2026 19:00"
  str = str.replace(/\s+at\s+\d{1,2}[:.]\d{2}.*/i, '');
  str = str.replace(/\s+\d{1,2}[:.]\d{2}\s*(AM|PM|am|pm)?.*$/, '');
  // Strip ordinal suffixes: "21st" -> "21"
  str = str.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
  // Normalize separators: "21-Feb-2026" -> "21 Feb 2026"
  str = str.replace(/(\d+)[-/]([A-Za-z])/g, '$1 $2');
  str = str.replace(/([A-Za-z])[-/](\d)/g, '$1 $2');
  str = str.trim();
  
  const autoYear = (d) => { if (d < Date.now() - 60*86400000) d.setFullYear(d.getFullYear()+1); return d; };
  let m;
  
  // "21 February 2026" or "21 Feb 2026"
  m = str.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m && monthToNum(m[2]) !== null) return new Date(+m[3], monthToNum(m[2]), +m[1]);
  
  // "February 21, 2026" or "Feb 21, 2026"
  m = str.match(/^([A-Za-z]+)\s+(\d{1,2})[,\s]+(\d{4})$/);
  if (m && monthToNum(m[1]) !== null) return new Date(+m[3], monthToNum(m[1]), +m[2]);
  
  // "Feb 27, 28 2026" / "Mar 1, 2, 3 2026" (month + multi-days + year)
  m = str.match(/^([A-Za-z]+)\s+([\d,\s]+)\s+(\d{4})$/);
  if (m && monthToNum(m[1]) !== null) {
    const days = m[2].split(',').map(d=>+d.trim()).filter(d=>d);
    return new Date(+m[3], monthToNum(m[1]), days[0]);
  }
  
  // "27, 28 Feb 2026" / "1,2,3 Mar 2026" (multi-days + month + year)
  m = str.match(/^([\d,\s]+)\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m && monthToNum(m[2]) !== null) {
    const days = m[1].split(',').map(d=>+d.trim()).filter(d=>d);
    return new Date(+m[3], monthToNum(m[2]), days[0]);
  }
  
  // "27-28 Feb 2026" / "1-3 Mar 2026" (day range + month + year)
  m = str.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m && monthToNum(m[3]) !== null) return new Date(+m[4], monthToNum(m[3]), +m[1]);
  
  // "Feb 27-28, 2026" (month + day range + year)
  m = str.match(/^([A-Za-z]+)\s+(\d{1,2})\s*[-–]\s*\d{1,2}[,\s]+(\d{4})$/);
  if (m && monthToNum(m[1]) !== null) return new Date(+m[3], monthToNum(m[1]), +m[2]);
  
  // "March 2026" / "Mar 2026" (month + year only)
  m = str.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m && monthToNum(m[1]) !== null) return new Date(+m[2], monthToNum(m[1]), 1);
  
  // "Feb 27, 28" (month + multi-days, no year)
  m = str.match(/^([A-Za-z]+)\s+([\d,\s]+)$/);
  if (m && monthToNum(m[1]) !== null) {
    const days = m[2].split(',').map(d=>+d.trim()).filter(d=>d);
    if (days.length > 0 && days[0] <= 31) {
      return autoYear(new Date(new Date().getFullYear(), monthToNum(m[1]), days[0]));
    }
  }
  
  // "21 Feb" (day + month, no year)
  m = str.match(/^(\d{1,2})\s+([A-Za-z]{3,})$/);
  if (m && monthToNum(m[2]) !== null) {
    return autoYear(new Date(new Date().getFullYear(), monthToNum(m[2]), +m[1]));
  }
  
  // "February 28" (month + day, no year)
  m = str.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (m && monthToNum(m[1]) !== null) {
    return autoYear(new Date(new Date().getFullYear(), monthToNum(m[1]), +m[2]));
  }
  
  // "19,20,21 Mar" (multi-days + month, no year)
  m = str.match(/^([\d,\s]+)\s+([A-Za-z]{3,})$/);
  if (m && monthToNum(m[2]) !== null) {
    const days = m[1].split(',').map(d=>+d.trim()).filter(d=>d);
    return autoYear(new Date(new Date().getFullYear(), monthToNum(m[2]), days[days.length-1]));
  }
  
  // "27-28 Feb" (day range + month, no year)
  m = str.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)$/);
  if (m && monthToNum(m[3]) !== null) {
    return autoYear(new Date(new Date().getFullYear(), monthToNum(m[3]), +m[1]));
  }
  
  // DD/MM/YYYY
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  
  // YYYY-MM-DD (ISO)
  m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  
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
  
  // Multi-day "MMM DD, DD YYYY" format: "Feb 27, 28 2026" -> find next upcoming
  let multiMonth = dateStr.match(/^([A-Za-z]+)\s+([\d,\s]+)\s+(\d{4})$/);
  if (multiMonth && monthToNum(multiMonth[1]) !== null) {
    const days = multiMonth[2].split(',').map(d=>+d.trim()).filter(d=>d).sort((a,b)=>a-b);
    const month = monthToNum(multiMonth[1]);
    const year = +multiMonth[3];
    const now = new Date(); now.setHours(0,0,0,0);
    for (const day of days) {
      const d = new Date(year, month, day);
      if (d >= now) return d;
    }
    return new Date(year, month, days[0]);
  }
  
  // Multi-day "MMM DD, DD" format (no year): "Feb 27, 28"
  multiMonth = dateStr.match(/^([A-Za-z]+)\s+([\d,\s]+)$/);
  if (multiMonth && monthToNum(multiMonth[1]) !== null) {
    const days = multiMonth[2].split(',').map(d=>+d.trim()).filter(d=>d && d<=31).sort((a,b)=>a-b);
    if (days.length > 1) {
      const month = monthToNum(multiMonth[1]);
      const y = new Date().getFullYear();
      const now = new Date(); now.setHours(0,0,0,0);
      for (const day of days) {
        let d = new Date(y, month, day);
        if (d < now - 60*86400000) d.setFullYear(y+1);
        if (d >= now) return d;
      }
      let d = new Date(y, month, days[0]);
      if (d < now - 60*86400000) d.setFullYear(y+1);
      return d;
    }
  }
  
  // Multi-day: "7,8,14,15,21,22,28 Feb" — find the NEXT upcoming date
  const multiDay = dateStr.match(/^([\d,\s]+)\s+([A-Za-z]{3,})$/);
  if (multiDay && monthToNum(multiDay[2]) !== null) {
    const days = multiDay[1].split(',').map(d=>+d.trim()).filter(d=>d).sort((a,b)=>a-b);
    const y = new Date().getFullYear();
    const month = monthToNum(multiDay[2]);
    const now = new Date(); now.setHours(0,0,0,0);
    for (const day of days) {
      let d = new Date(y, month, day);
      if (d < now - 60*86400000) d.setFullYear(y+1);
      if (d >= now) return d;
    }
    const d = new Date(y, month, days[0]);
    if (d < now - 60*86400000) d.setFullYear(y+1);
    return d;
  }
  return parseSingleDate(dateStr);
}

// Get the next upcoming date for sorting (handles multi-date and ranges)
function getNextDate(dateStr) {
  if (!dateStr) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  
  // Multi-day: "7,8,14,15,21,22,28 Feb"
  const multiDay = dateStr.match(/^([\d,\s]+)\s+([A-Za-z]{3,})$/);
  if (multiDay && monthToNum(multiDay[2]) !== null) {
    const days = multiDay[1].split(',').map(d=>+d.trim()).filter(d=>d).sort((a,b)=>a-b);
    const y = new Date().getFullYear();
    const month = monthToNum(multiDay[2]);
    for (const day of days) {
      let d = new Date(y, month, day);
      if (d < now - 60*86400000) d.setFullYear(y+1);
      if (d >= now) return d;
    }
  }
  
  // Range: sort by today if we're within the range
  const startDate = getStartDate(dateStr);
  const endDate = getEndDate(dateStr);
  if (startDate && endDate && startDate <= now && endDate >= now) {
    return now; // ongoing — treat as "today"
  }
  
  return startDate;
}

function looksLikeDate(str) {
  if (!str) return false;
  const s = str.trim();
  if (/^\d{1,2}[,\d\s]*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(s)) return true;
  if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(s)) return true;
  if (/^\d{1,2}[- ](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+to\s+/i.test(s)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return true;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return true;
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
      if (s.month === e.month) return badge(s.month, s.day + '-' + e.day, true);
      return badge(s.month + '→' + e.month, s.day + '→' + e.day, true);
    }
  }
  let mr = dateStr.match(/(?:(\d{1,2})[- ])?([A-Za-z]{3,})\s+to\s+(?:(\d{1,2})[- ])?([A-Za-z]{3,})/i);
  if (mr) {
    const m1 = (mr[2]||'').substring(0,3).toUpperCase();
    const m2 = (mr[4]||'').substring(0,3).toUpperCase();
    if (mr[1] && mr[3]) return badge(m1 + '→' + m2, mr[1] + '→' + mr[3], true);
    return badge(m1 + '→' + m2, 'Ongoing', true);
  }
  // "Feb 27, 28 2026" / "Mar 1, 2, 3 2026" (month + multi-days + year)
  let multiMonth = dateStr.match(/^([A-Za-z]+)\s+([\d,\s]+)\s+(\d{4})$/);
  if (multiMonth && monthToNum(multiMonth[1]) !== null) {
    const days = multiMonth[2].split(',').map(d=>d.trim()).filter(d=>d);
    const month = multiMonth[1].substring(0,3).toUpperCase();
    const monthNum = monthToNum(multiMonth[1]);
    if (days.length > 1) {
      const now = new Date(); now.setHours(0,0,0,0);
      const y = +multiMonth[3];
      let nextDay = null;
      for (const d of days.map(Number).sort((a,b)=>a-b)) {
        if (new Date(y, monthNum, d) >= now) { nextDay = d; break; }
      }
      if (nextDay) return badge(month, nextDay, true);
      return badge(month, days[0] + '-' + days[days.length-1], true);
    }
  }
  
  // "Feb 27, 28" (month + multi-days, no year)
  multiMonth = dateStr.match(/^([A-Za-z]+)\s+([\d,\s]+)$/);
  if (multiMonth && monthToNum(multiMonth[1]) !== null) {
    const days = multiMonth[2].split(',').map(d=>d.trim()).filter(d=>d && +d<=31);
    const month = multiMonth[1].substring(0,3).toUpperCase();
    if (days.length > 1) {
      return badge(month, days[0] + ',' + days[days.length-1], true);
    }
  }
  
  // "DD,DD MMM" (multi-days + month, no year)
  const multiDay = dateStr.match(/^([\d,\s]+)\s+([A-Za-z]{3,})$/);
  if (multiDay) {
    const days = multiDay[1].split(',').map(d=>d.trim()).filter(d=>d);
    const month = multiDay[2].substring(0,3).toUpperCase();
    const monthNum = monthToNum(multiDay[2]);
    
    if (monthNum !== null && days.length > 1) {
      // Find the next upcoming date
      const now = new Date(); now.setHours(0,0,0,0);
      const y = new Date().getFullYear();
      let nextDay = null;
      for (const d of days.map(Number).sort((a,b)=>a-b)) {
        let dt = new Date(y, monthNum, d);
        if (dt < now - 60*86400000) dt.setFullYear(y+1);
        if (dt >= now) { nextDay = d; break; }
      }
      if (nextDay) {
        return badge(month, nextDay, true);
      }
      return badge(month, days[0] + '-' + days[days.length-1], true);
    }
    return badge(month, days.length > 2 ? days[0] + '-' + days[days.length-1] : days.join(','), true);
  }
  const p = extractDM(dateStr);
  if (p) return badge(p.month, p.day);
  return '';
}
function extractDM(s) {
  if (!s) return null;
  s = s.trim();
  // Strip day names and time
  s = s.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[,.\s]*/i, '');
  s = s.replace(/\s+at\s+\d{1,2}[:.]\d{2}.*/i, '');
  s = s.replace(/\s+\d{1,2}[:.]\d{2}\s*(AM|PM|am|pm)?.*$/, '');
  s = s.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
  s = s.trim();
  // "27 Feb 2026" or "27 Feb"
  let m = s.match(/(\d{1,2})\s+([A-Za-z]{3,})/);
  if (m && monthToNum(m[2]) !== null) return { day: m[1], month: m[2].substring(0,3).toUpperCase() };
  // "Feb 27, 2026" or "Feb 27"
  m = s.match(/([A-Za-z]{3,})\s+(\d{1,2})/);
  if (m && monthToNum(m[1]) !== null) return { day: m[2], month: m[1].substring(0,3).toUpperCase() };
  return null;
}
function badge(top, bottom, isMulti) {
  const multiDot = isMulti ? '<div style="font-size:0.55rem;color:#fbbf24;margin-top:1px">● ● ●</div>' : '';
  return '<div class="date-badge"><div class="date-month">' + top + '</div><div class="date-day">' + bottom + '</div>' + multiDot + '</div>';
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
    
    // Detect multi-date events
    const hasRange = event.event_date && (event.event_date.includes(' - ') || / to /i.test(event.event_date));
    const isMultiDay = event.event_date && /^\d[\d,\s]+\s+[A-Za-z]/.test(event.event_date) && event.event_date.includes(',');
    const isRecurring = !!(event.recurring && event.recurring.trim());
    
    // Build date info line
    let dateInfo = '';
    if (isMultiDay) {
      dateInfo = '<div class="multi-date-tag">📅 Multiple dates: ' + event.event_date + '</div>';
    } else if (hasRange) {
      dateInfo = '<div class="date-range-text">📅 ' + event.event_date + '</div>';
    }
    const recurTag = isRecurring ? '<div class="recurring-tag">🔁 ' + event.recurring + '</div>' : '';
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
            ${hasImg ? '<img src="' + event.image_url + '" alt="' + (event.title||'').replace(/"/g,'&quot;') + ' in Malta" class="card-img" style="position:relative;z-index:2;" loading="lazy" width="400" height="220" onerror="this.hidden=1">' : ''}
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
// STATIC ASSETS
// =====================================================================
const fs = require('fs');
const path = require('path');
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
  <style>
    :root { --bg: #f8fafc; --text: #1e293b; --primary: #FF385C; }
    body { font-family:'Outfit',sans-serif; background:var(--bg); margin:0; color:var(--text); }
    a { color:var(--primary); text-decoration:none; }
    .nav { background:#0f172a; padding:15px 24px; display:flex; align-items:center; gap:15px; }
    .nav a { color:white; font-weight:700; font-size:1.1rem; }
    .nav .back { color:#94a3b8; font-size:0.85rem; margin-left:auto; }
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
  <div class="nav">
    <a href="/" style="display:flex;align-items:center;text-decoration:none"><img src="/logo.png" alt="Malta Event Guide" style="height:36px"></a>
    <div style="display:flex;align-items:center;gap:12px;margin-left:auto">
      <a href="https://www.instagram.com/maltaeventguide/" target="_blank" rel="noopener" style="color:#94a3b8;display:flex;align-items:center;transition:0.2s" onmouseover="this.style.color='white'" onmouseout="this.style.color='#94a3b8'" title="Instagram"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg></a>
      <a href="https://youtube.com/@maltaeventsguide" target="_blank" rel="noopener" style="color:#94a3b8;display:flex;align-items:center;transition:0.2s" onmouseover="this.style.color='white'" onmouseout="this.style.color='#94a3b8'" title="YouTube"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
      <a href="https://www.tiktok.com/@malta.events.guid" target="_blank" rel="noopener" style="color:#94a3b8;display:flex;align-items:center;transition:0.2s" onmouseover="this.style.color='white'" onmouseout="this.style.color='#94a3b8'" title="TikTok"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.73a8.19 8.19 0 004.76 1.52V6.79a4.84 4.84 0 01-1-.1z"/></svg></a>
      <a href="/" class="back">← All Events</a>
    </div>
  </div>
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
      <p>If you live in Malta and want to stay up to date, bookmark <a href="/">maltaeventguide.com</a> and check back regularly — we add new events every day. You can also subscribe to our weekly email newsletter at the bottom of the homepage to get a curated list of upcoming highlights delivered to your inbox every week.</p>

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
      <p>Malta's festival scene goes well beyond club nights. <a href="/event/earth-garden-festival-2026">Earth Garden</a> (May) is the island's biggest alternative festival with five stages at Ta' Qali National Park — think world music, techno, reggae, and psytrance across three days with 30,000 attendees. Bloom Festival brings slick house and techno production to outdoor venues with international headliners. <a href="/event/dark-malta-festival-2026">Dark Malta Festival</a> (April) is a unique gothic and industrial music event attracting alternative culture fans from across Europe. And the Isle of MTV (summer) is completely free, drawing tens of thousands to Floriana for performances by global pop and dance acts. Check our <a href="/festivals-malta">Festivals page</a> for all upcoming dates.</p>

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
      <p>If you visit between June and September, you will find Malta at its most vibrant. The Isle of MTV is a free open-air concert in Floriana featuring major international artists. <a href="/event/earth-garden-festival-2026">Earth Garden</a> is Malta's largest alternative festival, held at Ta' Qali National Park with five stages covering everything from world music and reggae to techno and psytrance — it attracts around 30,000 people over three days. Bloom Festival brings house and techno to open-air venues with international headliners. For something darker, <a href="/event/dark-malta-festival-2026">Dark Malta Festival</a> caters to gothic, industrial and metal fans with live bands and alternative culture. Village festas (local patron saint feasts) happen every weekend across different towns with fireworks, brass bands, and street food — these are free and give you an authentic taste of Maltese culture.</p>

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
    :root { --bg: #f8fafc; --text: #1e293b; --primary: #FF385C; }
    body { font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); margin:0; color:var(--text); }
    a { color:var(--primary); }
    .nav { background:#0f172a; padding:15px 24px; display:flex; align-items:center; gap:15px; }
    .nav a { color:white; font-weight:700; font-size:1.1rem; text-decoration:none; }
    .nav .back { color:#b0bec5; font-size:0.85rem; margin-left:auto; }
    article { max-width:740px; margin:40px auto; padding:0 24px 60px; }
    article h1 { font-size:2.2rem; font-weight:900; line-height:1.2; margin:0 0 12px; }
    article .byline { color:#64748b; font-size:0.9rem; margin-bottom:30px; }
    article h2 { font-size:1.25rem; font-weight:700; margin:35px 0 12px; color:#0f172a; }
    article p { font-size:1rem; line-height:1.8; color:#334155; margin:0 0 18px; }
    article a { text-decoration:underline; text-underline-offset:3px; }
    .guide-cta { background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%); border-radius:16px; padding:30px; text-align:center; color:white; margin:40px 0; }
    .guide-cta h3 { margin:0 0 8px; font-size:1.2rem; }
    .guide-cta p { color:#b0bec5; font-size:0.9rem; margin:0 0 16px; }
    .guide-cta a { display:inline-block; background:var(--primary); color:white; padding:12px 28px; border-radius:12px; font-weight:700; text-decoration:none; }
    .related-guides { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:16px; margin:40px 0; }
    .related-guides a { background:white; border-radius:12px; padding:20px; text-decoration:none; color:var(--text); box-shadow:0 2px 10px rgba(0,0,0,0.06); transition:0.2s; }
    .related-guides a:hover { transform:translateY(-2px); box-shadow:0 6px 20px rgba(0,0,0,0.1); }
    .related-guides a .rg-title { font-weight:700; font-size:0.95rem; margin-bottom:6px; }
    .related-guides a .rg-desc { font-size:0.8rem; color:#64748b; }
    footer { padding:30px 20px; background:#1e293b; color:#b0bec5; text-align:center; font-size:0.8rem; line-height:1.8; }
    footer a { color:#b0bec5; }
  </style>
</head>
<body>
  <div class="nav">
    <a href="/" style="display:flex;align-items:center"><img src="/logo.png" alt="Malta Event Guide" style="height:36px"></a>
    <a href="/" class="back">&larr; All Events</a>
  </div>
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
        if (!event.event_date && looksLikeDate(event.title)) event.event_date = event.title;
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

        const endDate = getEndDate(event.event_date);
        const startDate = getStartDate(event.event_date);
        const nextDate = getNextDate(event.event_date);
        
        // Recurring events with no parseable date are always "upcoming" and sort to today
        const isRecurring = !!(event.recurring && event.recurring.trim());
        
        if (isRecurring && !startDate && !endDate) {
          // Recurring with no date — it's ongoing, sort to today
          upcoming.push({ ...event, _sort: new Date(today), _isRecurring: true });
        } else if (!endDate || endDate >= today) {
          let sortDate = nextDate || startDate;
          if (sortDate && sortDate < today) sortDate = new Date(today);
          // Recurring events that have a date range: sort to today if within range
          if (isRecurring && !sortDate) sortDate = new Date(today);
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
  <title>Malta Events 2026 | Concerts, Festivals, Nightlife & Things to Do in Malta</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
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
    :root { --bg: #f8fafc; --card-bg: #fff; --text: #1e293b; --primary: #FF385C; }
    body { font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); margin: 0; color: var(--text); padding-bottom: 50px; }
    
    header { position: relative; background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 40%, #FF385C 100%); background-size: cover; background-position: center; color: white; text-align: center; padding: 6rem 1rem 8rem; margin-bottom: 80px; }
    .header-overlay { position: absolute; top:0;left:0;right:0;bottom:0; background: radial-gradient(ellipse at 30% 50%, rgba(255,56,92,0.15) 0%, transparent 60%); z-index:1; }
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
    .filter-bar .filter-count { font-size:0.85rem; color:#64748b; }
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
    .multi-date-tag { display:inline-block; background:#fef3c7; color:#92400e; font-size:0.75rem; font-weight:600; padding:3px 10px; border-radius:20px; margin-bottom:8px; }
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

  ${(() => {
    const featured = allEvents.filter(e => e.featured);
    if (featured.length === 0) return '';
    const fCount = featured.length;
    const gridCols = fCount === 1 ? 'grid-template-columns:1fr' : fCount === 2 ? 'grid-template-columns:repeat(2,1fr)' : 'grid-template-columns:repeat(auto-fill,minmax(300px,1fr))';
    const maxW = fCount === 1 ? '420' : fCount <= 2 ? '800' : '1400';
    const imgH = fCount === 1 ? '320' : '180';
    return `
    <div style="max-width:${maxW}px;margin:0 auto;padding:0 20px 20px">
      <h2 style="font-size:1.3rem;font-weight:800;margin:0 0 15px;color:#1e293b">⭐ Featured Events</h2>
      <div style="display:grid;${gridCols};gap:16px">
        ${featured.map(e => {
          const slug = e.slug || generateSlug(e.title);
          const img = e.image_url && e.image_url.startsWith('http') ? e.image_url : '';
          return `<a href="/event/${slug}" style="text-decoration:none;display:block;background:white;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);border:2px solid #fbbf24;transition:0.2s" onmouseover="this.style.transform='translateY(-3px)';this.style.boxShadow='0 8px 25px rgba(0,0,0,0.12)'" onmouseout="this.style.transform='';this.style.boxShadow='0 2px 12px rgba(0,0,0,0.08)'">
            ${img ? `<div style="height:${imgH}px;overflow:hidden"><img src="${img}" alt="${(e.title||'').replace(/"/g,'&quot;')} — event in Malta" loading="lazy" width="400" height="${imgH}" style="width:100%;height:100%;object-fit:cover"></div>` : ''}
            <div style="padding:14px">
              <div style="font-size:0.7rem;font-weight:700;color:#f59e0b;text-transform:uppercase;margin-bottom:4px">⭐ Featured</div>
              <div style="font-size:1rem;font-weight:700;color:#0f172a">${e.title}</div>
              <div style="font-size:0.8rem;color:#64748b;margin-top:4px">${e.event_date || ''} · ${e.location || 'Malta'}</div>
            </div>
          </a>`;
        }).join('')}
      </div>
    </div>`;
  })()}

  <div class="container" id="eventGrid">
    ${upcoming.map(e => createCard(e, false)).join('')}
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
          match = inRange(todayStr) || recurMatch(today);
        } else if(mode==='tomorrow'){
          match = inRange(tomorrowStr) || recurMatch(tomorrow);
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
      <p style="color:#b0bec5;font-size:0.9rem;margin:0 0 20px">Get weekly updates on the best events, festivals & things to do in Malta and Gozo.</p>
      <div style="display:flex;gap:8px;max-width:420px;margin:0 auto;flex-wrap:wrap" id="emailForm">
        <input type="email" id="subEmail" placeholder="Your email address" style="flex:1;min-width:200px;padding:12px 16px;border-radius:12px;border:2px solid #334155;background:#1e293b;color:white;font-family:inherit;font-size:0.9rem;outline:none" onfocus="this.style.borderColor='#FF385C'" onblur="this.style.borderColor='#334155'">
        <button onclick="subscribeEmail()" style="padding:12px 24px;border-radius:12px;border:none;background:#FF385C;color:white;font-family:inherit;font-weight:700;font-size:0.9rem;cursor:pointer;white-space:nowrap;transition:0.2s;flex-shrink:0" onmouseover="this.style.background='#e11d48'" onmouseout="this.style.background='#FF385C'">Subscribe</button>
      </div>
      <div id="subMsg" style="margin-top:10px;font-size:0.85rem;display:none"></div>
      <p style="color:#475569;font-size:0.7rem;margin:15px 0 0">No spam, unsubscribe anytime. We respect your privacy.</p>
    </div>
  </div>

  <section style="max-width:900px;margin:60px auto 0;padding:0 20px;color:#334155;font-size:0.95rem;line-height:1.8">
    <h2 style="font-size:1.5rem;font-weight:800;color:#0f172a;margin:0 0 15px">Your Complete Guide to Events in Malta & Gozo</h2>
    <p>Malta Event Guide is the most comprehensive events listing for the Maltese islands. Whether you are a local looking for something to do this weekend or a visitor planning your trip, our guide covers everything happening across Malta and Gozo — from live music concerts and theatre shows in Valletta to nightlife parties in Paceville, family days out in Mdina, and cultural festivals island-wide.</p>
    <p>We aggregate events from trusted sources including ShowsHappening, VisitMalta, Resident Advisor, and local organisers, then update our listings daily so you always see what is coming up. Every event includes the date, venue, and a direct link to buy tickets or find out more.</p>

    <h3 style="font-size:1.15rem;font-weight:700;color:#0f172a;margin:30px 0 10px">What Types of Events Can You Find?</h3>
    <p>Our guide covers <a href="/music-events-malta" style="color:#FF385C;text-decoration:underline">live music and concerts</a>, <a href="/nightlife-malta" style="color:#FF385C;text-decoration:underline">nightlife and club events</a>, <a href="/festivals-malta" style="color:#FF385C;text-decoration:underline">festivals</a>, <a href="/theatre-shows-malta" style="color:#FF385C;text-decoration:underline">theatre and shows</a>, <a href="/arts-culture-malta" style="color:#FF385C;text-decoration:underline">arts and culture</a>, <a href="/sports-events-malta" style="color:#FF385C;text-decoration:underline">sports and adventure</a>, <a href="/food-drink-events-malta" style="color:#FF385C;text-decoration:underline">food and drink experiences</a>, <a href="/family-events-malta" style="color:#FF385C;text-decoration:underline">family-friendly activities</a>, and <a href="/free-events-malta" style="color:#FF385C;text-decoration:underline">free events</a>. Use the filters above to narrow by category, date, or source.</p>

    <h3 style="font-size:1.15rem;font-weight:700;color:#0f172a;margin:30px 0 10px">Popular Events This Month</h3>
    <p>Malta has a packed calendar throughout the year. During carnival season in February you will find parades in Valletta and Nadur, while spring brings Holy Week processions and the Malta International Fireworks Festival. Late spring features <a href="/event/earth-garden-festival-2026" style="color:#FF385C;text-decoration:underline">Earth Garden Festival</a>, Malta's largest alternative music festival at Ta' Qali National Park with 30,000 attendees across five stages. Summer is peak season with the Isle of MTV, Bloom Festival, BeerFest, and numerous boat parties and pool events. <a href="/event/dark-malta-festival-2026" style="color:#FF385C;text-decoration:underline">Dark Malta Festival</a> in April draws alternative and gothic music fans from across Europe. Autumn features Notte Bianca and BirguFest, and winter brings the Malta Christmas markets, New Year celebrations, and the Baroque Festival at some of the island's most historic venues.</p>

    <h3 style="font-size:1.15rem;font-weight:700;color:#0f172a;margin:30px 0 10px">How to Use Malta Event Guide</h3>
    <p>Search by keyword, filter by date or category, or browse our curated category pages to find exactly what you are looking for. Each event links directly to its official source so you can buy tickets or get directions. We also feature handpicked events at the top of the page so you never miss the highlights. Bookmark us and check back regularly — new events are added every day.</p>

    <h3 style="font-size:1.15rem;font-weight:700;color:#0f172a;margin:30px 0 10px">Guides for Visitors and Locals</h3>
    <p>New to Malta or just visiting? Read our in-depth guides: <a href="/guide/how-to-find-events-in-malta" style="color:#FF385C;text-decoration:underline">How to Find Events in Malta Easily</a>, <a href="/guide/malta-nightlife-guide" style="color:#FF385C;text-decoration:underline">Malta Nightlife Guide 2026</a>, and <a href="/guide/things-to-do-malta-tourists" style="color:#FF385C;text-decoration:underline">Things to Do in Malta for Tourists</a>. Each guide is written from local experience and updated regularly.</p>
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
      <p style="margin-top:15px;font-size:0.75rem;color:#64748b">&copy; ${new Date().getFullYear()} maltaeventguide.com &middot; Events sourced from ShowsHappening, VisitMalta, Resident Advisor, EventWorks and local organizers</p>
      <div style="margin-top:18px;display:flex;justify-content:center;gap:16px">
        <a href="https://www.instagram.com/maltaeventguide/" target="_blank" rel="noopener" style="color:#94a3b8;transition:0.2s" onmouseover="this.style.color='#FF385C'" onmouseout="this.style.color='#94a3b8'" title="Instagram"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg></a>
        <a href="https://youtube.com/@maltaeventsguide" target="_blank" rel="noopener" style="color:#94a3b8;transition:0.2s" onmouseover="this.style.color='#FF0000'" onmouseout="this.style.color='#94a3b8'" title="YouTube"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
        <a href="https://www.tiktok.com/@malta.events.guid" target="_blank" rel="noopener" style="color:#94a3b8;transition:0.2s" onmouseover="this.style.color='#00f2ea'" onmouseout="this.style.color='#94a3b8'" title="TikTok"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.73a8.19 8.19 0 004.76 1.52V6.79a4.84 4.84 0 01-1-.1z"/></svg></a>
      </div>
      <p style="margin-top:15px;font-size:0.75rem;color:#64748b">Powered by <a href="https://bugrayildirim.me/" target="_blank" style="color:#94a3b8;text-decoration:underline">Bugra</a> &middot; <a href="mailto:hello@bugrayildirim.me" style="color:#94a3b8;text-decoration:underline">hello@bugrayildirim.me</a></p>
    </div>
  </footer>
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
    const startDate = getStartDate(event.event_date);
    const endDate = getEndDate(event.event_date);
    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "Event",
      "name": title,
      "description": event.description || desc,
      "startDate": startDate ? startDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      "endDate": endDate ? endDate.toISOString().split('T')[0] : (startDate ? startDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0]),
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
      }
    };
    if (hasImg) jsonLd.image = img;
    if (externalUrl) {
      jsonLd.url = externalUrl;
      jsonLd.offers = {
        "@type": "Offer",
        "url": externalUrl,
        "availability": "https://schema.org/InStock"
      };
    }
    if (event.source_name) {
      jsonLd.performer = {
        "@type": "PerformingGroup",
        "name": event.source_name
      };
    }

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

    .event-layout { display:grid; grid-template-columns:400px 1fr; gap:0; background:white; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }

    .event-img { background:#0f172a; display:flex; align-items:flex-start; justify-content:center; min-height:400px; }
    .event-img img { width:100%; height:100%; object-fit:cover; }
    .event-img .fallback { width:100%;min-height:400px;display:flex;align-items:center;justify-content:center;color:white;font-size:6rem;font-weight:800;background:#1e293b; }

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

    .cta { display:block; width:100%; padding:16px; background:#0f172a; color:white; text-align:center; border-radius:12px; font-weight:800; font-size:1.05rem; transition:0.3s; box-sizing:border-box; }
    .cta:hover { background:var(--primary); transform:translateY(-2px); box-shadow:0 8px 25px rgba(255,56,92,0.3); }

    .share-row { display:flex; gap:8px; margin-top:12px; }
    .share-btn { flex:1; padding:10px; border-radius:10px; text-align:center; font-size:0.8rem; font-weight:600; color:white; cursor:pointer; transition:opacity 0.2s; }
    .share-btn:hover { opacity:0.85; }
    .share-whatsapp { background:#25D366; }
    .share-facebook { background:#1877F2; }
    .share-copy { background:#64748b; }
    .share-calendar { background:#0f172a; }

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
      .event-img { min-height:auto; max-height:400px; overflow:hidden; }
      .event-img img { max-height:400px; object-fit:contain; }
      .event-details { padding:24px; }
      h1 { font-size:1.4rem; }
      .wrapper { margin-top:15px; }
      .share-row { flex-wrap:wrap; }
    }
  </style>
</head>
<body>
  <nav class="nav">
    <a href="/" style="display:flex;align-items:center;gap:10px;text-decoration:none"><img src="/logo.png" alt="Malta Event Guide" style="height:36px"></a>
    <div style="display:flex;align-items:center;gap:12px;margin-left:auto">
      <a href="https://www.instagram.com/maltaeventguide/" target="_blank" rel="noopener" style="color:#94a3b8;display:flex;align-items:center" title="Instagram"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg></a>
      <a href="https://youtube.com/@maltaeventsguide" target="_blank" rel="noopener" style="color:#94a3b8;display:flex;align-items:center" title="YouTube"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
      <a href="https://www.tiktok.com/@malta.events.guid" target="_blank" rel="noopener" style="color:#94a3b8;display:flex;align-items:center" title="TikTok"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.73a8.19 8.19 0 004.76 1.52V6.79a4.84 4.84 0 01-1-.1z"/></svg></a>
      <a href="/" class="back">← All Events</a>
    </div>
  </nav>

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
        ${event.description ? '<div class="desc">' + event.description.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>').replace(/$/, '</p>') + '</div>' : ''}
        ${externalUrl ? '<a href="' + externalUrl + '" target="_blank" class="cta" onclick="fetch(\'/api/track\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({event_id:' + event.id + ',event_title:\'' + title.replace(/'/g, "\\'") + '\',source:\'' + source + '\'})})">View Event / Get Tickets →</a>' : '<a href="/" class="cta">← Browse More Events</a>'}
        <div class="share-row">
          <div class="share-btn share-calendar" onclick="addToCalendar()">📅 Add to Calendar</div>
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

  <div style="max-width:600px;margin:40px auto 0;padding:0 20px">
    <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);border-radius:20px;padding:35px;text-align:center;color:white">
      <div style="font-size:2rem;margin-bottom:5px">📬</div>
      <h2 style="margin:0 0 8px;font-size:1.3rem;font-weight:800">Never Miss an Event in Malta</h2>
      <p style="color:#b0bec5;font-size:0.9rem;margin:0 0 20px">Get weekly updates on the best events, festivals & things to do in Malta and Gozo.</p>
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
    <a href="/"><img src="/logo.png" alt="Malta Event Guide" style="height:50px;margin-bottom:8px"></a><br>
    Your complete guide to events in Malta & Gozo
    <div style="margin-top:12px;display:flex;justify-content:center;gap:16px">
      <a href="https://www.instagram.com/maltaeventguide/" target="_blank" rel="noopener" style="color:#94a3b8;transition:0.2s" onmouseover="this.style.color='#FF385C'" onmouseout="this.style.color='#94a3b8'" title="Instagram"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg></a>
      <a href="https://youtube.com/@maltaeventsguide" target="_blank" rel="noopener" style="color:#94a3b8;transition:0.2s" onmouseover="this.style.color='#FF0000'" onmouseout="this.style.color='#94a3b8'" title="YouTube"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
      <a href="https://www.tiktok.com/@malta.events.guid" target="_blank" rel="noopener" style="color:#94a3b8;transition:0.2s" onmouseover="this.style.color='#00f2ea'" onmouseout="this.style.color='#94a3b8'" title="TikTok"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.73a8.19 8.19 0 004.76 1.52V6.79a4.84 4.84 0 01-1-.1z"/></svg></a>
    </div>
    <div style="margin-top:10px">&copy; ${new Date().getFullYear()} maltaeventguide.com · Powered by <a href="https://bugrayildirim.me/" target="_blank">Bugra</a> · <a href="mailto:hello@bugrayildirim.me">hello@bugrayildirim.me</a></div>
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
    .ig-pick-row:not(.ig-pick-done):hover { background: #334155; }
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
      <div class="tab" onclick="switchTab('upload',this)">📤 Upload</div>
      <div class="tab" onclick="switchTab('analytics',this)">📊 Analytics</div>
      <div class="tab" onclick="switchTab('instagram',this)">📸 Instagram</div>
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
        <button class="fb" onclick="removeDuplicates()" style="background:#1e3a5f;color:#60a5fa">🧹 Remove Duplicates</button>
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
          <div class="form-group"><label style="display:flex;align-items:center;gap:10px;cursor:pointer"><input type="checkbox" id="ed_featured" style="width:18px;height:18px;accent-color:#f59e0b"> ⭐ Featured Event (shown at top of homepage)</label></div>
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

    <!-- UPLOAD TAB -->
    <div id="uploadTab" style="display:none">
      <div style="display:flex;gap:20px;flex-wrap:wrap">
        <!-- Upload Section -->
        <div style="flex:1;min-width:300px">
          <h3 style="color:white;margin:0 0 15px">📤 Upload Events from Excel</h3>
          <div id="xlDrop" style="border:2px dashed #334155;border-radius:12px;padding:30px;text-align:center;cursor:pointer;transition:0.2s;margin-bottom:15px" onclick="document.getElementById('xlFile').click()" ondragover="event.preventDefault();this.style.borderColor='#FF385C'" ondragleave="this.style.borderColor='#334155'" ondrop="event.preventDefault();this.style.borderColor='#334155';xlHandleFile(event.dataTransfer.files[0])">
            <input type="file" id="xlFile" accept=".xlsx,.xls,.csv" onchange="xlHandleFile(this.files[0])" style="display:none">
            <div style="color:#64748b;font-size:2.5rem;margin-bottom:8px">📊</div>
            <div style="color:#94a3b8;font-size:0.95rem;font-weight:600">Drop Excel file here or click to browse</div>
            <div style="color:#475569;font-size:0.8rem;margin-top:6px">Supports .xlsx files · Events will be imported as drafts</div>
          </div>
          <div id="xlStatus" style="display:none;padding:12px;background:#1e293b;border-radius:8px;margin-bottom:15px">
            <div id="xlStatusText" style="color:#94a3b8;font-size:0.85rem"></div>
          </div>
          <div id="xlPreview" style="display:none;background:#1e293b;border-radius:12px;padding:15px;max-height:400px;overflow-y:auto">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <h4 style="color:white;margin:0">Preview</h4>
              <button onclick="xlImport()" style="padding:8px 20px;border-radius:8px;border:none;background:#22c55e;color:white;font-weight:700;font-family:inherit;cursor:pointer">Import as Drafts</button>
            </div>
            <div id="xlRows"></div>
          </div>
        </div>
        
        <!-- Drafts Section -->
        <div style="flex:1;min-width:300px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px">
            <h3 style="color:white;margin:0">📝 Draft Events</h3>
            <div style="display:flex;gap:8px">
              <button onclick="deleteAllDrafts()" style="padding:6px 14px;border-radius:8px;border:1px solid #ef4444;background:transparent;color:#ef4444;font-family:inherit;cursor:pointer;font-size:0.8rem;font-weight:600">🗑️ Delete All Drafts</button>
              <button onclick="loadDrafts()" style="padding:6px 14px;border-radius:8px;border:1px solid #334155;background:transparent;color:#94a3b8;font-family:inherit;cursor:pointer;font-size:0.8rem">↻ Refresh</button>
            </div>
          </div>
          <div id="draftList" style="max-height:600px;overflow-y:auto">
            <div style="color:#64748b;font-size:0.85rem;padding:20px;text-align:center">Switch to this tab to load drafts</div>
          </div>
        </div>
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

  <!-- INSTAGRAM TAB -->
  <div id="instagramTab" style="display:none">
    <div style="display:flex;gap:20px;flex-wrap:wrap">
      <!-- Left: Controls -->
      <div style="flex:1;min-width:300px">
        <h3 style="margin:0 0 15px;color:white">Generate Instagram Post</h3>
        
        <div style="margin-bottom:12px">
          <label style="display:block;color:#94a3b8;font-size:0.8rem;margin-bottom:4px">Template</label>
          <select id="igTemplate" onchange="igPreview()" style="width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:white;font-family:inherit">
            <option value="single">🎤 Single Event Spotlight</option>
            <option value="weekend">🎉 This Weekend</option>
            <option value="top5">🔥 Top 5 This Week</option>
            <option value="featured">⭐ Featured Events</option>
            <option value="picks">🎯 Our Picks</option>
          </select>
        </div>

        <div id="igSingleControls">
          <div style="margin-bottom:12px">
            <label style="display:block;color:#94a3b8;font-size:0.8rem;margin-bottom:4px">Search Event</label>
            <input type="text" id="igSearch" placeholder="Type event name..." oninput="igFilterEvents()" style="width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:white;font-family:inherit;box-sizing:border-box">
          </div>
          <div id="igEventList" style="max-height:200px;overflow-y:auto;border-radius:8px;background:#1e293b"></div>
          
          <div style="margin-top:12px">
            <label style="display:block;color:#94a3b8;font-size:0.8rem;margin-bottom:4px">Event Image</label>
            <div id="igImageDrop" style="border:2px dashed #334155;border-radius:10px;padding:20px;text-align:center;cursor:pointer;transition:0.2s;position:relative" onclick="document.getElementById('igImageFile').click()" ondragover="event.preventDefault();this.style.borderColor='#FF385C'" ondragleave="this.style.borderColor='#334155'" ondrop="event.preventDefault();this.style.borderColor='#334155';igHandleFile(event.dataTransfer.files[0])">
              <input type="file" id="igImageFile" accept="image/*" onchange="igHandleFile(this.files[0])" style="display:none">
              <div id="igImagePreview" style="display:none;margin-bottom:8px"><img id="igImageThumb" style="max-height:120px;border-radius:8px"></div>
              <div id="igImagePrompt">
                <div style="color:#64748b;font-size:2rem;margin-bottom:6px">🖼️</div>
                <div style="color:#94a3b8;font-size:0.85rem;font-weight:600">Drop image, click to browse, or paste</div>
                <div style="color:#475569;font-size:0.75rem;margin-top:4px">Supports JPG, PNG, WebP</div>
              </div>
            </div>
            <div id="igImageStatus" style="margin-top:6px;font-size:0.8rem;color:#4ade80;display:none"></div>
          </div>
        </div>

        <div id="igMultiControls" style="display:none">
          <p style="color:#94a3b8;font-size:0.85rem">Events are auto-selected based on the template. Click "Generate" to create the post.</p>
        </div>

        <div id="igPicksControls" style="display:none">
          <div style="margin-bottom:10px">
            <label style="display:block;color:#94a3b8;font-size:0.8rem;margin-bottom:4px">Search & add events (up to 5)</label>
            <input type="text" id="igPickSearch" placeholder="Type event name..." oninput="igPickFilter()" style="width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:white;font-family:inherit;box-sizing:border-box">
          </div>
          <div id="igPickResults" style="max-height:150px;overflow-y:auto;border-radius:8px;background:#1e293b;margin-bottom:10px"></div>
          <div id="igPickSelected" style="margin-bottom:8px"></div>
          <button onclick="igPicksClear()" style="padding:5px 12px;border-radius:6px;border:1px solid #334155;background:transparent;color:#94a3b8;font-size:0.75rem;cursor:pointer;font-family:inherit">Clear All</button>
        </div>

        <div id="igFeaturedInfo" style="display:none">
          <p style="color:#94a3b8;font-size:0.85rem">This template uses events marked as ⭐ Featured in your Manage tab. Click "Generate" to create the post.</p>
          <div id="igFeaturedList" style="max-height:200px;overflow-y:auto"></div>
        </div>

        <div style="margin-top:15px;display:flex;gap:10px">
          <button onclick="igGenerate()" style="flex:1;padding:12px;border-radius:10px;border:none;background:#FF385C;color:white;font-family:inherit;font-weight:700;font-size:0.9rem;cursor:pointer">Generate Post</button>
          <button onclick="igDownload()" id="igDownloadBtn" style="flex:1;padding:12px;border-radius:10px;border:1px solid #334155;background:transparent;color:#94a3b8;font-family:inherit;font-weight:600;font-size:0.9rem;cursor:pointer;display:none">⬇ Download</button>
        </div>

        <div style="margin-top:15px;padding:12px;background:#1e293b;border-radius:8px">
          <div style="color:#94a3b8;font-size:0.8rem;margin-bottom:6px">Suggested caption & hashtags:</div>
          <textarea id="igCaption" rows="5" style="width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;font-family:inherit;font-size:0.85rem;resize:vertical;box-sizing:border-box"></textarea>
          <button onclick="navigator.clipboard.writeText(document.getElementById('igCaption').value);toast('Caption copied!')" style="margin-top:6px;padding:6px 14px;border-radius:6px;border:1px solid #334155;background:transparent;color:#94a3b8;font-family:inherit;font-size:0.8rem;cursor:pointer">📋 Copy caption</button>
        </div>
      </div>

      <!-- Right: Preview -->
      <div style="flex:1;min-width:300px;display:flex;flex-direction:column;align-items:center">
        <h3 style="margin:0 0 15px;color:white">Preview (1080×1080)</h3>
        <canvas id="igCanvas" width="1080" height="1080" style="width:100%;max-width:500px;border-radius:12px;background:#0f172a"></canvas>
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
  ['imagesTab','datesTab','categoriesTab','manageTab','addTab','uploadTab','analyticsTab','instagramTab'].forEach(function(id){document.getElementById(id).style.display='none'});
  var map={images:'imagesTab',dates:'datesTab',categories:'categoriesTab',manage:'manageTab',add:'addTab',upload:'uploadTab',analytics:'analyticsTab',instagram:'instagramTab'};
  document.getElementById(map[t]).style.display='';
  if(t==='analytics')loadAnalytics();
  if(t==='instagram')igInit();
  if(t==='upload')loadDrafts();
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
    if(s!=='all'&&getSrc(e).toLowerCase()!==s)return 0;
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
    var s=getSrc(e);
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
  var stats=getSourceStats();
  var html='';
  Object.keys(stats).sort().forEach(function(s){
    html+='<div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:12px 18px;text-align:center;min-width:120px"><div style="font-size:1.5rem;font-weight:800;color:white">'+stats[s]+'<\/div><div style="font-size:0.75rem;color:#94a3b8;margin-top:2px">'+s+'<\/div><\/div>';
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
  document.getElementById('ed_featured').checked=!!e.featured;
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
    recurring:document.getElementById('ed_recur').value||null,
    featured:document.getElementById('ed_featured').checked
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
  if(e.source_url.indexOf('ra.co')>-1||e.source_url.indexOf('residentadvisor')>-1)return 'residentadvisor';
  if(e.source_url.indexOf('eventworks')>-1)return 'eventworks';
  if(e.source_url.indexOf('biljett')>-1)return 'biljett';
  return 'manual';
}
function getSrc(e){
  // Consolidate sources for clean display
  var s=getSource(e);
  if(s==='showshappening')return 'ShowsHappening';
  if(s==='visitmalta')return 'VisitMalta';
  if(s==='residentadvisor')return 'Resident Advisor';
  if(s==='eventworks')return 'EventWorks';
  if(s==='biljett')return 'Biljett.mt';
  if(e.source_name){
    // Consolidate "ShowsHappening · xyz" to just "ShowsHappening"
    if(e.source_name.indexOf('ShowsHappening')>-1||e.source_name.indexOf('Show Happening')>-1)return 'ShowsHappening';
    if(e.source_name.indexOf('Community Events')>-1)return 'Community Events Malta';
    if(e.source_name.indexOf('Dark Malta')>-1)return 'Dark Malta Festival';
    return e.source_name;
  }
  return 'Other';
}
// Source stats: group by consolidated source
function getSourceStats(){
  var counts={};
  E.forEach(function(e){
    var src=getSrc(e);
    counts[src]=(counts[src]||0)+1;
  });
  return counts;
}
function ue(id,f,v){var e=E.find(function(x){return x.id===id});if(e)e[f]=v;us();if(tab==='images')af1();else if(tab==='dates')af2();else if(tab==='categories')af3();else if(tab==='manage')af4()}
function api(method,url,body,cb){
  fetch(url,{method:method,headers:{'Content-Type':'application/json',Authorization:auth},body:JSON.stringify(body)})
    .then(function(r){if(!r.ok)throw 0;return r.json()}).then(cb).catch(function(){toast('Failed',1)});
}
function toast(m,e){var t=document.getElementById('toast');t.textContent=m;t.className='toast show'+(e?' err':'');setTimeout(function(){t.className='toast'},3000)}

function removeDuplicates(){
  if(!confirm('This will automatically remove duplicate events, keeping the version with the most data (image, description, category). Continue?'))return;
  fetch('/admin/api/remove-duplicates',{method:'POST',headers:{Authorization:auth}})
    .then(function(r){return r.json()})
    .then(function(d){
      if(d.ok){
        toast(d.removed+' duplicates removed!');
        // Reload events
        fetch('/admin/api/events',{headers:{Authorization:auth}}).then(function(r){return r.json()}).then(function(dd){E=dd;us();af4()});
      } else {
        toast('Error: '+(d.error||'unknown'),1);
      }
    }).catch(function(){toast('Failed',1)});
}
// ========== EXCEL UPLOAD & DRAFTS ==========
var xlParsedEvents=[];

function xlHandleFile(file){
  if(!file)return;
  var status=document.getElementById('xlStatus');
  var statusText=document.getElementById('xlStatusText');
  status.style.display='';
  statusText.textContent='Reading file...';
  statusText.style.color='#94a3b8';
  
  var reader=new FileReader();
  reader.onload=function(ev){
    try{
      xlParseXLSX(new Uint8Array(ev.target.result));
    }catch(err){
      statusText.textContent='Error reading file: '+err.message;
      statusText.style.color='#f87171';
    }
  };
  reader.readAsArrayBuffer(file);
}

function xlParseXLSX(data){
  // Send to server for parsing since we need xlsx library
  var formData=new FormData();
  formData.append('file',new Blob([data]),'events.xlsx');
  
  fetch('/admin/api/parse-excel',{method:'POST',headers:{Authorization:auth},body:formData})
    .then(function(r){return r.json()})
    .then(function(d){
      if(d.error){
        document.getElementById('xlStatusText').textContent='Error: '+d.error;
        document.getElementById('xlStatusText').style.color='#f87171';
        return;
      }
      xlParsedEvents=d.events;
      document.getElementById('xlStatusText').textContent='Found '+d.events.length+' events in file';
      document.getElementById('xlStatusText').style.color='#4ade80';
      document.getElementById('xlPreview').style.display='';
      
      var html=d.events.map(function(e,i){
        return '<div style="padding:10px 12px;border-bottom:1px solid #0f172a;font-size:0.85rem">'
          +'<div style="display:flex;justify-content:space-between;align-items:start">'
          +'<div><span style="color:white;font-weight:600">'+esc(e.title)+'</span></div>'
          +'<span style="color:#475569;font-size:0.75rem">#'+(i+1)+'</span></div>'
          +'<div style="color:#64748b;margin-top:4px;font-size:0.8rem">'
          +(e.event_date?'📅 '+esc(e.event_date)+'  ':'')
          +(e.location?'📍 '+esc(e.location)+'  ':'')
          +(e.description?'💰 '+esc(e.description):'')
          +'</div>'
          +(e.source_url?'<div style="color:#475569;margin-top:2px;font-size:0.75rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🔗 '+esc(e.source_url)+'</div>':'')
          +'</div>';
      }).join('');
      document.getElementById('xlRows').innerHTML=html;
    })
    .catch(function(err){
      document.getElementById('xlStatusText').textContent='Upload failed: '+err;
      document.getElementById('xlStatusText').style.color='#f87171';
    });
}

function xlImport(){
  if(!xlParsedEvents.length)return toast('No events to import',1);
  
  fetch('/admin/api/import-drafts',{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:auth},
    body:JSON.stringify({events:xlParsedEvents})
  })
  .then(function(r){return r.json()})
  .then(function(d){
    if(d.ok){
      toast(d.count+' events imported as drafts!');
      xlParsedEvents=[];
      document.getElementById('xlPreview').style.display='none';
      document.getElementById('xlStatusText').textContent=d.count+' events imported as drafts ✓';
      loadDrafts();
      // Reload main event list
      fetch('/admin/api/events',{headers:{Authorization:auth}}).then(function(r){return r.json()}).then(function(dd){E=dd;us()});
    } else {
      toast('Import failed: '+(d.error||'unknown'),1);
    }
  })
  .catch(function(){toast('Import failed',1)});
}

function deleteAllDrafts(){
  var count=document.querySelectorAll('#draftList .draft-row').length||'all';
  if(!confirm('Delete '+count+' draft events? This cannot be undone.'))return;
  fetch('/admin/api/drafts/delete-all',{method:'DELETE',headers:{Authorization:auth}})
    .then(function(r){return r.json()})
    .then(function(d){
      if(d.ok){toast(d.deleted+' drafts deleted');loadDrafts();loadStats();}
      else toast('Error: '+(d.error||'unknown'),1);
    }).catch(function(){toast('Failed to delete drafts',1)});
}
function loadDrafts(){
  fetch('/admin/api/drafts',{headers:{Authorization:auth}})
    .then(function(r){return r.json()})
    .then(function(drafts){
      if(!drafts.length){
        document.getElementById('draftList').innerHTML='<div style="color:#64748b;font-size:0.85rem;padding:20px;text-align:center">No draft events. Upload an Excel file to import events as drafts.</div>';
        return;
      }
      var html=drafts.map(function(e){
        var hasImg=e.image_url&&e.image_url.indexOf('http')===0;
        var hasCat=!!e.category;
        var hasDate=!!e.event_date;
        var missing=[];
        if(!hasImg)missing.push('image');
        if(!hasCat)missing.push('category');
        if(!hasDate)missing.push('date');
        
        return '<div style="padding:12px;background:#0f172a;border-radius:10px;margin-bottom:8px;border:1px solid #1e293b">'
          +'<div style="display:flex;justify-content:space-between;align-items:start;gap:10px">'
          +'<div style="flex:1;min-width:0">'
          +'<div style="color:white;font-weight:600;font-size:0.9rem">'+esc(e.title)+'</div>'
          +'<div style="color:#64748b;font-size:0.8rem;margin-top:4px">'
          +(e.event_date||'No date')+' · '+(e.location||'No location')
          +'</div>'
          +(missing.length?'<div style="margin-top:4px"><span style="background:#422006;color:#fbbf24;padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:600">Missing: '+missing.join(', ')+'</span></div>':'<div style="margin-top:4px"><span style="background:#052e16;color:#4ade80;padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:600">Ready to publish</span></div>')
          +'</div>'
          +'<div style="display:flex;gap:6px;flex-shrink:0">'
          +'<button onclick="editDraft('+e.id+')" style="padding:6px 12px;border-radius:6px;border:1px solid #334155;background:transparent;color:#94a3b8;font-size:0.75rem;cursor:pointer;font-family:inherit">✏️ Edit</button>'
          +'<button onclick="publishDraft('+e.id+')" style="padding:6px 12px;border-radius:6px;border:none;background:#22c55e;color:white;font-size:0.75rem;cursor:pointer;font-weight:600;font-family:inherit">🚀 Publish</button>'
          +'<button onclick="deleteDraft('+e.id+')" style="padding:6px 12px;border-radius:6px;border:1px solid #7f1d1d;background:transparent;color:#fca5a5;font-size:0.75rem;cursor:pointer;font-family:inherit">🗑️</button>'
          +'</div></div></div>';
      }).join('');
      document.getElementById('draftList').innerHTML='<div style="margin-bottom:10px;color:#94a3b8;font-size:0.85rem">'+drafts.length+' draft event'+(drafts.length===1?'':'s')+'</div>'+html;
    })
    .catch(function(){document.getElementById('draftList').innerHTML='<div style="color:#f87171;padding:10px">Failed to load drafts</div>'});
}

function editDraft(id){
  // Reuse the existing edit modal
  var e=E.find(function(x){return x.id===id});
  if(!e){
    // Fetch from drafts
    fetch('/admin/api/drafts',{headers:{Authorization:auth}})
      .then(function(r){return r.json()})
      .then(function(drafts){
        var d=drafts.find(function(x){return x.id===id});
        if(d){E.push(d);openEdit(id)}
      });
    return;
  }
  openEdit(id);
}

function publishDraft(id){
  api('PUT','/admin/api/events/'+id,{status:'live'},function(){
    toast('Event published! 🚀');
    var e=E.find(function(x){return x.id===id});
    if(e)e.status='live';
    loadDrafts();
  });
}

function deleteDraft(id){
  if(!confirm('Delete this draft?'))return;
  api('DELETE','/admin/api/events/'+id,{},function(){
    E=E.filter(function(x){return x.id!==id});
    us();
    loadDrafts();
    toast('Draft deleted');
  });
}
// ========== END UPLOAD & DRAFTS ==========

// ========== INSTAGRAM POST GENERATOR ==========
var igSelectedEvent=null;
var igLogoImg=null;
var igCustomImage=null; // Stores uploaded/pasted image as data URL

function igInit(){
  if(!igLogoImg){
    igLogoImg=new Image();
    igLogoImg.crossOrigin='anonymous';
    igLogoImg.src='/logo.png';
  }
  // Listen for paste anywhere when on instagram tab
  document.addEventListener('paste',function(ev){
    if(tab!=='instagram')return;
    var items=ev.clipboardData&&ev.clipboardData.items;
    if(!items)return;
    for(var i=0;i<items.length;i++){
      if(items[i].type.indexOf('image')>=0){
        igHandleFile(items[i].getAsFile());
        break;
      }
    }
  });
  igTemplateChange();
  igDrawEmpty();
}

function igHandleFile(file){
  if(!file||file.type.indexOf('image')<0)return;
  var reader=new FileReader();
  reader.onload=function(ev){
    igCustomImage=ev.target.result;
    // Show thumbnail
    document.getElementById('igImageThumb').src=igCustomImage;
    document.getElementById('igImagePreview').style.display='';
    document.getElementById('igImagePrompt').style.display='none';
    document.getElementById('igImageStatus').style.display='';
    document.getElementById('igImageStatus').textContent='✓ Image loaded — '+file.name;
    // Auto-generate if event is selected
    if(igSelectedEvent)igGenerate();
  };
  reader.readAsDataURL(file);
}

function igTemplateChange(){
  var t=document.getElementById('igTemplate').value;
  document.getElementById('igSingleControls').style.display=t==='single'?'':'none';
  document.getElementById('igMultiControls').style.display=(t==='weekend'||t==='top5')?'':'none';
  document.getElementById('igPicksControls').style.display=t==='picks'?'':'none';
  document.getElementById('igFeaturedInfo').style.display=t==='featured'?'':'none';
  if(t==='featured') igShowFeatured();
}

function igFilterEvents(){
  var q=document.getElementById('igSearch').value.toLowerCase();
  var list=document.getElementById('igEventList');
  if(!q){list.innerHTML='';return}
  var matches=E.filter(function(e){return e.title&&e.title.toLowerCase().indexOf(q)>=0}).slice(0,15);
  list.innerHTML=matches.map(function(e){
    var hasImg=e.image_url&&e.image_url.indexOf('http')===0;
    return '<div onclick="igSelectEvent('+e.id+')" style="padding:10px 12px;cursor:pointer;border-bottom:1px solid #1a2332;display:flex;align-items:center;gap:10px;transition:0.15s" onmouseover="this.style.background=\\'#334155\\'" onmouseout="this.style.background=\\'transparent\\'">'
      +(hasImg?'<img src="'+esc(e.image_url)+'" style="width:40px;height:40px;border-radius:6px;object-fit:cover">':'<div style="width:40px;height:40px;border-radius:6px;background:#334155;display:flex;align-items:center;justify-content:center;font-size:1.2rem">🎵</div>')
      +'<div><div style="color:white;font-size:0.85rem;font-weight:600">'+esc(e.title)+'</div>'
      +'<div style="color:#64748b;font-size:0.75rem">'+(e.event_date||'No date')+' · '+(e.location||'Malta')+'</div></div></div>';
  }).join('');
}

function igSelectEvent(id){
  igSelectedEvent=E.find(function(e){return e.id===id});
  igCustomImage=null;
  document.getElementById('igImagePreview').style.display='none';
  document.getElementById('igImagePrompt').style.display='';
  document.getElementById('igImageStatus').style.display='none';
  document.getElementById('igSearch').value=igSelectedEvent.title;
  document.getElementById('igEventList').innerHTML='<div style="padding:10px;color:#4ade80;font-size:0.85rem">✓ Selected: '+esc(igSelectedEvent.title)+'</div>';
}

function igDrawEmpty(){
  var c=document.getElementById('igCanvas');
  var ctx=c.getContext('2d');
  ctx.fillStyle='#0f172a';
  ctx.fillRect(0,0,1080,1080);
  ctx.fillStyle='#334155';
  ctx.font='600 24px Outfit, sans-serif';
  ctx.textAlign='center';
  ctx.fillText('Select an event or template to generate a post',540,540);
}

function igGenerate(){
  var template=document.getElementById('igTemplate').value;
  if(template==='single') igGenSingle();
  else if(template==='weekend') igGenMulti('weekend');
  else if(template==='top5') igGenMulti('top5');
  else if(template==='featured') igGenFeatured();
  else if(template==='picks') igGenPicks();
}

function igGenSingle(){
  if(!igSelectedEvent)return toast('Select an event first',1);
  var e=igSelectedEvent;
  var c=document.getElementById('igCanvas');
  var ctx=c.getContext('2d');
  
  // Background gradient
  var grad=ctx.createLinearGradient(0,0,0,1080);
  grad.addColorStop(0,'#0f172a');
  grad.addColorStop(0.5,'#1e293b');
  grad.addColorStop(1,'#0f172a');
  ctx.fillStyle=grad;
  ctx.fillRect(0,0,1080,1080);

  // Accent line top
  ctx.fillStyle='#FF385C';
  ctx.fillRect(0,0,1080,6);

  var afterImage=function(){
    // Event title
    ctx.fillStyle='white';
    ctx.font='800 52px Outfit, sans-serif';
    ctx.textAlign='center';
    var title=e.title||'Event';
    var words=title.split(' '),lines=[],line='';
    for(var i=0;i<words.length;i++){
      var test=line+(line?' ':'')+words[i];
      if(ctx.measureText(test).width>900&&line){lines.push(line);line=words[i]}
      else line=test;
    }
    if(line)lines.push(line);
    var titleY=lines.length>2?680:710;
    for(var i=0;i<Math.min(lines.length,3);i++){
      ctx.fillText(lines[i],540,titleY+i*62);
    }

    // Date pill
    if(e.event_date){
      var dateY=titleY+lines.length*62+20;
      ctx.font='600 28px Outfit, sans-serif';
      var dateW=ctx.measureText(e.event_date).width+40;
      ctx.fillStyle='#FF385C';
      igRoundRect(ctx,540-dateW/2,dateY-8,dateW,44,22);
      ctx.fill();
      ctx.fillStyle='white';
      ctx.fillText(e.event_date,540,dateY+24);
    }

    // Location
    if(e.location){
      var locY=(e.event_date?titleY+lines.length*62+80:titleY+lines.length*62+30);
      ctx.font='400 26px Outfit, sans-serif';
      ctx.fillStyle='#94a3b8';
      ctx.fillText('📍 '+(e.location||'Malta'),540,locY);
    }

    // Recurring badge
    if(e.recurring){
      var recurY=(e.location?(e.event_date?titleY+lines.length*62+120:titleY+lines.length*62+70):(e.event_date?titleY+lines.length*62+80:titleY+lines.length*62+30));
      ctx.font='600 24px Outfit, sans-serif';
      var recurText='🔁 '+e.recurring;
      var recurW=ctx.measureText(recurText).width+30;
      ctx.fillStyle='rgba(29,78,216,0.2)';
      igRoundRect(ctx,540-recurW/2,recurY-8,recurW,40,20);
      ctx.fill();
      ctx.fillStyle='#60a5fa';
      ctx.fillText(recurText,540,recurY+22);
    }

    // Category pill
    if(e.category){
      ctx.font='500 20px Outfit, sans-serif';
      var catW=ctx.measureText(e.category).width+30;
      ctx.fillStyle='rgba(255,56,92,0.15)';
      igRoundRect(ctx,540-catW/2,630-6,catW,32,16);
      ctx.fill();
      ctx.fillStyle='#FF385C';
      ctx.fillText(e.category,540,650);
    }

    // Logo at bottom
    if(igLogoImg&&igLogoImg.complete){
      var lh=55,lw=lh*(igLogoImg.width/igLogoImg.height);
      ctx.drawImage(igLogoImg,540-lw/2,1000,lw,lh);
    } else {
      ctx.font='600 22px Outfit, sans-serif';
      ctx.fillStyle='#64748b';
      ctx.fillText('maltaeventguide.com',540,1040);
    }

    // Bottom accent
    ctx.fillStyle='#FF385C';
    ctx.fillRect(0,1074,1080,6);

    document.getElementById('igDownloadBtn').style.display='';
    igSetCaption(e);
  };

  // Load image: custom upload first, then proxy, then placeholder
  var imgSrc=null;
  if(igCustomImage){
    imgSrc=igCustomImage;
  } else if(e.image_url&&e.image_url.indexOf('http')===0){
    imgSrc='/admin/api/proxy-image?url='+encodeURIComponent(e.image_url);
  }

  if(imgSrc){
    var img=new Image();
    img.crossOrigin='anonymous';
    img.onload=function(){
      // Draw image centered in top area with rounded corners effect
      var iw=img.width,ih=img.height;
      var targetW=900,targetH=550;
      var scale=Math.max(targetW/iw,targetH/ih);
      var sw=iw*scale,sh=ih*scale;
      var sx=540-sw/2,sy=50;
      
      ctx.save();
      igRoundRect(ctx,90,50,900,550,20);
      ctx.clip();
      ctx.drawImage(img,sx,sy,sw,sh);
      ctx.restore();
      
      // Subtle border
      ctx.strokeStyle='rgba(255,255,255,0.1)';
      ctx.lineWidth=2;
      igRoundRect(ctx,90,50,900,550,20);
      ctx.stroke();
      
      afterImage();
    };
    img.onerror=function(){afterImage()};
    img.src=imgSrc;
  } else {
    // No image - draw placeholder
    ctx.fillStyle='#1e293b';
    igRoundRect(ctx,90,50,900,550,20);
    ctx.fill();
    ctx.fillStyle='#334155';
    ctx.font='600 80px Outfit, sans-serif';
    ctx.textAlign='center';
    ctx.fillText('🎵',540,350);
    afterImage();
  }
}

function igGenMulti(type){
  var c=document.getElementById('igCanvas');
  var ctx=c.getContext('2d');
  
  // Get upcoming events
  var now=new Date();
  var events=E.filter(function(e){return e.title&&e.event_date}).slice(0,50);
  
  var selected=[];
  if(type==='weekend'){
    // Find events with dates containing current/next weekend day names or dates
    var dayNames=['Fri','Sat','Sun','Friday','Saturday','Sunday'];
    selected=events.filter(function(e){
      for(var i=0;i<dayNames.length;i++){
        if(e.event_date&&e.event_date.indexOf(dayNames[i])>=0)return true;
      }
      return false;
    }).slice(0,5);
    if(selected.length===0) selected=events.slice(0,5);
  } else {
    selected=events.slice(0,5);
  }

  // Background
  var grad=ctx.createLinearGradient(0,0,1080,1080);
  grad.addColorStop(0,'#0f172a');
  grad.addColorStop(1,'#1e293b');
  ctx.fillStyle=grad;
  ctx.fillRect(0,0,1080,1080);

  // Top accent
  ctx.fillStyle='#FF385C';
  ctx.fillRect(0,0,1080,6);

  // Title
  ctx.fillStyle='white';
  ctx.font='800 56px Outfit, sans-serif';
  ctx.textAlign='center';
  ctx.fillText(type==='weekend'?'THIS WEEKEND IN MALTA':'TOP EVENTS THIS WEEK',540,90);

  // Subtitle
  ctx.font='400 24px Outfit, sans-serif';
  ctx.fillStyle='#94a3b8';
  ctx.fillText('maltaeventguide.com',540,130);

  // Event rows
  var startY=180;
  var rowH=160;
  selected.forEach(function(e,i){
    var y=startY+i*rowH;
    
    // Row background
    ctx.fillStyle=i%2===0?'rgba(30,41,59,0.5)':'rgba(15,23,42,0.5)';
    igRoundRect(ctx,50,y,980,rowH-12,14);
    ctx.fill();

    // Number circle
    ctx.fillStyle='#FF385C';
    ctx.beginPath();
    ctx.arc(110,y+rowH/2-6,28,0,Math.PI*2);
    ctx.fill();
    ctx.fillStyle='white';
    ctx.font='700 28px Outfit, sans-serif';
    ctx.textAlign='center';
    ctx.fillText(''+(i+1),110,y+rowH/2+4);

    // Title
    ctx.textAlign='left';
    ctx.fillStyle='white';
    ctx.font='700 30px Outfit, sans-serif';
    var t=e.title.length>35?e.title.substring(0,35)+'...':e.title;
    ctx.fillText(t,160,y+55);

    // Date & location
    ctx.font='400 22px Outfit, sans-serif';
    ctx.fillStyle='#94a3b8';
    var metaText=(e.event_date||'TBA')+' · '+(e.location||'Malta');
    if(e.recurring) metaText+=' · 🔁 '+e.recurring;
    ctx.fillText(metaText,160,y+90);

    // Category pill
    if(e.category){
      ctx.font='500 18px Outfit, sans-serif';
      var cw=ctx.measureText(e.category).width+20;
      ctx.fillStyle='rgba(255,56,92,0.15)';
      igRoundRect(ctx,160,y+102,cw,28,14);
      ctx.fill();
      ctx.fillStyle='#FF385C';
      ctx.textAlign='left';
      ctx.fillText(e.category,170,y+122);
    }

    ctx.textAlign='center';
  });

  // Logo
  if(igLogoImg&&igLogoImg.complete){
    var lh=55,lw=lh*(igLogoImg.width/igLogoImg.height);
    ctx.drawImage(igLogoImg,540-lw/2,1000,lw,lh);
  }

  // Bottom accent
  ctx.fillStyle='#FF385C';
  ctx.fillRect(0,1074,1080,6);

  document.getElementById('igDownloadBtn').style.display='';

  // Set caption
  var cap=type==='weekend'?'🎉 This weekend in Malta!\\n\\n':'🔥 Top events this week in Malta!\\n\\n';
  selected.forEach(function(e,i){
    cap+=(i+1)+'. '+e.title+(e.event_date?' — '+e.event_date:'')+'\\n';
  });
  cap+='\\n👉 Full listings at maltaeventguide.com\\n\\n#MaltaEvents #WhatsOnMalta #MaltaNightlife #MaltaFestivals #ThingsToDoInMalta #VisitMalta #MaltaLife #ExploreMalta #Malta2026 #MaltaIsland #Valletta #Malta #LifeInMalta #MaltaExperience #MediterraneanLife #IslandLife';
  document.getElementById('igCaption').value=cap;
}

// ========== OUR PICKS ==========
var igPicks=[];

function igPickFilter(){
  var q=document.getElementById('igPickSearch').value.toLowerCase();
  var list=document.getElementById('igPickResults');
  if(!q){list.innerHTML='';return}
  var matches=E.filter(function(e){return e.title&&e.title.toLowerCase().indexOf(q)>=0}).slice(0,10);
  list.innerHTML=matches.map(function(e){
    var already=igPicks.some(function(p){return p.id===e.id});
    return '<div class="ig-pick-row'+(already?' ig-pick-done':'')+'" onclick="igPickAdd('+e.id+')" style="padding:8px 12px;cursor:'+(already?'default':'pointer')+';border-bottom:1px solid #1a2332;display:flex;align-items:center;gap:8px;opacity:'+(already?'0.4':'1')+'">'
      +'<div style="color:white;font-size:0.85rem;font-weight:600">'+esc(e.title)+'</div>'
      +'<div style="color:#64748b;font-size:0.7rem;margin-left:auto;white-space:nowrap">'+(e.event_date||'')+'</div>'
      +(already?'<span style="color:#4ade80;font-size:0.7rem">✓</span>':'')
      +'</div>';
  }).join('');
}

function igPickAdd(id){
  if(igPicks.length>=5)return toast('Maximum 5 events',1);
  var e=E.find(function(x){return x.id===id});
  if(!e||igPicks.some(function(p){return p.id===id}))return;
  igPicks.push(e);
  igPickRender();
  igPickFilter();
}

function igPickRemove(id){
  igPicks=igPicks.filter(function(p){return p.id!==id});
  igPickRender();
}

function igPicksClear(){
  igPicks=[];
  igPickRender();
}

function igPickRender(){
  var html=igPicks.length===0?'<div style="color:#475569;font-size:0.8rem;padding:6px 0">No events selected yet</div>':'';
  igPicks.forEach(function(e,i){
    html+='<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#0f172a;border-radius:8px;margin-bottom:4px">'
      +'<span style="color:#f59e0b;font-weight:700;font-size:0.8rem">'+(i+1)+'</span>'
      +'<span style="color:white;font-size:0.8rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(e.title)+'</span>'
      +'<span onclick="igPickRemove('+e.id+')" style="color:#f87171;cursor:pointer;font-size:0.8rem">✕</span>'
      +'</div>';
  });
  document.getElementById('igPickSelected').innerHTML=html;
}

// ========== FEATURED ==========
function igShowFeatured(){
  var featured=E.filter(function(e){return e.featured});
  if(featured.length===0){
    document.getElementById('igFeaturedList').innerHTML='<div style="color:#f87171;font-size:0.85rem;padding:10px">No featured events. Mark events as ⭐ Featured in the Manage tab first.</div>';
    return;
  }
  document.getElementById('igFeaturedList').innerHTML=featured.map(function(e,i){
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#0f172a;border-radius:8px;margin-bottom:4px">'
      +'<span style="color:#f59e0b;font-size:0.85rem">⭐</span>'
      +'<span style="color:white;font-size:0.85rem;flex:1">'+esc(e.title)+'</span>'
      +'<span style="color:#64748b;font-size:0.7rem">'+(e.event_date||'')+'</span>'
      +'</div>';
  }).join('');
}

function igGenFeatured(){
  var selected=E.filter(function(e){return e.featured}).slice(0,5);
  if(selected.length===0)return toast('No featured events! Mark events as featured first.',1);
  igDrawStyledMulti(selected,'featured');
}

function igGenPicks(){
  if(igPicks.length===0)return toast('Add events to your picks first!',1);
  igDrawStyledMulti(igPicks,'picks');
}

function igDrawStyledMulti(selected,type){
  var c=document.getElementById('igCanvas');
  var ctx=c.getContext('2d');
  
  if(type==='featured'){
    // Gold/premium gradient background
    var grad=ctx.createLinearGradient(0,0,0,1080);
    grad.addColorStop(0,'#1a1207');
    grad.addColorStop(0.3,'#1e1608');
    grad.addColorStop(0.7,'#1a1207');
    grad.addColorStop(1,'#0f0d07');
    ctx.fillStyle=grad;
    ctx.fillRect(0,0,1080,1080);
    
    // Gold accent line top
    ctx.fillStyle='#f59e0b';
    ctx.fillRect(0,0,1080,6);
    
    // Title
    ctx.fillStyle='#fbbf24';
    ctx.font='800 52px Outfit, sans-serif';
    ctx.textAlign='center';
    ctx.fillText('⭐ FEATURED EVENTS ⭐',540,85);
    
    // Subtitle
    ctx.font='400 26px Outfit, sans-serif';
    ctx.fillStyle='#d4a254';
    ctx.fillText("Don't miss these handpicked highlights",540,125);
    
    var accentColor='#f59e0b';
    var accentBg='rgba(245,158,11,0.15)';
    
  } else {
    // Blue/editorial gradient
    var grad=ctx.createLinearGradient(0,0,0,1080);
    grad.addColorStop(0,'#0c1929');
    grad.addColorStop(0.5,'#0f2440');
    grad.addColorStop(1,'#0c1929');
    ctx.fillStyle=grad;
    ctx.fillRect(0,0,1080,1080);
    
    // Blue accent line top
    ctx.fillStyle='#3b82f6';
    ctx.fillRect(0,0,1080,6);
    
    // Title
    ctx.fillStyle='white';
    ctx.font='800 52px Outfit, sans-serif';
    ctx.textAlign='center';
    ctx.fillText('🎯 OUR PICKS',540,85);
    
    // Subtitle
    ctx.font='400 26px Outfit, sans-serif';
    ctx.fillStyle='#60a5fa';
    ctx.fillText('Events we love this week',540,125);
    
    var accentColor='#3b82f6';
    var accentBg='rgba(59,130,246,0.15)';
  }
  
  // "maltaeventguide.com" watermark
  ctx.font='400 20px Outfit, sans-serif';
  ctx.fillStyle='rgba(255,255,255,0.2)';
  ctx.fillText('maltaeventguide.com',540,158);
  
  // Event rows
  var startY=185;
  var rowH=selected.length<=3?200:(selected.length<=4?170:160);
  
  selected.forEach(function(e,i){
    var y=startY+i*rowH;
    
    // Row background
    ctx.fillStyle=i%2===0?'rgba(255,255,255,0.03)':'rgba(255,255,255,0.06)';
    igRoundRect(ctx,50,y,980,rowH-14,14);
    ctx.fill();
    
    // Left accent stripe
    ctx.fillStyle=accentColor;
    igRoundRect(ctx,50,y,6,rowH-14,3);
    ctx.fill();
    
    // Number circle
    ctx.fillStyle=accentColor;
    ctx.beginPath();
    ctx.arc(105,y+rowH/2-7,26,0,Math.PI*2);
    ctx.fill();
    ctx.fillStyle=type==='featured'?'#1a1207':'#0c1929';
    ctx.font='700 26px Outfit, sans-serif';
    ctx.textAlign='center';
    ctx.fillText(''+(i+1),105,y+rowH/2+3);
    
    // Title
    ctx.textAlign='left';
    ctx.fillStyle='white';
    ctx.font='700 30px Outfit, sans-serif';
    var t=e.title.length>38?e.title.substring(0,38)+'...':e.title;
    ctx.fillText(t,155,y+48);
    
    // Date & location
    ctx.font='400 22px Outfit, sans-serif';
    ctx.fillStyle='#94a3b8';
    var metaText='';
    if(e.event_date) metaText+=e.event_date;
    if(e.location&&e.location!=='Malta') metaText+=(metaText?' · ':'')+'📍 '+e.location;
    if(e.recurring) metaText+=(metaText?' · ':'')+'🔁 '+e.recurring;
    if(metaText.length>55) metaText=metaText.substring(0,55)+'...';
    ctx.fillText(metaText,155,y+82);
    
    // Category pill
    if(e.category){
      ctx.font='500 18px Outfit, sans-serif';
      var cw=ctx.measureText(e.category).width+20;
      ctx.fillStyle=accentBg;
      igRoundRect(ctx,155,y+94,cw,28,14);
      ctx.fill();
      ctx.fillStyle=accentColor;
      ctx.textAlign='left';
      ctx.fillText(e.category,165,y+114);
    }
    
    ctx.textAlign='center';
  });
  
  // Logo
  if(igLogoImg&&igLogoImg.complete){
    var lh=55,lw=lh*(igLogoImg.width/igLogoImg.height);
    ctx.drawImage(igLogoImg,540-lw/2,1000,lw,lh);
  } else {
    ctx.font='600 22px Outfit, sans-serif';
    ctx.fillStyle='#64748b';
    ctx.fillText('maltaeventguide.com',540,1040);
  }
  
  // Bottom accent
  ctx.fillStyle=accentColor;
  ctx.fillRect(0,1074,1080,6);
  
  document.getElementById('igDownloadBtn').style.display='';
  
  // Caption
  var cap=type==='featured'?'⭐ Featured Events in Malta!\\n\\n':'🎯 Our top picks this week!\\n\\n';
  selected.forEach(function(e,i){
    cap+=(i+1)+'. '+e.title;
    if(e.event_date) cap+=' — '+e.event_date;
    cap+='\\n';
  });
  cap+='\\n👉 Full listings at maltaeventguide.com\\n\\n#MaltaEvents #WhatsOnMalta #MaltaNightlife #MaltaFestivals #ThingsToDoInMalta #VisitMalta #MaltaLife #ExploreMalta #Malta2026 #MaltaIsland #Valletta #Malta #LifeInMalta #MaltaExperience #MediterraneanLife #IslandLife';
  document.getElementById('igCaption').value=cap;
}

function igSetCaption(e){
  var cap='🎤 '+e.title+'\\n\\n';
  if(e.event_date)cap+='📅 '+e.event_date+'\\n';
  if(e.recurring)cap+='🔁 '+e.recurring+'\\n';
  if(e.location)cap+='📍 '+e.location+'\\n';
  if(e.description){
    var d=e.description.length>200?e.description.substring(0,200)+'...':e.description;
    cap+='\\n'+d+'\\n';
  }
  cap+='\\n👉 Link in bio for full details & more events!\\n\\n#MaltaEvents #WhatsOnMalta #ThingsToDoInMalta #VisitMalta #MaltaLife #ExploreMalta #Malta2026 #MaltaIsland #Valletta #Malta #LifeInMalta #MaltaExperience #MediterraneanLife #IslandLife #MaltaEntertainment #WeekendMalta';
  if(e.category){
    if(e.category.indexOf('Music')>=0||e.category.indexOf('Concert')>=0) cap+=' #LiveMusicMalta #MaltaConcerts';
    if(e.category.indexOf('Nightlife')>=0) cap+=' #MaltaNightlife #Paceville';
    if(e.category.indexOf('Festival')>=0) cap+=' #MaltaFestivals';
    if(e.category.indexOf('Theatre')>=0) cap+=' #MaltaTheatre';
    if(e.category.indexOf('Food')>=0) cap+=' #MaltaFood #MaltaFoodie';
    if(e.category.indexOf('Sport')>=0) cap+=' #MaltaSports';
  }
  document.getElementById('igCaption').value=cap;
}

function igDownload(){
  var c=document.getElementById('igCanvas');
  var link=document.createElement('a');
  link.download='malta-event-guide-post.png';
  link.href=c.toDataURL('image/png');
  link.click();
  toast('Image downloaded!');
}

function igRoundRect(ctx,x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r);
  ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r);
  ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

function igPreview(){igTemplateChange();}
// ========== END INSTAGRAM ==========
`);
});


// =====================================================================
// ADMIN API ROUTES
// =====================================================================

// Parse Excel file
app.post('/admin/api/parse-excel', upload.single('file'), async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    
    const events = rows.map(row => {
      const get = (...keys) => {
        for (const k of keys) {
          for (const col of Object.keys(row)) {
            if (col.toLowerCase().replace(/[^a-z]/g, '').includes(k.toLowerCase().replace(/[^a-z]/g, ''))) {
              if (row[col]) return String(row[col]).trim();
            }
          }
        }
        return '';
      };
      
      const title = get('eventname', 'name', 'title', 'event');
      const date = get('eventdate', 'date');
      const time = get('eventtime', 'time');
      const location = get('eventlocation', 'location', 'venue');
      const price = get('eventprice', 'price', 'cost');
      const link = get('eventlink', 'link', 'url', 'website');
      const contact = get('contact', 'phone', 'email');
      
      if (!title) return null;
      
      let desc = '';
      if (price) desc += 'Price: ' + price;
      if (time) desc += (desc ? ' · ' : '') + 'Time: ' + time;
      if (contact) desc += (desc ? ' · ' : '') + 'Contact: ' + contact;
      
      return {
        title, event_date: date, location, description: desc,
        source_url: link || '', source_name: 'Community Events Malta'
      };
    }).filter(e => e !== null);
    
    res.json({ events, count: events.length });
  } catch (e) {
    console.error('Parse excel error:', e);
    res.json({ error: e.message });
  }
});

// Import events as drafts
app.post('/admin/api/import-drafts', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const events = req.body.events;
    if (!events || !events.length) return res.json({ error: 'No events' });
    
    // Ensure status column exists
    await pool.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'live'").catch(() => {});
    
    let count = 0;
    for (const e of events) {
      const slug = (e.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 80);
      // Make source_url unique by appending draft timestamp if empty or duplicate
      const sourceUrl = e.source_url || ('manual:draft-' + Date.now() + '-' + count);
      try {
        await pool.query(
          `INSERT INTO events (title, event_date, location, description, source_url, source_name, slug, status, image_url, category)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', '', '')
           ON CONFLICT (source_url) DO NOTHING`,
          [e.title, e.event_date, e.location, e.description, sourceUrl, e.source_name || 'Community Events Malta', slug]
        );
        count++;
      } catch(err) {
        // Skip duplicates silently
        console.log('Skipped duplicate:', e.title);
      }
    }
    res.json({ ok: true, count });
  } catch (e) {
    console.error('Import drafts error:', e);
    res.json({ error: e.message });
  }
});

// Get draft events
app.get('/admin/api/drafts', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const result = await pool.query("SELECT * FROM events WHERE status = 'draft' ORDER BY id DESC");
    res.json(result.rows);
  } catch (e) {
    res.json([]);
  }
});

app.delete('/admin/api/drafts/delete-all', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const result = await pool.query("DELETE FROM events WHERE status = 'draft'");
    res.json({ ok: true, deleted: result.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clean up locations in database (removes "View map", ", Malta" etc)
app.post('/admin/api/cleanup-locations', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const result = await pool.query("SELECT id, location FROM events WHERE location IS NOT NULL AND (location LIKE '%View map%' OR location LIKE '%, Malta%')");
    let fixed = 0;
    for (const row of result.rows) {
      let loc = row.location
        .replace(/\s*View map\s*/gi, '')
        .replace(/,\s*Malta\s*$/i, '')
        .replace(/,\s*Malta,\s*/i, ', ')
        .replace(/\s+/g, ' ')
        .trim();
      if (loc !== row.location) {
        await pool.query('UPDATE events SET location = $1 WHERE id = $2', [loc, row.id]);
        fixed++;
      }
    }
    res.json({ ok: true, fixed, checked: result.rows.length });
  } catch (e) { res.json({ error: e.message }); }
});

// Remove duplicate events - keeps the one with most data
app.post('/admin/api/remove-duplicates', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const result = await pool.query('SELECT * FROM events ORDER BY id');
    const events = result.rows;
    
    // Group by normalized title
    const groups = {};
    events.forEach(e => {
      const key = (e.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (key.length < 5) return;
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    });
    
    let removed = 0;
    const toDelete = [];
    
    for (const key of Object.keys(groups)) {
      if (groups[key].length <= 1) continue;
      
      const dupes = groups[key];
      // Score each duplicate - higher = more data = keep this one
      dupes.forEach(e => {
        e._score = 0;
        if (e.image_url && e.image_url.startsWith('http')) e._score += 10;
        if (e.description && e.description.length > 20) e._score += 5;
        if (e.description && e.description.length > 100) e._score += 5;
        if (e.category) e._score += 3;
        if (e.event_date) e._score += 3;
        if (e.location && e.location !== 'Malta') e._score += 2;
        if (e.recurring) e._score += 1;
        // Prefer certain sources
        const src = (e.source_url || '').toLowerCase();
        if (src.includes('showshappening')) e._score += 1;
        if (src.includes('visitmalta')) e._score += 1;
        if (src.includes('ra.co')) e._score += 2;
      });
      
      // Sort by score descending - keep the best one
      dupes.sort((a, b) => b._score - a._score);
      
      // Keep first (best), delete the rest
      for (let i = 1; i < dupes.length; i++) {
        toDelete.push(dupes[i].id);
      }
    }
    
    if (toDelete.length > 0) {
      await pool.query('DELETE FROM events WHERE id = ANY($1)', [toDelete]);
      removed = toDelete.length;
    }
    
    res.json({ ok: true, removed, checked: events.length });
  } catch (e) {
    console.error('Remove duplicates error:', e);
    res.json({ error: e.message });
  }
});

// Image proxy for Instagram post generator (avoids CORS)
app.get('/admin/api/proxy-image', async (req, res) => {
  if (!authCheck(req, res)) return;
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');
  try {
    const https = require('https');
    const http = require('http');
    const mod = url.startsWith('https') ? https : http;
    
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' }, timeout: 10000 }, (imgRes) => {
      if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
        // Follow redirect
        mod.get(imgRes.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' } }, (imgRes2) => {
          res.type(imgRes2.headers['content-type'] || 'image/jpeg');
          res.set({ 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
          imgRes2.pipe(res);
        }).on('error', () => res.status(500).send('Failed'));
        return;
      }
      if (imgRes.statusCode !== 200) return res.status(404).send('Not found');
      res.type(imgRes.headers['content-type'] || 'image/jpeg');
      res.set({ 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
      imgRes.pipe(res);
    }).on('error', () => res.status(500).send('Failed'));
  } catch (e) {
    res.status(500).send('Failed to fetch image');
  }
});

// Get all events
app.get('/admin/api/events', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    // Try with category column first, fallback without it
    let result;
    try {
      result = await pool.query("SELECT id, title, source_url, image_url, event_date, location, description, category, source_name, recurring, COALESCE(status,'live') as status, COALESCE(featured,FALSE) as featured FROM events ORDER BY title");
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
    const { title, event_date, location, source_name, category, description, recurring, status, featured } = req.body;
    let { image_url, source_url } = req.body;
    // Auto-fix URLs missing protocol
    if (source_url && !source_url.startsWith('http') && !source_url.startsWith('manual:')) source_url = 'https://' + source_url;
    if (image_url && !image_url.startsWith('http')) image_url = 'https://' + image_url;
    await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS source_name TEXT').catch(()=>{});
    await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS recurring TEXT').catch(()=>{});
    await pool.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'live'").catch(()=>{});
    await pool.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT FALSE").catch(()=>{});
    
    // If only status is being updated (publish action)
    if (status && !title) {
      await pool.query('UPDATE events SET status=$1 WHERE id=$2', [status, req.params.id]);
      return res.json({ success: true });
    }
    
    await pool.query(
      `UPDATE events SET title=$1, event_date=$2, location=$3, source_name=$4, category=$5, image_url=$6, source_url=$7, description=$8, recurring=$9, slug=$10, status=COALESCE($12, status, 'live'), featured=COALESCE($13, featured, FALSE) WHERE id=$11`,
      [title, event_date, location, source_name, category, image_url, source_url, description, recurring || null, generateSlug(title) + '-' + req.params.id, req.params.id, status || null, featured !== undefined ? featured : null]
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

// =====================================================================
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
      const endDate = getEndDate(event.event_date);
      const startDate = getStartDate(event.event_date);
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

app.listen(3000, () => console.log('Server running at http://localhost:3000'));
