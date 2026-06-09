const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const DLHD_BASE = process.env.DLHD_BASE_URL || 'https://dlhd.pk';
const SCHEDULE_CACHE_TTL = 5 * 60 * 1000;
const STALE_CACHE_TTL = 8 * 60 * 60 * 1000;
const CACHE_FILE = path.join(__dirname, '..', 'schedule-cache.json');
const SCHEDULE_BASES = [
  DLHD_BASE,
  'https://www.livetvon.pk',
  'https://livetvon.pk'
];
const DISPLAY_TZ = process.env.TZ || 'Africa/Johannesburg';
// dlhd.pk header says "UK GMT" — times are UTC+0 year-round, not Europe/London BST
const SCHEDULE_TZ = process.env.SCHEDULE_TZ || 'GMT';
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: `${DLHD_BASE}/`,
  Origin: DLHD_BASE.replace(/\/$/, '')
};

const SOCCER_KW = ['soccer', 'football', 'fifa', 'premier', 'la liga', 'serie a', 'bundesliga',
  'champions league', 'uefa', 'friendly', 'mls', 'copa', 'ligue', 'eredivisie', 'world cup'];

let eventCache = [];
let cacheTime = 0;
let lastSource = 'none';
let lastFetchError = null;
let lastParseStats = null;
let refreshInFlight = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadPersistedCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!data.events?.length) return;
    if (Date.now() - data.cacheTime > STALE_CACHE_TTL) return;
    eventCache = data.events;
    cacheTime = data.cacheTime;
    lastSource = data.source || 'persisted';
    console.log(`📅 Loaded ${eventCache.length} cached events from disk (${Math.round((Date.now() - cacheTime) / 60000)}m old)`);
  } catch (err) {
    console.error(`Schedule cache load failed: ${err.message}`);
  }
}

function persistCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      events: eventCache,
      cacheTime,
      source: lastSource
    }));
  } catch (err) {
    console.error(`Schedule cache save failed: ${err.message}`);
  }
}

function makeEventId(title, timestamp) {
  const raw = title + String(timestamp);
  return 'live:' + Buffer.from(raw).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 40);
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function parseUkDate(header) {
  const m = header.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\w+)\s+(\d{4})/i);
  if (!m) return null;
  const months = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };
  const month = months[m[3].toLowerCase()];
  if (month === undefined) return null;
  return { year: parseInt(m[4], 10), month, day: parseInt(m[2], 10) };
}

function scheduleTimeToUtc(year, month, day, hour, minute) {
  if (SCHEDULE_TZ === 'GMT' || SCHEDULE_TZ === 'UTC' || SCHEDULE_TZ === 'Etc/GMT') {
    return Math.floor(Date.UTC(year, month, day, hour, minute) / 1000);
  }
  const probe = new Date(Date.UTC(year, month, day, hour, minute));
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: SCHEDULE_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(probe).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const offset = shown - probe.getTime();
  return Math.floor((probe.getTime() - offset) / 1000);
}

function formatDisplayTime(unixTs) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = fmt.formatToParts(new Date(unixTs * 1000));
  const h = parts.find(p => p.type === 'hour')?.value || '00';
  const m = parts.find(p => p.type === 'minute')?.value || '00';
  const tzShort = DISPLAY_TZ.includes('Johannesburg') ? 'SAST' : DISPLAY_TZ.split('/').pop();
  return `${h}:${m} ${tzShort}`;
}

function isSoccerEvent(event) {
  const text = (event.category + ' ' + event.title).toLowerCase();
  return SOCCER_KW.some(k => text.includes(k));
}

function isLiveSportEvent(event) {
  const cat = event.category.toLowerCase();
  const skip = ['tv shows', 'ppv events'];
  if (skip.some(s => cat.includes(s))) return false;
  if (cat === 'upcoming events') return false;
  return true;
}

