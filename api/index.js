const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache clients – reset if they start failing
let ytIosPromise, ytAndroidPromise, ytTvEmbeddedPromise, ytWebPromise, ytMwebPromise;

async function createYT(clientType) {
  const mod = await import('youtubei.js');

  // Override the eval shim so it works in restricted serverless environments
  // (Vercel's V8 sandbox sometimes blocks `new Function`)
  try {
    mod.Platform.shim.eval = async (data) => {
      // eslint-disable-next-line no-new-func
      return new Function(data.output)();
    };
  } catch (_) {
    // If overriding fails, proceed without it – generate_session_locally avoids eval anyway
  }

  const opts = {
    cache: new mod.UniversalCache(false),
    generate_session_locally: true, // avoids fetching player.js which needs eval
  };

  if (clientType) {
    opts.client_type = clientType;
  }

  if (process.env.YT_COOKIE) opts.cookie = process.env.YT_COOKIE;

  return mod.Innertube.create(opts);
}

// IOS client – best for bypassing Vercel datacenter IP blocks (no poToken required)
async function getYTIos() {
  if (!ytIosPromise) {
    ytIosPromise = (async () => {
      const { ClientType } = await import('youtubei.js');
      return createYT(ClientType.IOS);
    })();
  }
  return ytIosPromise;
}

// TV_EMBEDDED client – second best bypass option
async function getYTTvEmbedded() {
  if (!ytTvEmbeddedPromise) {
    ytTvEmbeddedPromise = (async () => {
      const { ClientType } = await import('youtubei.js');
      return createYT(ClientType.TV_EMBEDDED);
    })();
  }
  return ytTvEmbeddedPromise;
}

// Android client – kept for music API methods that need it
async function getYTAndroid() {
  if (!ytAndroidPromise) {
    ytAndroidPromise = (async () => {
      const { ClientType } = await import('youtubei.js');
      return createYT(ClientType.ANDROID);
    })();
  }
  return ytAndroidPromise;
}

// Web client
async function getYTWeb() {
  if (!ytWebPromise) ytWebPromise = createYT('WEB');
  return ytWebPromise;
}

// Mobile web client
async function getYTMweb() {
  if (!ytMwebPromise) {
    ytMwebPromise = (async () => {
      const { ClientType } = await import('youtubei.js');
      return createYT(ClientType.MWEB);
    })();
  }
  return ytMwebPromise;
}

// Default client for music API calls (use Android for music namespace methods)
async function getYT() {
  return getYTAndroid();
}

try {
  const cors = require('cors');
  app.use(cors());
} catch (_) {}

app.use(express.json());

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
    const ytWeb = await getYTWeb();
    const filters = {};
    if (req.query.type) filters.type = req.query.type;
    if (req.query.upload_date) filters.upload_date = req.query.upload_date;
    if (req.query.duration) filters.duration = req.query.duration;

    let data = await ytWeb.search(req.query.q, filters);

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
    let stream_url = null;

    // Try to get a stream URL using the best clients for Vercel
    for (const get of streamClients) {
      try {
        const c = await get();
        const bi = await c.getBasicInfo(req.params.id, getClientName(get));
        const sd = bi?.streaming_data;
        if (sd?.formats?.length) {
          stream_url = sd.formats.at(-1).url
            || await tryDecipher(sd.formats.at(-1), c);
          if (stream_url) break;
        }
      } catch (_) {}
    }

    res.json({ ...info, stream_url });
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

// Stream clients ordered by best Vercel-bypass ability:
// IOS > TV_EMBEDDED > Android > MWEB > WEB
const streamClients = [getYTIos, getYTTvEmbedded, getYTAndroid, getYTMweb, getYTWeb];

function getClientName(getter) {
  if (getter === getYTIos) return 'IOS';
  if (getter === getYTTvEmbedded) return 'TV_EMBEDDED';
  if (getter === getYTAndroid) return 'ANDROID';
  if (getter === getYTMweb) return 'MWEB';
  return 'WEB';
}

