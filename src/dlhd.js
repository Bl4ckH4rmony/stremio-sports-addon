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

function absUrl(url, base = DLHD_BASE) {
  if (url.startsWith('http')) return url;
  return `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

function decodeEmbedSource(html) {
  const match = html.match(/source:\s*window\.atob\(['"]([A-Za-z0-9+/=]+)['"]\)/i)
    || html.match(/atob\(['"]([A-Za-z0-9+/=]+)['"]\)/i);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    if (decoded.startsWith('http') && decoded.includes('.m3u8')) return decoded;
  } catch {
    return null;
  }
  return null;
}

async function resolveViaEmbedPage(channelId) {
  for (const folder of STREAM_PAGE_PATHS) {
    const pageUrl = `${DLHD_BASE}/${folder}/stream-${channelId}.php`;
    try {
      const pageRes = await fetch(pageUrl, { headers: FETCH_HEADERS, redirect: 'follow', timeout: 15000 });
      if (!pageRes.ok) continue;
      const pageHtml = await pageRes.text();
      const iframeMatch = pageHtml.match(/<iframe[^>]+src="([^"]+)"/i);
      if (!iframeMatch) continue;

      const embedUrl = absUrl(iframeMatch[1]);
      const embedRes = await fetch(embedUrl, {
        headers: { ...FETCH_HEADERS, Referer: pageUrl },
        redirect: 'follow',
        timeout: 15000
      });
      if (!embedRes.ok) continue;
      const embedHtml = await embedRes.text();
      const m3u8 = decodeEmbedSource(embedHtml);
      if (!m3u8) continue;

      registerHost(new URL(m3u8).hostname);
      registerHost(new URL(embedUrl).hostname);
      return m3u8;
    } catch {
      // try next folder
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
      const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', timeout: 10000 });
      if (res.status !== 200) continue;
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
  const serverKey = await lookupServerKey(channelId);
  if (!serverKey) return null;
  return buildM3u8Url(serverKey, channelId);
}

async function probeStream(url) {
  try {
    const res = await fetch(url, {
      headers: getStreamHeaders(url),
      redirect: 'follow',
      timeout: 8000
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveChannelStream(channelId, channelName) {
  let url = await resolveViaEmbedPage(channelId);
  let method = 'embed';

  if (!url) {
    url = await resolveViaServerLookup(channelId);
    method = 'lookup';
  }

  if (!url) return null;

  const verified = await probeStream(url);
  return { url, channelName, channelId, verified, method };
}

async function resolveEventStreams(channels) {
  if (!channels || channels.length === 0) return [];

  const results = await Promise.all(
    channels.slice(0, 12).map(ch =>
      resolveChannelStream(ch.channel_id, ch.channel_name)
    )
  );

  return results.filter(Boolean);
}

module.exports = {
  lookupServerKey,
  buildM3u8Url,
  resolveChannelStream,
  resolveEventStreams,
  resolveViaEmbedPage,
  decodeEmbedSource
};
