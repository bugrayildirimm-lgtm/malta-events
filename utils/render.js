/**
 * Reusable HTML rendering helpers for Malta Event Guide.
 * These functions return HTML strings and help reduce the size of
 * giant template literals inside server.js.
 */

const dates = require('./dates');

/**
 * Renders a single event card (used on homepage, category pages, etc.)
 */
function createCard(event, isPast) {
  let source = event.source_name || 'Other';
  if (!event.source_name) {
    if (event.source_url && event.source_url.includes('showshappening')) source = 'ShowsHappening';
    else if (event.source_url && event.source_url.includes('visitmalta')) source = 'VisitMalta';
    else if (event.source_url && event.source_url.includes('eventbrite')) source = 'Eventbrite';
  }

  let title = event.title || '';
  if (dates.looksLikeDate(title) || title.startsWith('Price:') || title.includes('€')) {
    const parts = (event.source_url || '').split('/');
    const slug = parts[parts.length - 1] || parts[parts.length - 2] || '';
    if (slug && slug.length > 3) {
      title = decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
    }
    if (dates.looksLikeDate(event.title) && !event.event_date) event.event_date = event.title;
  }

  const firstLetter = title ? title.charAt(0).toUpperCase() : '?';
  const colors = [
    'linear-gradient(135deg, #FF9A9E 0%, #FECFEF 100%)',
    'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
    'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)',
    'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)'
  ];
  const bgStyle = colors[(firstLetter.charCodeAt(0) || 0) % colors.length];
  const dateHTML = dates.getDateBadge(event.event_date);
  let desc = event.description || '';
  if (!desc || desc === 'null') desc = '';

  const hasRange = event.event_date && (event.event_date.includes(' - ') || / to /i.test(event.event_date));
  const isMultiDay = event.event_date && /^\d[\d,\s]+\s+[A-Za-z]/.test(event.event_date) && event.event_date.includes(',');
  const isRecurring = !!(event.recurring && event.recurring.trim());

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
  const safeTitle = (title || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');

  // Note: generateSlug is still defined in server.js for now
  // We'll pass the slug in or handle it at call site for now.
  const slug = event.slug || 'event';
  const startDate = dates.getStartDate(event.event_date);
  const endDate = dates.getEndDate(event.event_date);
  const startDateStr = startDate ? startDate.toISOString().split('T')[0] : '';
  const endDateStr = endDate ? endDate.toISOString().split('T')[0] : '';

  return `
    <div class="card event-item ${gray}" data-source="${sourceLower}" data-location="${(event.location || 'malta').toLowerCase()}" data-category="${(event.category || '').toLowerCase()}" data-startdate="${startDateStr}" data-enddate="${endDateStr}" data-recurring="${event.recurring || ''}">
        <a href="/event/${slug}" class="card-media-link">
        <div class="card-media">
            ${dateHTML} ${expired}
            <div class="fallback" style="background: ${bgStyle}; position:absolute;top:0;left:0;z-index:1;">${firstLetter}</div>
            ${hasImg ? '<img src="' + event.image_url + '" alt="' + (event.title || '').replace(/"/g, '&quot;') + ' in Malta" class="card-img" style="position:relative;z-index:2;" loading="lazy" width="400" height="220" onerror="this.hidden=1">' : ''}
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
}

/**
 * Renders the newsletter signup box (used on homepage and other pages)
 */
function renderNewsletterBox() {
  return `
    <div style="max-width:600px;margin:50px auto 0;padding:0 20px">
      <div class="newsletter-box">
        <div style="font-size:2rem;margin-bottom:5px">📬</div>
        <h2>Never Miss an Event in Malta</h2>
        <p>Get weekly updates on the best events, festivals & things to do in Malta and Gozo.</p>
        <div class="newsletter-form" id="emailForm">
          <input type="email" id="subEmail" placeholder="Your email address">
          <button onclick="subscribeEmail()">Subscribe</button>
        </div>
        <div id="subMsg" class="newsletter-msg"></div>
        <p style="color:#475569;font-size:0.7rem;margin:15px 0 0">No spam, unsubscribe anytime. We respect your privacy.</p>
      </div>
    </div>
  `;
}

/**
 * Renders the "⭐ Featured Events" section on the homepage
 */
function renderFeaturedEvents(allEvents, generateSlugFn) {
  const featured = allEvents.filter(e => e.featured);
  if (featured.length === 0) return '';

  const fCount = featured.length;
  const colWidth = fCount === 1 ? '380px' : '320px';

  const items = featured.map(e => {
    const slug = e.slug || generateSlugFn(e.title);
    const img = e.image_url && e.image_url.startsWith('http') ? e.image_url : '';
    const catEmoji = {
      'Music & Concerts': '🎵', 'Theatre & Shows': '🎭', 'Dance': '💃',
      'Nightlife & Parties': '🎉', 'Festivals': '🎪', 'Arts & Culture': '🎨',
      'Sports & Adventure': '🏃', 'Food & Drink': '🍷', 'Family': '👨‍👩‍👧',
      'Religious': '⛪', 'Conference': '📋', 'Other': '📌'
    }[e.category] || '📌';

    const imgHtml = img
      ? `<div style="overflow:hidden;height:280px"><img src="${img}" alt="${(e.title || '').replace(/"/g, '&quot;')} — event in Malta" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block"></div>`
      : `<div style="height:120px;background:linear-gradient(135deg,#0f172a,#1e3a5f);display:flex;align-items:center;justify-content:center;font-size:3rem">${catEmoji}</div>`;

    return `<a href="/event/${slug}" style="text-decoration:none;display:block;background:white;border-radius:20px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);border:2px solid #fbbf24;transition:all 0.3s;width:${colWidth};flex-shrink:0" onmouseover="this.style.transform='translateY(-4px)';this.style.boxShadow='0 12px 35px rgba(251,191,36,0.2)'" onmouseout="this.style.transform='';this.style.boxShadow='0 4px 20px rgba(0,0,0,0.08)'">`
      + imgHtml
      + `<div style="padding:16px 18px 18px">`
      + `<div style="display:inline-block;background:linear-gradient(135deg,#f59e0b,#d97706);color:white;padding:3px 10px;border-radius:20px;font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">⭐ Featured</div>`
      + `<div style="font-size:1.1rem;font-weight:800;color:#0f172a;line-height:1.3;margin-bottom:6px">${e.title || ''}</div>`
      + `<div style="display:flex;align-items:center;gap:6px;font-size:0.82rem;color:#64748b;margin-bottom:3px"><span style="font-size:0.9rem">📅</span> ${e.event_date || 'TBA'}</div>`
      + `<div style="display:flex;align-items:center;gap:6px;font-size:0.82rem;color:#64748b"><span style="font-size:0.9rem">📍</span> ${e.location || 'Malta'}</div>`
      + `</div></a>`;
  }).join('');

  return `
    <div style="max-width:1400px;margin:0 auto;padding:0 20px 25px">
      <h2 style="font-size:1.3rem;font-weight:800;margin:0 0 15px;color:#1e293b">⭐ Featured Events</h2>
      <div style="display:flex;flex-wrap:wrap;gap:20px;justify-content:center">
        ${items}
      </div>
    </div>`;
}

module.exports = {
  createCard,
  renderNewsletterBox,
  renderFeaturedEvents
};