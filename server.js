require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

// --- YARDIMCI FONKSİYONLAR ---
function parseEventDate(dateStr) {
  if (!dateStr) return null;
  try {
    let date = new Date(dateStr);
    if (isNaN(date.getTime())) {
        const fixedDateStr = dateStr
            .replace('Februar', 'February').replace('Januar', 'January')
            .replace('Marz', 'March').replace('Mai', 'May')
            .replace('Oktober', 'October').replace('Dezember', 'December');
        date = new Date(fixedDateStr);
    }
    if (isNaN(date.getTime())) return null;
    return date;
  } catch (e) { return null; }
}

const createCard = (event, isGray) => {
    let source = 'Unknown Source';
    if (event.source_url.includes('showshappening')) source = 'ShowsHappening';
    else if (event.source_url.includes('visitmalta')) source = 'VisitMalta';
    else if (event.source_url.includes('ticketline')) source = 'Ticketline';

    const firstLetter = event.title ? event.title.charAt(0).toUpperCase() : '?';
    const colors = [
        'linear-gradient(135deg, #FF9A9E 0%, #FECFEF 100%)',
        'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
        'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)',
        'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)'
    ];
    const colorIndex = (firstLetter.charCodeAt(0) || 0) % colors.length;
    const bgStyle = colors[colorIndex];

    let dateHTML = '';
    if (event.event_date) {
        try {
            let safeDate = event.event_date.replace('Februar', 'February').replace('Januar', 'January');
            const parts = safeDate.replace(',', '').split(' ');
            let day = parts[0]; let month = parts[1];
            if (isNaN(day) && !isNaN(month)) { let temp = day; day = month; month = temp; }
            const monthShort = month ? month.substring(0, 3).toUpperCase() : "EVT";
            const dayClean = day ? day.replace(/\D/g, '') : "";

            if (dayClean && monthShort) {
                dateHTML = `<div class="date-badge"><div class="date-month">${monthShort}</div><div class="date-day">${dayClean}</div></div>`;
            }
        } catch (e) {}
    }

    let desc = event.description || "No description available. Click details to see more.";
    const grayClass = isGray ? 'past-event' : '';
    const expiredLabel = isGray ? '<div class="expired-label">PAST EVENT</div>' : '';

    return `
    <div class="card event-item ${grayClass}">
        <div class="card-media">
            ${dateHTML} ${expiredLabel}
            <div class="fallback" style="background: ${bgStyle}; position: absolute; top:0; left:0; z-index:1;">${firstLetter}</div>
            <img src="${event.image_url}" class="card-img" style="position: relative; z-index: 2;" onerror="this.style.display='none'">
        </div>
        <div class="card-content">
            <div class="source-tag">${source}</div>
            <div class="title">${event.title}</div>
            <div class="description">${desc}</div>
            <a href="${event.source_url}" target="_blank" class="btn">View Details</a>
        </div>
    </div>
    `;
};

