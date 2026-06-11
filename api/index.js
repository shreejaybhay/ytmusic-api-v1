const express = require('express');
const { Readable } = require('stream');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Innertube client (singleton) ─────────────────────────────────────────────
let ytPromise = null;

async function createYT() {
  const mod = await import('youtubei.js');

  try {
    mod.Platform.shim.eval = async (data) => new Function(data.output)();
  } catch (_) {}

  const opts = {
    cache: new mod.UniversalCache(false),
    generate_session_locally: true,
    client_type: mod.ClientType.TV_EMBEDDED,
  };

  if (process.env.YT_COOKIE) opts.cookie = process.env.YT_COOKIE;

  const yt = await mod.Innertube.create(opts);

  if (process.env.YT_OAUTH && !process.env.YT_COOKIE) {
    try {
      const credentials = JSON.parse(process.env.YT_OAUTH);
      await yt.session.signIn(credentials);
      yt.session.on('update-credentials', ({ credentials: creds }) => {
        console.log('[oauth] Credentials refreshed:', JSON.stringify(creds));
      });
    } catch (e) {
      console.error('[oauth] Failed to sign in with stored credentials:', e?.message);
    }
  }

  return yt;
}

function getYT() {
  if (!ytPromise) ytPromise = createYT().catch(err => { ytPromise = null; throw err; });
  return ytPromise;
}

// ─── Middleware ───────────────────────────────────────────────────────────────
try { app.use(require('cors')()); } catch (_) {}
app.use(express.json());

// ─── Third-party stream resolvers (bypass Vercel IP block) ───────────────────

const INVIDIOUS_INSTANCES = [
  'https://invidious.nerdvpn.de',
  'https://iv.datura.network',
  'https://invidious.privacyredirect.com',
  'https://yt.artemislena.eu',
  'https://invidious.lunar.icu',
  'https://invidious.fdn.fr',
  'https://inv.tux.pizza',
  'https://invidious.einfachzocken.eu',
];

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.yt',
  'https://piped-api.garudalinux.org',
  'https://pipedapi.adminforge.de',
  'https://piped.privacydev.net/api',
  'https://pipedapi.colinslegacy.com',
];

async function getStreamFromInvidious(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const res = await fetch(
        `${instance}/api/v1/videos/${videoId}?fields=adaptiveFormats,formatStreams`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YTMusicAPI/1.0)' }, signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) continue;
      const data = await res.json();

      const audioFormats = (data.adaptiveFormats || [])
        .filter(f => f.type?.startsWith('audio/'))
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
      if (audioFormats.length && audioFormats[0].url)
        return { url: audioFormats[0].url, client: `invidious` };

      const streams = data.formatStreams || [];
      if (streams.length) {
        const url = streams.at(-1).url;
        if (url) return { url, client: `invidious` };
      }
    } catch (e) {
      console.error(`[invidious] ${instance}:`, e?.message?.substring(0, 80));
    }
  }
  return null;
}

async function getStreamFromPiped(videoId) {
  for (const instance of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${instance}/streams/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YTMusicAPI/1.0)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.error) continue;

      const audioStreams = (data.audioStreams || []).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (audioStreams.length && audioStreams[0].url)
        return { url: audioStreams[0].url, client: `piped` };

      const videoStreams = (data.videoStreams || []).sort((a, b) => (b.quality || 0) - (a.quality || 0));
      if (videoStreams.length && videoStreams[0].url)
        return { url: videoStreams[0].url, client: `piped`, type: 'video' };
    } catch (e) {
      console.error(`[piped] ${instance}:`, e?.message?.substring(0, 80));
    }
  }
  return null;
}

async function resolveYTdlp(id) {
  try {
    const url = `https://music.youtube.com/watch?v=${id}`;
    const cmd = `python -m yt_dlp -g -f "bestaudio" --no-warnings --no-playlist "${url}"`;
    const streamUrl = execSync(cmd, { timeout: 30000, encoding: 'utf8' }).trim();
    if (streamUrl) return { url: streamUrl, client: 'yt-dlp', type: 'audio' };
  } catch (e) {
    console.error(`[stream] yt-dlp error:`, e?.message?.substring(0, 200));
  }
  return null;
}

