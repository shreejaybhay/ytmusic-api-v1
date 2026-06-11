// Cloudflare Worker — relays YouTube Innertube API calls from Cloudflare IPs
// (unblocked by YouTube). Vercel sends the full session context + videoId.
// 
// Deploy via: wrangler deploy worker.js --name yt-proxy
// Then set YT_PROXY_URL on Vercel to the worker URL.

const API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'POST required' }, 400);
  }

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  if (!body.videoId || !body.context) {
    return jsonResponse({ error: 'videoId and context required' }, 400);
  }

  const payload = {
    videoId: body.videoId,
    context: body.context,
  };

  try {
    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=${API_KEY}&prettyPrint=false&alt=json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    if (!res.ok) {
      return jsonResponse({ error: `YouTube API returned ${res.status}` }, 502);
    }

    const data = await res.json();
    if (data?.playabilityStatus?.status !== 'OK') {
      return jsonResponse({ error: data?.playabilityStatus?.status || 'Not playable', reason: data?.playabilityStatus?.reason }, 404);
    }

    const sd = data.streamingData;
    if (!sd) {
      return jsonResponse({ error: 'No streaming data' }, 404);
    }

    const result = {};
    const formats = sd.formats || [];
    const adaptiveFormats = sd.adaptiveFormats || [];

    // Prefer progressive format (video+audio, itag 18 = 360p)
    const bestFormat = formats.find(f => f.itag === 18) || formats.at(-1);
    if (bestFormat) {
      result.url = bestFormat.url || extractCipherUrl(bestFormat);
      if (result.url) return jsonResponse(result);
    }

    // Fallback: best audio
    const audioFmts = adaptiveFormats
      .filter(f => f.mimeType?.startsWith('audio/'))
      .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
    for (const fmt of audioFmts) {
      const url = fmt.url || extractCipherUrl(fmt);
      if (url) { result.url = url; result.type = 'audio'; return jsonResponse(result); }
    }

    // Fallback: any video-only
    const videoFmts = adaptiveFormats.filter(f => f.mimeType?.startsWith('video/'));
    if (videoFmts.length) {
      const url = videoFmts[0].url || extractCipherUrl(videoFmts[0]);
      if (url) { result.url = url; result.type = 'video'; return jsonResponse(result); }
    }

    return jsonResponse({ error: 'No playable stream' }, 404);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

function extractCipherUrl(fmt) {
  if (fmt.url) return fmt.url;
  const cipher = fmt.signatureCipher || fmt.cipher;
  if (cipher) {
    const params = new URLSearchParams(cipher);
    const url = params.get('url');
    const s = params.get('s');
    if (url && s) return url + '&sig=' + s;
    if (url) return url;
  }
  return null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