function normalizeChannels(channels) {
  if (!channels) return [];
  const list = Array.isArray(channels) ? channels : Object.values(channels);
  const seen = new Set();
  return list
    .map(ch => ({
      channel_name: ch.channel_name || ch.name || 'Stream',
      channel_id: String(ch.channel_id || ch.id || ''),
      logo_url: ch.logo_url || ch.logo || null
    }))
    .filter(ch => ch.channel_id && ch.channel_id !== '00')
    .filter(ch => {
      const key = ch.channel_id + ':' + ch.channel_name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function parseChannelsFromHtml(block) {
  const channels = [];
  const linkRegex = /<a[^>]+href="\/watch\.php\?id=(\d+)"[^>]*title="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(block)) !== null) {
    channels.push({
      channel_name: decodeHtmlEntities(match[2].trim()),
      channel_id: match[1],
      logo_url: null
    });
  }
  return normalizeChannels(channels);
}

function parseStructuredHtmlSchedule(html) {
  const events = [];
  const dayBlocks = html.split(/<div class="schedule__day">/i).slice(1);

  for (const dayBlock of dayBlocks) {
    const dayMatch = dayBlock.match(/<div class="schedule__dayTitle">([^<]+)<\/div>/i);
    if (!dayMatch) continue;
    const dateParts = parseUkDate(dayMatch[1]);
    if (!dateParts) continue;

    const categoryBlocks = dayBlock.split(/<div class="schedule__category/i).slice(1);
    for (const catBlock of categoryBlocks) {
      const catMatch = catBlock.match(/<div class="card__meta">([^<]*)<\/div>/i);
      const category = catMatch ? decodeHtmlEntities(catMatch[1].trim()) : 'Live';

      let rollDay = false;
      let lastHour = -1;
      let lastMinute = -1;
      let y = dateParts.year;
      let m = dateParts.month;
      let d = dateParts.day;

      const eventBlocks = catBlock.split(/<div class="schedule__event">/i).slice(1);
      for (const evBlock of eventBlocks) {
        const timeMatch = evBlock.match(/data-time="(\d{1,2}):(\d{2})"/i);
        const titleMatch = evBlock.match(/<span class="schedule__eventTitle">([^<]+)<\/span>/i);
        if (!timeMatch || !titleMatch) continue;

        const hour = parseInt(timeMatch[1], 10);
        const minute = parseInt(timeMatch[2], 10);
        const title = decodeHtmlEntities(titleMatch[1].trim());
        if (title.length < 3) continue;

        if (lastHour >= 0 && (hour < lastHour || (hour === lastHour && minute < lastMinute))) {
          rollDay = true;
        }
        lastHour = hour;
        lastMinute = minute;

        let ey = y;
        let em = m;
        let ed = d;
        if (rollDay) {
          const next = new Date(Date.UTC(y, m, d + 1));
          ey = next.getUTCFullYear();
          em = next.getUTCMonth();
          ed = next.getUTCDate();
        }

        const channels = parseChannelsFromHtml(evBlock);
        if (channels.length === 0) continue;

        const ts = scheduleTimeToUtc(ey, em, ed, hour, minute);
        events.push({
          id: makeEventId(title, ts),
          title,
          category,
          channels,
          startTs: ts,
          kind: 'event'
        });
      }
    }
  }

  const byId = new Map();
  for (const ev of events) {
    if (!byId.has(ev.id)) byId.set(ev.id, ev);
  }
  return [...byId.values()];
}

function parseApiSchedule(data) {
  const events = [];
  if (!data || typeof data !== 'object') return events;

  const schedule = data.data || data;
  for (const [dayHeader, categories] of Object.entries(schedule)) {
    if (!categories || typeof categories !== 'object') continue;
    const dateParts = parseUkDate(dayHeader);
    if (!dateParts) continue;

    for (const [category, items] of Object.entries(categories)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const timeMatch = (item.time || '').match(/^(\d{1,2}):(\d{2})$/);
        if (!timeMatch) continue;
        const channels = normalizeChannels(item.channels);
        if (channels.length === 0) continue;

        const ts = scheduleTimeToUtc(
          dateParts.year, dateParts.month, dateParts.day,
          parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10)
        );

        const title = item.event || item.title || 'Live Event';
        events.push({
          id: makeEventId(title, ts),
          title,
          category,
          channels,
          startTs: ts,
          kind: 'event'
        });
      }
    }
  }
  return events;
}

function filterActiveEvents(events) {
  const now = Math.floor(Date.now() / 1000);
  const pastWindow = 3 * 3600;
  const futureWindow = 24 * 3600;

  return events
    .filter(e => e.startTs >= now - pastWindow && e.startTs <= now + futureWindow)
    .filter(isLiveSportEvent)
    .sort((a, b) => a.startTs - b.startTs);
}

async function fetchFromApi() {
  const key = process.env.DLHD_API_KEY;
  if (!key) return null;

  const url = `${DLHD_BASE}/daddyapi.php?key=${encodeURIComponent(key)}&endpoint=schedule`;
  const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', timeout: 20000 });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const data = await res.json();
  if (!data.success && !data.data) throw new Error(data.message || data.error || 'API failed');
  return parseApiSchedule(data);
}

async function fetchFromJsonEndpoint() {
  const urls = [
    `${DLHD_BASE}/schedule/schedule-generated.php`,
    'https://daddylive.dad/schedule/schedule-generated.php'
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', timeout: 15000 });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      const text = await res.text();
      if (ct.includes('json') || text.trim().startsWith('{')) {
        const parsed = parseApiSchedule(JSON.parse(text));
        if (parsed.length > 0) return parsed;
      }
    } catch {
      // try next
    }
  }
  return null;
}

