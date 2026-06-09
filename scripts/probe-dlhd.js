const fetch = require('node-fetch');

const headers = {
  Referer: 'https://dlhd.pk/',
  Origin: 'https://dlhd.pk',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

(async () => {
  const stream = await fetch('https://dlhd.pk/stream/stream-358.php', { headers, timeout: 20000 });
  const streamHtml = await stream.text();
  const iframe = streamHtml.match(/<iframe[^>]+src="([^"]+)"/i);
  console.log('iframe', iframe && iframe[1]);

  if (iframe) {
    const embed = await fetch(iframe[1], { headers: { ...headers, Referer: 'https://dlhd.pk/' }, timeout: 20000 });
    const embedHtml = await embed.text();
    console.log('embed status', embed.status, embedHtml.length);
    const m3u8 = [...embedHtml.matchAll(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/g)].slice(0, 8);
    console.log('m3u8', m3u8.map(m => m[0]));
    const lookup = [...embedHtml.matchAll(/https?:\/\/[^"'\s]*lookup[^"'\s]*/g)].slice(0, 5);
    console.log('lookup urls', lookup.map(m => m[0]));
  }

  const lookups = [
    'https://dlhd.pk/luna/server_lookup.php?channel_id=premium358',
    'https://fnjplay.xyz/server_lookup.php?channel_id=premium358',
    'https://cheesehost.xyz/server_lookup.php?channel_id=premium358'
  ];
  for (const u of lookups) {
    try {
      const r = await fetch(u, { headers, timeout: 10000 });
      const t = await r.text();
      if (t.includes('server_key')) console.log('HIT', u, t.slice(0, 120));
    } catch (e) {
      console.log('miss', u, e.code || e.message);
    }
  }
})();
