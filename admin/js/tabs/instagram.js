/**
 * Instagram Image Picker Tab
 */

function searchInstagram() {
  var q = (document.getElementById('igSearch') ? document.getElementById('igSearch').value : '').toLowerCase();
  var res = E.filter(function (e) { return (e.title || '').toLowerCase().includes(q); }).slice(0, 20);

  var h = '';
  res.forEach(function (e) {
    h += '<div class="ec" onclick="pickIg(' + e.id + ')"><div class="ep">' +
      (e.image_url ? '<img src="' + e.image_url + '" style="width:100%;height:100%;object-fit:cover">' : '<div class="ni">No image</div>') +
      '</div><div class="ei"><div class="ttl">' + esc(e.title) + '</div></div></div>';
  });

  var results = document.getElementById('igResults');
  if (results) results.innerHTML = h;
}

function pickIg(id) {
  var url = prompt('Paste Instagram image URL for this event:');
  if (!url) return;

  api('PUT', '/admin/api/events/' + id + '/image', { image_url: url }, function () {
    toast('Image updated');
    E.forEach(function (x) { if (x.id === id) x.image_url = url; });
    af1();
    af4();
  });
}