app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events');
    const allEvents = result.rows;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let upcomingEvents = [];
    let pastEvents = [];

    allEvents.forEach(event => {
        const eDate = parseEventDate(event.event_date);
        if (!eDate || eDate >= today) upcomingEvents.push(event);
        else pastEvents.push(event);
    });

    const sortEvents = (a, b) => {
        const isSHA = a.source_url.includes('showshappening');
        const isSHB = b.source_url.includes('showshappening');
        if (isSHA !== isSHB) return isSHA ? -1 : 1;
        const hasImgA = !!a.image_url;
        const hasImgB = !!b.image_url;
        if (hasImgA !== hasImgB) return hasImgA ? -1 : 1;
        const dateA = parseEventDate(a.event_date) || new Date('2099-01-01');
        const dateB = parseEventDate(b.event_date) || new Date('2099-01-01');
        return dateA - dateB;
    };

    upcomingEvents.sort(sortEvents);
    pastEvents.sort(sortEvents);
    
    let html = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <title>Malta Events | Discover</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap" rel="stylesheet">
          <style>
            :root { --bg: #f8fafc; --card-bg: #ffffff; --text: #1e293b; --primary: #FF385C; }
            body { font-family: 'Outfit', sans-serif; background: var(--bg); margin: 0; color: var(--text); padding-bottom: 50px; }
            
            header { 
                position: relative;
                background-image: url('https://images.pexels.com/photos/34699762/pexels-photo-34699762.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1');
                background-size: cover;
                background-position: center center;
                color: white;
                text-align: center; 
                padding: 6rem 1rem 8rem 1rem; 
                margin-bottom: 80px; /* Aradaki yazıyı silince burayı artırdım ki kartlar yapışmasın */
            }

            .header-overlay {
                position: absolute; top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(15, 23, 42, 0.75); z-index: 1;
            }

            .header-content { position: relative; z-index: 2; max-width: 800px; margin: 0 auto; }

            h1 { 
                margin: 0; font-size: 3.5rem; font-weight: 900; letter-spacing: -1px;
                text-shadow: 0 4px 10px rgba(0,0,0,0.3);
            }
            .subtitle { color: rgba(255,255,255,0.9); margin-top: 10px; font-size: 1.2rem; font-weight: 300; }
            
            .search-box-wrapper {
                position: absolute; bottom: -35px; left: 0; right: 0; padding: 0 20px; z-index: 10;
            }
            .search-box { 
                max-width: 600px; margin: 0 auto; position: relative;
                box-shadow: 0 20px 40px rgba(0,0,0,0.2);
            }
            input { 
                width: 100%; padding: 20px 25px 20px 55px; border-radius: 50px; border: none;
                background: rgba(255, 255, 255, 0.98); font-family: inherit; font-size: 1.1rem; 
                box-sizing: border-box; transition: 0.3s;
            }
            input:focus { outline: none; transform: scale(1.02); }
            .search-icon { position: absolute; left: 25px; top: 50%; transform: translateY(-50%); opacity: 0.5; font-size: 1.2rem; }

            /* Grid ve Kartlar */
            .container { max-width: 1200px; margin: 0 auto; padding: 0 20px; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 30px; }
            
            .card { background: var(--card-bg); border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); transition: transform 0.2s, box-shadow 0.2s; display: flex; flex-direction: column; position: relative; height: 100%; border: 1px solid #e2e8f0; }
            .card:hover { transform: translateY(-5px); box-shadow: 0 20px 30px rgba(0,0,0,0.1); border-color: transparent; }
            
            .card-media { height: 200px; position: relative; background: #eee; overflow: hidden; }
            .card-img { width: 100%; height: 100%; object-fit: cover; transition: 0.5s; }
            .card:hover .card-img { transform: scale(1.05); }
            
            .past-event { filter: grayscale(100%); opacity: 0.6; }
            .past-event:hover { filter: grayscale(0%); opacity: 1; }
            .expired-label { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.8); color: white; padding: 5px 15px; font-weight: 800; text-transform: uppercase; border-radius: 4px; z-index: 20; letter-spacing: 1px; font-size: 0.9rem; border: 1px solid white; }

            .separator { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; margin: 50px 0 30px 0; color: #94a3b8; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; font-size: 0.9rem; }
            .separator::before, .separator::after { content: ""; flex: 1; border-bottom: 2px solid #e2e8f0; margin: 0 20px; }

            .date-badge { position: absolute; top: 12px; left: 12px; background: rgba(255, 255, 255, 0.95); border-radius: 8px; text-align: center; box-shadow: 0 4px 10px rgba(0,0,0,0.15); z-index: 10; backdrop-filter: blur(4px); display: flex; flex-direction: column; overflow: hidden; min-width: 50px; }
            .date-month { background: var(--primary); color: white; font-size: 0.7rem; font-weight: 700; padding: 3px 6px; text-transform: uppercase; letter-spacing: 1px; }
            .date-day { color: #333; font-size: 1.1rem; font-weight: 800; padding: 2px 6px 4px 6px; }

            .fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: white; font-size: 4rem; font-weight: 800; text-shadow: 0 2px 10px rgba(0,0,0,0.2); }
            
            .card-content { padding: 1.5rem; flex-grow: 1; display: flex; flex-direction: column; }
            .source-tag { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-bottom: 8px; font-weight: 700; }
            .title { font-size: 1.25rem; font-weight: 800; margin-bottom: 0.75rem; line-height: 1.3; color: #0f172a; }
            .description { font-size: 0.9rem; color: #475569; margin-bottom: 1.5rem; line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
            .btn { margin-top: auto; display: block; width: 100%; padding: 15px; background: #0f172a; color: white; text-align: center; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 1rem; transition: 0.3s; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.15); }
            .btn:hover { background: var(--primary); box-shadow: 0 8px 20px rgba(255, 56, 92, 0.3); transform: translateY(-2px); }
            .hidden { display: none; }
          </style>
        </head>
        <body>
          <header>
            <div class="header-overlay"></div>
            <div class="header-content">
                <h1>Malta Events Guide</h1>
                <div class="subtitle">Discover ${upcomingEvents.length} upcoming & ${pastEvents.length} past experiences</div>
            </div>

            <div class="search-box-wrapper">
                <div class="search-box">
                <span class="search-icon">🔍</span>
                <input type="text" id="searchInput" placeholder="Search for concerts, festivals, nightlife..." onkeyup="filterEvents()">
                </div>
            </div>
          </header>

          <div class="container" id="eventGrid">
            ${upcomingEvents.map(e => createCard(e, false)).join('')}
            ${pastEvents.length > 0 ? `<div class="separator">Past Events Archive</div>${pastEvents.map(e => createCard(e, true)).join('')}` : ''}
          </div>

          <script>
            function filterEvents() {
              const input = document.getElementById('searchInput').value.toLowerCase();
              const cards = document.getElementsByClassName('event-item');
              for (let i = 0; i < cards.length; i++) {
                const title = cards[i].querySelector('.title').innerText.toLowerCase();
                const desc = cards[i].querySelector('.description').innerText.toLowerCase();
                if (title.includes(input) || desc.includes(input)) cards[i].classList.remove('hidden');
                else cards[i].classList.add('hidden');
              }
            }
          </script>
        </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    res.status(500).send("Database error: " + err.message);
  }
});

app.listen(3000, () => {
  console.log('Server is running at http://localhost:3000');
});