const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Innertube client cache ───────────────────────────────────────────────────
let ytPromise;

async function createYT() {
  const mod = await import('youtubei.js');

  try {
    mod.Platform.shim.eval = async (data) => new Function(data.output)();
  } catch (_) {}

  const opts = {
    cache: new mod.UniversalCache(false),
    generate_session_locally: true,
    // IOS client: returns plain stream URLs (no decipher needed) and is
    // the least restricted client type on fresh/unauthenticated sessions.
    client_type: mod.ClientType.IOS,
  };

  // A valid YouTube account cookie bypasses the "Sign in to confirm" bot check
  // that Vercel datacenter IPs trigger. Set YT_COOKIE in Vercel env vars.
  if (process.env.YT_COOKIE) opts.cookie = process.env.YT_COOKIE;

  return mod.Innertube.create(opts);
}

async function getYT() {
  if (!ytPromise) ytPromise = createYT();
  return ytPromise;
}

// ─── Third-party stream resolvers (bypass Vercel IP block) ───────────────────

/**
 * List of Invidious API instances sorted by reliability.
 * Source: https://api.invidious.io/instances.json (only api:true ones)
 */
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

/**
 * List of Piped API backend instances.
 * Source: https://github.com/TeamPiped/Piped/wiki/Instances
 */
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.yt',
  'https://piped-api.garudalinux.org',
  'https://pipedapi.adminforge.de',
  'https://piped.privacydev.net/api',
  'https://pipedapi.colinslegacy.com',
];

/**
 * Try to get a stream URL from an Invidious instance.
 * Uses ?local=true so URLs are proxied through the instance's own IP
 * (which is not blocked by YouTube).
 */
async function getStreamFromInvidious(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const res = await fetch(
        `${instance}/api/v1/videos/${videoId}?fields=adaptiveFormats,formatStreams`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YTMusicAPI/1.0)' },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!res.ok) continue;

      const data = await res.json();

      // Prefer audio-only adaptive formats
      const audioFormats = (data.adaptiveFormats || [])
        .filter(f => f.type?.startsWith('audio/'))
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));

      if (audioFormats.length) {
        const url = audioFormats[0].url;
        if (url) return { url, source: `invidious:${instance}` };
      }

      // Fall back to combined formatStreams
      const streams = data.formatStreams || [];
      if (streams.length) {
        const url = streams.at(-1).url;
        if (url) return { url, source: `invidious-stream:${instance}` };
      }
    } catch (e) {
      console.error(`[invidious] ${instance} failed:`, e?.message);
    }
  }
  return null;
}

/**
 * Try to get an audio stream URL from a Piped API instance.
 */
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

      const audioStreams = (data.audioStreams || [])
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (audioStreams.length) {
        const url = audioStreams[0].url;
        if (url) return { url, source: `piped:${instance}` };
      }
    } catch (e) {
      console.error(`[piped] ${instance} failed:`, e?.message);
    }
  }
  return null;
}

/**
 * Try to get a stream URL via youtubei.js (Innertube).
 * Works locally and when YT_COOKIE is set in production.
 */
async function getStreamFromInnertube(videoId) {
  try {
    const yt = await getYT();
    const info = await yt.getBasicInfo(videoId, 'IOS');
    const sd = info?.streaming_data;

    if (sd?.formats?.length) {
      const fmt = sd.formats.at(-1);
      const url = fmt.url || (typeof fmt.decipher === 'function'
        ? await fmt.decipher(yt.session.player) : null);
      if (url) return { url, source: 'innertube:IOS' };
    }

    // Try audio-only adaptive formats
    if (sd?.adaptive_formats?.length) {
      const audioFmt = sd.adaptive_formats
        .filter(f => f.mime_type?.startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (audioFmt) {
        const url = audioFmt.url || (typeof audioFmt.decipher === 'function'
          ? await audioFmt.decipher(yt.session.player) : null);
        if (url) return { url, source: 'innertube:IOS:adaptive' };
      }
    }
  } catch (e) {
    console.error('[innertube] failed:', e?.message);
  }
  return null;
}

// ─── Main stream resolver ─────────────────────────────────────────────────────

/**
 * Resolves a stream URL using multiple strategies in priority order:
 * 1. Innertube (works locally / when YT_COOKIE is set)
 * 2. Invidious public instances
 * 3. Piped public instances
 */
async function resolveStreamUrl(videoId) {
  // Strategy 1: Innertube (fast when it works)
  const innertubeResult = await getStreamFromInnertube(videoId);
  if (innertubeResult) return innertubeResult;

  // Strategy 2 & 3: Run Invidious and Piped in parallel for speed
  const [invResult, pipedResult] = await Promise.allSettled([
    getStreamFromInvidious(videoId),
    getStreamFromPiped(videoId),
  ]);

  if (invResult.status === 'fulfilled' && invResult.value) return invResult.value;
  if (pipedResult.status === 'fulfilled' && pipedResult.value) return pipedResult.value;

  return null;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

try {
  const cors = require('cors');
  app.use(cors());
} catch (_) {}

app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ message: 'YTMusic API is running' });
});

