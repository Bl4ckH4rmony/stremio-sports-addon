const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 7000;

const STREAM_HEADERS = {
  'Referer': 'https://cookiewebplay.xyz/',
  'Origin': 'https://cookiewebplay.xyz',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

const ALLOWED_HOSTS = ['mizhls.ru'];

const M3U_URLS = [
  // pigzillaaa - verified working raw URLs
  'https://raw.githubusercontent.com/pigzillaaa/daddylive/refs/heads/main/daddylive-channels.m3u8',
  'https://raw.githubusercontent.com/pigzillaaa/daddylive/refs/heads/main/daddylive-events.m3u8',
  // ICEZOMBIE - another active mirror
  'https://raw.githubusercontent.com/ICEZOMBIE-m3u/Daddylive-m3u/main/Playlist.m3u8',
  // aphrodite747
  'https://raw.githubusercontent.com/aphrodite747/daddylive-m3u/main/playlist.m3u8',
];

const MANIFEST = {
  id: 'org.stremio.sportslive',
  version: '1.3.0',
  name: '🏟️ Sports Live TV',
  description: 'Live sports and TV channels via DaddyLive. Premier League, NFL, NBA, UFC, Cricket and more.',
  resources: ['stream', 'catalog', 'meta'],
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'sportslive-all',
      name: '🏟️ All Sports & Live TV',
      extra: [{ name: 'search', isRequired: false }]
    },
    {
      type: 'tv',
      id: 'sportslive-sports',
      name: '⚽ Sports Channels Only',
      extra: [{ name: 'search', isRequired: false }]
    }
  ],
  idPrefixes: ['sportslive:']
};

let channelCache = null;
let cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000;

async function fetchFromUrl(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    redirect: 'follow',
    timeout: 10000
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('#EXTINF')) throw new Error('Not a valid M3U');
  return text;
}

async function fetchChannels() {
  if (channelCache && channelCache.length > 0 && Date.now() - cacheTime < CACHE_TTL) {
    return channelCache;
  }

  const allChannels = [];

  for (const url of M3U_URLS) {
    try {
      console.log(`Trying: ${url}`);
      const text = await fetchFromUrl(url);
      const channels = parseM3U(text);
      console.log(`✅ Got ${channels.length} channels from ${url}`);
      allChannels.push(...channels);
    } catch (err) {
      console.error(`❌ Failed ${url}: ${err.message}`);
    }
  }

  // Dedupe by name
  const seen = new Set();
  const unique = allChannels.filter(ch => {
    if (seen.has(ch.name)) return false;
    seen.add(ch.name);
    return true;
  });

  if (unique.length > 0) {
    channelCache = unique;
    cacheTime = Date.now();
    console.log(`Total unique channels: ${unique.length}`);
  }

  return channelCache || [];
}

function parseM3U(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const channels = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXTINF')) {
      const info = lines[i];
      const url = lines[i + 1];
      if (!url || url.startsWith('#')) continue;

      const nameMatch = info.match(/,(.+)$/);
      const logoMatch = info.match(/tvg-logo="([^"]+)"/);
      const groupMatch = info.match(/group-title="([^"]+)"/);

      const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
      const logo = logoMatch ? logoMatch[1] : null;
      const group = groupMatch ? groupMatch[1] : 'Other';

      const id = 'sportslive:' + Buffer.from(name + url).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 40);

      channels.push({ id, name, logo, group, url });
      i++;
    }
  }
  return channels;
}

function isSportsChannel(ch) {
  const kw = ['sport', 'football', 'soccer', 'nfl', 'nba', 'nhl', 'mlb', 'espn',
    'sky sport', 'bt sport', 'tnt sport', 'dazn', 'eurosport', 'bein', 'fox sport',
    'golf', 'tennis', 'cricket', 'rugby', 'mma', 'ufc', 'boxing', 'f1', 'formula',
    'motorsport', 'racing', 'wrestling', 'wwe', 'arena', 'score', 'supersport'];
  const text = (ch.name + ' ' + ch.group).toLowerCase();
  return kw.some(k => text.includes(k));
}

function getBaseUrl(req) {
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function encodeProxyUrl(url) {
  return Buffer.from(url).toString('base64url');
}

function decodeProxyUrl(encoded) {
  return Buffer.from(encoded, 'base64url').toString();
}

function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
}

function toProxyUrl(targetUrl, req) {
  return `${getBaseUrl(req)}/proxy?u=${encodeProxyUrl(targetUrl)}`;
}

function isM3u8(url, contentType) {
  if (url.includes('.m3u8')) return true;
  const ct = (contentType || '').toLowerCase();
  return ct.includes('mpegurl') || ct.includes('x-mpegurl');
}