// ─── Cloudflare Worker proxy ─────────────────────────────────────────────────
// The worker relays Innertube API calls from Cloudflare IPs (unblocked by YouTube).
// Vercel generates the session context locally and sends it + videoId to the worker.

const PROXY_URL = process.env.YT_PROXY_URL;
let proxyContext = null;

async function getProxyContext() {
  if (!proxyContext) {
    const mod = await import('youtubei.js');
    const yt = await mod.Innertube.create({
      cache: new mod.UniversalCache(false),
      generate_session_locally: true,
      client_type: mod.ClientType.ANDROID_VR,
    });
    proxyContext = yt.session.context;
  }
  return proxyContext;
}

async function resolveViaProxy(id) {
  if (!PROXY_URL) return null;
  try {
    const context = await getProxyContext();
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: id, context }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('[proxy] error:', e?.message?.substring(0, 100));
  }
  return null;
}

// ─── Main stream resolver ─────────────────────────────────────────────────────

async function resolveStream(id) {
  const yt = await getYT();
  const player = yt.session.player;
  const isSignedIn = yt.session?.logged_in ?? false;

  // Try youtubei.js with signed-in clients first
  for (const client of isSignedIn ? ['WEB', 'WEB_REMIX', 'MWEB'] : ['ANDROID_VR', 'iOS', 'ANDROID', 'MWEB', 'WEB_REMIX', 'WEB']) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      const sd = info?.streaming_data;

      const tryFormat = async (fmt) => {
        if (typeof fmt.decipher === 'function' && player) {
          try {
            const url = await fmt.decipher(player);
            if (url) return url;
          } catch (_) {}
        }
        return fmt.url || null;
      };

      if (sd?.formats?.length) {
        const url = await tryFormat(sd.formats.at(-1));
        if (url) return { url, client };
      }

      if (sd?.adaptive_formats?.length) {
        const audioFmts = sd.adaptive_formats
          .filter(f => f.mime_type?.startsWith('audio/'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        for (const fmt of audioFmts) {
          const url = await tryFormat(fmt);
          if (url) return { url, client, type: 'audio' };
        }
      }
    } catch (e) {
      console.error(`[stream] client=${client} error:`, e?.message?.substring(0, 200));
    }
  }

  return null;
}

async function resolveStreamWithFallback(id) {
  // Tier 1: youtubei.js (Works locally; on Vercel requires YT_COOKIE for Music videos)
  const result = await resolveStream(id);
  if (result?.url) return result;

  // Tier 2: Cloudflare Worker proxy (bypasses Vercel IP block for non-Music videos)
  const proxyResult = await resolveViaProxy(id);
  if (proxyResult?.url) {
    return { url: proxyResult.url, client: `proxy(${proxyResult.client || '?'})`, type: proxyResult.type };
  }

  // Tier 3: Invidious + Piped in parallel
  const [invResult, pipedResult] = await Promise.allSettled([
    getStreamFromInvidious(id),
    getStreamFromPiped(id),
  ]);
  if (invResult.status === 'fulfilled' && invResult.value) return invResult.value;
  if (pipedResult.status === 'fulfilled' && pipedResult.value) return pipedResult.value;

  // Tier 4: yt-dlp (local only)
  return resolveYTdlp(id);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ message: 'YTMusic API is running' }));

app.get('/api/search', async (req, res, next) => {
  try {
    const yt = await getYT();
    const filters = {};
    if (req.query.type && req.query.type !== 'all') filters.type = req.query.type;
    const data = await yt.music.search(req.query.q, filters);
    const results = [];
    for (const item of data.contents ?? []) {
      for (const sub of item.contents ?? []) {
        if (sub.type === 'MusicResponsiveListItem' && /^[a-zA-Z0-9_-]{11}$/.test(sub.id)) {
          results.push({
            id: sub.id,
            title: sub.title,
            type: sub.item_type,
            artists: sub.artists?.map(a => ({ name: a?.name, id: a?.id })),
            album: sub.album ? { name: sub.album?.name, id: sub.album?.id } : null,
            duration: sub.duration?.text || null,
            views: sub.views || null,
            thumbnail: sub.thumbnail?.contents?.[0]?.url || null,
          });
        }
      }
    }
    results.sort((a, b) => {
      const p = v => !v ? 0 : parseFloat(v) * (v.includes('M') ? 1e6 : v.includes('K') ? 1e3 : 1);
      return p(b.views) - p(a.views);
    });
    res.json({ results });
  } catch (err) { next(err); }
});

