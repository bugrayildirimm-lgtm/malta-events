/**
 * Dates Tab
 */

function af2() {
  var q = (document.getElementById('sf2') ? document.getElementById('sf2').value : '').toLowerCase();
  var src = document.getElementById('ss2') ? document.getElementById('ss2').value : 'all';
  var mode = sf2v;

  var f = E.filter(function (e) {
    if (src !== 'all' && !((e.source_name || '').toLowerCase().includes(src))) return false;
    if (mode === 'missing' && e.event_date) return false;
    if (mode === 'has' && !e.event_date) return false;
    return (e.title || '').toLowerCase().includes(q) || (e.location || '').toLowerCase().includes(q);
  }).slice(0, 80);

  var h = '';
  f.forEach(function (e) {
    h += '<div class="ec"><div class="ep">' +
      (e.image_url ? '<img src="' + e.image_url + '" style="width:100%;height:100%;object-fit:cover">' : '<div class="ni">No image</div>') +
      '</div><div class="ei"><div class="src">' + (e.source_name || 'Other') + '</div><div class="ttl">' + esc(e.title) + '</div>' +
      '<div class="mt">' + esc(e.event_date || 'No date') + ' · ' + esc(e.location || '') + '</div>' +
      '<div class="fr"><input id="d' + e.id + '" value="' + esc(e.event_date || '') + '"><button onclick="setDate(' + e.id + ')">Save</button></div>' +
      '</div></div>';
  });
  var eg = document.getElementById('eg2');
  if (eg) eg.innerHTML = h;
}

function sdf(m, el) {
  document.querySelectorAll('#datesTab .fb').forEach(function (x) { x.classList.remove('active'); });
  if (el) el.classList.add('active');
  sf2v = m;
  af2();
}

function setDate(id) {
  var v = document.getElementById('d' + id).value.trim();
  api('PUT', '/admin/api/events/' + id + '/date', { event_date: v }, function () {
    toast('Saved');
    E.forEach(function (x) { if (x.id === id) x.event_date = v; });
    af2();
    us();
  });
}
