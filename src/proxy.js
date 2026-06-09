const fetch = require('node-fetch');

const validatedHosts = new Set();

function getStreamHeaders(url) {
  const host = new URL(url).hostname;
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  if (
    host.endsWith('newkso.ru') || host.endsWith('mizhls.ru') ||
    host.includes('phantemlis') || host.includes('jimpenopisonline') ||
    host.endsWith('.top') && host.includes('premium')
  ) {
    return { Referer: 'https://dlhd.pk/', Origin: 'https://dlhd.pk', 'User-Agent': ua };
  }
  if (host.endsWith('thetvapp.to')) {
    return { Referer: 'https://thetvapp.to/', Origin: 'https://thetvapp.to', 'User-Agent': ua };
  }
  return { 'User-Agent': ua };
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

function registerHost(hostname) {
  if (hostname) validatedHosts.add(hostname);
}

function isAllowedHost(hostname) {
  if (validatedHosts.has(hostname)) return true;
  for (const allowed of validatedHosts) {
    if (hostname === allowed || hostname.endsWith('.' + allowed)) return true;
  }
  return false;
}

function toProxyUrl(targetUrl, req) {
  registerHost(new URL(targetUrl).hostname);
  return `${getBaseUrl(req)}/proxy?u=${encodeProxyUrl(targetUrl)}`;
}

function isM3u8(url, contentType) {
  if (url.includes('.m3u8')) return true;
  const ct = (contentType || '').toLowerCase();
  return ct.includes('mpegurl') || ct.includes('x-mpegurl');
}

function registerManifestHosts(content, manifestUrl) {
  const base = new URL(manifestUrl);
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      const uriMatch = trimmed.match(/URI="([^"]+)"/);
      if (uriMatch) registerHost(new URL(uriMatch[1], base).hostname);
      continue;
    }
    registerHost(new URL(trimmed, base).hostname);
  }
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

async function probeUpstream(url, timeout = 8000) {
  try {
    const res = await fetch(url, { headers: getStreamHeaders(url), redirect: 'follow', timeout });
    return { status: res.status, ok: res.ok };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

function createProxyHandler() {
  return async (req, res) => {
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
        headers: getStreamHeaders(upstreamUrl),
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
        registerManifestHosts(text, upstreamUrl);
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
  };
}

module.exports = {
  validatedHosts,
  getStreamHeaders,
  getBaseUrl,
  toProxyUrl,
  registerHost,
  probeUpstream,
  createProxyHandler
};
