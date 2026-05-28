/**
 * Manage Tab (full edit + delete)
 */

function af4() {
  var q = (document.getElementById('sf4') ? document.getElementById('sf4').value : '').toLowerCase();
  var src = document.getElementById('ss4') ? document.getElementById('ss4').value : 'all';

  var f = E.filter(function (e) {
    if (src !== 'all' && !((e.source_name || '').toLowerCase().includes(src))) return false;
    return (e.title || '').toLowerCase().includes(q) || (e.location || '').toLowerCase().includes(q);
  }).slice(0, 100);

  var h = '';
  f.forEach(function (e) {
    h += '<div class="ec"><div class="ep">' +
      (e.image_url ? '<img src="' + e.image_url + '" style="width:100%;height:100%;object-fit:cover">' : '<div class="ni">No image</div>') +
      '</div><div class="ei"><div class="src">' + (e.source_name || 'Other') + '</div><div class="ttl">' + esc(e.title) + '</div>' +
      '<div class="mt">' + esc(e.event_date || 'No date') + ' · ' + esc(e.location || '') + '</div>' +
      '<div class="fr"><input id="e' + e.id + '" value="' + esc(e.event_date || '') + '"><button onclick="updE(' + e.id + ')">Save</button><button onclick="delE(' + e.id + ')" class="del">Delete</button></div>' +
      '</div></div>';
  });
  var eg = document.getElementById('eg4');
  if (eg) eg.innerHTML = h;
}

function updE(id) {
  var v = document.getElementById('e' + id).value.trim();
  api('PUT', '/admin/api/events/' + id, { event_date: v }, function () {
    toast('Updated');
    E.forEach(function (x) { if (x.id === id) x.event_date = v; });
    af4();
  });
}

function delE(id) {
  if (!confirm('Delete this event?')) return;
  api('DELETE', '/admin/api/events/' + id, {}, function () {
    toast('Deleted');
    E = E.filter(function (x) { return x.id !== id; });
    af4();
    af1();
    af2();
    af3();
    us();
  });
}

function removeDuplicates() {
  if (!confirm('Remove duplicate events? This will keep the best version of each (most complete data) and delete the rest. This cannot be undone.')) return;

  api('POST', '/admin/api/remove-duplicates', {}, function (res) {
    if (res.ok) {
      toast('Removed ' + (res.removed || 0) + ' duplicates');
      // Refresh data
      fetch('/admin/api/events', { headers: { Authorization: auth } })
        .then(r => r.json())
        .then(data => {
          E = data;
          af4();
          us();
        });
    } else {
      toast('Error: ' + (res.error || 'Failed'), 1);
    }
  });
}
