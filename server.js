/**
 * DropLoad Backend — server.js
 * yt-dlp for YouTube/TikTok/etc + RapidAPI for Instagram
 */

const express = require('express');
const cors    = require('cors');
const { spawn } = require('child_process');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3001;

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '2d2f763f83mshfd74c67f8b4d298p139dd8jsn2166cc27ce06';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isInstagramUrl(url) {
  return /instagram\.com\/(reel|p|tv|stories)\//i.test(url);
}

function ytDlp(args) {
  const isWin = process.platform === 'win32';
  const cmd   = isWin ? 'python' : 'yt-dlp';
  const argv  = isWin ? ['-m', 'yt_dlp', ...args] : args;
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const proc = spawn(cmd, argv);
    proc.stdout.on('data', d => (stdout += d));
    proc.stderr.on('data', d => (stderr += d));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(stderr.trim() || `yt-dlp exited ${code}`));
      else resolve(stdout.trim());
    });
    proc.on('error', err => reject(err));
  });
}

function fmtDuration(secs) {
  if (!secs) return '-';
  const s = Math.round(Number(secs));
  if (isNaN(s)) return String(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function humanSize(bytes) {
  if (!bytes) return null;
  const units = ['B','KB','MB','GB'];
  let i = 0, b = Number(bytes);
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `~${b.toFixed(b < 10 ? 1 : 0)} ${units[i]}`;
}

function buildFormats(info) {
  const formats = info.formats || [];
  const videoByHeight = {};
  for (const f of formats) {
    if (!f.vcodec || f.vcodec === 'none') continue;
    if (!f.height) continue;
    const h = f.height;
    const existing = videoByHeight[h];
    const hasAudio = f.acodec && f.acodec !== 'none';
    if (!existing) {
      videoByHeight[h] = { ...f, hasAudio };
    } else {
      const exHasAudio = existing.hasAudio;
      if (hasAudio && !exHasAudio) {
        videoByHeight[h] = { ...f, hasAudio };
      } else if (hasAudio === exHasAudio && (f.filesize || 0) > (existing.filesize || 0)) {
        videoByHeight[h] = { ...f, hasAudio };
      }
    }
  }
  const heights = Object.keys(videoByHeight).map(Number).sort((a, b) => b - a).slice(0, 5);
  const result = heights.map(h => {
    const f = videoByHeight[h];
    const label = h >= 2160 ? `${h >= 4320 ? '8K' : '4K'} · MP4` : `${h}p · MP4`;
    return {
      formatId: `bestvideo[height=${h}]+bestaudio/best[height<=${h}]`,
      label, badge: 'video',
      size: humanSize(f.filesize || f.filesize_approx) || `~${Math.round(h * 0.06)} MB`,
      height: h,
    };
  });
  const audioFormats = formats.filter(f => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none');
  if (audioFormats.length > 0) {
    const best = audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
    result.push({ formatId: 'bestaudio/best', label: 'Audio only · MP3', badge: 'audio', size: humanSize(best.filesize || best.filesize_approx) || '~8 MB', height: null });
  }
  if (result.length === 0) {
    result.push(
      { formatId: 'bestvideo+bestaudio/best', label: 'Best Quality · MP4', badge: 'video', size: null, height: null },
      { formatId: 'bestaudio/best', label: 'Audio only · MP3', badge: 'audio', size: null, height: null }
    );
  }
  return result;
}

// ─── Instagram via RapidAPI ───────────────────────────────────────────────────

function rapidApiRequest(urlToFetch) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(urlToFetch);
    const options = {
      method: 'GET',
      hostname: 'instagram-downloader-download-instagram-videos-stories.p.rapidapi.com',
      path: `/index?url=${encoded}`,
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': 'instagram-downloader-download-instagram-videos-stories.p.rapidapi.com'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Instagram API')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getInstagramInfo(url) {
  const data = await rapidApiRequest(url);
  console.log('[Instagram API response]', JSON.stringify(data).slice(0, 300));

  // Handle various response shapes from this API
  let videoUrl = null;
  let thumbnail = null;
  let title = 'Instagram Video';

  if (data.media && Array.isArray(data.media) && data.media.length > 0) {
    const item = data.media[0];
    videoUrl = item.url || item.video_url || item.download_url;
    thumbnail = item.thumbnail || item.thumb || item.cover;
    title = data.title || data.caption || 'Instagram Video';
  } else if (data.url) {
    videoUrl = data.url;
    thumbnail = data.thumbnail || data.thumb;
    title = data.title || data.caption || 'Instagram Video';
  } else if (Array.isArray(data) && data.length > 0) {
    videoUrl = data[0].url || data[0].video_url;
    thumbnail = data[0].thumbnail;
    title = 'Instagram Video';
  } else if (data.video_url) {
    videoUrl = data.video_url;
    thumbnail = data.thumbnail_url || data.thumbnail;
    title = data.title || 'Instagram Video';
  } else if (data.result) {
    const r = data.result;
    videoUrl = r.url || r.video_url || (Array.isArray(r) && r[0]?.url);
    thumbnail = r.thumbnail || r.thumb;
    title = r.title || data.title || 'Instagram Video';
  }

  if (!videoUrl) throw new Error('Could not extract video URL from Instagram. The post may be private or unavailable.');

  return {
    title,
    source: 'Instagram',
    duration: '-',
    thumbnail,
    isInstagram: true,
    formats: [
      { formatId: videoUrl, label: 'Video · MP4', badge: 'video', size: null, height: null, directUrl: true }
    ]
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  let parsed;
  try { parsed = new URL(url.startsWith('http') ? url : `https://${url}`); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }

  try {
    if (isInstagramUrl(parsed.href)) {
      const info = await getInstagramInfo(parsed.href);
      return res.json(info);
    }

    const json = await ytDlp(['--dump-json', '--no-playlist', '--no-warnings', parsed.href]);
    const info = JSON.parse(json);
    return res.json({
      title:     info.title    || 'Untitled',
      source:    info.uploader || info.channel || parsed.hostname.replace('www.', ''),
      duration:  fmtDuration(info.duration),
      thumbnail: info.thumbnail || null,
      formats:   buildFormats(info),
    });
  } catch (err) {
    console.error('[/api/info]', err.message);
    return res.status(422).json({ error: err.message });
  }
});

app.get('/api/download', async (req, res) => {
  const { url, formatId, filename } = req.query;
  if (!url || !formatId) return res.status(400).json({ error: 'url and formatId are required' });

  let parsed;
  try { parsed = new URL(url.startsWith('http') ? url : `https://${url}`); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const safeFilename = (filename || 'download').replace(/[^a-z0-9 _\-\.]/gi, '_');

  // Instagram: formatId IS the direct video URL
  if (isInstagramUrl(parsed.href)) {
    // Check if formatId looks like a URL
    let directUrl = formatId;
    if (!directUrl.startsWith('http')) {
      // Re-fetch info to get the direct URL
      try {
        const info = await getInstagramInfo(parsed.href);
        directUrl = info.formats[0]?.formatId;
      } catch (e) {
        return res.status(422).json({ error: e.message });
      }
    }

    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    const dlUrl = new URL(directUrl);
    const proto = dlUrl.protocol === 'https:' ? https : require('http');
    const dlReq = proto.get(directUrl, dlRes => {
      if (dlRes.headers['content-length']) res.setHeader('Content-Length', dlRes.headers['content-length']);
      dlRes.pipe(res);
    });
    dlReq.on('error', err => {
      console.error('[instagram proxy]', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to stream Instagram video' });
    });
    return;
  }

  // Normal yt-dlp download
  const isAudio = formatId === 'bestaudio/best';
  const ext     = isAudio ? 'mp3' : 'mp4';
  const tmpDir  = os.tmpdir();
  const tmpBase = path.join(tmpDir, `dl_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const tmpFile = `${tmpBase}.${ext}`;

  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.${ext}"`);
  res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

  const dlArgs = isAudio
    ? ['--no-playlist', '--no-warnings', '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', `${tmpBase}.%(ext)s`, parsed.href]
    : ['--no-playlist', '--no-warnings', '-f', formatId, '--merge-output-format', 'mp4', '-o', tmpFile, parsed.href];

  try {
    await ytDlp(dlArgs);
    if (!fs.existsSync(tmpFile)) throw new Error('Output file not found after download');
    const stat = fs.statSync(tmpFile);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(tmpFile, () => {}));
    stream.on('error', e => { console.error(e); fs.unlink(tmpFile, () => {}); res.destroy(); });
  } catch (err) {
    console.error('[/api/download]', err.message);
    fs.unlink(tmpFile, () => {});
    if (!res.headersSent) res.status(422).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🟠 DropLoad backend running at http://localhost:${PORT}\n`);
});