app.get('/api/search', async (req, res, next) => {
  try {
    const yt = await getYT();
    const filters = {};
    if (req.query.type && req.query.type !== 'all') {
      filters.type = req.query.type;
    }
    const data = await yt.music.search(req.query.q, filters);
    const results = [];
    for (const item of data.contents) {
      if (item.contents) {
        for (const sub of item.contents) {
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
    }
    results.sort((a, b) => {
      const parse = (v) => {
        if (!v) return 0;
        const n = parseFloat(v);
        return v.includes('M') ? n * 1e6 : v.includes('K') ? n * 1e3 : n;
      };
      return parse(b.views) - parse(a.views);
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

    const mapResult = (r) => ({
      id: r.video_id || r.id || null,
      title: r.title?.text || r.title,
      type: r.type?.toLowerCase() || null,
      channel: r.author?.name || null,
      views: r.view_count?.text || r.view_count || null,
      duration: r.length_text?.text || r.length_text || null,
      thumbnail: r.thumbnails?.[0]?.url || null,
      published: r.published?.text || r.published || null,
      subscribers: r.subscriber_count?.text || r.subscriber_count || null,
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
  try {
    const yt = await getYT();
    const data = await yt.music.getPlaylist(req.params.id);
    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/album/:id', async (req, res, next) => {
  try {
    const yt = await getYT();
    const data = await yt.music.getAlbum(req.params.id);
    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/artist/:id', async (req, res, next) => {
  try {
    const yt = await getYT();
    const data = await yt.music.getArtist(req.params.id);
    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/song/:id', async (req, res, next) => {
  try {
    const yt = await getYT();
    const info = await yt.music.getInfo(req.params.id);
    const streamResult = await resolveStreamUrl(req.params.id);
    res.json({ ...info, stream_url: streamResult?.url || null });
  } catch (err) { next(err); }
});

app.get('/api/home', async (req, res, next) => {
  try {
    const yt = await getYT();
    const data = await yt.music.getHomeFeed();
    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/explore', async (req, res, next) => {
  try {
    const yt = await getYT();
    const data = await yt.music.getExplore();
    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/lyrics/:id', async (req, res, next) => {
  try {
    const yt = await getYT();
    const data = await yt.music.getLyrics(req.params.id);
    res.json(data);
  } catch (err) {
    if (err.message === 'Lyrics not available') {
      res.json({ lyrics: null, message: 'No lyrics available for this song' });
    } else {
      next(err);
    }
  }
});

app.get('/api/upnext/:id', async (req, res, next) => {
  try {
    const yt = await getYT();
    const data = await yt.music.getUpNext(req.params.id);
    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/related/:id', async (req, res, next) => {
  try {
    const yt = await getYT();
    const data = await yt.music.getRelated(req.params.id);
    res.json(data);
  } catch (err) { next(err); }
});

// Main stream endpoint
app.get('/api/stream/:id', async (req, res, next) => {
  try {
    const result = await resolveStreamUrl(req.params.id);
    if (result) {
      return res.json({ url: result.url, source: result.source });
    }
    res.status(404).json({ error: 'No playable stream found for this video' });
  } catch (err) { next(err); }
});

// Debug endpoint: shows innertube playability + which third-party sources respond
app.get('/api/debug/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const out = { innertube: null, invidious: null, piped: null };

    // Innertube check
    try {
      const yt = await getYT();
      const info = await yt.getBasicInfo(id, 'IOS');
      out.innertube = {
        has_streaming_data: !!info?.streaming_data,
        formats: info?.streaming_data?.formats?.length || 0,
        adaptive: info?.streaming_data?.adaptive_formats?.length || 0,
        playability: info?.playability_status?.status,
        reason: info?.playability_status?.reason,
        cookie_set: !!process.env.YT_COOKIE,
      };
    } catch (e) {
      out.innertube = { error: e?.message };
    }

    // Invidious check
    try {
      const invResult = await getStreamFromInvidious(id);
      out.invidious = invResult
        ? { ok: true, source: invResult.source, url_preview: invResult.url?.slice(0, 80) + '...' }
        : { ok: false };
    } catch (e) {
      out.invidious = { error: e?.message };
    }

    // Piped check
    try {
      const pipedResult = await getStreamFromPiped(id);
      out.piped = pipedResult
        ? { ok: true, source: pipedResult.source, url_preview: pipedResult.url?.slice(0, 80) + '...' }
        : { ok: false };
    } catch (e) {
      out.piped = { error: e?.message };
    }

    res.json(out);
  } catch (err) { next(err); }
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error(err?.stack || err);
  res.status(500).json({ error: err?.message || 'Something went wrong!' });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
