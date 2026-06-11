// Cloudflare Worker — extracts YouTube stream URLs from the embed page.
// Bypasses Vercel's blocked AWS IPs by fetching from Cloudflare's network.
// No visitor data / Innertube session needed.

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

  if (!body.videoId) {
    return jsonResponse({ error: 'videoId required' }, 400);
  }

  const videoId = body.videoId;
  const results = [];

  // Strategy 1: Fetch embed page and extract ytInitialPlayerResponse
  try {
    const html = await fetchText(`https://www.youtube.com/embed/${videoId}`);
    const json = extractJson(html, 'ytInitialPlayerResponse');
    if (json) {
      const url = extractStreamUrl(json);
      if (url) return jsonResponse({ url, client: 'embed' });
    }
  } catch (e) {}

  // Strategy 2: Fetch watch page
  try {
    const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}`);
    const json = extractJson(html, 'ytInitialPlayerResponse');
    if (json) {
      const url = extractStreamUrl(json);
      if (url) return jsonResponse({ url, client: 'watch' });
    }
  } catch (e) {}

  // Strategy 3: Innertube API with minimal context (works from non-blocked IPs)
  try {
    const payload = {
      videoId,
      context: {
        client: {
          clientName: 'ANDROID_VR',
          clientVersion: '1.65.10',
          hl: 'en',
          gl: 'US',
        },
      },
    };
    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false&alt=json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.playabilityStatus?.status === 'OK') {
        const url = extractStreamUrl(data);
        if (url) return jsonResponse({ url, client: 'innertube' });
      }
    }
  } catch (e) {}

  return jsonResponse({ error: 'No playable stream found' }, 404);
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    },
  });
  return res.text();
}

function extractJson(html, varName) {
  const regex = new RegExp(`${varName}\\s*=\\s*(\\{.*?\\});`, 's');
  const match = html.match(regex);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractStreamUrl(data) {
  const sd = data?.streamingData;
  if (!sd) return null;

  const formats = sd.formats || [];
  const adaptiveFormats = sd.adaptiveFormats || [];

  // Prefer progressive (video+audio, itag 18 = 360p)
  const best = formats.find(f => f.itag === 18) || formats.at(-1);
  if (best) {
    const url = best.url || extractCipherUrl(best);
    if (url) return url;
  }

  // Fallback: best audio
  const audioFmts = adaptiveFormats
    .filter(f => f.mimeType?.startsWith('audio/'))
    .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
  for (const fmt of audioFmts) {
    const url = fmt.url || extractCipherUrl(fmt);
    if (url) return url;
  }

  // Fallback: any video-only
  for (const fmt of adaptiveFormats) {
    if (fmt.mimeType?.startsWith('video/')) {
      const url = fmt.url || extractCipherUrl(fmt);
      if (url) return url;
    }
  }

  return null;
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
