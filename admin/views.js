/**
 * Admin UI Views - Modular Structure
 *
 * HTML side:
 *   - getAdminHTML() + many small render*Tab() functions (clean & focused)
 *
 * JS side (zero bundler):
 *   - admin/js/core.js          → shared state + utils + auth + tab switching
 *   - admin/js/tabs/*.js        → one file per admin tab
 *   - admin/js/main.js          → final bootstrap
 *
 * getAdminJS() concatenates everything at request time into a single
 * flat bundle for the browser. This gives us excellent maintainability
 * without introducing any build tooling.
 */

// ==================== MAIN SHELL ====================

function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Admin - Malta Events</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/admin.css">
</head>
<body>
  <div class="login-screen" id="LS">
    <div class="login-box">
      <h2>🔐 Admin Login</h2>
      <input type="password" id="pw" placeholder="Enter admin password" onkeydown="if(event.key==='Enter')doLogin()">
      <button onclick="doLogin()">Login</button>
    </div>
  </div>

  <div class="admin-panel" id="AP">
    ${renderAdminHeader()}
    ${renderAdminTabs()}

    <!-- Tab Content Containers -->
    <div id="imagesTab">${renderImagesTab()}</div>
    <div id="datesTab" style="display:none">${renderDatesTab()}</div>
    <div id="categoriesTab" style="display:none">${renderCategoriesTab()}</div>
    <div id="manageTab" style="display:none">${renderManageTab()}</div>
    <div id="addTab" style="display:none">${renderAddEventTab()}</div>
    <div id="uploadTab" style="display:none">${renderUploadTab()}</div>
    <div id="analyticsTab" style="display:none">${renderAnalyticsTab()}</div>
    <div id="instagramTab" style="display:none">${renderInstagramTab()}</div>
  </div>

  <div class="toast" id="toast"></div>

  <script src="/admin/js"></script>
