const fetch = require('node-fetch');

const DLHD_BASE = process.env.DLHD_BASE_URL || 'https://dlhd.pk';
const SCHEDULE_CACHE_TTL = 5 * 60 * 1000;
const DISPLAY_TZ = process.env.TZ || 'Africa/Johannesburg';
const UK_TZ = 'Europe/London';

const SOCCER_KW = ['soccer', 'football', 'fifa', 'premier', 'la liga', 'serie a', 'bundesliga',
  'champions league', 'uefa', 'friendly', 'mls', 'copa', 'ligue', 'eredivisie', 'world cup'];

let eventCache = [];
let cacheTime = 0;
let lastSource = 'none';
let lastFetchError = null;

function makeEventId(title, timestamp) {
  const raw = title + String(timestamp);
  return 'live:' + Buffer.from(raw).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 40);
}

function parseUkDate(header) {
  const m = header.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\w+)\s+(\d{4})/i);
  if (!m) return null;
  const months = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
  const month = months[m[3].toLowerCase()];
  if (month === undefined) return null;
  return { year: parseInt(m[4], 10), month, day: parseInt(m[2], 10) };
}

function ukLocalToUtc(year, month, day, hour, minute) {
  const probe = new Date(Date.UTC(year, month, day, hour, minute));
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: UK_TZ,
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
  const skip = ['tv shows', 'ppv events', 'upcoming events'];
  return !skip.some(s => event.category.toLowerCase().includes(s));
}

function normalizeChannels(channels) {
  if (!channels) return [];
  const list = Array.isArray(channels) ? channels : Object.values(channels);
  return list
    .map(ch => ({
      channel_name: ch.channel_name || ch.name || 'Stream',
      channel_id: String(ch.channel_id || ch.id || ''),
      logo_url: ch.logo_url || ch.logo || null
    }))
    .filter(ch => ch.channel_id);
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

        const ts = ukLocalToUtc(
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

function parseHtmlSchedule(html) {
  const events = [];
  const lines = html.replace(/<[^>]+>/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);

  let currentDate = null;
  let currentCategory = 'Live';
  const categoryMaxTime = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const dayMatch = line.match(/(\w+day)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\w+)\s+(\d{4})\s+-\s+Schedule/i);
    if (dayMatch) {
      currentDate = parseUkDate(line);
      categoryMaxTime[currentCategory] = null;
      continue;
    }

    if (line.length < 40 && !line.match(/^\d{1,2}:\d{2}/) && !line.includes('http')) {
      const lower = line.toLowerCase();
      if (!['upcoming events', 'schedule time uk gmt', 'chat', 'menu'].includes(lower)) {
        currentCategory = line;
        categoryMaxTime[currentCategory] = null;
      }
      continue;
    }

    const eventMatch = line.match(/^(\d{1,2}):(\d{2})\s+(.+)$/);
    if (!eventMatch || !currentDate) continue;

    const hour = parseInt(eventMatch[1], 10);
    const minute = parseInt(eventMatch[2], 10);
    const title = eventMatch[3].trim();
    if (title.length < 3) continue;

    const timeKey = `${hour}:${minute}`;
    let rollDay = false;
    const maxTime = categoryMaxTime[currentCategory];
    if (maxTime && (hour < maxTime.hour || (hour === maxTime.hour && minute < maxTime.minute))) {
      rollDay = true;
    }
    categoryMaxTime[currentCategory] = { hour, minute };

    let y = currentDate.year, m = currentDate.month, d = currentDate.day;
    if (rollDay) {
      const next = new Date(Date.UTC(y, m, d + 1));
      y = next.getUTCFullYear();
      m = next.getUTCMonth();
      d = next.getUTCDate();
    }

    const channels = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (/^\d{1,2}:\d{2}\s/.test(next)) break;
      if (/(\w+day)\s+\d{1,2}/i.test(next)) break;
      if (next.length < 50 && next === next.toUpperCase() && !next.includes(':')) break;
      if (next.startsWith('Channel Not Listed')) { j++; continue; }
      if (next.length > 2 && next.length < 80) {
        channels.push({ channel_name: next, channel_id: '', logo_url: null });
      }
      j++;
      if (channels.length >= 8) break;
    }

    const ts = ukLocalToUtc(y, m, d, hour, minute);
    events.push({
      id: makeEventId(title, ts),
      title,
      category: currentCategory,
      channels,
      startTs: ts,
      kind: 'event',
      htmlOnly: true
    });
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
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: `${DLHD_BASE}/` },
    redirect: 'follow',
    timeout: 20000
  });
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
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: `${DLHD_BASE}/` },
        redirect: 'follow',
        timeout: 15000
      });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      const text = await res.text();
      if (ct.includes('json') || text.trim().startsWith('{')) {
        return parseApiSchedule(JSON.parse(text));
      }
    } catch {
      // try next
    }
  }
  return null;
}

async function fetchFromHtml() {
  const res = await fetch(`${DLHD_BASE}/`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: `${DLHD_BASE}/` },
    redirect: 'follow',
    timeout: 25000
  });
  if (!res.ok) throw new Error(`HTML HTTP ${res.status}`);
  const html = await res.text();
  return parseHtmlSchedule(html);
}

async function enrichChannelsFromApi(events) {
  const key = process.env.DLHD_API_KEY;
  if (!key) return events;

  try {
    const res = await fetch(`${DLHD_BASE}/daddyapi.php?key=${encodeURIComponent(key)}&endpoint=channels`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: `${DLHD_BASE}/` },
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

    return events.map(ev => {
      if (!ev.htmlOnly) return ev;
      const channels = ev.channels.map(c => {
        const match = byName.get(c.channel_name.toLowerCase().trim());
        if (match) return normalizeChannels([match])[0];
        return c;
      }).filter(c => c.channel_id);
      return { ...ev, channels, htmlOnly: channels.length === 0 };
    });
  } catch {
    return events;
  }
}

async function fetchEvents() {
  if (eventCache.length > 0 && Date.now() - cacheTime < SCHEDULE_CACHE_TTL) {
    return filterActiveEvents(eventCache);
  }

  let events = [];
  lastFetchError = null;

  try {
    events = await fetchFromApi();
    if (events && events.length > 0) lastSource = 'api';
  } catch (err) {
    lastFetchError = err.message;
    console.error(`DLHD API: ${err.message}`);
  }

  if (!events || events.length === 0) {
    try {
      events = await fetchFromJsonEndpoint();
      if (events && events.length > 0) lastSource = 'json';
    } catch (err) {
      console.error(`DLHD JSON endpoint: ${err.message}`);
    }
  }

  if (!events || events.length === 0) {
    try {
      events = await fetchFromHtml();
      lastSource = 'html';
      events = await enrichChannelsFromApi(events);
    } catch (err) {
      lastFetchError = err.message;
      console.error(`DLHD HTML: ${err.message}`);
    }
  }

  if (events && events.length > 0) {
    eventCache = events;
    cacheTime = Date.now();
    const active = filterActiveEvents(events);
    console.log(`📅 Schedule: ${active.length} active events (source: ${lastSource}, total parsed: ${events.length})`);
    return active;
  }

  if (eventCache.length > 0) return filterActiveEvents(eventCache);
  return [];
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

function getEventById(id) {
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
    error: lastFetchError,
    timezone: DISPLAY_TZ
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
  DISPLAY_TZ
};