async function fetchHtmlFromBase(base) {
  const res = await fetch(`${base}/`, {
    headers: { ...FETCH_HEADERS, Referer: `${base}/`, Origin: base.replace(/\/$/, '') },
    redirect: 'follow',
    timeout: 20000
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (!html.includes('schedule__dayTitle') || !html.includes('schedule__eventTitle')) {
    throw new Error('No schedule markup in response');
  }
  return { html, base };
}

async function fetchHtmlFromSources() {
  const bases = [...new Set(SCHEDULE_BASES)];
  for (let round = 0; round < 3; round++) {
    const results = await Promise.allSettled(bases.map(base => fetchHtmlFromBase(base)));
    for (const result of results) {
      if (result.status === 'fulfilled') return result.value;
    }
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`DLHD HTML attempt ${round + 1}: ${result.reason?.message || result.reason}`);
      }
    }
    if (round < 2) await sleep(1500 * (round + 1));
  }
  throw new Error('No schedule HTML source responded');
}

async function fetchFromHtml() {
  const { html, base } = await fetchHtmlFromSources();
  const events = parseStructuredHtmlSchedule(html);
  lastParseStats = { totalParsed: events.length, htmlBytes: html.length, base };
  if (events.length === 0) {
    throw new Error(`Structured HTML parse returned 0 events from ${base}`);
  }
  return events;
}

async function enrichChannelsFromApi(events) {
  const key = process.env.DLHD_API_KEY;
  if (!key) return events;

  try {
    const res = await fetch(`${DLHD_BASE}/daddyapi.php?key=${encodeURIComponent(key)}&endpoint=channels`, {
      headers: FETCH_HEADERS,
      timeout: 15000
    });
    if (!res.ok) return events;
    const data = await res.json();
    const channelList = data.data || data.channels || [];
    const byName = new Map();
    for (const ch of channelList) {
      if (ch.channel_name && ch.channel_id) {
        byName.set(ch.channel_name.toLowerCase().trim(), ch);
      }
    }

    return events.map(ev => ({
      ...ev,
      channels: ev.channels.map(c => {
        const match = byName.get(c.channel_name.toLowerCase().trim());
        return match ? normalizeChannels([match])[0] : c;
      }).filter(c => c.channel_id)
    }));
  } catch {
    return events;
  }
}

async function pullSchedule() {
  let events = [];
  lastFetchError = null;

  try {
    events = await fetchFromApi();
    if (events?.length > 0) lastSource = 'api';
  } catch (err) {
    lastFetchError = err.message;
    console.error(`DLHD API: ${err.message}`);
  }

  if (!events?.length) {
    try {
      events = await fetchFromJsonEndpoint();
      if (events?.length > 0) lastSource = 'json';
    } catch (err) {
      console.error(`DLHD JSON endpoint: ${err.message}`);
    }
  }

  if (!events?.length) {
    events = await fetchFromHtml();
    lastSource = 'html';
    events = await enrichChannelsFromApi(events);
  }

  if (events?.length > 0) {
    eventCache = events;
    cacheTime = Date.now();
    persistCache();
    const active = filterActiveEvents(events);
    console.log(`📅 Schedule: ${active.length} active events (source: ${lastSource}, total parsed: ${events.length})`);
    return active;
  }

  throw new Error(lastFetchError || 'Schedule fetch returned no events');
}

