/**
 * Upload / Excel + Drafts Tab
 */

function uploadFile() {
  var f = document.getElementById('uploadFile').files[0];
  if (!f) return toast('Select a file');

  var fd = new FormData();
  fd.append('file', f);

  fetch('/admin/api/parse-excel', {
    method: 'POST',
    headers: { Authorization: auth },
    body: fd
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.events || !d.events.length) return toast('No events found');

      var p = document.getElementById('uploadPreview');
      p.style.display = 'block';
      p.innerHTML = '<h4>Preview (' + d.events.length + ' events)</h4><button onclick="importDrafts()">Import All</button><div id="prevList"></div>';

      var html = '';
      d.events.forEach(function (e, i) {
        html += '<div style="padding:6px 0;border-bottom:1px solid #334155">' + esc(e.title) + ' — ' + esc(e.event_date || 'no date') + '</div>';
      });
      document.getElementById('prevList').innerHTML = html;
      window._drafts = d.events;
    })
    .catch(function () { toast('Upload failed', 1); });
}

function importDrafts() {
  if (!window._drafts) return;
  api('POST', '/admin/api/import-drafts', { events: window._drafts }, function (d) {
    toast('Imported ' + d.count + ' events');
    location.reload();
  });
}
