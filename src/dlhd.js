const fetch = require('node-fetch');
const { getStreamHeaders, registerHost } = require('./proxy');

const DLHD_BASE = process.env.DLHD_BASE_URL || 'https://dlhd.pk';
const SERVER_LOOKUP_URLS = [
  `${DLHD_BASE}/server_lookup.php?channel_id={server_type}{channel_id}`,
  'https://allupplay.xyz/server_lookup.php?channel_id={server_type}{channel_id}',
  'https://cookiewebplay.xyz/server_lookup.php?channel_id={server_type}{channel_id}'
];
const M3U8_TEMPLATE = 'https://{server_key}new.newkso.ru/{server_key}/{server_type}{channel_id}/mono.m3u8';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function lookupServerKey(channelId, serverType = 'premium') {
  const headers = {
    Referer: `${DLHD_BASE}/`,
    Origin: DLHD_BASE,
    'User-Agent': UA
  };

  for (const template of SERVER_LOOKUP_URLS) {
    const url = template
      .replace('{server_type}', serverType)
      .replace('{channel_id}', channelId);

    try {
      const res = await fetch(url, { headers, redirect: 'follow', timeout: 10000 });
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

async function resolveChannelStream(channelId, channelName) {
  const serverKey = await lookupServerKey(channelId);
  if (!serverKey) return null;
  const url = buildM3u8Url(serverKey, channelId);
  const probe = await fetch(url, {
    headers: getStreamHeaders(url),
    redirect: 'follow',
    timeout: 8000
  }).catch(() => null);

  if (!probe || !probe.ok) return { url, channelName, channelId, verified: false };
  return { url, channelName, channelId, verified: true };
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
  resolveEventStreams
};
