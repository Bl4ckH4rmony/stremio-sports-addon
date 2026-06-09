const fetch = require('node-fetch');
const fs = require('fs');

(async () => {
  const headers = { Referer: 'https://dlhd.pk/', 'User-Agent': 'Mozilla/5.0' };
  const url = 'https://donis.jimpenopisonline.online/premiumtv/daddy5.php?id=358';
  const r = await fetch(url, { headers, timeout: 20000 });
  const html = await r.text();
  fs.writeFileSync('tmp-embed.html', html);
  const keys = ['newkso', 'm3u8', 'server', 'lookup', 'source', 'file:', 'hls', 'playlist', 'channel'];
  for (const k of keys) {
    const idx = html.toLowerCase().indexOf(k.toLowerCase());
    if (idx >= 0) console.log(k, 'at', idx, html.slice(idx, idx + 120).replace(/\s+/g, ' '));
  }
})();
