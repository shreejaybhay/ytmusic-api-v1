const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

let ytPromise, ytWebPromise, ytMwebPromise, Platform;

async function createYT(ct) {
  const mod = await import('youtubei.js');
  Platform = mod.Platform;
  Platform.shim.eval = async (data) => new Function(data.output)();
  return mod.Innertube.create({
    cache: new mod.UniversalCache(false),
    client_type: ct,
    generate_session_locally: true,
  });
}

async function getYT() {
  if (!ytPromise) ytPromise = createYT((await import('youtubei.js')).ClientType.ANDROID);
  return ytPromise;
}

async function getYTWeb() {
  if (!ytWebPromise) ytWebPromise = createYT('WEB');
  return ytWebPromise;
}

async function getYTMweb() {
  if (!ytMwebPromise) ytMwebPromise = createYT((await import('youtubei.js')).ClientType.MWEB);
  return ytMwebPromise;
}

try {
  const cors = require('cors');
  app.use(cors());
} catch {}

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
    for (const get of streamClients) {
      try {
        const c = await get();
        const bi = await c.getBasicInfo(req.params.id);
        const sd = bi?.streaming_data;
        if (sd?.formats?.length) {
          stream_url = await sd.formats.at(-1).decipher(c.session.player);
          break;
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

const streamClients = [getYT, getYTMweb, getYTWeb];

async function getStreamURL(yt, id) {
  const info = await yt.getBasicInfo(id);
  const sd = info?.streaming_data;
  if (sd?.formats?.length) {
    const url = await sd.formats.at(-1).decipher(yt.session.player);
    const test = await fetch(url, { method: 'HEAD' });
    if (test.ok) return url;
  }
  const raw = await yt.actions.execute('/player', {
    videoId: id, racyCheckOk: true, contentCheckOk: true, parse: false,
  });
  const rawSd = raw?.data?.streamingData;
  if (!rawSd?.formats?.length) return null;
  const f = rawSd.formats.at(-1);
  const url = await yt.session.player.decipher(f.url, f.signatureCipher || f.cipher);
  const test = await fetch(url, { method: 'HEAD' });
  if (test.ok) return url;
  return null;
}

app.get('/api/stream/:id', async (req, res, next) => {
  try {
    for (const get of streamClients) {
      try {
        const yt = await get();
        const url = await getStreamURL(yt, req.params.id);
        if (url) return res.json({ url });
      } catch (_) {}
    }
    res.status(404).json({ error: 'No playable stream found for this video' });
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