function refreshScheduleInBackground() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = pullSchedule()
    .catch(err => {
      lastFetchError = err.message;
      console.error(`DLHD background refresh: ${err.message}`);
      return filterActiveEvents(eventCache);
    })
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function fetchEvents() {
  const age = cacheTime ? Date.now() - cacheTime : Infinity;

  if (eventCache.length > 0 && age < SCHEDULE_CACHE_TTL) {
    return filterActiveEvents(eventCache);
  }

  if (eventCache.length > 0 && age < STALE_CACHE_TTL) {
    refreshScheduleInBackground();
    return filterActiveEvents(eventCache);
  }

  try {
    return await pullSchedule();
  } catch (err) {
    lastFetchError = err.message;
    console.error(`DLHD HTML: ${err.message}`);
    if (eventCache.length > 0) return filterActiveEvents(eventCache);
    return [];
  }
}

function startSchedulePoller() {
  loadPersistedCache();
  refreshScheduleInBackground();
  setInterval(() => {
    if (eventCache.length === 0 || Date.now() - cacheTime >= SCHEDULE_CACHE_TTL) {
      refreshScheduleInBackground();
    }
  }, 90 * 1000);
}

function toEventMeta(event) {
  const timeLabel = formatDisplayTime(event.startTs);
  const channelNames = event.channels.map(c => c.channel_name).slice(0, 8).join(' · ');
  const logo = event.channels[0]?.logo_url;
  const posterLogo = logo
    ? (logo.startsWith('http') ? logo : `${DLHD_BASE}/${logo.replace(/^\//, '')}`)
    : null;

  return {
    id: event.id,
    type: 'tv',
    name: `${timeLabel} · ${event.title}`,
    poster: posterLogo || `https://placehold.co/300x170/0d1b2a/ffffff?text=${encodeURIComponent(timeLabel)}`,
    background: posterLogo,
    logo: posterLogo,
    description: `${event.category}${channelNames ? '\n' + channelNames : ''}`,
    genres: [event.category],
    releaseInfo: new Date(event.startTs * 1000).toISOString().slice(0, 10)
  };
}

function getEventById(id, forStream = false) {
  const ev = eventCache.find(e => e.id === id);
  if (!ev) return null;
  if (forStream) {
    const now = Math.floor(Date.now() / 1000);
    const pastWindow = 4 * 3600;
    const futureWindow = 24 * 3600;
    if (ev.startTs >= now - pastWindow && ev.startTs <= now + futureWindow) return ev;
    return null;
  }
  return filterActiveEvents(eventCache).find(e => e.id === id) || null;
}

function getScheduleStats() {
  const active = filterActiveEvents(eventCache);
  return {
    events: active.length,
    soccer: active.filter(isSoccerEvent).length,
    source: lastSource,
    cacheAgeSeconds: cacheTime ? Math.round((Date.now() - cacheTime) / 1000) : null,
    nextRefreshSec: cacheTime ? Math.max(0, Math.round((SCHEDULE_CACHE_TTL - (Date.now() - cacheTime)) / 1000)) : 0,
    staleCacheSeconds: cacheTime ? Math.round((Date.now() - cacheTime) / 1000) : null,
    usingStaleCache: cacheTime ? Date.now() - cacheTime >= SCHEDULE_CACHE_TTL : false,
    error: lastFetchError,
    timezone: DISPLAY_TZ,
    scheduleTimezone: SCHEDULE_TZ,
    parseStats: lastParseStats
  };
}

module.exports = {
  fetchEvents,
  toEventMeta,
  getEventById,
  isSoccerEvent,
  isLiveSportEvent,
  getScheduleStats,
  formatDisplayTime,
  DISPLAY_TZ,
  parseStructuredHtmlSchedule,
  startSchedulePoller
};