async function tryDecipher(format, yt) {
  try {
    if (typeof format.decipher === 'function') {
      return await format.decipher(yt.session.player);
    }
  } catch (_) {}
  return format.url || null;
}

/**
 * Get a stream URL for a video ID using the given innertube client.
 * NOTE: We do NOT make a HEAD request to validate the URL because
 * Vercel's datacenter IPs are often blocked by YouTube's CDN (googlevideo.com),
 * causing valid URLs to appear broken. The client receives the URL and plays it
 * directly from a residential/browser IP which is not blocked.
 */
async function getStreamURL(yt, id, clientHint) {
  // First try: getBasicInfo with specific client type for better stream access
  try {
    const info = await yt.getBasicInfo(id, clientHint);
    const sd = info?.streaming_data;

    if (sd?.formats?.length) {
      // Try direct URL first (IOS/TV clients return plain URLs)
      const fmt = sd.formats.at(-1);
      if (fmt.url) return fmt.url;

      // Fall back to decipher (Android/Web clients sign the URL)
      const url = await tryDecipher(fmt, yt);
      if (url) return url;
    }

    // Try adaptive_formats (audio-only) as fallback
    if (sd?.adaptive_formats?.length) {
      // Find best audio format
      const audioFmt = sd.adaptive_formats
        .filter(f => f.mime_type?.startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (audioFmt) {
        if (audioFmt.url) return audioFmt.url;
        const url = await tryDecipher(audioFmt, yt);
        if (url) return url;
      }
    }
  } catch (e) {
    console.error(`[stream] getBasicInfo failed for client ${clientHint}:`, e?.message);
  }

  // Second try: raw InnerTube /player endpoint
  try {
    const raw = await yt.actions.execute('/player', {
      videoId: id,
      racyCheckOk: true,
      contentCheckOk: true,
      parse: false,
    });
    const rawSd = raw?.data?.streamingData;
    if (!rawSd?.formats?.length) return null;

    const f = rawSd.formats.at(-1);
    // Plain URL (IOS/TV clients)
    if (f.url) return f.url;

    // Signed URL needing decipher
    if (yt.session?.player && (f.signatureCipher || f.cipher)) {
      const url = await yt.session.player.decipher(f.url, f.signatureCipher || f.cipher);
      if (url) return url;
    }
  } catch (e) {
    console.error(`[stream] raw /player failed for client ${clientHint}:`, e?.message);
  }

  return null;
}

app.get('/api/stream/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const errors = [];

    for (const get of streamClients) {
      const clientName = getClientName(get);
      try {
        const yt = await get();
        const url = await getStreamURL(yt, id, clientName);
        if (url) {
          return res.json({ url, client: clientName });
        }
      } catch (e) {
        errors.push(`${clientName}: ${e?.message}`);
      }
    }

    console.error('[stream] All clients failed for', id, errors);
    res.status(404).json({
      error: 'No playable stream found for this video',
      details: errors,
    });
  } catch (err) { next(err); }
});

app.get('/api/debug/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const results = {};

    for (const get of streamClients) {
      const clientName = getClientName(get);
      try {
        const yt = await get();
        const info = await yt.getBasicInfo(id, clientName);
        results[clientName] = {
          has_streaming_data: !!info?.streaming_data,
          formats: info?.streaming_data?.formats?.length || 0,
          adaptive: info?.streaming_data?.adaptive_formats?.length || 0,
          playability: info?.playability_status,
          basic_info: info?.basic_info ? {
            title: info.basic_info.title,
            duration: info.basic_info.duration,
            is_private: info.basic_info.is_private,
            is_live: info.basic_info.is_live,
          } : null,
        };
      } catch (e) {
        results[clientName] = { error: e?.message };
      }
    }

    res.json(results);
  } catch (err) { next(err); }
});

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
