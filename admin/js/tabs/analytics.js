/**
 * Analytics Tab
 */

function loadAnalytics() {
  fetch('/admin/api/analytics', { headers: { Authorization: auth } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      // Stat cards - use the actual keys returned by the API
      var h = '<div class="sc"><div class="num">' + (d.total_clicks || 0) + '</div><div class="lbl">Total Clicks</div></div>';
      h += '<div class="sc"><div class="num">' + (d.today_clicks || 0) + '</div><div class="lbl">Clicks Today</div></div>';
      h += '<div class="sc"><div class="num">' + (d.week_clicks || 0) + '</div><div class="lbl">Clicks This Week</div></div>';
      h += '<div class="sc"><div class="num">' + (d.month_clicks || 0) + '</div><div class="lbl">Clicks This Month</div></div>';
      h += '<div class="sc"><div class="num">' + (d.unique_events || 0) + '</div><div class="lbl">Unique Events Clicked</div></div>';

      var cards = document.getElementById('statCards');
      if (cards) cards.innerHTML = h;

      // Top clicked events
      var topH = '<tr><th>Event</th><th>Source</th><th>Clicks</th><th>Last</th></tr>';
      (d.top_events || []).slice(0, 12).forEach(function (c) {
        topH += '<tr><td>' + esc(c.event_title) + '</td><td>' + esc(c.source || '') + '</td><td><strong>' + (c.clicks || 0) + '</strong></td><td>' + (c.last_click || '').substring(0, 16) + '</td></tr>';
      });
      var topTable = document.getElementById('topTable');
      if (topTable) topTable.innerHTML = topH;

      // Source breakdown
      var srcH = '<tr><th>Source</th><th>Clicks</th></tr>';
      (d.source_totals || []).forEach(function (s) {
        srcH += '<tr><td>' + esc(s.source) + '</td><td><strong>' + (s.clicks || 0) + '</strong></td></tr>';
      });
      var srcTable = document.getElementById('sourceTable');
      if (srcTable) srcTable.innerHTML = srcH;

      // Recent clicks (keep the original table)
      var th = '<tr><th>Event</th><th>Source</th><th>When</th></tr>';
      // Note: the /analytics endpoint currently does not return a "recent" array.
      // We show a small note instead of leaving it empty.
      var recentTable = document.getElementById('clickTable');
      if (recentTable) {
        recentTable.innerHTML = th + '<tr><td colspan="3" style="color:#64748b;padding:12px">Recent individual clicks are available in the click_tracking table. Top events and source breakdown shown above.</td></tr>';
      }
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