app.get('/api/search/all', async (req, res, next) => {
  try {
    const yt = await getYT();
    const filters = {};
    if (req.query.type) filters.type = req.query.type;
    if (req.query.upload_date) filters.upload_date = req.query.upload_date;
    if (req.query.duration) filters.duration = req.query.duration;

    let data = await yt.search(req.query.q, filters);
    const mapResult = r => ({
      id: r.video_id || r.id || null,
      title: r.title?.text || r.title,
      type: r.type?.toLowerCase() || null,
      channel: r.author?.name || null,
      views: r.view_count?.text || r.view_count || null,
      duration: r.length_text?.text || r.length_text || null,
      thumbnail: r.thumbnails?.[0]?.url || null,
      published: r.published?.text || r.published || null,
    });
    let results = (data.results || []).map(mapResult);
    if (req.query.page && data.getContinuation) {
      for (let i = 1; i < parseInt(req.query.page); i++) {
        data = await data.getContinuation();
        results = results.concat((data.results || []).map(mapResult));
      }
    }
    res.json({ results, has_more: data.has_continuation });
  } catch (err) { next(err); }
});

app.get('/api/playlist/:id', async (req, res, next) => {
  try { res.json(await (await getYT()).music.getPlaylist(req.params.id)); }
  catch (err) { next(err); }
});

app.get('/api/album/:id', async (req, res, next) => {
  try { res.json(await (await getYT()).music.getAlbum(req.params.id)); }
  catch (err) { next(err); }
});

app.get('/api/artist/:id', async (req, res, next) => {
  try { res.json(await (await getYT()).music.getArtist(req.params.id)); }
  catch (err) { next(err); }
});

app.get('/api/song/:id', async (req, res, next) => {
  try {
    const yt = await getYT();
    const info = await yt.music.getInfo(req.params.id);
    const streamResult = await resolveStreamWithFallback(req.params.id);
    res.json({ ...info, stream_url: streamResult?.url || null });
  } catch (err) { next(err); }
});

app.get('/api/home', async (req, res, next) => {
  try { res.json(await (await getYT()).music.getHomeFeed()); }
  catch (err) { next(err); }
});

app.get('/api/explore', async (req, res, next) => {
  try { res.json(await (await getYT()).music.getExplore()); }
  catch (err) { next(err); }
});

app.get('/api/lyrics/:id', async (req, res, next) => {
  try { res.json(await (await getYT()).music.getLyrics(req.params.id)); }
  catch (err) {
    if (err.message === 'Lyrics not available')
      res.json({ lyrics: null, message: 'No lyrics available for this song' });
    else next(err);
  }
});

app.get('/api/upnext/:id', async (req, res, next) => {
  try { res.json(await (await getYT()).music.getUpNext(req.params.id)); }
  catch (err) { next(err); }
});

app.get('/api/related/:id', async (req, res, next) => {
  try { res.json(await (await getYT()).music.getRelated(req.params.id)); }
  catch (err) { next(err); }
});

