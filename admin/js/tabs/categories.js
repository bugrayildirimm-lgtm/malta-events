/**
 * Categories Tab
 */

var sf3v = 'uncat';   // 'uncat' or 'all'

function af3() {
  var q = (document.getElementById('sf3') ? document.getElementById('sf3').value : '').toLowerCase();
  var src = document.getElementById('ss3') ? document.getElementById('ss3').value : 'all';

  var f = E.filter(function (e) {
    if (src !== 'all' && !((e.source_name || '').toLowerCase().includes(src))) return false;

    var matchSearch = (e.title || '').toLowerCase().includes(q) || (e.location || '').toLowerCase().includes(q);

    if (sf3v === 'uncat') {
      return !e.category && matchSearch;
    } else {
      return matchSearch;   // show all events when "All" is selected
    }
  }).slice(0, 80);

  var h = '';
  f.forEach(function (e) {
    h += '<div class="ec"><div class="ep">' +
      (e.image_url ? '<img src="' + e.image_url + '" style="width:100%;height:100%;object-fit:cover">' : '<div class="ni">No image</div>') +
      '</div><div class="ei"><div class="src">' + (e.source_name || 'Other') + '</div><div class="ttl">' + esc(e.title) + '</div>' +
      '<div class="mt">' + esc(e.event_date || '') + ' · ' + esc(e.location || '') + '</div>' +
      '<div class="fa">' + catChips(e.id) + '</div></div></div>';
  });
  var eg = document.getElementById('eg3');
  if (eg) eg.innerHTML = h;
}

function scf(m, el) {
  document.querySelectorAll('#categoriesTab .fb').forEach(function (x) { x.classList.remove('active'); });
  if (el) el.classList.add('active');
  sf3v = m;
  af3();
}

function catChips(id) {
  var cats = ['Music & Concerts', 'Theatre & Shows', 'Dance', 'Nightlife & Parties', 'Festivals', 'Arts & Culture', 'Sports & Adventure', 'Food & Drink', 'Family', 'Religious', 'Conference', 'Other'];
  return cats.map(function (c) {
    return '<button onclick="setCat(' + id + ',\'' + c + '\')">' + c + '</button>';
  }).join('');
}

function setCat(id, cat) {
  api('PUT', '/admin/api/events/' + id + '/category', { category: cat }, function () {
    toast('Category set');
    E.forEach(function (x) { if (x.id === id) x.category = cat; });
    af3();
    af1();
    af4();
    us();
  });
}
