/**
 * Add Event Tab
 */

function addEvent() {
  var title = document.getElementById('ae_title').value.trim();
  var date = document.getElementById('ae_date').value.trim();
  var loc = document.getElementById('ae_loc').value.trim();
  var cat = document.getElementById('ae_cat').value;
  var img = document.getElementById('ae_img').value.trim();
  var url = document.getElementById('ae_url').value.trim();
  var desc = document.getElementById('ae_desc').value.trim();
  var src = document.getElementById('ae_source').value;
  var recur = document.getElementById('ae_recur').value.trim();

  if (!title) return toast('Title is required', 1);
  if (!date) return toast('Date is required', 1);
  if (!loc) return toast('Location is required', 1);
  if (!cat) return toast('Category is required', 1);

  var sourceUrl = url || 'manual://added';

  api('POST', '/admin/api/events', {
    title: title,
    event_date: date,
    location: loc,
    category: cat,
    image_url: img,
    source_url: sourceUrl,
    description: desc,
    source_name: src,
    recurring: recur
  }, function (d) {
    E.push(d.event);
    us();
    toast('Event added! ✓');

    ['ae_title', 'ae_date', 'ae_loc', 'ae_img', 'ae_url', 'ae_desc'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    var catEl = document.getElementById('ae_cat');
    var srcEl = document.getElementById('ae_source');
    var recurEl = document.getElementById('ae_recur');
    if (catEl) catEl.value = '';
    if (srcEl) srcEl.value = '';
    if (recurEl) recurEl.value = '';
  });
}
