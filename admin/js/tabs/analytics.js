/**
 * Analytics Tab
 */

function loadAnalytics() {
  fetch('/admin/api/analytics', { headers: { Authorization: auth } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var h = '<div class="sc"><div class="num">' + d.total + '</div><div class="lbl">Total Events</div></div>';
      h += '<div class="sc"><div class="num">' + d.today_clicks + '</div><div class="lbl">Clicks Today</div></div>';
      h += '<div class="sc"><div class="num">' + d.week_clicks + '</div><div class="lbl">Clicks This Week</div></div>';

      var cards = document.getElementById('statCards');
      if (cards) cards.innerHTML = h;

      var th = '<tr><th>Event</th><th>Source</th><th>When</th></tr>';
      (d.recent || []).forEach(function (c) {
        th += '<tr><td>' + esc(c.event_title) + '</td><td>' + esc(c.source) + '</td><td>' + (c.clicked_at || '').substring(0, 16) + '</td></tr>';
      });

      var table = document.getElementById('clickTable');
      if (table) table.innerHTML = th;
    })
    .catch(function () { });
}
