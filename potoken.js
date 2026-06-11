const { execSync } = require('child_process');

const YT_DLP = 'python -m yt_dlp';

function getStreamUrl(videoId, format = 'bestaudio') {
  const url = `https://music.youtube.com/watch?v=${videoId}`;
  const cmd = `${YT_DLP} -g -f "${format}" --no-warnings "${url}"`;
  return execSync(cmd, { timeout: 30000 }).toString().trim();
}

function listFormats(videoId) {
  const url = `https://music.youtube.com/watch?v=${videoId}`;
  const cmd = `${YT_DLP} -f "bestaudio" --print-json --no-warnings "${url}"`;
  const output = execSync(cmd, { timeout: 30000 }).toString().trim();
  return JSON.parse(output);
}

module.exports = { getStreamUrl, listFormats };
