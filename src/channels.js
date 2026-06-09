const fetch = require('node-fetch');
const { validatedHosts, getStreamHeaders } = require('./proxy');

const M3U_URLS = [
  { name: 'US Samsung TV', url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/us_samsung.m3u' },
  { name: 'US', url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/us.m3u' },
  { name: 'UK', url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/uk.m3u' },
  { name: 'Canada', url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/ca.m3u' },
  { name: 'South Africa', url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/za.m3u' }
];

const VALIDATE_CONCURRENCY = 12;
const VALIDATE_TIMEOUT = 8000;
const MAX_VALIDATE = 250;
const CACHE_TTL = 30 * 60 * 1000;

let channelCache = null;
let cacheTime = 0;
let lastFetchStats = null;

async function fetchFromUrl(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    redirect: 'follow',
    timeout: 15000
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('#EXTINF')) throw new Error('Not a valid M3U');
  return text;
}

function parseM3U(text, sourceName) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const channels = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXTINF')) {
      const info = lines[i];
      const url = lines[i + 1];
      if (!url || url.startsWith('#') || !url.startsWith('http')) continue;

      const nameMatch = info.match(/,(.+)$/);
      const logoMatch = info.match(/tvg-logo="([^"]+)"/);
      const groupMatch = info.match(/group-title="([^"]+)"/);

      const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
      const logo = logoMatch ? logoMatch[1] : null;
      const group = groupMatch ? groupMatch[1] : sourceName;

      const id = 'sportslive:' + Buffer.from(name + url).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 40);

      channels.push({ id, name, logo, group, url, source: sourceName, kind: 'channel' });
      i++;
    }
  }
  return channels;
}

function isSportsChannel(ch) {
  const kw = ['sport', 'football', 'soccer', 'nfl', 'nba', 'nhl', 'mlb', 'espn',
    'sky sport', 'bt sport', 'tnt sport', 'dazn', 'eurosport', 'bein', 'fox sport',
    'golf', 'tennis', 'cricket', 'rugby', 'mma', 'ufc', 'boxing', 'f1', 'formula',
    'motorsport', 'racing', 'wrestling', 'wwe', 'arena', 'score', 'supersport',
    'stadium', 'outdoor', 'nba tv', 'mlb channel', 'nfl channel', 'willow'];
  const text = (ch.name + ' ' + ch.group).toLowerCase();
  return kw.some(k => text.includes(k));
}

function isKidsChannel(ch) {
  const kw = ['nickelodeon', 'nick ', 'nick jr', 'cartoon', 'disney', 'cbeebies', 'kids',
    'family', 'pop kids', 'pop max', 'pbs kids', 'cartoonito', 'boomerang', 'tiny pop',
    'baby tv', 'ducktv', 'moonbug', 'paw patrol'];
  const text = (ch.name + ' ' + ch.group).toLowerCase();
  return kw.some(k => text.includes(k));
}

function channelPriority(ch) {
  if (isSportsChannel(ch)) return 0;
  if (isKidsChannel(ch)) return 1;
  return 2;
}

async function validateStream(url) {
  const headers = getStreamHeaders(url);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', timeout: VALIDATE_TIMEOUT });
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (url.includes('.m3u8') || ct.includes('mpegurl') || ct.includes('x-mpegurl')) {
      const text = await res.text();
      return text.includes('#EXT');
    }
    return true;
  } catch {
    return false;
  }
}

async function validateChannels(channels) {
  const sorted = [...channels].sort((a, b) => channelPriority(a) - channelPriority(b));
  const toCheck = sorted.slice(0, MAX_VALIDATE);
  const working = [];
  let checked = 0;
  let index = 0;

  async function worker() {
    while (index < toCheck.length) {
      const i = index++;
      const ch = toCheck[i];
      checked++;
      if (await validateStream(ch.url)) {
        validatedHosts.add(new URL(ch.url).hostname);
        working.push(ch);
      }
    }
  }

  await Promise.all(Array.from({ length: VALIDATE_CONCURRENCY }, () => worker()));
  return { working, checked, total: channels.length };
}

async function fetchChannels() {
  if (channelCache && channelCache.length > 0 && Date.now() - cacheTime < CACHE_TTL) {
    return channelCache;
  }

  const allChannels = [];
  const sourceStats = {};

  for (const { name, url } of M3U_URLS) {
    try {
      console.log(`Fetching playlist: ${name}`);
      const text = await fetchFromUrl(url);
      const channels = parseM3U(text, name);
      console.log(`  Parsed ${channels.length} channels from ${name}`);
      allChannels.push(...channels);
      sourceStats[name] = { parsed: channels.length, error: null };
    } catch (err) {
      console.error(`  Failed ${name}: ${err.message}`);
      sourceStats[name] = { parsed: 0, error: err.message };
    }
  }

  const seen = new Set();
  const unique = allChannels.filter(ch => {
    if (seen.has(ch.name)) return false;
    seen.add(ch.name);
    return true;
  });

  console.log(`Validating streams (${Math.min(unique.length, MAX_VALIDATE)} of ${unique.length} channels)...`);
  const { working, checked } = await validateChannels(unique);

  const seenWorking = new Set();
  const dedupedWorking = working.filter(ch => {
    if (seenWorking.has(ch.name)) return false;
    seenWorking.add(ch.name);
    return true;
  });

  if (dedupedWorking.length > 0) {
    channelCache = dedupedWorking;
    cacheTime = Date.now();
    console.log(`✅ ${dedupedWorking.length} working channels (${dedupedWorking.filter(isSportsChannel).length} sports, ${dedupedWorking.filter(isKidsChannel).length} kids)`);
  } else {
    console.error('⚠️ No working streams found — keeping previous cache if available');
  }

  lastFetchStats = {
    sources: sourceStats,
    parsed: unique.length,
    validated: checked,
    working: dedupedWorking.length,
    sports: dedupedWorking.filter(isSportsChannel).length,
    kids: dedupedWorking.filter(isKidsChannel).length
  };

  return channelCache || [];
}

function toChannelMeta(ch) {
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

function getChannelStats() {
  return {
    cacheTime,
    lastFetchStats,
    count: channelCache ? channelCache.length : 0
  };
}

module.exports = {
  fetchChannels,
  isSportsChannel,
  isKidsChannel,
  toChannelMeta,
  getChannelStats
};
