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

  // Cookie auth: bypasses Vercel IP bot-check.
  // Set YT_COOKIE in Vercel env vars (copy from browser DevTools).
  if (process.env.YT_COOKIE) {
    opts.cookie = process.env.YT_COOKIE;
  }

  const yt = await mod.Innertube.create(opts);

  // OAuth: more stable long-term auth alternative to cookie.
  // If YT_OAUTH is set, use stored access/refresh tokens.
  if (process.env.YT_OAUTH && !process.env.YT_COOKIE) {
    try {
      const credentials = JSON.parse(process.env.YT_OAUTH);
      await yt.session.signIn(credentials);
      yt.session.on('update-credentials', ({ credentials: creds }) => {
        // Log so you can update the env var (Vercel doesn't support runtime writes)
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

// ─── Stream resolver ──────────────────────────────────────────────────────────

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

async function resolveStream(id) {
  const yt = await getYT();
  const player = yt.session.player;

  const clients = ['IOS', 'TV_EMBEDDED', 'ANDROID', 'WEB', 'MUSIC', 'ANDROID_MUSIC', 'MWEB', 'WEB_EMBEDDED'];

  for (const client of clients) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      const sd = info?.streaming_data;

      const tryFormat = async (fmt) => {
        if (typeof fmt.decipher === 'function' && player) {
          const url = await fmt.decipher(player);
          if (url) return url;
        }
        return fmt.url || null;
      };

      // Try progressive formats first (combined audio+video)
      if (sd?.formats?.length) {
        const url = await tryFormat(sd.formats.at(-1));
        if (url) return { url, client };
      }

      // Try audio-only adaptive formats
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
      console.error(`[stream] client=${client} error:`, e?.message);
    }
  }

  // Fallback: try getInfo (full player response)
  try {
    const info = await yt.getInfo(id, { client: 'WEB' });
    const sd = info?.streaming_data;
    const tryFormat = async (fmt) => {
      if (typeof fmt.decipher === 'function' && player) {
        const url = await fmt.decipher(player);
        if (url) return url;
      }
      return fmt.url || null;
    };
    if (sd?.formats?.length) {
      const url = await tryFormat(sd.formats.at(-1));
      if (url) return { url, client: 'WEB(getInfo)' };
    }
    if (sd?.adaptive_formats?.length) {
      const audioFmts = sd.adaptive_formats
        .filter(f => f.mime_type?.startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      for (const fmt of audioFmts) {
        const url = await tryFormat(fmt);
        if (url) return { url, client: 'WEB(getInfo)', type: 'audio' };
      }
    }
  } catch (e) {
    console.error(`[stream] getInfo fallback error:`, e?.message);
  }

  // Final fallback: yt-dlp (handles restricted/DRM content)
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
    const streamResult = await resolveStream(req.params.id);
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

async function pipeStream(url, req, res) {
  const headers = {
    Referer: 'https://www.youtube.com',
    Origin: 'https://www.youtube.com',
    Accept: '*/*',
  };
  if (req.headers.range) headers.Range = req.headers.range;

  const ytRes = await fetch(url, { headers, redirect: 'follow' });

  if (!ytRes.ok) return null;

  const ct = ytRes.headers.get('content-type');
  const cl = ytRes.headers.get('content-length');
  const cr = ytRes.headers.get('content-range');
  if (ct) res.setHeader('Content-Type', ct);
  if (cl) res.setHeader('Content-Length', cl);
  if (cr) res.setHeader('Content-Range', cr);
  if (req.headers.range) res.status(206);

  Readable.fromWeb(ytRes.body).pipe(res);
  return true;
}

app.get('/api/stream/:id', async (req, res, next) => {
  try {
    const id = req.params.id;

    // Return URL only when ?url_only=true (for curl, ffmpeg, etc.)
    if (req.query.url_only === 'true') {
      const result = await resolveStream(id);
      if (!result) return res.status(404).json({ error: 'No playable stream found for this video' });
      return res.json({ url: result.url, client: result.client });
    }

    // Try resolveStream (youtubei.js) first
    const result = await resolveStream(id);
    if (result && await pipeStream(result.url, req, res)) return;

    // Fallback: yt-dlp directly (handles restricted/DRM content)
    const ytDlpResult = await resolveYTdlp(id);
    if (ytDlpResult && await pipeStream(ytDlpResult.url, req, res)) return;

    res.status(404).json({ error: 'No playable stream found for this video' });
  } catch (err) { next(err); }
});

// OAuth setup endpoint — call this ONCE to get credentials to store in YT_OAUTH
app.get('/api/auth/start', async (req, res, next) => {
  try {
    const mod = await import('youtubei.js');
    const yt = await mod.Innertube.create({
      client_type: mod.ClientType.TV_EMBEDDED,
      generate_session_locally: true,
    });

    let pendingData = null;
    yt.session.on('auth-pending', data => { pendingData = data; });

    // Start sign-in (non-blocking — user visits the URL separately)
    yt.session.signIn().catch(() => {});

    // Wait briefly for the pending data
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
        oauth_set: !!process.env.YT_OAUTH,
        signed_in: yt.session?.logged_in ?? false,
      },
      clients: {}
    };

    for (const client of ['IOS', 'TV_EMBEDDED', 'ANDROID', 'WEB', 'MUSIC']) {
      try {
        const info = await yt.getBasicInfo(id, { client });
        out.clients[client] = {
          playability: info?.playability_status?.status,
          reason: info?.playability_status?.reason,
          formats: info?.streaming_data?.formats?.length || 0,
          adaptive: info?.streaming_data?.adaptive_formats?.length || 0,
        };
      } catch (e) {
        out.clients[client] = { error: e?.message };
      }
    }

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
