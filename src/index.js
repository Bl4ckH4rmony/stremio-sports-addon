const express = require('express');
const cors = require('cors');

const { fetchChannels, isSportsChannel, isKidsChannel, toChannelMeta, getChannelStats } = require('./channels');
const { fetchEvents, toEventMeta, getEventById, isSoccerEvent, getScheduleStats } = require('./schedule');
const { resolveEventStreams, getStreamCacheStats } = require('./dlhd');
const { toProxyUrl, probeUpstream, createProxyHandler } = require('./proxy');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 7000;

const MANIFEST = {
  id: 'org.stremio.sportslive',
  version: '2.0.2',
  name: '🏟️ Sports Live TV',
  description: 'Live match schedule (dlhd.pk style) plus verified 24/7 sports, kids and entertainment channels.',
  resources: ['stream', 'catalog', 'meta'],
  types: ['tv'],
  catalogs: [
    { type: 'tv', id: 'live-today', name: '📅 Live Today', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'live-soccer', name: '⚽ Soccer Matches', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'live-sports', name: '🏟️ Live Sports', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'channels-sports', name: '📺 24/7 Sports', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'channels-kids', name: '🧒 Kids & Family', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'channels-all', name: '📡 All Channels', extra: [{ name: 'search', isRequired: false }] }
  ],
  idPrefixes: ['sportslive:', 'live:']
};

const LIVE_CATALOGS = new Set(['live-today', 'live-soccer', 'live-sports']);
const CHANNEL_CATALOGS = new Set(['channels-sports', 'channels-kids', 'channels-all']);

function applySearch(items, extra, fields) {
  if (!extra.search) return items;
  const q = extra.search.toLowerCase();
  return items.filter(item => fields.some(f => (item[f] || '').toLowerCase().includes(q)));
}

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

app.get('/debug', async (req, res) => {
  const [channels, events] = await Promise.all([fetchChannels(), fetchEvents()]);
  const scheduleStats = getScheduleStats();
  const channelStats = getChannelStats();

  const sampleEvent = events[0];
  let sampleEventDetail = null;
  if (sampleEvent) {
    const streams = await resolveEventStreams(sampleEvent.channels.filter(c => c.channel_id));
    sampleEventDetail = {
      name: toEventMeta(sampleEvent).name,
      streams: sampleEvent.channels.length,
      resolvedStreams: streams.length,
      verifiedStreams: streams.filter(s => s.verified).length
    };
  }

  const sampleChannel = channels.find(isSportsChannel) || channels[0];
  let proxyTest = null;
  if (sampleChannel) {
    const upstream = await probeUpstream(sampleChannel.url);
    proxyTest = {
      channel: sampleChannel.name,
      upstreamUrl: sampleChannel.url,
      upstreamStatus: upstream.status,
      upstreamOk: upstream.ok,
      upstreamError: upstream.error || null,
      proxiedUrl: toProxyUrl(sampleChannel.url, req)
    };
  }

  res.json({
    version: MANIFEST.version,
    timezone: scheduleStats.timezone,
    schedule: scheduleStats,
    channels: {
      total: channels.length,
      sports: channels.filter(isSportsChannel).length,
      kids: channels.filter(isKidsChannel).length,
      cacheAgeSeconds: channelStats.cacheTime ? Math.round((Date.now() - channelStats.cacheTime) / 1000) : null,
      fetchStats: channelStats.lastFetchStats
    },
    sampleEvent: sampleEventDetail,
    streamCache: getStreamCacheStats(),
    sampleChannels: channels.slice(0, 5).map(c => ({ name: c.name, group: c.group })),
    proxyTest
  });
});

app.get('/proxy', createProxyHandler());

app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { type, id } = req.params;
  const extra = req.params.extra ? JSON.parse(decodeURIComponent(req.params.extra)) : {};
  if (type !== 'tv') return res.json({ metas: [] });

  if (LIVE_CATALOGS.has(id)) {
    let events = await fetchEvents();
    if (id === 'live-soccer') events = events.filter(isSoccerEvent);
    if (id === 'live-sports') events = events.filter(e => !isSoccerEvent(e));
    events = applySearch(events, extra, ['title', 'category']);
    return res.json({ metas: events.slice(0, 300).map(toEventMeta) });
  }

  if (CHANNEL_CATALOGS.has(id)) {
    let channels = await fetchChannels();
    if (id === 'channels-sports') channels = channels.filter(isSportsChannel);
    if (id === 'channels-kids') channels = channels.filter(isKidsChannel);
    channels = applySearch(channels, extra, ['name', 'group']);
    return res.json({ metas: channels.slice(0, 300).map(toChannelMeta) });
  }

  res.json({ metas: [] });
});

app.get('/meta/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  if (type !== 'tv') return res.json({ meta: {} });

  if (id.startsWith('live:')) {
    const event = getEventById(id);
    return res.json({ meta: event ? toEventMeta(event) : {} });
  }

  const channels = await fetchChannels();
  const ch = channels.find(c => c.id === id);
  res.json({ meta: ch ? toChannelMeta(ch) : {} });
});

app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  if (type !== 'tv') return res.json({ streams: [] });

  if (id.startsWith('live:')) {
    const event = getEventById(id, true);
    if (!event) return res.json({ streams: [] });

    const withIds = event.channels.filter(c => c.channel_id);
    if (withIds.length === 0) {
      return res.json({
        streams: [{
          name: '⚠️ No streams',
          title: event.title,
          description: 'Channel IDs not available — set DLHD_API_KEY on Render for full stream support.',
          url: '',
          behaviorHints: { notWebReady: true }
        }]
      });
    }

    const resolved = await resolveEventStreams(withIds);
    if (resolved.length === 0) {
      return res.json({
        streams: [{
          name: '⏳ Retry in a moment',
          title: event.title,
          description: 'DLHD stream lookup timed out — tap play again. Upstream may be rate-limiting.',
          url: '',
          behaviorHints: { notWebReady: true }
        }]
      });
    }

    return res.json({
      streams: resolved.map(s => ({
        name: s.channelName,
        title: event.title,
        url: toProxyUrl(s.url, req),
        behaviorHints: { notWebReady: true }
      }))
    });
  }

  const channels = await fetchChannels();
  const ch = channels.find(c => c.id === id);
  if (!ch) return res.json({ streams: [] });

  res.json({
    streams: [{
      name: '🔴 LIVE',
      title: ch.name,
      url: toProxyUrl(ch.url, req),
      behaviorHints: { notWebReady: true }
    }]
  });
});

app.get('/', (req, res) => {
  res.send('🏟️ Sports Addon v2 — <a href="/debug">Check /debug</a>');
});

app.listen(PORT, () => {
  console.log(`Running on port ${PORT} (v${MANIFEST.version}, TZ=${process.env.TZ || 'Africa/Johannesburg'})`);
  fetchChannels();
  fetchEvents();
});
