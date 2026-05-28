/**
 * Analytics Tab
 */

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

      // Simple Top 8 clicked events
      var topH = '<tr><th>Event</th><th>Clicks</th></tr>';
      (d.top_events || []).slice(0, 8).forEach(function (c) {
        topH += '<tr><td>' + esc(c.event_title) + '</td><td><strong>' + (c.clicks || 0) + '</strong></td></tr>';
      });
      var topTable = document.getElementById('topTable');
      if (topTable) topTable.innerHTML = topH;

      // Source summary (compact)
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
      var container = document.getElementById('subscribersList');
      var countEl = document.getElementById('subCount');
      if (countEl) countEl.textContent = '(' + (rows.length || 0) + ' total)';

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
    })
    .catch(function () {
      var c = document.getElementById('subscribersList');
      if (c) c.innerHTML = '<div style="color:#ef4444">Failed to load subscribers</div>';
    });
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
      resultEl.innerHTML = '<span style="color:#4ade80">✅ Sent to ' + (res.sent || 0) + ' subscribers</span>';
      toast('Newsletter sent!');
    } else {
      resultEl.innerHTML = '<span style="color:#ef4444">Error: ' + (res.error || 'Failed') + '</span>';
    }
  });
}
