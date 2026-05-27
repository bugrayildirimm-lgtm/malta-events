/**
 * Admin API Routes
 *
 * All /admin/api/* endpoints extracted from the main server.js monolith.
 * This makes the entire admin feature (views + client + API) self-contained
 * under the admin/ directory.
 *
 * Usage in server.js:
 *   const createAdminApi = require('./admin/api');
 *   app.use('/admin/api', createAdminApi({ pool, dates, ADMIN_PASSWORD, upload }));
 */

const express = require('express');

module.exports = function createAdminApi(deps) {
  const { pool, dates, ADMIN_PASSWORD, upload } = deps;

  const router = express.Router();

  function authCheck(req, res) {
    if (req.headers.authorization !== ADMIN_PASSWORD) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  // =====================================================================
  // NEWSLETTER
  // =====================================================================

  router.post('/send-newsletter', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const { subject, previewText } = req.body;

      const subs = await pool.query('SELECT email FROM email_subscribers ORDER BY subscribed_at');
      if (!subs.rows.length) return res.json({ ok: false, error: 'No subscribers' });

      const evResult = await pool.query("SELECT * FROM events WHERE COALESCE(status,'live')='live' ORDER BY id DESC LIMIT 200");
      const now = new Date();
      const upcoming = evResult.rows.filter(e => {
        const sd = dates.getStartDate(e.event_date);
        return sd && sd >= now;
      }).sort((a,b) => {
        const da = dates.getStartDate(a.event_date);
        const db = dates.getStartDate(b.event_date);
        return (da||now) - (db||now);
      }).slice(0, 8);

      const eventRows = upcoming.map(e => {
        const slug = e.slug || '';
        const img = e.image_url && e.image_url.startsWith('http') ? e.image_url : '';
        const cat = e.category || '';
        return '<tr><td style="padding:12px 0;border-bottom:1px solid #e2e8f0">'
          + '<table width="100%" cellpadding="0" cellspacing="0"><tr>'
          + (img ? '<td width="80" style="padding-right:14px;vertical-align:top"><img src="' + img + '" width="80" height="80" style="border-radius:10px;object-fit:cover;display:block" alt=""></td>' : '')
          + '<td style="vertical-align:top">'
          + '<a href="https://maltaeventguide.com/event/' + slug + '" style="color:#0f172a;font-weight:700;font-size:15px;text-decoration:none;line-height:1.3">' + (e.title||'') + '</a><br>'
          + '<span style="color:#64748b;font-size:13px">📅 ' + (e.event_date||'') + '</span><br>'
          + '<span style="color:#64748b;font-size:13px">📍 ' + (e.location||'Malta') + '</span>'
          + (cat ? '<br><span style="color:#94a3b8;font-size:12px">' + cat + '</span>' : '')
          + '</td></tr></table></td></tr>';
      }).join('');

      const emailHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
        + '<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">'
        + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:20px 0"><tr><td align="center">'
        + '<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">'
        + '<tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 50%,#FF385C 100%);padding:30px 30px;border-radius:16px 16px 0 0;text-align:center">'
        + '<img src="https://maltaeventguide.com/logo.png" height="45" alt="Malta Event Guide" style="margin-bottom:10px"><br>'
        + '<span style="color:white;font-size:22px;font-weight:700">This Week in Malta</span><br>'
        + '<span style="color:rgba(255,255,255,0.7);font-size:14px">' + (previewText || 'The best events happening this week') + '</span>'
        + '</td></tr>'
        + '<tr><td style="background:white;padding:28px 30px">'
        + '<table width="100%" cellpadding="0" cellspacing="0">' + eventRows + '</table>'
        + '</td></tr>'
        + '<tr><td style="background:white;padding:0 30px 28px;text-align:center">'
        + '<a href="https://maltaeventguide.com/" style="display:inline-block;background:#FF385C;color:white;padding:14px 36px;border-radius:12px;text-decoration:none;font-weight:700;font-size:15px">Browse All Events →</a>'
        + '</td></tr>'
        + '<tr><td style="background:#f8fafc;padding:20px 30px;border-radius:0 0 16px 16px;text-align:center;font-size:12px;color:#94a3b8">'
        + 'You received this because you subscribed at <a href="https://maltaeventguide.com" style="color:#94a3b8">maltaeventguide.com</a><br>'
        + '<a href="https://maltaeventguide.com/unsubscribe?email=%%EMAIL%%" style="color:#94a3b8;text-decoration:underline">Unsubscribe</a>'
        + '</td></tr>'
        + '</table></td></tr></table></body></html>';

      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: 'smtp-relay.brevo.com',
        port: 587,
        auth: {
          user: process.env.BREVO_SMTP_USER,
          pass: process.env.BREVO_SMTP_PASS
        }
      });

      for (const sub of subs.rows) {
        const personalized = emailHtml.replace('%%EMAIL%%', encodeURIComponent(sub.email));
        await transporter.sendMail({
          from: '"Malta Event Guide" <hello@maltaeventguide.com>',
          to: sub.email,
          subject: subject || 'This Week in Malta — Malta Event Guide',
          html: personalized
        });
      }

      res.json({ ok: true, sent: subs.rows.length });
    } catch (e) {
      console.error('Newsletter error:', e);
      res.json({ ok: false, error: e.message });
    }
  });

  router.get('/newsletter-preview', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const evResult = await pool.query("SELECT * FROM events WHERE COALESCE(status,'live')='live' ORDER BY id DESC LIMIT 200");
      const now = new Date();
      const upcoming = evResult.rows.filter(e => {
        const sd = dates.getStartDate(e.event_date);
        return sd && sd >= now;
      }).sort((a,b) => {
        const da = dates.getStartDate(a.event_date);
        const db = dates.getStartDate(b.event_date);
        return (da||now) - (db||now);
      }).slice(0, 8);

      const subs = await pool.query('SELECT COUNT(*) as c FROM email_subscribers');

      res.json({
        subscribers: subs.rows[0].c,
        events: upcoming.map(e => ({
          title: e.title,
          date: e.event_date,
          location: e.location,
          category: e.category,
          image: e.image_url
        }))
      });
    } catch (e) {
      res.json({ events: [], subscribers: 0 });
    }
  });

  // =====================================================================
  // EXCEL / DRAFTS
  // =====================================================================

  router.post('/parse-excel', upload.single('file'), async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const XLSX = require('xlsx');
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      const events = rows.map(row => {
        const get = (...keys) => {
          for (const k of keys) {
            if (row[k] != null && row[k] !== '') return row[k];
          }
          return '';
        };
        return {
          title: get('title', 'Title', 'event'),
          event_date: get('event_date', 'date', 'Event Date'),
          location: get('location', 'Location'),
          category: get('category', 'Category'),
          image_url: get('image_url', 'image', 'Image'),
          source_url: get('source_url', 'url', 'link'),
          description: get('description', 'Description'),
          source_name: get('source_name', 'source', 'Source') || 'Excel Import',
          recurring: get('recurring', 'Recurring')
        };
      }).filter(e => e.title);

      res.json({ events });
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  router.post('/import-drafts', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const events = req.body.events;
      if (!events || !Array.isArray(events)) {
        return res.json({ ok: false, error: 'Invalid events' });
      }

      let count = 0;
      for (const ev of events) {
        await pool.query(`
          INSERT INTO events (title, event_date, location, category, image_url, source_url, description, source_name, recurring, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft')
        `, [
          ev.title, ev.event_date, ev.location, ev.category,
          ev.image_url, ev.source_url, ev.description, ev.source_name, ev.recurring
        ]);
        count++;
      }
      res.json({ ok: true, count });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  router.get('/drafts', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const result = await pool.query("SELECT * FROM events WHERE status = 'draft' ORDER BY id DESC");
      res.json(result.rows);
    } catch (e) {
      res.json([]);
    }
  });

  router.delete('/drafts/delete-all', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const result = await pool.query("DELETE FROM events WHERE status = 'draft'");
      res.json({ ok: true, deleted: result.rowCount });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // =====================================================================
  // CLEANUP TOOLS
  // =====================================================================

  router.post('/cleanup-locations', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const result = await pool.query("SELECT id, location FROM events WHERE location IS NOT NULL AND (location LIKE '%View map%' OR location LIKE '%, Malta%')");
      let updated = 0;
      for (const row of result.rows) {
        let loc = row.location
          .replace(/View map/gi, '')
          .replace(/, Malta/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (loc.endsWith(',')) loc = loc.slice(0, -1).trim();
        if (loc !== row.location) {
          await pool.query('UPDATE events SET location = $1 WHERE id = $2', [loc, row.id]);
          updated++;
        }
      }
      res.json({ ok: true, updated });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  router.post('/cleanup-images', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const result = await pool.query("SELECT id, title, image_url FROM events WHERE image_url IS NOT NULL");
      let cleaned = 0;
      for (const row of result.rows) {
        if (row.image_url.includes('showshappening.com') || row.image_url.includes('/api/v2/file/')) {
          await pool.query('UPDATE events SET image_url = NULL WHERE id = $1', [row.id]);
          cleaned++;
        }
      }
      res.json({ ok: true, cleaned });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  router.post('/remove-duplicates', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const result = await pool.query('SELECT * FROM events ORDER BY id');
      const seen = new Map();
      const toDelete = [];

      for (const e of result.rows) {
        const key = (e.title || '').toLowerCase().trim();
        if (!key) continue;

        if (seen.has(key)) {
          const existing = seen.get(key);
          const score = (e.image_url ? 2 : 0) + (e.description ? 1 : 0) + (e.category ? 1 : 0) + (e.event_date ? 1 : 0);
          const existingScore = (existing.image_url ? 2 : 0) + (existing.description ? 1 : 0) + (existing.category ? 1 : 0) + (existing.event_date ? 1 : 0);

          if (score > existingScore) {
            toDelete.push(existing.id);
            seen.set(key, e);
          } else {
            toDelete.push(e.id);
          }
        } else {
          seen.set(key, e);
        }
      }

      if (toDelete.length > 0) {
        await pool.query('DELETE FROM events WHERE id = ANY($1)', [toDelete]);
      }

      res.json({ ok: true, removed: toDelete.length });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // =====================================================================
  // IMAGE PROXY (for Instagram generator etc)
  // =====================================================================

  router.get('/proxy-image', async (req, res) => {
    if (!authCheck(req, res)) return;
    const url = req.query.url;
    if (!url) return res.status(400).send('Missing url');

    try {
      const fetch = (await import('node-fetch')).default;
      const r = await fetch(url);
      if (!r.ok) throw new Error('Upstream error');
      const contentType = r.headers.get('content-type') || 'image/jpeg';
      const buffer = await r.arrayBuffer();
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(Buffer.from(buffer));
    } catch (e) {
      res.status(502).send('Failed to proxy image');
    }
  });

  // =====================================================================
  // EVENTS CRUD
  // =====================================================================

  router.get('/events', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const result = await pool.query('SELECT * FROM events ORDER BY id DESC');
      res.json(result.rows);
    } catch (e) {
      res.json([]);
    }
  });

  router.put('/events/:id/image', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      await pool.query('UPDATE events SET image_url = $1 WHERE id = $2', [req.body.image_url, req.params.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/events/:id/category', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      await pool.query('UPDATE events SET category = $1 WHERE id = $2', [req.body.category, req.params.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/events/:id', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/events/:id', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const { title, event_date, location, source_name, category, description, recurring, status, featured } = req.body;
      const result = await pool.query(`
        UPDATE events SET
          title = COALESCE($1, title),
          event_date = COALESCE($2, event_date),
          location = COALESCE($3, location),
          source_name = COALESCE($4, source_name),
          category = COALESCE($5, category),
          description = COALESCE($6, description),
          recurring = COALESCE($7, recurring),
          status = COALESCE($8, status),
          featured = COALESCE($9, featured)
        WHERE id = $10
        RETURNING *
      `, [title, event_date, location, source_name, category, description, recurring, status, featured, req.params.id]);

      res.json({ success: true, event: result.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/events/:id/date', (req, res) => {
    if (!authCheck(req, res)) return;
    const { event_date } = req.body;
    let warning = null;

    if (event_date && dates.looksLikeDate && !dates.looksLikeDate(event_date)) {
      warning = 'Date format may not be recognized by the parser';
    }

    pool.query('UPDATE events SET event_date = $1 WHERE id = $2', [event_date, req.params.id])
      .then(() => res.json({ success: true, warning }))
      .catch(e => res.status(500).json({ error: e.message }));
  });

  router.post('/events', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const { title, event_date, location, description, category, source_name, recurring } = req.body;
      const source_url = req.body.source_url || 'manual://added';

      const result = await pool.query(`
        INSERT INTO events (title, event_date, location, description, category, source_name, source_url, recurring, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'live')
        RETURNING *
      `, [title, event_date, location, description, category, source_name, source_url, recurring]);

      res.json({ success: true, event: result.rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // =====================================================================
  // ANALYTICS & SUBSCRIBERS
  // =====================================================================

  router.get('/analytics', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const total = await pool.query('SELECT COUNT(*) as c FROM click_tracking');
      const today = await pool.query("SELECT COUNT(*) as c FROM click_tracking WHERE clicked_at >= CURRENT_DATE");
      const week = await pool.query("SELECT COUNT(*) as c FROM click_tracking WHERE clicked_at >= CURRENT_DATE - INTERVAL '7 days'");
      const month = await pool.query("SELECT COUNT(*) as c FROM click_tracking WHERE clicked_at >= CURRENT_DATE - INTERVAL '30 days'");
      const unique = await pool.query('SELECT COUNT(DISTINCT event_id) as c FROM click_tracking');

      const top = await pool.query(`
        SELECT event_title, 
          CASE 
            WHEN LOWER(source) LIKE 'showshappening%' THEN 'ShowsHappening'
            WHEN LOWER(source) LIKE 'eventworks%' THEN 'EventWorks'
            WHEN LOWER(source) LIKE 'visitmalta%' THEN 'VisitMalta'
            WHEN LOWER(source) LIKE 'resident advisor%' THEN 'Resident Advisor'
            WHEN LOWER(source) LIKE 'community events%' THEN 'Community Events Malta'
            ELSE source
          END as source_normalized,
          COUNT(*) as clicks, 
          MAX(clicked_at) as last_click 
        FROM click_tracking 
        GROUP BY event_title, source_normalized
        ORDER BY clicks DESC LIMIT 100
      `);

      const sourceTotals = await pool.query(`
        SELECT 
          CASE 
            WHEN LOWER(source) LIKE 'showshappening%' THEN 'ShowsHappening'
            WHEN LOWER(source) LIKE 'eventworks%' THEN 'EventWorks'
            WHEN LOWER(source) LIKE 'visitmalta%' THEN 'VisitMalta'
            WHEN LOWER(source) LIKE 'resident advisor%' THEN 'Resident Advisor'
            WHEN LOWER(source) LIKE 'community events%' THEN 'Community Events Malta'
            ELSE source
          END as source, 
          COUNT(*) as clicks 
        FROM click_tracking 
        GROUP BY 1 
        ORDER BY clicks DESC
      `);

      res.json({
        total_clicks: total.rows[0].c,
        today_clicks: today.rows[0].c,
        week_clicks: week.rows[0].c,
        month_clicks: month.rows[0].c,
        unique_events: unique.rows[0].c,
        top_events: top.rows.map(r => ({ ...r, source: r.source_normalized || r.source })),
        source_totals: sourceTotals.rows
      });
    } catch (e) {
      res.json({ total_clicks: 0, today_clicks: 0, week_clicks: 0, month_clicks: 0, unique_events: 0, top_events: [], source_totals: [] });
    }
  });

  router.get('/subscribers', async (req, res) => {
    if (!authCheck(req, res)) return;
    try {
      const result = await pool.query('SELECT email, subscribed_at FROM email_subscribers ORDER BY subscribed_at DESC');
      res.json(result.rows);
    } catch (e) { res.json([]); }
  });

  return router;
};
