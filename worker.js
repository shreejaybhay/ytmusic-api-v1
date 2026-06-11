// Cloudflare Worker — proxies YouTube Innertube API without browser cookies.
// Deploy this to Cloudflare Workers, then set YT_PROXY_URL on Vercel to its URL.

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

const API_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';
const ANDROID_CLIENTS = [
  { name: 'ANDROID_VR', version: '19.09.37' },
  { name: 'ANDROID', version: '19.09.37' },
  { name: 'iOS', version: '19.09.37' },
];

async function handleRequest(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  if (!body.videoId) {
    return new Response(JSON.stringify({ error: 'videoId required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const videoId = body.videoId;

  for (const client of ANDROID_CLIENTS) {
    try {
      const payload = {
        videoId,
        context: {
          client: {
            clientName: client.name,
            clientVersion: client.version,
            hl: 'en',
            gl: 'US',
          },
        },
      };

      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${API_KEY}&prettyPrint=false&alt=json`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );

      if (!res.ok) continue;

      const data = await res.json();
      if (data?.playabilityStatus?.status !== 'OK') continue;

      const sd = data.streamingData;
      if (!sd) continue;

      const formats = sd.formats || [];
      const adaptiveFormats = sd.adaptiveFormats || [];

      const result = { client: client.name };

      // Prefer progressive (video+audio) format
      let bestFmt = null;
      if (formats.length) {
        bestFmt = formats.find(f => f.itag === 18) || formats.at(-1);
      }

      if (bestFmt) {
        result.url = bestFmt.url || extractCipherUrl(bestFmt);
        if (result.url) {
          return jsonResponse(result);
        }
      }

      // Fallback to any audio format
      const audioFmts = adaptiveFormats
        .filter(f => f.mimeType?.startsWith('audio/'))
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));

      for (const fmt of audioFmts) {
        const url = fmt.url || extractCipherUrl(fmt);
        if (url) {
          result.url = url;
          result.type = 'audio';
          return jsonResponse(result);
        }
      }

      // Fallback to any video-only format
      const videoFmts = adaptiveFormats.filter(f => f.mimeType?.startsWith('video/'));
      if (videoFmts.length) {
        const url = videoFmts[0].url || extractCipherUrl(videoFmts[0]);
        if (url) {
          result.url = url;
          result.type = 'video';
          return jsonResponse(result);
        }
      }
    } catch (e) {
      // Try next client
    }
  }

  return jsonResponse({ error: 'No playable stream found' });
}

function extractCipherUrl(fmt) {
  if (fmt.url) return fmt.url;
  const cipher = fmt.signatureCipher || fmt.cipher;
  if (cipher) {
    const params = new URLSearchParams(cipher);
    const url = params.get('url');
    const s = params.get('s');
    if (url && s) return url + '&signature=' + s;
    if (url) return url;
  }
  return null;
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: data.error ? 404 : 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
