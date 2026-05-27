/**
 * Images Tab
 */

function af1() {
  var q = (document.getElementById('sf1') ? document.getElementById('sf1').value : '').toLowerCase();
  var src = document.getElementById('ss1') ? document.getElementById('ss1').value : 'all';
  var mode = sf1v;

  var f = E.filter(function (e) {
    if (src !== 'all' && !((e.source_name || '').toLowerCase().includes(src))) return false;
    if (mode === 'missing' && vi(e)) return false;
    if (mode === 'has' && !vi(e)) return false;
    return (e.title || '').toLowerCase().includes(q) || (e.location || '').toLowerCase().includes(q);
  }).slice(0, 80);

  var h = '';
  f.forEach(function (e) {
    h += '<div class="ec"><div class="ep">' +
      (vi(e) ? '<img src="' + e.image_url + '" style="width:100%;height:100%;object-fit:cover">' : '<div class="ni">No image</div>') +
      '</div><div class="ei"><div class="src">' + (e.source_name || 'Other') + '</div><div class="ttl">' + esc(e.title) + '</div>' +
      '<div class="mt">' + esc(e.event_date || 'No date') + ' · ' + esc(e.location || '') + '</div>' +
      '<div class="fr"><input id="i' + e.id + '" placeholder="New image URL"><button onclick="setImage(' + e.id + ')">Save</button></div>' +
      '</div></div>';
  });
  var eg = document.getElementById('eg1');
  if (eg) eg.innerHTML = h;
}

function ssf(m, el) {
  document.querySelectorAll('#imagesTab .fb').forEach(function (x) { x.classList.remove('active'); });
  if (el) el.classList.add('active');
  sf1v = m;
  af1();
}

function setImage(id) {
  var v = document.getElementById('i' + id).value.trim();
  if (!v) return toast('Enter URL');
  api('PUT', '/admin/api/events/' + id + '/image', { image_url: v }, function () {
    toast('Saved');
    E.forEach(function (x) { if (x.id === id) x.image_url = v; });
    af1();
    us();
  });
}