async function pipeStream(url, req, res, timeout = 20000) {
  const headers = {
    Accept: '*/*',
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com',
  };
  if (req.headers.range) headers.Range = req.headers.range;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const ytRes = await fetch(url, { headers, redirect: 'follow', signal: ac.signal });
    clearTimeout(t);

    if (!ytRes.ok) return { error: ytRes.status };

    const ct = ytRes.headers.get('content-type');
    const cl = ytRes.headers.get('content-length');
    const cr = ytRes.headers.get('content-range');
    if (ct) res.setHeader('Content-Type', ct);
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);
    if (req.headers.range) res.status(206);

    Readable.fromWeb(ytRes.body).pipe(res);
    return { ok: true };
  } catch (e) {
    clearTimeout(t);
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

app.get('/api/stream/:id', async (req, res, next) => {
  try {
    const id = req.params.id;

    if (req.query.url_only === 'true') {
      const result = await resolveStreamWithFallback(id);
      if (!result) return res.status(404).json({ error: 'No playable stream found for this video' });
      return res.json({ url: result.url, client: result.client });
    }

    // Tier 1: Try youtubei.js URL
    const result = await resolveStreamWithFallback(id);
    if (result) {
      const p = await pipeStream(result.url, req, res);
      if (p.ok) return;
      console.error(`[stream] pipe failed (${result.client}):`, p.error);
    }

    res.status(404).json({ error: 'No playable stream found for this video' });
  } catch (err) { next(err); }
});

// OAuth setup endpoint
app.get('/api/auth/start', async (req, res, next) => {
  try {
    const mod = await import('youtubei.js');
    const yt = await mod.Innertube.create({
      client_type: mod.ClientType.TV_EMBEDDED,
      generate_session_locally: true,
    });

    let pendingData = null;
    yt.session.on('auth-pending', data => { pendingData = data; });

    yt.session.signIn().catch(() => {});

    await new Promise(r => setTimeout(r, 2000));

    if (pendingData) {
      res.json({
        message: 'Visit the URL below on any device and enter the code. Then call /api/auth/poll to get your credentials.',
        verification_url: pendingData.verification_url,
        user_code: pendingData.user_code,
        expires_in: pendingData.expires_in,
        instruction: 'Once authorized, copy the credentials JSON printed in Vercel logs and set it as YT_OAUTH env var',
      });
    } else {
      res.status(500).json({ error: 'Could not start auth flow' });
    }
  } catch (err) { next(err); }
});

// Debug endpoint
app.get('/api/debug/:id', async (req, res, next) => {
  try {
    const yt = await getYT();
    const id = req.params.id;
    const out = {
      auth: {
        cookie_set: !!process.env.YT_COOKIE,
        cookie_length: process.env.YT_COOKIE ? process.env.YT_COOKIE.length : 0,
        cookie_preview: process.env.YT_COOKIE ? process.env.YT_COOKIE.substring(0, 20) + '...' : null,
        oauth_set: !!process.env.YT_OAUTH,
        oauth_length: process.env.YT_OAUTH ? process.env.YT_OAUTH.length : 0,
        signed_in: yt.session?.logged_in ?? false,
      },
      innertube: {},
      invidious: null,
      piped: null,
    };

    for (const client of ['ANDROID_VR', 'iOS', 'ANDROID', 'WEB']) {
      try {
        const info = await yt.getBasicInfo(id, { client });
        out.innertube[client] = {
          playability: info?.playability_status?.status,
          formats: info?.streaming_data?.formats?.length || 0,
          adaptive: info?.streaming_data?.adaptive_formats?.length || 0,
        };
      } catch (e) {
        out.innertube[client] = { error: e?.message?.substring(0, 100) };
      }
    }

    const proxyResult = PROXY_URL ? await resolveViaProxy(id) : null;
    out.proxy = {
      configured: !!PROXY_URL,
      url: PROXY_URL ? PROXY_URL.substring(0, 40) + '...' : null,
      ok: !!proxyResult?.url,
      error: proxyResult?.error || null,
    };

    const [invResult, pipedResult] = await Promise.allSettled([
      getStreamFromInvidious(id),
      getStreamFromPiped(id),
    ]);
    out.invidious = invResult.status === 'fulfilled' && invResult.value ? { ok: true } : { ok: false };
    out.piped = pipedResult.status === 'fulfilled' && pipedResult.value ? { ok: true } : { ok: false };

    res.json(out);
  } catch (err) { next(err); }
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err?.stack || err);
  res.status(500).json({ error: err?.message || 'Something went wrong!' });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