function rewriteM3u8(content, manifestUrl, req) {
  const base = new URL(manifestUrl);
  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const abs = new URL(uri, base).href;
        return `URI="${toProxyUrl(abs, req)}"`;
      });
    }

    const abs = new URL(trimmed, base).href;
    return toProxyUrl(abs, req);
  }).join('\n');
}

async function probeUpstream(url) {
  try {
    const res = await fetch(url, { headers: STREAM_HEADERS, redirect: 'follow', timeout: 10000 });
    return { status: res.status, ok: res.ok };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

function toMeta(ch) {
  return {
    id: ch.id,
    type: 'tv',
    name: ch.name,
    poster: ch.logo || `https://placehold.co/300x170/1a1a2e/ffffff?text=${encodeURIComponent(ch.name.substring(0, 20))}`,
    background: ch.logo || null,
    logo: ch.logo || null,
    description: `Live: ${ch.group}`,
    genres: [ch.group]
  };
}

// Routes
app.get('/manifest.json', (req, res) => res.json(MANIFEST));

app.get('/debug', async (req, res) => {
  const channels = await fetchChannels();
  const sample = channels[0];
  let proxyTest = null;

  if (sample) {
    const upstream = await probeUpstream(sample.url);
    proxyTest = {
      channel: sample.name,
      upstreamUrl: sample.url,
      upstreamStatus: upstream.status,
      upstreamOk: upstream.ok,
      upstreamError: upstream.error || null,
      proxiedUrl: toProxyUrl(sample.url, req)
    };
  }

  res.json({
    channelCount: channels.length,
    cacheAgeSeconds: Math.round((Date.now() - cacheTime) / 1000),
    groups: [...new Set(channels.map(c => c.group))].slice(0, 20),
    sample: channels.slice(0, 10).map(c => ({ name: c.name, group: c.group })),
    proxyTest
  });
});

app.get('/proxy', async (req, res) => {
  const encoded = req.query.u;
  if (!encoded) return res.status(400).send('Missing u parameter');

  let upstreamUrl;
  try {
    upstreamUrl = decodeProxyUrl(encoded);
    new URL(upstreamUrl);
  } catch {
    return res.status(400).send('Invalid URL');
  }

  const { hostname } = new URL(upstreamUrl);
  if (!isAllowedHost(hostname)) {
    console.error(`Proxy blocked host: ${hostname}`);
    return res.status(403).send('Host not allowed');
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: STREAM_HEADERS,
      redirect: 'follow',
      timeout: 15000
    });

    if (!upstream.ok) {
      console.error(`Proxy upstream ${upstream.status}: ${upstreamUrl}`);
      return res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
    }

    const contentType = upstream.headers.get('content-type') || '';

    if (isM3u8(upstreamUrl, contentType)) {
      const text = await upstream.text();
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewriteM3u8(text, upstreamUrl, req));
      return;
    }

    if (contentType) res.set('Content-Type', contentType);
    const cacheControl = upstream.headers.get('cache-control');
    if (cacheControl) res.set('Cache-Control', cacheControl);
    upstream.body.pipe(res);
  } catch (err) {
    console.error(`Proxy error for ${upstreamUrl}: ${err.message}`);
    res.status(502).send('Proxy fetch failed');
  }
});

app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { type, id } = req.params;
  const extra = req.params.extra ? JSON.parse(decodeURIComponent(req.params.extra)) : {};
  if (type !== 'tv') return res.json({ metas: [] });

  let channels = await fetchChannels();
  if (id === 'sportslive-sports') channels = channels.filter(isSportsChannel);
  if (extra.search) {
    const q = extra.search.toLowerCase();
    channels = channels.filter(ch =>
      ch.name.toLowerCase().includes(q) || ch.group.toLowerCase().includes(q)
    );
  }

  res.json({ metas: channels.slice(0, 300).map(toMeta) });
});

app.get('/meta/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  if (type !== 'tv') return res.json({ meta: {} });
  const channels = await fetchChannels();
  const ch = channels.find(c => c.id === id);
  res.json({ meta: ch ? toMeta(ch) : {} });
});

app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  if (type !== 'tv') return res.json({ streams: [] });
  const channels = await fetchChannels();
  const ch = channels.find(c => c.id === id);
  if (!ch) return res.json({ streams: [] });

  res.json({
    streams: [{
      name: '🔴 LIVE',
      title: ch.name,
      url: toProxyUrl(ch.url, req),
      behaviorHints: {
        notWebReady: true
      }
    }]
  });
});

app.get('/', (req, res) => {
  res.send('🏟️ Sports Addon running. <a href="/debug">Check /debug</a>');
});

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
  fetchChannels();
});
