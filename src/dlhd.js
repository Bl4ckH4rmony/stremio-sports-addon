const fetch = require('node-fetch');
const { getStreamHeaders, registerHost } = require('./proxy');

const DLHD_BASE = process.env.DLHD_BASE_URL || 'https://dlhd.pk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const FETCH_HEADERS = {
  Referer: `${DLHD_BASE}/`,
  Origin: DLHD_BASE.replace(/\/$/, ''),
  'User-Agent': UA
};

const STREAM_PAGE_PATHS = ['stream', 'cast', 'watch', 'plus', 'player'];
const SERVER_LOOKUP_URLS = [
  `${DLHD_BASE}/server_lookup.php?channel_id={server_type}{channel_id}`,
  'https://cookiewebplay.xyz/server_lookup.php?channel_id={server_type}{channel_id}'
];
const M3U8_TEMPLATE = 'https://{server_key}new.newkso.ru/{server_key}/{server_type}{channel_id}/mono.m3u8';

const STREAM_CACHE_TTL = 3 * 60 * 1000;
const RESOLVE_CONCURRENCY = 3;
const MIN_STREAMS_TARGET = 4;
const MAX_CHANNEL_ATTEMPTS = 20;
const REQUEST_DELAY_MS = 120;

const streamCache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function absUrl(url, base = DLHD_BASE) {
  if (url.startsWith('http')) return url;
  return `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

function channelPriority(ch) {
  const name = ch.channel_name.toLowerCase();
  const id = parseInt(ch.channel_id, 10);
  if (name.includes('backup')) return 100;
  if (id >= 5000) return 90;
  if (id >= 3000) return 60;
  if (name.includes('multifeed')) return 70;
  return 0;
}

function sortChannels(channels) {
  const seen = new Set();
  return [...channels]
    .sort((a, b) => channelPriority(a) - channelPriority(b))
    .filter(ch => {
      const key = ch.channel_id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function decodeEmbedSource(html) {
  const patterns = [
    /source:\s*window\.atob\(['"]([A-Za-z0-9+/=]+)['"]\)/gi,
    /atob\(['"]([A-Za-z0-9+/=]+)['"]\)/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      try {
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        if (decoded.startsWith('http') && decoded.includes('.m3u8')) return decoded;
      } catch {
        // try next match
      }
    }
  }
  return null;
}

async function fetchWithRetry(url, options, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...options, timeout: options.timeout || 18000 });
      if (res.status === 429 || res.status >= 500) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

function cacheStream(channelId, url, method) {
  streamCache.set(channelId, { url, method, cachedAt: Date.now() });
  registerHost(new URL(url).hostname);
}

function getCachedStream(channelId) {
  const cached = streamCache.get(channelId);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > STREAM_CACHE_TTL) {
    streamCache.delete(channelId);
    return null;
  }
  return cached.url;
}

async function resolveEmbedFromPage(pageUrl) {
  const pageRes = await fetchWithRetry(pageUrl, { headers: FETCH_HEADERS, redirect: 'follow' });
  if (!pageRes.ok) return null;
  const pageHtml = await pageRes.text();

  const iframeMatch = pageHtml.match(/<iframe[^>]+src="([^"]+)"/i);
  if (!iframeMatch) return null;

  const embedUrl = absUrl(iframeMatch[1]);
  registerHost(new URL(embedUrl).hostname);

  const embedRes = await fetchWithRetry(embedUrl, {
    headers: { ...FETCH_HEADERS, Referer: pageUrl },
    redirect: 'follow'
  });
  if (!embedRes.ok) return null;

  const embedHtml = await embedRes.text();
  return decodeEmbedSource(embedHtml);
}

async function resolveViaEmbedPage(channelId) {
  const cached = getCachedStream(channelId);
  if (cached) return cached;

  const entryPoints = [
    ...STREAM_PAGE_PATHS.map(folder => `${DLHD_BASE}/${folder}/stream-${channelId}.php`),
    `${DLHD_BASE}/watch.php?id=${channelId}`
  ];

  for (const pageUrl of entryPoints) {
    try {
      const m3u8 = await resolveEmbedFromPage(pageUrl);
      if (!m3u8) continue;
      cacheStream(channelId, m3u8, 'embed');
      return m3u8;
    } catch {
      // try next entry point
    }
  }
  return null;
}

async function lookupServerKey(channelId, serverType = 'premium') {
  for (const template of SERVER_LOOKUP_URLS) {
    const url = template
      .replace('{server_type}', serverType)
      .replace('{channel_id}', channelId);

    try {
      const res = await fetchWithRetry(url, { headers: FETCH_HEADERS, redirect: 'follow', timeout: 10000 }, 1);
      if (!res || res.status !== 200) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) continue;
      const data = await res.json();
      if (data.server_key) return data.server_key;
    } catch {
      // try next lookup URL
    }
  }
  return null;
}

function buildM3u8Url(serverKey, channelId, serverType = 'premium') {
  const url = M3U8_TEMPLATE
    .replace(/\{server_key\}/g, serverKey)
    .replace('{server_type}', serverType)
    .replace('{channel_id}', channelId);
  registerHost(new URL(url).hostname);
  return url;
}

async function resolveViaServerLookup(channelId) {
  const cached = getCachedStream(channelId);
  if (cached) return cached;

  const serverKey = await lookupServerKey(channelId);
  if (!serverKey) return null;
  const url = buildM3u8Url(serverKey, channelId);
  cacheStream(channelId, url, 'lookup');
  return url;
}

async function resolveChannelStream(channelId, channelName) {
  let url = await resolveViaEmbedPage(channelId);
  let method = 'embed';

  if (!url) {
    url = await resolveViaServerLookup(channelId);
    method = 'lookup';
  }

  if (!url) return null;

  return { url, channelName, channelId, verified: true, method };
}

async function resolveEventStreams(channels) {
  if (!channels || channels.length === 0) return [];

  const sorted = sortChannels(channels);
  const toTry = sorted.slice(0, MAX_CHANNEL_ATTEMPTS);
  const results = [];
  const resolvedIds = new Set();
  let index = 0;

  async function worker() {
    while (index < toTry.length) {
      if (results.length >= MIN_STREAMS_TARGET + 4) break;
      const i = index++;
      const ch = toTry[i];
      if (resolvedIds.has(ch.channel_id)) continue;

      const stream = await resolveChannelStream(ch.channel_id, ch.channel_name);
      if (stream) {
        resolvedIds.add(ch.channel_id);
        results.push(stream);
      }

      await sleep(REQUEST_DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: RESOLVE_CONCURRENCY }, () => worker()));

  return results.sort((a, b) => {
    const priA = channelPriority({ channel_name: a.channelName, channel_id: a.channelId });
    const priB = channelPriority({ channel_name: b.channelName, channel_id: b.channelId });
    return priA - priB;
  });
}

function getStreamCacheStats() {
  const now = Date.now();
  let valid = 0;
  for (const [, entry] of streamCache) {
    if (now - entry.cachedAt < STREAM_CACHE_TTL) valid++;
  }
  return { entries: streamCache.size, valid };
}

module.exports = {
  lookupServerKey,
  buildM3u8Url,
  resolveChannelStream,
  resolveEventStreams,
  resolveViaEmbedPage,
  decodeEmbedSource,
  getStreamCacheStats
};
