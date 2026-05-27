/**
 * Date parsing and formatting utilities for Malta Event Guide.
 * 
 * This module contains robust logic for parsing the wide variety of
 * date formats coming from different event sources (VisitMalta, ShowsHappening,
 * Resident Advisor, EventWorks, etc.).
 */

const MONTHS = {
  'jan':0,'january':0,'feb':1,'february':1,'mar':2,'march':2,
  'apr':3,'april':3,'may':4,'jun':5,'june':5,
  'jul':6,'july':6,'aug':7,'august':7,'sep':8,'september':8,
  'oct':9,'october':9,'nov':10,'november':10,'dec':11,'december':11
};

function monthToNum(s) { 
  return MONTHS[(s||'').toLowerCase()] ?? null; 
}

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
// DATE BADGE (used for visual cards)
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

module.exports = {
  MONTHS,
  monthToNum,
  parseSingleDate,
  getStartDate,
  getEndDate,
  getNextDate,
  looksLikeDate,
  getDateBadge,
  extractDM,
  badge
};