</body>
</html>`;
}

// ==================== LAYOUT COMPONENTS ====================

function renderAdminHeader() {
  return `
    <div class="admin-header">
      <div>
        <h1>🎛️ Event Manager</h1>
        <div class="stats" id="st">Loading...</div>
      </div>
      <a href="/">← Back to site</a>
    </div>
  `;
}

function renderAdminTabs() {
  return `
    <div class="tabs">
      <div class="tab active" onclick="switchTab('images',this)">🖼️ Images <span class="tc" id="ic">0</span></div>
      <div class="tab" onclick="switchTab('dates',this)">📅 Dates <span class="tc" id="dc">0</span></div>
      <div class="tab" onclick="switchTab('categories',this)">🏷️ Categories <span class="tc" id="cc">0</span></div>
      <div class="tab" onclick="switchTab('manage',this)">📋 Manage</div>
      <div class="tab" onclick="switchTab('add',this)">➕ Add Event</div>
      <div class="tab" onclick="switchTab('upload',this)">📤 Upload</div>
      <div class="tab" onclick="switchTab('analytics',this)">📊 Analytics</div>
      <div class="tab" onclick="switchTab('instagram',this)">📸 Instagram</div>
    </div>
  `;
}

// ==================== TAB RENDERERS ====================

function renderImagesTab() {
  return `
    <div class="filters">
      <input type="text" id="sf1" placeholder="🔍 Search..." oninput="af1()">
      <select id="ss1" onchange="af1()">
        <option value="all">All sources</option>
        <option value="showshappening">ShowsHappening</option>
        <option value="visitmalta">VisitMalta</option>
        <option value="manual">Manual</option>
      </select>
      <button class="fb active" onclick="ssf('missing',this)">Missing</button>
      <button class="fb" onclick="ssf('has',this)">Has images</button>
      <button class="fb" onclick="ssf('all',this)">All</button>
    </div>
    <div class="events-grid" id="eg1"></div>
  `;
}

function renderDatesTab() {
  return `
    <div class="fgt" onclick="document.getElementById('fgd').style.display = document.getElementById('fgd').style.display==='none' ? '' : 'none'">
      📖 Date format guide
    </div>
    <div class="fg" id="fgd">
      <h3>Supported formats</h3>
      <table class="ft">
        <tr><td>14 Feb</td><td>Single date</td></tr>
        <tr><td>20,21 Feb</td><td>Multiple days same month</td></tr>
        <tr><td>13,14,15 Mar</td><td>Multi-day event</td></tr>
        <tr><td>14 Feb to 28 Mar</td><td>Date range (different months)</td></tr>
        <tr><td>Feb to May</td><td>Month range (ongoing)</td></tr>
        <tr><td>14-Feb to 28-Mar</td><td>Dash style range</td></tr>
        <tr><td>5 February 2026 - 1 March 2026</td><td>Full date range</td></tr>
      </table>
    </div>
    <div class="filters">
      <input type="text" id="sf2" placeholder="🔍 Search..." oninput="af2()">
      <select id="ss2" onchange="af2()">
        <option value="all">All sources</option>
        <option value="showshappening">ShowsHappening</option>
        <option value="visitmalta">VisitMalta</option>
        <option value="manual">Manual</option>
      </select>
      <button class="fb active" onclick="sdf('missing',this)">Missing</button>
      <button class="fb" onclick="sdf('has',this)">Has date</button>
      <button class="fb" onclick="sdf('all',this)">All</button>
    </div>
    <div class="events-grid" id="eg2"></div>
  `;
}

function renderCategoriesTab() {
  return `
    <div class="filters">
      <input type="text" id="sf3" placeholder="🔍 Search..." oninput="af3()">
      <select id="ss3" onchange="af3()">
        <option value="all">All sources</option>
        <option value="showshappening">ShowsHappening</option>
        <option value="visitmalta">VisitMalta</option>
        <option value="manual">Manual</option>
      </select>
      <button class="fb active" onclick="scf('uncat',this)">Uncategorized</button>
      <button class="fb" onclick="scf('all',this)">All</button>
    </div>
    <div class="events-grid" id="eg3"></div>
  `;
}

function renderManageTab() {
  return `
    <div class="filters">
      <input type="text" id="sf4" placeholder="🔍 Search..." oninput="af4()">
      <select id="ss4" onchange="af4()">
        <option value="all">All sources</option>
        <option value="showshappening">ShowsHappening</option>
        <option value="visitmalta">VisitMalta</option>
        <option value="manual">Manual</option>
      </select>
      <button onclick="removeDuplicates()" style="margin-left:auto;background:#ef4444;color:white;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:700">🧹 Remove Duplicates</button>
    </div>
    <div class="events-grid" id="eg4"></div>
  `;
}

function renderAddEventTab() {
  return `
    <div class="add-form">
      <h3>Add New Event</h3>
      <div class="form-group">
        <label>Title <span class="req">*</span></label>
        <input id="ae_title" placeholder="Event title">
      </div>
      <div class="form-group">
        <label>Date <span class="req">*</span></label>
        <input id="ae_date" placeholder="e.g. 15 March 2026 or 10-12 Apr">
      </div>
      <div class="form-group">
        <label>Location <span class="req">*</span></label>
        <input id="ae_loc" placeholder="Valletta, Paceville, etc.">
      </div>
      <div class="form-group">
        <label>Category</label>
        <select id="ae_cat">
          <option value="">-- Select --</option>
          <option>Music & Concerts</option>
          <option>Theatre & Shows</option>
          <option>Dance</option>
          <option>Nightlife & Parties</option>
          <option>Festivals</option>
          <option>Arts & Culture</option>
          <option>Sports & Adventure</option>
          <option>Food & Drink</option>
          <option>Family</option>
          <option>Religious</option>
          <option>Conference</option>
          <option>Other</option>
        </select>
      </div>
      <div class="form-group">
        <label>Image URL</label>
        <input id="ae_img" placeholder="https://...">
      </div>
      <div class="form-group">
        <label>Source URL</label>
        <input id="ae_url" placeholder="https://...">
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="ae_desc"></textarea>
      </div>
      <div class="form-group">
        <label>Source Name</label>
        <select id="ae_source">
          <option value="">-- Select --</option>
          <option>ShowsHappening</option>
          <option>VisitMalta</option>
          <option>Resident Advisor</option>
          <option>EventWorks</option>
          <option>Manual</option>
        </select>
      </div>
      <div class="form-group">
        <label>Recurring (optional)</label>
        <input id="ae_recur" placeholder="e.g. Every Friday">
      </div>
      <button class="form-btn" onclick="addEvent()">Add Event</button>
    </div>
  `;
}

function renderUploadTab() {
  return `
    <div style="padding:30px;max-width:700px">
      <h3>Upload Excel / CSV</h3>
      <p style="color:#94a3b8;font-size:0.9rem;margin-bottom:15px">
        Upload a file with columns: title, event_date, location, category, image_url, source_url, description
      </p>
      <input type="file" id="uploadFile" accept=".xlsx,.xls,.csv">
      <button class="form-btn" onclick="uploadFile()" style="margin-top:15px">Upload & Preview</button>
      <div id="uploadPreview" style="margin-top:20px;display:none"></div>
    </div>
  `;
}

function renderAnalyticsTab() {
  return `
    <div class="analytics">
      <h3>Analytics</h3>
      <div class="stat-cards" id="statCards"></div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:20px">
        <div>
          <h3 style="margin:0 0 10px;font-size:1.05rem">Top Clicked Events</h3>
          <table class="click-table" id="topTable"></table>
        </div>
        <div>
          <h3 style="margin:0 0 10px;font-size:1.05rem">Clicks by Source</h3>
          <table class="click-table" id="sourceTable"></table>
        </div>
      </div>

      <h3 style="margin:30px 0 10px;font-size:1.05rem">Email Subscribers <span id="subCount" style="color:#94a3b8;font-size:0.9rem;font-weight:400"></span></h3>
      <div id="subscribersList" style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:15px;max-height:320px;overflow:auto"></div>

      <div style="margin-top:40px;border-top:1px solid #334155;padding-top:25px">
        <h3 style="margin:0 0 12px;font-size:1.05rem">📧 Send Newsletter to Subscribers</h3>
        <input id="nlSubject" placeholder="Subject line" style="width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;margin-bottom:8px">
        <textarea id="nlPreview" placeholder="Short preview text (appears in inbox)" style="width:100%;height:70px;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;margin-bottom:8px"></textarea>
        <button onclick="sendNewsletter()" class="form-btn" style="width:auto;padding:10px 28px">Send to All Subscribers</button>
        <button onclick="previewNewsletter()" style="margin-left:10px;padding:10px 18px;background:#334155;color:white;border:none;border-radius:8px;cursor:pointer">Preview</button>
        <div id="nlResult" style="margin-top:10px;color:#94a3b8"></div>
      </div>
    </div>
  `;
}

function renderInstagramTab() {
  return `
    <div style="padding:30px">
      <h3>📸 Instagram Post Creator</h3>
      <p style="color:#94a3b8;margin-bottom:15px">Click any event below to automatically generate a ready-to-post Instagram graphic using its image + details.</p>
      <div class="filters">
        <input type="text" id="igSearch" placeholder="Search events..." oninput="searchInstagram()">
      </div>
      <div id="igResults" class="events-grid"></div>
    </div>

    <!-- Instagram Post Generator Modal -->
    <div id="igModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;align-items:center;justify-content:center">
      <div style="background:#1e293b;border-radius:16px;padding:20px;max-width:520px;width:95%">
        <h3 style="margin:0 0 10px">Instagram Post Preview</h3>
        <canvas id="igCanvas" width="1080" height="1080" style="width:100%;border-radius:12px;background:#0f172a"></canvas>
        <div style="margin-top:15px;display:flex;gap:10px">
          <button onclick="downloadIgPost()" style="flex:1;padding:12px;background:#FF385C;color:white;border:none;border-radius:10px;font-weight:700">⬇️ Download PNG (1080x1080)</button>
          <button onclick="closeIgModal()" style="flex:1;padding:12px;background:#334155;color:white;border:none;border-radius:10px">Close</button>
        </div>
        <div style="font-size:0.8rem;color:#64748b;margin-top:8px">Right-click the image above or use the download button. Add your own caption when posting.</div>
      </div>
    </div>
  `;
}

// ==================== REUSABLE COMPONENTS ====================

function renderAdminFilters(idPrefix) {
  // Can be expanded later for shared filter UI
  return '';
}

// ==================== JS BUNDLE (modular concatenation, zero bundler) ====================

function getAdminJS() {
  const fs = require('fs');
  const path = require('path');
  const base = __dirname;

  // Order is critical: core first, then tabs in logical order, main.js last.
  const files = [
    'js/core.js',
    'js/tabs/images.js',
    'js/tabs/dates.js',
    'js/tabs/categories.js',
    'js/tabs/manage.js',
    'js/tabs/add.js',
    'js/tabs/upload.js',
    'js/tabs/analytics.js',
    'js/tabs/instagram.js',
    'js/main.js'
  ];

  return files
    .map(f => {
      const full = path.join(base, f);
      try {
        return fs.readFileSync(full, 'utf8');
      } catch (e) {
        console.error('[admin] Missing module:', f);
        return `console.error("Admin module missing: ${f}");\n`;
      }
    })
    .join('\n\n');
}

// ==================== EXPORTS ====================

module.exports = {
  getAdminHTML,
  getAdminJS
};