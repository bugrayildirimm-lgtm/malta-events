// Explores VisitMalta API to find image URLs for events with missing images
// Also outputs a list of event → image URL mappings
// Usage: node fix-visitmalta-images.js

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const fetch = (await import('node-fetch')).default;
    
    console.log("Fetching VisitMalta API...");
    const response = await fetch('https://api.visitmaltaplus.com/api/v2/LoadAllEvents?&limit=500&version=947', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    });

    const data = await response.json();
    const rows = data.rows || {};
    
    let found = 0, missing = 0, updated = 0;

    for (const key of Object.keys(rows)) {
      const event = rows[key];
      const title = event.title?.[0]?.value;
      if (!title || title.length < 3) continue;

      // Check all possible image sources
      const externalImg = event.field_external_image_url?.[0]?.value || null;
      const imageField = event.field_image || [];
      const headerImage = event.field_header_image || [];
      
      // The target_id in field_image is the media ID
      const mediaId = imageField[0]?.target_id || headerImage[0]?.target_id || null;
      
      // Build the working image URL from media_id
      let imageUrl = null;
      if (externalImg && externalImg.startsWith('http')) {
        imageUrl = externalImg;
      } else if (mediaId) {
        imageUrl = `https://api.visitmaltaplus.com/api/v2/images/1?media_id=${mediaId}&height=400`;
      }

      if (imageUrl) {
        found++;
        
        // Update in database if event exists and has no image
        const urlAlias = event.url_alias || event.path?.[0]?.alias?.replace(/^\//, '') || '';
        const sourceUrl = urlAlias
          ? `https://www.visitmalta.com/en/events-in-malta-and-gozo/event/${urlAlias}`
          : null;

        if (sourceUrl) {
          const result = await pool.query(
            `UPDATE events SET image_url = $1 
             WHERE source_url = $2 
             AND (image_url IS NULL OR image_url LIKE '%/api/v2/file/%' OR image_url = '')`,
            [imageUrl, sourceUrl]
          );
          if (result.rowCount > 0) {
            console.log(`✓ Updated: ${title}`);
            console.log(`  Image: ${imageUrl}`);
            updated++;
          }
        }
      } else {
        missing++;
        console.log(`✗ No image: ${title}`);
        // Debug: show all fields that might contain images
        const fields = Object.keys(event).filter(k => k.includes('image') || k.includes('media') || k.includes('photo'));
        if (fields.length) console.log(`  Image-related fields: ${fields.join(', ')}`);
      }
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`Total events: ${Object.keys(rows).length}`);
    console.log(`With images: ${found}`);
    console.log(`No images: ${missing}`);
    console.log(`Database updated: ${updated}`);

    // Also save to overrides table if it exists
    try {
      for (const key of Object.keys(rows)) {
        const event = rows[key];
        const title = event.title?.[0]?.value;
        if (!title) continue;
        
        const imageField = event.field_image || [];
        const headerImage = event.field_header_image || [];
        const externalImg = event.field_external_image_url?.[0]?.value || null;
        const mediaId = imageField[0]?.target_id || headerImage[0]?.target_id || null;
        
        let imageUrl = null;
        if (externalImg && externalImg.startsWith('http')) imageUrl = externalImg;
        else if (mediaId) imageUrl = `https://api.visitmaltaplus.com/api/v2/images/1?media_id=${mediaId}&height=400`;
        
        if (!imageUrl) continue;

        const urlAlias = event.url_alias || event.path?.[0]?.alias?.replace(/^\//, '') || '';
        const sourceUrl = urlAlias
          ? `https://www.visitmalta.com/en/events-in-malta-and-gozo/event/${urlAlias}`
          : null;
        if (!sourceUrl) continue;

        await pool.query(
          `INSERT INTO event_overrides (source_url, image_url) VALUES ($1, $2) 
           ON CONFLICT (source_url) DO UPDATE SET image_url = COALESCE(event_overrides.image_url, $2)`,
          [sourceUrl, imageUrl]
        ).catch(() => {});
      }
      console.log('✓ Also saved to event_overrides');
    } catch(e) {
      console.log('(event_overrides table not found, skipping)');
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

run();
