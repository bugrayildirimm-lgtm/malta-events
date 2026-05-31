/**
 * Analytics Tab
 */

var analyticsTopEvents = [];
var analyticsSubscribers = [];

function loadAnalytics() {
  fetch('/admin/api/analytics', { headers: { Authorization: auth } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      // Clean, simple stat cards
      var h = '<div class="sc"><div class="num">' + (d.total_clicks || 0) + '</div><div class="lbl">Total Clicks</div></div>';
      h += '<div class="sc"><div class="num">' + (d.today_clicks || 0) + '</div><div class="lbl">Today</div></div>';
      h += '<div class="sc"><div class="num">' + (d.week_clicks || 0) + '</div><div class="lbl">This Week</div></div>';
      h += '<div class="sc"><div class="num">' + (d.unique_events || 0) + '</div><div class="lbl">Unique Events</div></div>';

      var cards = document.getElementById('statCards');
      if (cards) cards.innerHTML = h;

      // Store data for filtering
      analyticsTopEvents = (d.top_events || []).slice(0, 8);
      renderTopEventsTable(analyticsTopEvents);

      // Populate source filter dropdown dynamically
      var sourceSelect = document.getElementById('topSourceFilter');
      if (sourceSelect) {
        // Clear existing options except "All Sources"
        while (sourceSelect.options.length > 1) sourceSelect.remove(1);

        var sources = {};
        analyticsTopEvents.forEach(function(e) {
          if (e.source) sources[e.source] = true;
        });

        Object.keys(sources).sort().forEach(function(src) {
          var opt = document.createElement('option');
          opt.value = src;
          opt.textContent = src;
          sourceSelect.appendChild(opt);
        });
      }

      // Source summary (compact) - no filter needed, small list
      var srcH = '<tr><th>Source</th><th>Clicks</th></tr>';
      (d.source_totals || []).slice(0, 6).forEach(function (s) {
        srcH += '<tr><td>' + esc(s.source) + '</td><td><strong>' + (s.clicks || 0) + '</strong></td></tr>';
      });
      var srcTable = document.getElementById('sourceTable');
      if (srcTable) srcTable.innerHTML = srcH;
    })
    .catch(function () { });

  // Also load email subscribers (separate lightweight call)
  loadSubscribers();
}

function loadSubscribers() {
  fetch('/admin/api/subscribers', { headers: { Authorization: auth } })
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      analyticsSubscribers = rows || [];

      var countEl = document.getElementById('subCount');
      if (countEl) countEl.textContent = '(' + analyticsSubscribers.length + ' total)';

      renderSubscribersTable(analyticsSubscribers);
    })
    .catch(function () {
      var c = document.getElementById('subscribersList');
      if (c) c.innerHTML = '<div style="color:#ef4444">Failed to load subscribers</div>';
    });
}

function renderTopEventsTable(events) {
  var topTable = document.getElementById('topTable');
  if (!topTable) return;

  var topH = '<tr><th>Event</th><th>Source</th><th>Clicks</th></tr>';
  events.forEach(function (c) {
    topH += '<tr><td>' + esc(c.event_title) + '</td><td>' + esc(c.source || '') + '</td><td><strong>' + (c.clicks || 0) + '</strong></td></tr>';
  });
  topTable.innerHTML = topH;
}

function filterTopEvents() {
  var q = (document.getElementById('topSearch') ? document.getElementById('topSearch').value : '').toLowerCase();
  var srcFilter = document.getElementById('topSourceFilter') ? document.getElementById('topSourceFilter').value : '';

  var filtered = analyticsTopEvents.filter(function (e) {
    var titleMatch = (e.event_title || '').toLowerCase().includes(q);
    var sourceMatch = !srcFilter || (e.source || '').toLowerCase() === srcFilter.toLowerCase();
    return titleMatch && sourceMatch;
  });

  renderTopEventsTable(filtered);
}

function renderSubscribersTable(rows) {
  var container = document.getElementById('subscribersList');
  if (!container) return;

  if (!rows || !rows.length) {
    container.innerHTML = '<div style="color:#64748b;padding:8px">No subscribers yet.</div>';
    return;
  }

  var html = '<table style="width:100%;font-size:0.9rem;border-collapse:collapse">';
  html += '<tr><th style="text-align:left;padding:6px 8px;border-bottom:1px solid #334155;color:#94a3b8">Email</th><th style="text-align:left;padding:6px 8px;border-bottom:1px solid #334155;color:#94a3b8">Subscribed</th></tr>';
  rows.forEach(function (s) {
    var date = (s.subscribed_at || '').substring(0, 10);
    html += '<tr><td style="padding:6px 8px;border-bottom:1px solid #1e293b">' + esc(s.email) + '</td><td style="padding:6px 8px;border-bottom:1px solid #1e293b;color:#64748b">' + date + '</td></tr>';
  });
  html += '</table>';
  container.innerHTML = html;
}

function filterSubscribers() {
  var q = (document.getElementById('subSearch') ? document.getElementById('subSearch').value : '').toLowerCase();

  var filtered = analyticsSubscribers.filter(function (s) {
    return (s.email || '').toLowerCase().includes(q);
  });

  renderSubscribersTable(filtered);
}

function previewNewsletter() {
  var subject = document.getElementById('nlSubject').value.trim();
  var previewText = document.getElementById('nlPreview').value.trim();

  fetch('/admin/api/newsletter-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ subject: subject, previewText: previewText })
  })
  .then(r => r.text())
  .then(html => {
    var w = window.open('', '_blank');
    w.document.write(html);
  })
  .catch(() => toast('Preview failed', 1));
}

function sendNewsletter() {
  var subject = document.getElementById('nlSubject').value.trim();
  var previewText = document.getElementById('nlPreview').value.trim();
  var resultEl = document.getElementById('nlResult');

  if (!subject) return toast('Please enter a subject', 1);

  if (!confirm('Send this newsletter to ALL subscribers?')) return;

  resultEl.textContent = 'Sending...';

  api('POST', '/admin/api/send-newsletter', { subject: subject, previewText: previewText }, function (res) {
    if (res.ok) {
      resultEl.innerHTML = '<span style="color:#4ade80">✅ Sent to ' + (res.sent || 0) + ' subscribers (' + (res.eventsIncluded || 0) + ' events)</span>';
      toast('Newsletter sent!');
    } else {
      resultEl.innerHTML = '<span style="color:#ef4444">Error: ' + (res.error || 'Failed') + '</span>';
    }
  });
}

function autoGenerateNewsletter() {
  const now = new Date();
  const weekLabel = now.toLocaleDateString('en-GB', { month: 'long', day: 'numeric' });

  const subject = `This Week in Malta — ${weekLabel}`;
  const preview = 'The best unique events happening this week (no recurring or ongoing)';

  document.getElementById('nlSubject').value = subject;
  document.getElementById('nlPreview').value = preview;

  toast('Auto-filled for this week\'s unique events. Opening preview...');

  // Automatically show what the newsletter will look like
  setTimeout(() => {
    previewNewsletter();
  }, 600);
}
