/**
 * Admin Core
 * Shared state, utilities, auth, and tab switching.
 * Must be loaded before any tab modules.
 */

// ==================== STATE ====================
var E = [];           // all events
var tab = 'images';
var sf1v = 'missing';
var sf2v = 'missing';
var auth = '';

// ==================== CORE UTILS ====================
function esc(s) {
  if (!s) return '';
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function toast(m, err) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = m;
  t.className = err ? 'toast err' : 'toast';
  t.style.display = 'block';
  t.classList.add('show');
  setTimeout(function () {
    t.classList.remove('show');
    setTimeout(function () { t.style.display = 'none'; }, 300);
  }, 2500);
}

function api(method, url, body, cb) {
  fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(body)
  })
    .then(function (r) { return r.json(); })
    .then(cb)
    .catch(function () { toast('Error', 1); });
}

// ==================== LOGIN & INIT ====================
function doLogin() {
  auth = document.getElementById('pw').value;

  fetch('/admin/api/events', { headers: { Authorization: auth } })
    .then(function (r) {
      if (!r.ok) throw new Error('auth');
      return r.json();
    })
    .then(function (d) {
      E = d;
      document.getElementById('LS').style.display = 'none';
      document.getElementById('AP').style.display = 'block';

      try { us(); } catch (e) { console.error('us', e); }
      try { af1(); } catch (e) { console.error('af1', e); }
      try { af2(); } catch (e) { console.error('af2', e); }
      try { af3(); } catch (e) { console.error('af3', e); }
      try { af4(); } catch (e) { console.error('af4', e); }
      try { loadAnalytics(); } catch (e) { console.error('analytics', e); }
    })
    .catch(function (e) {
      if (e && e.message === 'auth') toast('Wrong password!', 1);
      else { console.error('Login:', e); toast('Error: ' + e, 1); }
    });
}

function us() {
  var mi = E.filter(function (e) { return !vi(e); }).length;
  var md = E.filter(function (e) { return !e.event_date; }).length;
  var mc = E.filter(function (e) { return !e.category; }).length;

  var st = document.getElementById('st');
  if (st) {
    st.textContent = E.length + ' events · ' + mi + ' missing images · ' + md + ' missing dates · ' + mc + ' uncategorized';
  }

  var ic = document.getElementById('ic');
  var dc = document.getElementById('dc');
  var cc = document.getElementById('cc');
  if (ic) ic.textContent = mi;
  if (dc) dc.textContent = md;
  if (cc) cc.textContent = mc;
}

function vi(e) {
  return e.image_url && !e.image_url.includes('/api/v2/file/');
}

// ==================== TAB SWITCHING ====================
function switchTab(t, el) {
  document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
  if (el) el.classList.add('active');

  document.querySelectorAll('[id$="Tab"]').forEach(function (x) { x.style.display = 'none'; });

  var tabEl = document.getElementById(t + 'Tab');
  if (tabEl) tabEl.style.display = 'block';

  tab = t;
}
