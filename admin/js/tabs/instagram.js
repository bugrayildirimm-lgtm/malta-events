/**
 * Instagram Post Creator Tab
 * Clicking an event generates a branded 1080x1080 Instagram graphic using its data + image.
 */

function searchInstagram() {
  var q = (document.getElementById('igSearch') ? document.getElementById('igSearch').value : '').toLowerCase();
  var res = E.filter(function (e) { return (e.title || '').toLowerCase().includes(q); }).slice(0, 24);

  var h = '';
  res.forEach(function (e) {
    var img = e.image_url ? e.image_url : '';
    h += '<div class="ec" onclick="createInstagramPost(' + e.id + ')" style="cursor:pointer">' +
         '<div class="ep">' +
         (img ? '<img src="' + img + '" style="width:100%;height:100%;object-fit:cover">' : '<div class="ni">No image</div>') +
         '</div>' +
         '<div class="ei">' +
         '<div class="ttl">' + esc(e.title) + '</div>' +
         '<div class="mt">' + esc(e.event_date || '') + ' · ' + esc(e.location || 'Malta') + '</div>' +
         '</div></div>';
  });

  var results = document.getElementById('igResults');
  if (results) results.innerHTML = h;
}

function createInstagramPost(eventId) {
  var event = E.find(function (e) { return e.id === eventId; });
  if (!event) return;

  var modal = document.getElementById('igModal');
  var canvas = document.getElementById('igCanvas');
  if (!modal || !canvas) return;

  modal.style.display = 'flex';

  var ctx = canvas.getContext('2d');
  var W = 1080, H = 1080;

  // Background
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, W, H);

  var imgUrl = event.image_url || '';

  function drawPost(bgImg) {
    // Draw background image (cover)
    if (bgImg) {
      var ratio = Math.max(W / bgImg.width, H / bgImg.height);
      var newW = bgImg.width * ratio;
      var newH = bgImg.height * ratio;
      var x = (W - newW) / 2;
      var y = (H - newH) / 2;
      ctx.drawImage(bgImg, x, y, newW, newH);

      // Dark gradient overlay for readability
      var grad = ctx.createLinearGradient(0, H * 0.45, 0, H);
      grad.addColorStop(0, 'rgba(15,23,42,0.35)');
      grad.addColorStop(1, 'rgba(15,23,42,0.92)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    } else {
      // Fallback gradient
      var g2 = ctx.createLinearGradient(0, 0, 0, H);
      g2.addColorStop(0, '#1e3a5f');
      g2.addColorStop(1, '#0f172a');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, W, H);
    }

    // Brand bar at top
    ctx.fillStyle = '#FF385C';
    ctx.fillRect(0, 0, W, 85);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 42px Outfit, sans-serif';
    ctx.fillText('MALTA EVENT GUIDE', 60, 58);

    // Main title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 58px Outfit, sans-serif';
    var title = event.title || 'Event';
    // Word wrap title
    var lines = wrapText(ctx, title, W - 120, 58);
    var titleY = 220;
    lines.forEach(function (line, i) {
      ctx.fillText(line, 60, titleY + i * 68);
    });

    // Date + Location
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '500 38px Outfit, sans-serif';
    var metaY = 520;
    if (event.event_date) ctx.fillText(event.event_date, 60, metaY);
    if (event.location) ctx.fillText(event.location + ', Malta', 60, metaY + 52);

    // Category badge
    if (event.category) {
      ctx.fillStyle = '#FF385C';
      ctx.font = 'bold 28px Outfit, sans-serif';
      ctx.fillText(event.category.toUpperCase(), 60, metaY + 110);
    }

    // Bottom branding
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '600 32px Outfit, sans-serif';
    ctx.fillText('maltaeventguide.com', 60, H - 70);

    // Small decorative line
    ctx.strokeStyle = '#FF385C';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(60, H - 95);
    ctx.lineTo(420, H - 95);
    ctx.stroke();
  }

  function wrapText(context, text, maxWidth, fontSize) {
    var words = text.split(' ');
    var lines = [];
    var currentLine = words[0];

    for (var i = 1; i < words.length; i++) {
      var testLine = currentLine + ' ' + words[i];
      var metrics = context.measureText(testLine);
      if (metrics.width > maxWidth) {
        lines.push(currentLine);
        currentLine = words[i];
      } else {
        currentLine = testLine;
      }
    }
    lines.push(currentLine);
    return lines;
  }

  if (imgUrl) {
    // Use proxy for external images to avoid CORS issues when drawing to canvas
    var proxyUrl = '/admin/api/proxy-image?url=' + encodeURIComponent(imgUrl);
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () {
      drawPost(img);
    };
    img.onerror = function () {
      console.warn('Instagram generator: Failed to load event image via proxy, using gradient fallback');
      drawPost(null); // fallback without image
    };
    img.src = proxyUrl;
  } else {
    drawPost(null);
  }

  // Store for download
  window._currentIgCanvas = canvas;
  window._currentIgEvent = event;
}

function downloadIgPost() {
  var canvas = window._currentIgCanvas;
  if (!canvas) return;

  var link = document.createElement('a');
  var safeTitle = (window._currentIgEvent && window._currentIgEvent.title || 'event')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60);
  link.download = 'malta-' + safeTitle + '-instagram.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function closeIgModal() {
  var modal = document.getElementById('igModal');
  if (modal) modal.style.display = 'none';
}
